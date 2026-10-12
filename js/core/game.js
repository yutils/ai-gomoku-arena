// 对局状态机：驱动 黑/白 双方交替思考、落子、异常处理、指标记录
import { Board, BLACK, WHITE, opponent, colorName, rcToLabel } from './board.js';
import { chooseMoveAsync } from '../ai/engine.js';
import { chatCompletion, ChatError } from '../ai/openai.js';
import { buildMessages } from '../ai/prompt.js';
import { parseMove } from '../ai/parse.js';
import { uid } from '../util.js';
import { t, arenaLevel, getLang } from '../i18n.js';

export const GAME_DEFAULTS = {
  size: 15,
  moveTimeoutMs: 600000, // 单步超时（含请求重试总时长）
  illegalRetries: 10, // 非法/无法解析时的重试次数
  onAbnormal: 'fallback', // fallback=内置算法兜底代下 | forfeit=判负
  thinking: true, // 提示词中是否要求模型先分析
  lang: 'zh',
  engineBudgetMs: 1800,
  savePrompts: false,
};

export const STATUS_TEXT = {
  idle: '待开始',
  playing: '进行中',
  thinking: '思考中',
  human: '等待人类落子',
  paused: '已暂停',
  ended: '已结束',
};

// 终局原因
export const REASON_TEXT = {
  five: '五连获胜',
  full: '满盘和棋',
  timeout: '超时判负',
  illegal: '连续非法落子判负',
  request: '请求失败判负',
  manual: '手动终止',
  engine_fallback_over: '兜底也失败',
};

export class GameSession {
  constructor({ black, white, settings = {}, id = null }) {
    this.id = id || uid();
    this.settings = { ...GAME_DEFAULTS, ...settings };
    this.board = new Board(this.settings.size);
    this.players = { [BLACK]: black, [WHITE]: white };
    this.turn = BLACK;
    this.moves = []; // 扩展记录（含 metrics / thought）
    this.status = 'idle';
    this.result = null;
    this.startedAt = null;
    this.endedAt = null;
    this.paused = false;
    this.stopped = false;
    this.currentStartedAt = null;
    this.abortCtrl = null;
    this.thinkingStopped = false; // 用户点击“终止思考”后置真，用于中断在途请求
    this._humanResolve = null;
    this._resumeResolve = null;
    this._listeners = new Map();
  }

