// 对战台：选边 → 对局 → 实时指标 / 思考流 / 走子记录
import { GameSession, GAME_DEFAULTS, computeTotals } from '../core/game.js';
import { BLACK, WHITE } from '../core/board.js';
import { loadProviders, loadGameSettings, saveGameSettings, loadUiPrefs, saveUiPrefs } from '../store/providers.js';
import { saveGame } from '../store/db.js';
import { createBoardView } from './boardview.js';
import { toast, confirmDialog, openModal } from './feedback.js';
import { fmtMs, fmtNum, fmtTps, estimateTokens } from '../util.js';
import { t, applyStaticI18n, uiSide, arenaLevel, arenaLevelSuffix, getLang } from '../i18n.js';

function defaultSetup() {
  return {
    black: { kind: 'llm', providerId: '', modelId: '', level: 'hard' },
    white: { kind: 'llm', providerId: '', modelId: '', level: 'medium' },
  };
}

export function createArenaView(el) {
  const prefs = loadUiPrefs();
  const state = {
    setup: { ...defaultSetup(), ...(prefs.setup || {}) },
    settings: { ...GAME_DEFAULTS, ...loadGameSettings() },
    session: null,
    originals: {},
    streams: { [BLACK]: null, [WHITE]: null },
    saveTimer: null,
    tick: null,
  };

  el.innerHTML = `
    <div class="view-inner">
      <div class="arena-grid">
        <div class="board-column">
          <div class="board-head">
            <span class="match-title" id="match-title">等待开始</span>
            <span class="match-meta" id="match-meta">选择双方选手后开始对局</span>
          </div>
          <div id="board-host"></div>
          <div class="controls" id="controls">
            <button class="btn primary" id="btn-start" data-i18n="arena.btnStart">${t('arena.btnStart')}</button>
            <button class="btn" id="btn-pause" disabled data-i18n="arena.btnPause">${t('arena.btnPause')}</button>
            <button class="btn ghost" id="btn-stop-think" disabled data-i18n="arena.btnStopThink">${t('arena.btnStopThink')}</button>
            <div class="sep"></div>
            <button class="btn ghost" id="btn-undo" disabled data-i18n="arena.btnUndo">${t('arena.btnUndo')}</button>
            <button class="btn ghost" id="btn-stop" disabled data-i18n="arena.btnStop">${t('arena.btnStop')}</button>
            <button class="btn ghost" id="btn-settings" data-i18n="arena.btnSettings">${t('arena.btnSettings')}</button>
            <div class="spacer"></div>
            <span class="elapsed"><span class="status-dot" id="status-dot"></span><span id="status-text" data-i18n="arena.statusIdle">${t('arena.statusIdle')}</span><span class="num dim" id="elapsed-text"></span></span>
          </div>
        </div>
        <div class="side-column">
          <div class="panel" id="setup-panel"></div>
          <div class="panel" id="pp-black"></div>
          <div class="panel" id="pp-white"></div>
          <div class="panel flush" id="log-panel" hidden></div>
        </div>
      </div>
    </div>`;

  const $ = (id) => el.querySelector(`#${id}`);
  const board = createBoardView($('board-host'), {
    size: state.settings.size,
    onCellClick: (r, c) => {
      const s = state.session;
      if (!s) return;
      if (!s.playHuman(r, c)) toast(t('arena.cantPlace'), { type: 'warn' });
    },
  });

  // ---------------- 选边面板 ----------------
  function providers() {
    return loadProviders();
  }

  function setupSlotHtml(color) {
    const sel = state.setup[color === BLACK ? 'black' : 'white'];
    const list = providers();
    if (!sel.providerId && list.length) sel.providerId = list[0].id;
    const prov = list.find((p) => p.id === sel.providerId) || list[0];
    if (prov && !prov.models?.some((m) => m.id === sel.modelId)) {
      sel.modelId = prov?.models?.[0]?.id || '';
    }
    const isBlack = color === BLACK;
    return `
      <div class="slot" data-color="${isBlack ? 'black' : 'white'}">
        <div class="slot-head">
          <span class="slot-dot ${isBlack ? 'black' : 'white'}"></span>
          <span class="slot-title">${uiSide(color)}${isBlack ? t('arena.firstMove') : ''}</span>
          <span class="tail">
            ${isBlack ? `<button class="btn ghost sm" data-act="copy-white">${t('arena.copyWhite')}</button>` : `<button class="btn ghost sm" data-act="copy-black">${t('arena.copyBlack')}</button>`}
          </span>
        </div>
        <div class="slot-row">
          <label class="field"><span class="lbl">${t('arena.label.kind')}</span>
            <select data-act="kind">
              <option value="llm" ${sel.kind === 'llm' ? 'selected' : ''}>${t('arena.kind.llm')}</option>
              <option value="engine" ${sel.kind === 'engine' ? 'selected' : ''}>${t('arena.kind.engine')}</option>
              <option value="human" ${sel.kind === 'human' ? 'selected' : ''}>${t('arena.kind.human')}</option>
            </select>
          </label>
          ${sel.kind === 'engine' ? `
          <label class="field"><span class="lbl">${t('arena.label.level')}</span>
            <select data-act="level">
              ${['easy', 'medium', 'hard'].map((k) => `<option value="${k}" ${sel.level === k ? 'selected' : ''}>${arenaLevel(k)}${arenaLevelSuffix(k)}</option>`).join('')}
            </select>
          </label>` : sel.kind === 'human' ? `
          <label class="field"><span class="lbl">${t('arena.label.control')}</span>
            <div class="hint" style="margin-top:6px">${t('arena.humanHint')}</div>
          </label>` : `
          <label class="field"><span class="lbl">${t('arena.label.provider')}</span>
            <select data-act="provider">
              ${list.length ? list.map((p) => `<option value="${p.id}" ${p.id === sel.providerId ? 'selected' : ''}>${p.name}</option>`).join('') : `<option value="">${t('arena.noProviders')}</option>`}
            </select>
          </label>`}
        </div>
        ${sel.kind === 'llm' ? `
        <div class="slot-row single sub">
          <label class="field" style="margin-bottom:0"><span class="lbl">${t('arena.label.model')}</span>
            <select data-act="model">
              ${(prov?.models || []).map((m) => `<option value="${m.id}" ${m.id === sel.modelId ? 'selected' : ''}>${m.name || m.id}</option>`).join('') || `<option value="">${t('arena.noModels')}</option>`}
            </select>
          </label>
        </div>
        <div class="hint" style="font-size:11.5px;color:var(--text-faint);margin-top:2px">
          ${prov ? t('arena.baseUrlHint', { url: prov.baseUrl, s: Math.round((prov.timeoutMs || 300000) / 1000) }) : ''}
        </div>` : ''}
      </div>`;
  }

  function renderSetup() {
    const s = state.settings;
    const p = $('setup-panel');
    p.innerHTML = `
      <div class="setup-head"><h2>${t('arena.choosePlayers')}</h2>
        <span class="tail">
          <button class="btn ghost sm" data-act="swap">${t('arena.swap')}</button>
          <a class="btn ghost sm" href="#/models">${t('arena.linkModels')}</a>
        </span>
      </div>
      ${setupSlotHtml(BLACK)}
      ${setupSlotHtml(WHITE)}
      <div class="section" style="padding-bottom:0">
        <div class="hint" style="font-size:12px;color:var(--text-dim);line-height:1.9">
          ${[t('arena.summarySize', { n: s.size }), t('arena.summaryTimeout', { s: Math.round(s.moveTimeoutMs / 1000) }), t('arena.summaryRetries', { n: s.illegalRetries }), s.onAbnormal === 'fallback' ? t('arena.summaryFallback') : t('arena.summaryForfeit'), s.thinking ? t('arena.summaryThinking') : t('arena.summaryNoThinking'), getLang() === 'zh' ? t('arena.promptZh') : t('arena.promptEn')].join(' · ')}
        </div>
        <button class="btn primary" data-act="start" style="width:100%;margin-top:14px" ${providers().length || state.setup.black.kind !== 'llm' || state.setup.white.kind !== 'llm' ? '' : 'disabled'}>
          ${state.session && state.session.status === 'ended' ? t('arena.rematch') : t('arena.btnStart')}
        </button>
      </div>`;

    p.onclick = null;
    p.onchange = (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      const slot = e.target.closest('.slot');
      const colorKey = slot?.dataset.color;
      const sel = colorKey ? state.setup[colorKey] : null;
      if (!sel) return;
      if (act === 'kind') sel.kind = e.target.value;
      if (act === 'level') sel.level = e.target.value;
      if (act === 'provider') { sel.providerId = e.target.value; sel.modelId = ''; }
      if (act === 'model') sel.modelId = e.target.value;
      persistSetup();
      renderSetup();
    };
    p.onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'start') startGame();
      if (act === 'swap') {
        const b = state.setup.black;
        state.setup.black = state.setup.white;
        state.setup.white = b;
        persistSetup();
        renderSetup();
      }
      if (act === 'copy-white') {
        state.setup.white = JSON.parse(JSON.stringify(state.setup.black));
        persistSetup();
        renderSetup();
      }
      if (act === 'copy-black') {
        state.setup.black = JSON.parse(JSON.stringify(state.setup.white));
        persistSetup();
        renderSetup();
      }
    };
  }

  function persistSetup() {
    saveUiPrefs({ setup: state.setup });
  }

  // ---------------- 选手构建 ----------------
  function buildPlayer(color, sel) {
    const key = color === BLACK ? 'black' : 'white';
    if (sel.kind === 'human') return { kind: 'human', name: t('arena.humanPlayer', { side: uiSide(color) }), color };
    if (sel.kind === 'engine') {
      return { kind: 'engine', name: t('arena.enginePlayer', { level: arenaLevel(sel.level || 'medium') }), level: sel.level || 'medium', color };
    }
    const prov = providers().find((p) => p.id === sel.providerId);
    if (!prov) {
      toast(t('arena.needProvider'), { type: 'warn' });
      return null;
    }
    const model = (prov.models || []).find((m) => m.id === sel.modelId) || prov.models?.[0];
    if (!model) {
      toast(t('arena.providerNoModel', { name: prov.name }), { type: 'warn' });
      return null;
    }
    return {
      kind: 'llm',
      name: model.name || model.id,
      providerName: prov.name,
      provider: JSON.parse(JSON.stringify(prov)),
      model: JSON.parse(JSON.stringify(model)),
      color,
      _key: key,
    };
  }

  // 人类玩家名字按当前语言动态生成，避免切换语言后仍停留在旧语言
  function displayName(color) {
    const s = state.session;
    const p = s?.player(color);
    if (!p) return uiSide(color);
    if (p.kind === 'human') {
      const orig = state.originals[color];
      return orig && orig.kind !== 'human'
        ? t('arena.takeoverHumanName', { side: uiSide(color) })
        : t('arena.humanPlayer', { side: uiSide(color) });
    }
    return p.name;
  }

  // ---------------- 选手面板 ----------------
  function panelHtml(color) {
    const s = state.session;
    if (!s) {
      return `<div class="kv"><span class="k">${uiSide(color)}</span><span class="v">${t('arena.panelStartsAfter')}</span></div>`;
    }
    const p = s.player(color);
    const kindName = t(`arena.kind.${p.kind}`);
    const sub = p.kind === 'llm'
      ? `${p.providerName || p.provider?.name || ''} · ${p.model?.id || ''}`
      : p.kind === 'engine' ? t('arena.engineLevelSub', { level: arenaLevel(p.level || 'medium') }) : t('arena.humanSub');
    return `
      <div class="pp-head">
        <span class="slot-dot ${color === BLACK ? 'black' : 'white'}"></span>
        <div style="min-width:0">
          <div class="pp-name">${displayName(color)}</div>
          <div class="pp-model">${sub}</div>
        </div>
        <span class="pp-badge">${kindName}</span>
        <span class="pp-status" data-live="status"><span class="status-dot"></span></span>
      </div>
      <div class="pp-current hint" data-live="current" style="display:none;margin-top:10px;font-size:12px;color:var(--text-dim)"></div>
      <div class="pp-stats">
        <div class="stat"><div class="s-label">${t('arena.stat.time')}</div><div class="s-value" data-stat="time">—</div></div>
        <div class="stat"><div class="s-label">${t('arena.stat.tokens')}</div><div class="s-value" data-stat="tokens">—</div></div>
        <div class="stat"><div class="s-label">${t('arena.stat.tps')}</div><div class="s-value" data-stat="tps">—</div></div>
        <div class="stat"><div class="s-label">${t('arena.stat.ttft')}</div><div class="s-value small" data-stat="ttft">—</div></div>
      </div>
      <div class="stream" data-stream>
        <div class="stream-head" data-act="toggle-stream"><span class="chev">▶</span> <span>${t('arena.thinking')}</span> <span class="dim" data-live="stream-meta"></span></div>
        <div class="stream-tabs">
          <button class="stab active" data-tab="reasoning">${t('arena.tabReasoning')}</button>
          <button class="stab" data-tab="answer">${t('arena.tabAnswer')}</button>
          <button class="stab" data-tab="prompt">${t('arena.tabPrompt')}</button>
        </div>
        <div class="stream-body" data-pane="reasoning"></div>
        <div class="stream-body" data-pane="answer" hidden></div>
        <div class="stream-body" data-pane="prompt" hidden></div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn ghost sm" data-act="takeover">
          ${p.kind === 'human' && state.originals[color] ? t('arena.restoreAi') : t('arena.takeover')}
        </button>
      </div>`;
  }

  function renderPanel(color) {
    const pane = $(color === BLACK ? 'pp-black' : 'pp-white');
    const s = state.session;
    const p = s?.player(color);
    const pid = p ? `${p.kind}:${p.name}:${p.model?.id || p.level || ''}` : 'none';
    pane.dataset.color = color;
    pane.classList.toggle('active', !!s && s.turn === color && ['thinking', 'human', 'playing'].includes(s.status));
    if (pane.dataset.pid === pid) {
      updatePanelStats(color);
      return; // 同一选手：保留思考流内容，只刷新数字
    }
    pane.dataset.pid = pid;
    pane.innerHTML = panelHtml(color);
    const streamEl = pane.querySelector('[data-stream]');
    if (streamEl && state.streams[color]?.open) streamEl.classList.add('open');
    pane.querySelector('[data-act="toggle-stream"]')?.addEventListener('click', () => {
      const st = state.streams[color];
      if (st) st.open = !st.open;
      streamEl.classList.toggle('open', !!st?.open);
    });
    pane.querySelectorAll('.stab').forEach((btn) => {
      btn.addEventListener('click', () => {
        pane.querySelectorAll('.stab').forEach((b) => b.classList.toggle('active', b === btn));
        pane.querySelectorAll('[data-pane]').forEach((pv) => { pv.hidden = pv.dataset.pane !== btn.dataset.tab; });
      });
    });
    pane.querySelector('[data-act="takeover"]')?.addEventListener('click', () => toggleTakeover(color));
    updatePanelStats(color);
  }

  function refreshActivePanels() {
    const s = state.session;
    for (const color of [BLACK, WHITE]) {
      const pane = $(color === BLACK ? 'pp-black' : 'pp-white');
      pane.classList.toggle('active', !!s && s.turn === color && ['thinking', 'human', 'playing'].includes(s.status));
    }
  }

  function updatePanelStats(color) {
    const s = state.session;
    const pane = $(color === BLACK ? 'pp-black' : 'pp-white');
    if (!s || !pane) return;
    const totals = computeTotals(s.moves)[color];
    const set = (k, v) => {
      const node = pane.querySelector(`[data-stat="${k}"]`);
      if (node) node.textContent = v;
    };
    set('time', totals.moves ? fmtMs(totals.totalMs) : '—');
    set('tokens', totals.totalTokens ? fmtNum(totals.totalTokens) : (totals.completionTokens ? fmtNum(totals.completionTokens) + '+' : '—'));
    set('tps', fmtTps(totals.avgTps));
    set('ttft', totals.avgTtftMs != null ? fmtMs(totals.avgTtftMs) : '—');
  }

  function updateStatusUI() {
    const s = state.session;
    const dot = $('status-dot');
    const text = $('status-text');
    const pauseBtn = $('btn-pause');
    const stopThinkBtn = $('btn-stop-think');
    if (!s) {
      dot.className = 'status-dot';
      text.textContent = t('arena.statusIdle');
      pauseBtn.disabled = true;
      stopThinkBtn.disabled = true;
      $('btn-undo').disabled = true;
      $('btn-stop').disabled = true;
      return;
    }
    const st = s.status;
    dot.className = `status-dot ${st === 'thinking' ? 'thinking' : st === 'human' ? 'human' : st === 'paused' ? 'paused' : st === 'ended' ? 'ended' : ''}`;
    const turnName = s.player(s.turn)?.name || uiSide(s.turn);
    text.textContent = {
      playing: t('arena.status.playing', { side: uiSide(s.turn) }),
      thinking: t('arena.status.thinking', { name: turnName }),
      human: t('arena.status.human', { name: turnName }),
      paused: t('arena.status.paused'),
      ended: t('arena.status.ended'),
      idle: t('arena.statusIdle'),
    }[st] || t('arena.statusIdle');
    pauseBtn.disabled = !['playing', 'thinking', 'human', 'paused'].includes(st);
    pauseBtn.textContent = st === 'paused' ? t('arena.btnResume') : t('arena.btnPause');
    stopThinkBtn.disabled = st !== 'thinking';
    $('btn-undo').disabled = !(['paused', 'ended'].includes(st) && s.moves.length);
    $('btn-stop').disabled = st === 'ended';
    $('btn-start').disabled = !(['idle', 'ended'].includes(st));
    $('btn-start').textContent = st === 'ended' ? t('arena.rematch') : t('arena.btnStart');
  }

  // ---------------- 走子记录 ----------------
  // 展开查看本轮实际发给 AI 的完整提示词（system + user），便于人工核对
  function promptHtml(m) {
    const msgs = m.messages;
    if (!Array.isArray(msgs) || !msgs.length) return '';
    const blocks = msgs
      .map((x) => `<div class="pp-role">${x.role === 'system' ? t('arena.promptSystem') : t('arena.promptUser')}</div><pre class="prompt-block">${escapeHtml(x.content)}</pre>`)
      .join('');
    return `
      <div class="prompt-view">
        <button class="btn ghost sm" data-act="toggle-prompt" data-show="${t('arena.viewPrompt')}" data-hide="${t('arena.hidePrompt')}">${t('arena.viewPrompt')}</button>
        <div class="prompt-body" hidden>${blocks}</div>
      </div>`;
  }

  function moveDetailHtml(m) {
    const mt = m.metrics || {};
    const tags = [];
    if (m.type === 'llm') tags.push(`<span class="tag">TTFT ${mt.ttftMs != null ? fmtMs(mt.ttftMs) : '—'}</span>`);
    if (mt.promptTokens != null) tags.push(`<span class="tag">${t('arena.detail.input', { n: fmtNum(mt.promptTokens) })}</span>`);
    if (mt.completionTokens != null) tags.push(`<span class="tag">${t('arena.detail.output', { n: fmtNum(mt.completionTokens) })}${mt.estimated ? '≈' : ''}</span>`);
    if (mt.cachedTokens) tags.push(`<span class="tag">${t('arena.detail.cached', { n: fmtNum(mt.cachedTokens) })}</span>`);
    if (mt.promptTps) tags.push(`<span class="tag">Prompt ${mt.promptTps.toFixed(0)} tok/s</span>`);
    if (mt.draftN) tags.push(`<span class="tag">${t('arena.detail.mtp', { n: mt.draftN, a: mt.draftAccepted ?? 0 })}</span>`);
    if (mt.fallback) tags.push(`<span class="tag warn">${t('arena.detail.fallback')}</span>`);
    if (m.source === 'engine') tags.push(`<span class="tag">${t('arena.detail.engine')}</span>`);
    const errs = (m.attempts || []).map((a) => `<span class="tag bad">${(a.error || '').slice(0, 60)}</span>`).join('');
    const reasoning = m.thought?.reasoning || '';
    const answer = m.thought?.content || '';
    const failRaw = (!answer && (m.attempts || []).length) ? m.attempts.map((a) => a.raw || '').filter(Boolean).join('\n---\n') : '';
    const errText = m.thought?.error ? `[ERROR] ${m.thought.error}` : '';
    return `
      <div>${m.reason ? t('arena.detail.reason', { text: escapeHtml(m.reason) }) : ''}</div>
      ${reasoning || errText ? `<div class="dlabel">${t('arena.tabReasoning')}</div><div class="thought">${escapeHtml(reasoning || errText)}</div>` : ''}
      ${answer || failRaw ? `<div class="dlabel">${t('arena.tabAnswer')}</div><div class="thought">${escapeHtml(answer || failRaw)}</div>` : ''}
      <div class="tags">${tags.join('')}${errs}</div>
      ${promptHtml(m)}`;
  }

  function renderLog() {
    const s = state.session;
    const panel = $('log-panel');
    panel.innerHTML = `
      <div style="padding:12px 16px 4px;border:none" class="section-title">${t('arena.moveLog')} <span class="tail num dim" style="font-size:11px" id="log-count"></span></div>
      <div class="move-log" id="move-log"></div>`;
    const log = panel.querySelector('#move-log');
    if (s) for (const m of s.moves.slice().reverse()) appendMoveRow(m, log);
    updateLogHeader();
  }

  function updateLogHeader() {
    const s = state.session;
    const panel = $('log-panel');
    const count = panel.querySelector('#log-count');
    const n = s?.moves.length || 0;
    if (count) count.textContent = n ? t('arena.moveCount', { n }) : '';
    panel.hidden = !n;
  }

  function appendMoveRow(m, logEl = null) {
    let log = logEl || $('log-panel').querySelector('#move-log');
    if (!log) {
      renderLog();
      log = $('log-panel').querySelector('#move-log');
    }
    if (!log) return;
    const mt = m.metrics || {};
    const row = document.createElement('div');
    row.className = 'mlog-row';
    row.innerHTML = `
      <span class="n">#${m.n}</span>
      <span class="mlog-round-dot ${m.color === BLACK ? 'black' : 'white'}"></span>
      <span class="coord">${m.label}${m.source === 'fallback' ? ` <span class="tag warn" style="font-size:9px">${t('arena.fallbackTag')}</span>` : ''}</span>
      <span class="metric">${mt.latencyMs != null ? fmtMs(mt.latencyMs) : '—'}</span>
      <span class="metric">${mt.completionTokens != null ? fmtNum(mt.completionTokens) + ' tok' : '—'}</span>
      <span class="metric">${fmtTps(mt.decodeTps)}</span>
      <span class="chev">▶</span>`;
    const detail = document.createElement('div');
    detail.className = 'mlog-detail';
    detail.innerHTML = moveDetailHtml(m);
    const pbtn = detail.querySelector('[data-act="toggle-prompt"]');
    if (pbtn) pbtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const body = detail.querySelector('.prompt-body');
      if (!body) return;
      body.hidden = !body.hidden;
      pbtn.textContent = body.hidden ? pbtn.dataset.show : pbtn.dataset.hide;
    });
    row.addEventListener('click', () => row.classList.toggle('open'));
    log.prepend(detail);
    log.prepend(row);
    return { row, detail };
  }

  // ---------------- 思考流 ----------------
  function resetStream(color) {
    state.streams[color] = { open: state.streams[color]?.open ?? false, text: '', answer: '', promptSent: null, tokens: 0, startedAt: null, firstDeltaAt: null, dirty: false };
    clearStream(color);
  }

  // 清空某个面板的三个内容区，避免新回合开始时残留上一轮内容
  function clearStream(color) {
    const pane = $(color === BLACK ? 'pp-black' : 'pp-white');
    if (!pane) return;
    for (const k of ['reasoning', 'answer', 'prompt']) {
      const pv = pane.querySelector(`[data-pane="${k}"]`);
      if (pv) pv.textContent = '';
    }
    const meta = pane.querySelector('[data-live="stream-meta"]');
    if (meta) meta.textContent = '';
  }

  function formatPrompt(messages) {
    return (Array.isArray(messages) && messages.length)
      ? messages.map((m) => `===== ${m.role} =====\n${m.content}`).join('\n\n')
      : '';
  }

  function setPromptPane(color, messages) {
    const pane = $(color === BLACK ? 'pp-black' : 'pp-white');
    if (!pane) return;
    const pv = pane.querySelector('[data-pane="prompt"]');
    if (pv) pv.textContent = formatPrompt(messages);
  }

  function onDelta({ color, type, text }) {
    const st = state.streams[color];
    if (!st) return;
    if (!st.startedAt) st.startedAt = performance.now();
    if (!st.firstDeltaAt) st.firstDeltaAt = performance.now();
    const isAnswer = type === 'content';
    if (isAnswer) st.answer += text; else st.text += text;
    st.tokens = estimateTokens(`${st.text}${st.answer}`);
    if (!st.dirty) {
      st.dirty = true;
      requestAnimationFrame(() => {
        st.dirty = false;
        const pane = $(color === BLACK ? 'pp-black' : 'pp-white');
        if (!pane) return;
        const target = pane.querySelector(`[data-pane="${isAnswer ? 'answer' : 'reasoning'}"]`);
        if (target) {
          target.textContent = isAnswer ? st.answer : st.text;
          const cursor = document.createElement('span');
          cursor.className = 'cursor';
          target.appendChild(cursor);
          target.scrollTop = target.scrollHeight;
        }
        const meta = pane.querySelector('[data-live="stream-meta"]');
        if (meta) meta.textContent = t('arena.generating', { n: fmtNum(st.tokens) });
      });
    }
  }

  function finalizeStream(color, rec) {
    const st = state.streams[color];
    const pane = $(color === BLACK ? 'pp-black' : 'pp-white');
    if (!st || !pane) return;
    const mt = rec?.metrics || {};
    const th = rec?.thought || {};
    const reasoning = th.reasoning || '';
    const answer = th.content || '';
    const errText = th.error ? `[ERROR] ${th.error}` : '';
    const attemptText = (rec?.attempts || []).map((a) => a.raw || a.error || '').filter(Boolean).join('\n---\n');
    const rPane = pane.querySelector('[data-pane="reasoning"]');
    const aPane = pane.querySelector('[data-pane="answer"]');
    const pPane = pane.querySelector('[data-pane="prompt"]');
    if (rPane) rPane.textContent = reasoning || errText || (answer ? '' : st.text);
    if (aPane) aPane.textContent = answer || attemptText;
    if (rec?.messages) st.promptSent = rec.messages;
    if (pPane) pPane.textContent = formatPrompt(st.promptSent);
    const meta = pane.querySelector('[data-live="stream-meta"]');
    if (meta && rec?.metrics) {
      meta.textContent = `${fmtMs(mt.latencyMs)} · ${fmtNum(mt.completionTokens ?? st.tokens)} tok · ${fmtTps(mt.decodeTps)}`;
    }
  }

  // ---------------- 实时刷新（计时器，200ms 一跳） ----------------
  function liveTick() {
    if (!el.classList.contains('active')) return; // 其他页面时不做无谓刷新
    const s = state.session;
    if (s && ['thinking', 'human'].includes(s.status) && s.currentStartedAt) {
      const elapsed = Date.now() - s.currentStartedAt;
      const color = s.turn;
      const pane = $(color === BLACK ? 'pp-black' : 'pp-white');
      const cur = pane?.querySelector('[data-live="current"]');
      if (cur) {
        cur.style.display = '';
        const st = state.streams[color];
        const stElapsed = st?.firstDeltaAt ? performance.now() - st.firstDeltaAt : 0;
        const tps = st?.tokens && stElapsed > 300 ? st.tokens / (stElapsed / 1000) : null;
        cur.innerHTML = s.status === 'human'
          ? t('arena.waitingMove', { t: `<span class="num">${fmtMs(elapsed)}</span>` })
          : t('arena.currentStep', { t: `<span class="num">${fmtMs(elapsed)}</span>` }) + (st?.tokens ? ` · <span class="num">${fmtNum(st.tokens)}</span> tok` : '') + (tps ? ` · <span class="num">${fmtTps(tps)}</span>` : '');
      }
      const sdot = pane?.querySelector('.pp-status');
      if (sdot && sdot.dataset.state !== s.status) {
        sdot.dataset.state = s.status;
        sdot.innerHTML = `<span class="status-dot ${s.status === 'human' ? 'human' : 'thinking'}"></span>${s.status === 'human' ? t('arena.statusDot.human') : t('arena.statusDot.thinking')}`;
      }
    }
    if (s?.startedAt && s.status !== 'idle') {
      const end = s.endedAt || Date.now();
      $('elapsed-text').textContent = fmtMs(end - s.startedAt);
    }
  }
  state.tick = setInterval(liveTick, 200);

  // ---------------- 对局控制 ----------------
  function updateHeader() {
    const s = state.session;
    const title = $('match-title');
    const meta = $('match-meta');
    if (!s) {
      title.textContent = t('arena.matchTitleIdle');
      meta.textContent = t('arena.metaIdle', { size: state.settings.size });
      return;
    }
    title.textContent = `${displayName(BLACK)}  vs  ${displayName(WHITE)}`;
    const r = s.result;
    meta.textContent = r
      ? t('arena.headerResult', { res: r.winner ? t('arena.win', { side: uiSide(r.winner) }) : t('arena.draw'), n: s.moves.length, t: fmtMs((s.endedAt || Date.now()) - s.startedAt) })
      : t('arena.headerPlaying', { n: s.moves.length + 1, t: fmtMs(Date.now() - s.startedAt) });
  }

  function startGame() {
    const black = buildPlayer(BLACK, state.setup.black);
    const white = buildPlayer(WHITE, state.setup.white);
    if (!black || !white) return;
    if (state.session && !['idle', 'ended'].includes(state.session.status)) return;

    const s = new GameSession({ black, white, settings: state.settings });
    state.session = s;
    state.originals = { [BLACK]: black, [WHITE]: white };
    resetStream(BLACK);
    resetStream(WHITE);
    for (const id of ['pp-black', 'pp-white']) $(id).dataset.pid = '';
    board.setSize(state.settings.size);
    board.reset();
    board.setInteractive(true);
    renderLog();
    $('setup-panel').hidden = true;

    s.on('status', () => {
      updateStatusUI();
      renderPanel(BLACK);
      renderPanel(WHITE);
      board.setHumanTurn(s.status === 'human' && s.player(s.turn)?.kind === 'human');
    });
    s.on('turn', (ev) => {
      resetStream(ev.color);
      $('match-meta') && updateHeader();
    });
    s.on('request', ({ color, messages }) => {
      if (state.streams[color]) state.streams[color].promptSent = messages;
      setPromptPane(color, messages);
    });
    s.on('delta', onDelta);
    s.on('move', (rec) => {
      board.applyMove(rec);
      board.setHumanTurn(false);
      finalizeStream(rec.color, rec);
      appendMoveRow(rec);
      updateLogHeader();
      refreshActivePanels();
      updatePanelStats(rec.color);
      updateHeader();
      scheduleSave();
    });
    s.on('winline', (w) => board.showWin(w.line));
    s.on('undo', ({ removed }) => {
      for (const rec of removed) board.removeLastStone(rec);
      board.clearWin();
      board.hideResult();
      renderLog();
      updatePanelStats(BLACK);
      updatePanelStats(WHITE);
      updateHeader();
      updateStatusUI();
      refreshActivePanels();
      scheduleSave();
    });
    s.on('warn', ({ color, message }) => toast(t('arena.warnMsg', { side: uiSide(color), msg: message }), { type: 'warn', title: t('arena.warnTitle') }));
    s.on('abnormal', ({ color, error, fallback, attempts, messages }) => {
      // 即使失败也把「思考 / 回答 / 提示词」留在面板里，便于人工核对
      finalizeStream(color, { type: 'llm', thought: { error: error?.message, code: error?.code }, attempts, messages });
      toast(t('arena.abnormalMsg', { side: uiSide(color), error: error?.message || '', fallback: fallback ? t('arena.fallbackHandled') : '' }), { type: 'bad', title: t('arena.abnormalTitle') });
    });
    s.on('end', (result) => {
      board.setHumanTurn(false);
      const winnerName = result.winner ? displayName(result.winner) : null;
      const REASON_KEY = { five: 'arena.reason.five', full: 'arena.reason.full', timeout: 'arena.reason.timeout', illegal: 'arena.reason.illegal', request: 'arena.reason.request', manual: 'arena.reason.manual', engine_fallback_over: 'arena.reason.engineFallbackOver' };
      const reasonText = REASON_KEY[result.reason] ? t(REASON_KEY[result.reason]) : result.reason;
      board.showResult(`
        <div class="result-label">${result.winner ? t('arena.resultWin', { side: uiSide(result.winner) }) : t('arena.matchEnded')}</div>
        <div class="result-name ${result.winner === BLACK ? 'black-win' : result.winner === WHITE ? 'white-win' : 'draw'}">${winnerName || t('arena.draw')}</div>
        <div class="result-reason">${reasonText} · ${t('arena.moveCount', { n: s.moves.length })} · ${fmtMs(s.endedAt - s.startedAt)}</div>
        <div class="result-actions">
          <button class="btn primary" data-act="restart">${t('arena.rematch')}</button>
          <a class="btn ghost" href="#/history">${t('arena.viewHistory')}</a>
        </div>`);
      board.el.querySelector('[data-act="restart"]')?.addEventListener('click', () => {
        board.hideResult();
        startGame();
      });
      updateHeader();
      updateStatusUI();
      refreshActivePanels();
      $('setup-panel').hidden = false;
      renderSetup();
      saveNow();
      toast(result.winner ? t('arena.toastWinner', { winner: winnerName, reason: reasonText }) : t('arena.matchEnded'), { type: 'good', title: t('arena.matchEnded') });
    });

    renderPanel(BLACK);
    renderPanel(WHITE);
    updateStatusUI();
    updateHeader();
    s.start();
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, 600);
  }

  async function saveNow() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    const s = state.session;
    if (!s || !s.startedAt) return;
    try {
      await saveGame(s.snapshot());
    } catch (e) {
      console.warn('保存对局失败', e);
    }
  }

  function toggleTakeover(color) {
    const s = state.session;
    if (!s) return;
    const cur = s.player(color);
    if (cur.kind === 'human' && state.originals[color]) {
      s.setPlayer(color, state.originals[color]);
      toast(t('arena.takeoverRestored', { side: uiSide(color), name: state.originals[color].name }), { type: 'good' });
    } else {
      state.originals[color] = cur;
      s.setPlayer(color, { kind: 'human', name: t('arena.takeoverHumanName', { side: uiSide(color) }), color });
      toast(t('arena.takeoverDone', { side: uiSide(color) }), { type: 'info' });
    }
    renderPanel(color);
    updateHeader();
  }

  function openSettingsModal() {
    const s = state.settings;
    const { close } = openModal(`
      <h3>${t('arena.settings.title')}</h3>
      <div class="form-grid">
        <label class="field"><span class="lbl">${t('arena.settings.boardSize')}</span>
          <select id="set-size">${[13, 15, 19].map((n) => `<option value="${n}" ${s.size === n ? 'selected' : ''}>${n} × ${n}</option>`).join('')}</select>
          <span class="hint">${t('arena.settings.boardSizeHint')}</span>
        </label>
        <label class="field"><span class="lbl">${t('arena.settings.timeout')}</span>
          <input type="number" id="set-timeout" min="10" max="3600" value="${Math.round(s.moveTimeoutMs / 1000)}">
          <span class="hint">${t('arena.settings.timeoutHint')}</span>
        </label>
        <label class="field"><span class="lbl">${t('arena.settings.retries')}</span>
          <input type="number" id="set-retries" min="0" max="20" value="${s.illegalRetries}">
        </label>
        <label class="field"><span class="lbl">${t('arena.settings.abnormal')}</span>
          <select id="set-abnormal">
            <option value="fallback" ${s.onAbnormal === 'fallback' ? 'selected' : ''}>${t('arena.settings.abnormalFallback')}</option>
            <option value="forfeit" ${s.onAbnormal === 'forfeit' ? 'selected' : ''}>${t('arena.settings.abnormalForfeit')}</option>
          </select>
        </label>
        <label class="field" style="display:flex;align-items:flex-end">
          <span class="switch"><input type="checkbox" id="set-thinking" ${s.thinking ? 'checked' : ''}><span class="track"></span>${t('arena.settings.thinking')}</span>
        </label>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" data-x="cancel">${t('common.close')}</button>
        <button class="btn primary" data-x="save">${t('common.save')}</button>
      </div>`, {
      onMount(modal, closeFn) {
        modal.querySelector('[data-x="cancel"]').onclick = () => closeFn();
        modal.querySelector('[data-x="save"]').onclick = () => {
          state.settings = {
            ...state.settings,
            size: Number(modal.querySelector('#set-size').value),
            moveTimeoutMs: Math.max(10, Number(modal.querySelector('#set-timeout').value) || 600) * 1000,
            illegalRetries: Math.max(0, Number(modal.querySelector('#set-retries').value) || 0),
            onAbnormal: modal.querySelector('#set-abnormal').value,
            thinking: modal.querySelector('#set-thinking').checked,
          };
          saveGameSettings(state.settings);
          // 无进行中的对局时，立即按新尺寸刷新棋盘
          if (!state.session || ['idle', 'ended'].includes(state.session.status)) {
            board.setSize(state.settings.size);
            board.reset();
          }
          renderSetup();
          updateHeader();
          toast(t('arena.settings.saved'), { type: 'good' });
          closeFn();
        };
      },
    });
  }

  // ---------------- 控制按钮 ----------------
  $('btn-start').addEventListener('click', startGame);
  $('btn-pause').addEventListener('click', () => {
    const s = state.session;
    if (!s) return;
    if (s.status === 'paused') s.resume();
    else s.pause();
    updateStatusUI();
  });
  $('btn-stop-think').addEventListener('click', () => {
    const s = state.session;
    if (s && s.stopThinking()) toast(t('arena.stoppedToast'), { type: 'info' });
  });
  $('btn-undo').addEventListener('click', () => {
    const s = state.session;
    if (!s) return;
    if (!['paused', 'ended'].includes(s.status)) {
      s.pause();
      updateStatusUI();
      toast(t('arena.undoPaused'), { type: 'info' });
      return;
    }
    const n = s.undo(1);
    if (!n) toast(t('arena.undoNone'), { type: 'warn' });
  });
  $('btn-stop').addEventListener('click', async () => {
    const s = state.session;
    if (!s || s.status === 'ended') return;
    if (await confirmDialog({ title: t('arena.stop.title'), text: t('arena.stop.text'), confirmText: t('arena.stop.confirm'), danger: true })) {
      s.stop();
      saveNow();
    }
  });
  $('btn-settings').addEventListener('click', openSettingsModal);

  window.addEventListener('beforeunload', (e) => {
    const s = state.session;
    if (s && ['playing', 'thinking', 'human'].includes(s.status)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------------- 对外 ----------------
  renderSetup();
  renderPanel(BLACK);
  renderPanel(WHITE);
  updateStatusUI();
  updateHeader();

  return {
    el,
    show() {
      if (!state.session || state.session.status === 'ended') renderSetup();
    },
    rerender() {
      applyStaticI18n(el);
      if (!state.session || state.session.status === 'ended') renderSetup();
      for (const id of ['pp-black', 'pp-white']) $(id).dataset.pid = '';
      renderPanel(BLACK);
      renderPanel(WHITE);
      for (const color of [BLACK, WHITE]) {
        const st = state.streams[color];
        const pane = $(color === BLACK ? 'pp-black' : 'pp-white');
        if (!st) continue;
        const rp = pane.querySelector('[data-pane="reasoning"]');
        const ap = pane.querySelector('[data-pane="answer"]');
        const pp = pane.querySelector('[data-pane="prompt"]');
        if (rp && st.text) rp.textContent = st.text;
        if (ap && st.answer) ap.textContent = st.answer;
        if (pp && st.promptSent) pp.textContent = formatPrompt(st.promptSent);
      }
      renderLog();
      updateStatusUI();
      updateHeader();
    },
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}