  // ---- 事件 ----
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return () => this._listeners.get(event)?.delete(cb);
  }

  emit(event, payload) {
    const set = this._listeners.get(event);
    if (set) for (const cb of [...set]) cb(payload);
  }

  get(record) {
    return {
      id: this.id,
      black: this.players[BLACK],
      white: this.players[WHITE],
      settings: this.settings,
      status: this.status,
      turn: this.turn,
      result: this.result,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      numberOfMoves: this.moves.length,
      ...(record ? { board: this.board, moves: this.moves } : {}),
    };
  }

  player(color) {
    return this.players[color];
  }

  // ---- 生命周期 ----
  async start() {
    if (this.status !== 'idle') return;
    this.startedAt = Date.now();
    this.status = 'playing';
    this.emit('status', { status: this.status });
    await this.loop();
  }

  pause() {
    if (this.status === 'ended' || this.status === 'idle') return;
    this.paused = true;
    this.status = 'paused';
    this.emit('status', { status: this.status });
    this.thinkingStopped = false;
    if (this.abortCtrl) this.abortCtrl.abort();
  }

  // 终止本次思考：立即中断在途请求，并用已产生的输出抢救一手（防止模型过度思考）
  stopThinking() {
    if (this.status !== 'thinking') return false;
    this.thinkingStopped = true;
    if (this.abortCtrl) this.abortCtrl.abort();
    return true;
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.status = this._humanResolve ? 'human' : 'playing';
    this.emit('status', { status: this.status });
    if (this._resumeResolve) {
      const r = this._resumeResolve;
      this._resumeResolve = null;
      r();
    }
  }

  stop(reason = 'manual') {
    this.stopped = true;
    this.thinkingStopped = false;
    if (this.abortCtrl) this.abortCtrl.abort();
    if (this._humanResolve) {
      const r = this._humanResolve;
      this._humanResolve = null;
      r(null);
    }
    if (this._resumeResolve) {
      const r = this._resumeResolve;
      this._resumeResolve = null;
      r();
    }
    this.end(null, reason);
  }

  // 悔棋：从暂停/结束状态下回退若干手（暂停中的人类等待会被安全打断）
  undo(count = 1) {
    if (this.status !== 'paused' && this.status !== 'ended') return 0;
    if (this._humanResolve) {
      const r = this._humanResolve;
      this._humanResolve = null;
      r(null);
    }
    const wasEnded = this.status === 'ended';
    const removed = [];
    let done = 0;
    while (done < count && this.moves.length) {
      const rec = this.moves.pop();
      this.board.undo();
      this.turn = rec.color;
      removed.push(rec);
      done++;
    }
    if (done) {
      this.result = null;
      this.endedAt = null;
      if (wasEnded) {
        // 对局已结束（主循环已退出）：悔棋后重新启动主循环继续下
        this.paused = false;
        this.stopped = false;
        this.status = 'playing';
        this.emit('status', { status: this.status });
        this.emit('undo', { count: done, removed });
        this.loop();
      } else {
        this.emit('status', { status: this.status });
        this.emit('undo', { count: done, removed });
      }
    }
    return done;
  }

  // 接管：中场把某一方换成人类/算法/另一个模型
  setPlayer(color, player) {
    this.players[color] = player;
    if (this.abortCtrl && this.turn === color && ['thinking', 'playing'].includes(this.status)) {
      this.abortCtrl.abort();
    }
    this.emit('players', { black: this.players[BLACK], white: this.players[WHITE] });
  }

  // 人类落子入口（UI 调用）
  playHuman(r, c) {
    if (this.status !== 'human' || !this._humanResolve) return false;
    if (!this.board.isEmpty(r, c)) return false;
    const resolve = this._humanResolve;
    this._humanResolve = null;
    resolve({ r, c, source: 'human-click' });
    return true;
  }

  end(winner, reason) {
    if (this.status === 'ended') return;
    this.status = 'ended';
    this.endedAt = Date.now();
    this.result = { winner: winner ?? null, reason };
    this.emit('status', { status: this.status });
    this.emit('end', this.result);
  }

  // ---- 主循环 ----
  async loop() {
    while (!this.stopped) {
      if (this.paused) {
        await new Promise((resolve) => { this._resumeResolve = resolve; });
        continue;
      }
      if (this.status === 'ended') break;

      const color = this.turn;
      const player = this.players[color];
      this.emit('turn', { color, player });

      let moveRes = null;
      try {
        if (player.kind === 'human') {
          this.status = 'human';
          this.currentStartedAt = Date.now();
          this.emit('status', { status: this.status });
          moveRes = await new Promise((resolve) => { this._humanResolve = resolve; });
          this.currentStartedAt = null;
          if (!moveRes) continue; // 被 stop/pause 打断
        } else if (player.kind === 'engine') {
          this.status = 'thinking';
          this.currentStartedAt = Date.now();
          this.emit('status', { status: this.status });
          moveRes = await this.engineMove(player, color);
          this.currentStartedAt = null;
        } else {
          this.status = 'thinking';
          this.currentStartedAt = Date.now();
          this.emit('status', { status: this.status });
          moveRes = await this.llmMove(player, color);
          this.currentStartedAt = null;
        }
      } catch (e) {
        this.currentStartedAt = null;
        if (e?.code === 'aborted' || this.stopped || this.paused) continue;
        // 未预期异常：按异常处理策略
        moveRes = await this.handleAbnormal(player, color, e, []);
        if (!moveRes) continue;
      }

      if (this.stopped || this.paused) continue;
      if (!moveRes || moveRes.r == null) continue;

      const mv = this.board.place(moveRes.r, moveRes.c, color);
      const rec = {
        ...mv,
        type: player.kind,
        playerName: player.name,
        reason: moveRes.reason || null,
        thought: moveRes.thought || null,
        metrics: moveRes.metrics || null,
        attempts: moveRes.attempts || null,
        messages: moveRes.messages || null,
      };
      this.moves.push(rec);
      this.emit('move', rec);

      const win = this.board.checkWin(mv.r, mv.c);
      if (win) {
        this.emit('winline', win);
        this.end(color, 'five');
        break;
      }
      if (this.board.isFull()) {
        this.end(null, 'full');
        break;
      }
      this.turn = opponent(color);
    }
    if (this.status !== 'ended' && !this.stopped) {
      // 正常流程外的退出（比如异常导致 continue 死循环保护）不处理
    }
  }

  // ---- 传统算法走一手 ----
  async engineMove(player, color) {
    const t0 = performance.now();
    const level = player.level || 'hard';
    const budget = this.settings.engineBudgetMs;
    const mv = await chooseMoveAsync(this.board, color, level, { budgetMs: budget });
    const latencyMs = performance.now() - t0;
    if (!mv || !this.board.isEmpty(mv.r, mv.c)) {
      return this.handleAbnormal(player, color, new ChatError(t('game.err.illegalNoMove'), { code: 'illegal' }), []);
    }
    return {
      r: mv.r,
      c: mv.c,
      source: 'engine',
      reason: t('game.engineReason', { level: arenaLevel(level) }),
      metrics: { latencyMs, ttftMs: null, promptTokens: null, completionTokens: null, totalTokens: null, decodeTps: null, promptTps: null, estimated: false },
    };
  }

  // ---- LLM 走一手（含重试/兜底/流式回调）----
  async llmMove(player, color) {
    const maxAttempts = 1 + Math.max(0, this.settings.illegalRetries | 0);
    const attempts = [];
    let feedback = null;
    const thinkStart = performance.now();
    let lastRequestMessages = null;
    this.thinkingStopped = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.paused || this.stopped) throw new ChatError(t('game.err.cancelled'), { code: 'aborted' });
      if (performance.now() - thinkStart > this.settings.moveTimeoutMs) {
        return this.handleAbnormal(player, color, new ChatError(t('game.err.timeout'), { code: 'timeout' }), attempts);
      }

      const messages = buildMessages({
        board: this.board,
        color,
        thinking: this.settings.thinking,
        lang: getLang(), // 提示词语言始终跟随界面语言
        feedback,
      });
      lastRequestMessages = messages;
      this.emit('request', { color, messages }); // 请求一发出就把提示词交给界面，思考过程中即可查看

      const ctrl = new AbortController();
      this.abortCtrl = ctrl;
      const t0 = performance.now();
      const model = player.model || {};
      const provider = player.provider || {};

      // 单次尝试的预算 = 整步剩余时间；总时长由循环顶部的整体超时检查统一约束。
      // 不在各次尝试间均分：否则长思考模型会在流式输出途中被误判为超时。
      // 真正防止“卡死”的是请求层的空闲超时（收到数据即重置）。
      const remaining = this.settings.moveTimeoutMs - (t0 - thinkStart);
      const perAttempt = Math.max(20000, remaining);
      let partialReasoning = ''; // 流式累积，供“终止思考”时抢救落子
      let partialContent = '';
      let res;
      try {
        res = await chatCompletion({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: model.id,
          messages,
          temperature: model.temperature,
          topP: model.topP,
          topK: model.topK,
          maxTokens: model.maxTokens,
          extraBody: { ...(provider.extraBody || {}), ...(model.extraBody || {}) },
          headers: provider.headers,
          timeoutMs: Math.max(5000, Math.round(perAttempt)),
          signal: ctrl.signal,
          viaProxy: provider.viaProxy || 'auto',
          onDelta: (d) => {
            if (d.type === 'content') partialContent += d.text;
            else partialReasoning += d.text;
            this.emit('delta', { color, ...d });
          },
        });
      } catch (e) {
        this.abortCtrl = null;
        if (e?.code === 'aborted') {
          // 用户点击“终止思考”：用已产生的输出抢救一手
          if (this.thinkingStopped) {
            this.thinkingStopped = false;
            const pC = parseMove(partialContent, this.board.size);
            const pR = pC.ok ? pC : parseMove(partialReasoning, this.board.size);
            if (pR.ok && this.board.isEmpty(pR.r, pR.c)) {
              return {
                r: pR.r,
                c: pR.c,
                source: 'llm',
                reason: pR.reason,
                metrics: { latencyMs: performance.now() - t0, ttftMs: null, promptTokens: null, completionTokens: null, totalTokens: null, decodeTps: null, promptTps: null, estimated: false, stopped: true },
                thought: { reasoning: partialReasoning, content: partialContent, stopped: true, parsedFrom: pC.ok ? 'content' : 'reasoning' },
                attempts: attempts.length ? attempts : null,
                messages,
              };
            }
            this.emit('warn', { color, message: t('game.warn.stoppedNoMove') });
            return this.handleAbnormal(player, color, new ChatError(t('game.warn.stoppedNoMove'), { code: 'stopped' }), attempts, messages);
          }
          throw e;
        }
        attempts.push({ error: String(e?.message || e), code: e?.code });
        this.emit('warn', { color, message: t('game.warn.requestFail', { msg: e?.message || e }) });
        // 请求层错误：直接重试（可能是瞬时故障），反馈里带上错误信息
        feedback = {
          kind: e?.code || 'error',
          text: t('game.feedback.request', { msg: e?.message || e }),
          lastRaw: '',
        };
        continue;
      }
      this.abortCtrl = null;

      const text = res.content ?? '';
      // 常规解析 content；思考模型被长度截断时，退回解析思考过程（最终结论常在其中）
      let parsed = parseMove(text, this.board.size);
      let parsedFrom = 'content';
      if (!parsed.ok && res.reasoning) {
        const fromReasoning = parseMove(res.reasoning, this.board.size);
        if (fromReasoning.ok) {
          parsed = fromReasoning;
          parsedFrom = 'reasoning';
        }
      }
      const metrics = buildMetrics({ t0, res });
      const thought = {
        reasoning: res.reasoning || '',
        content: text,
        finishReason: res.finishReason,
        usage: res.usage,
        timings: res.timings || null,
        viaProxy: res.viaProxy,
        endpoint: res.endpoint,
        parsedFrom,
        prompt: this.settings.savePrompts ? messages : null,
      };

      if (parsed.ok && this.board.isEmpty(parsed.r, parsed.c)) {
        return {
          r: parsed.r,
          c: parsed.c,
          source: 'llm',
          reason: parsed.reason,
          metrics: { ...metrics, attempts: attempts.length || undefined },
          thought,
          attempts: attempts.length ? attempts : null,
          messages,
        };
      }

      const why = !parsed.ok
        ? (res.finishReason === 'length'
          ? t('game.warn.truncated')
          : t('game.warn.noCoord'))
        : t('game.warn.occupied', { coord: rcToLabel(parsed.r, parsed.c, this.board.size) });
      attempts.push({ error: why, raw: text.slice(0, 500), finishReason: res.finishReason, parsed });
      this.emit('warn', { color, message: why });
      feedback = {
        kind: parsed.ok ? 'occupied' : 'no-candidate',
        text: `${why}${t('game.feedback.append')}`,
        lastRaw: text || res.reasoning || '',
      };
    }

    return this.handleAbnormal(
      player,
      color,
      new ChatError(t('game.warn.invalidMove'), { code: 'illegal' }),
      attempts,
      lastRequestMessages,
    );
  }

  // ---- 异常处理：兜底 or 判负 ----
  async handleAbnormal(player, color, error, attempts, messages = null) {
    const mode = this.settings.onAbnormal;
    this.emit('warn', { color, message: t('game.warn.playerError', { name: player.name, msg: error.message }) });
    if (mode === 'forfeit') {
      const reason = error.code === 'timeout' ? 'timeout' : error.code === 'illegal' ? 'illegal' : 'request';
      this.emit('abnormal', { color, error, attempts, messages });
      this.end(opponent(color), reason);
      return null;
    }
    // fallback：用内置算法代下
    const t0 = performance.now();
    const mv = await chooseMoveAsync(this.board, color, 'medium', { budgetMs: 800 });
    const latencyMs = performance.now() - t0;
    if (!mv) {
      this.end(opponent(color), 'engine_fallback_over');
      return null;
    }
    this.emit('abnormal', { color, error, attempts, fallback: mv, messages });
    return {
      r: mv.r,
      c: mv.c,
      source: 'fallback',
      reason: t('game.fallbackReason'),
      metrics: { latencyMs, ttftMs: null, promptTokens: null, completionTokens: null, totalTokens: null, decodeTps: null, promptTps: null, estimated: false, fallback: true },
      thought: { error: error.message, code: error.code, attempts, prompt: messages && this.settings.savePrompts ? messages : null },
      attempts,
      messages: messages || null,
    };
  }

  // ---- 存档快照（不含密钥）----
  snapshot({ includeThoughts = true } = {}) {
    const stripKey = (p) => {
      if (!p) return p;
      const { apiKey, ...rest } = p;
      return rest;
    };
    const moves = this.moves.map((m) => {
      const out = {
        n: m.n, color: m.color, r: m.r, c: m.c, label: m.label,
        type: m.type, playerName: m.playerName, reason: m.reason,
        metrics: m.metrics || null,
      };
      if (includeThoughts && m.thought) {
        out.thought = {
          reasoning: (m.thought.reasoning || '').slice(0, 30000),
          content: (m.thought.content || '').slice(0, 10000),
          finishReason: m.thought.finishReason,
          usage: m.thought.usage,
          timings: m.thought.timings,
          error: m.thought.error,
          code: m.thought.code,
        };
      }
      if (m.attempts?.length) out.attempts = m.attempts;
      return out;
    });
    return {
      id: this.id,
      version: 1,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      status: this.status,
      result: this.result,
      settings: this.settings,
      players: { black: stripKey(this.players[BLACK]), white: stripKey(this.players[WHITE]) },
      moves,
      totals: computeTotals(moves),
    };
  }
}

function buildMetrics({ t0, res }) {
  const latencyMs = res.latencyMs ?? (performance.now() - t0);
  const ttftMs = res.ttftMs;
  const usage = res.usage || {};
  const timings = res.timings || null;
  let decodeTps = timings?.predicted_per_second ?? null;
  if (decodeTps == null && usage.completion_tokens) {
    const decodeMs = Math.max(1, latencyMs - (ttftMs ?? 0));
    decodeTps = usage.completion_tokens / (decodeMs / 1000);
  }
  return {
    latencyMs,
    ttftMs,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
    decodeTps,
    promptTps: timings?.prompt_per_second ?? null,
    estimated: !!res.usageEstimated,
    draftN: timings?.draft_n ?? null,
    draftAccepted: timings?.draft_n_accepted ?? null,
  };
}

// 汇总统计（对战台与历史页共用）
export function computeTotals(moves) {
  const acc = {
    [BLACK]: { moves: 0, totalMs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, tpsSum: 0, tpsCount: 0, ttftSum: 0, ttftCount: 0, thinkerMoves: 0, fallbacks: 0 },
    [WHITE]: { moves: 0, totalMs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, tpsSum: 0, tpsCount: 0, ttftSum: 0, ttftCount: 0, thinkerMoves: 0, fallbacks: 0 },
  };
  for (const m of moves) {
    const a = acc[m.color];
    if (!a) continue;
    a.moves++;
    const mt = m.metrics || {};
    a.totalMs += mt.latencyMs || 0;
    if (mt.promptTokens) a.promptTokens += mt.promptTokens;
    if (mt.completionTokens) a.completionTokens += mt.completionTokens;
    if (mt.totalTokens) a.totalTokens += mt.totalTokens;
    if (mt.decodeTps != null) { a.tpsSum += mt.decodeTps; a.tpsCount++; }
    if (mt.ttftMs != null) { a.ttftSum += mt.ttftMs; a.ttftCount++; }
    if (m.type === 'llm') a.thinkerMoves++;
    if (m.source === 'fallback' || mt.fallback) a.fallbacks++;
  }
  for (const color of [BLACK, WHITE]) {
    const a = acc[color];
    a.avgTps = a.tpsCount ? a.tpsSum / a.tpsCount : null;
    a.avgTtftMs = a.ttftCount ? a.ttftSum / a.ttftCount : null;
    a.avgMoveMs = a.moves ? a.totalMs / a.moves : null;
  }
  return acc;
}