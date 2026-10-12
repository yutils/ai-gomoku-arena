// 传统五子棋算法引擎：三档难度
//  easy   - 从高分区随机选点，会下坏棋
//  medium - 贪心启发式（攻防评分）
//  hard   - 启发式 + Minimax Alpha-Beta 迭代加深（时间预算内）
import { opponent } from '../core/board.js';

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const FIVE = 10000000;
const OPEN_FOUR = 300000;
const FOUR = 25000;
const OPEN_THREE = 12000;
const BROKEN_THREE = 1500;
const OPEN_TWO = 800;
const BROKEN_TWO = 150;

// 以 (r,c) 为中心、假设该点落 color 子的 9 格窗口字符串：1=己方 2=对方/界外 0=空
function lineWindow(board, r, c, dr, dc, color) {
  let s = '';
  for (let k = -4; k <= 4; k++) {
    if (k === 0) {
      s += '1';
      continue;
    }
    const rr = r + dr * k;
    const cc = c + dc * k;
    if (!board.inBounds(rr, cc)) s += '2';
    else {
      const v = board.get(rr, cc);
      s += v === 0 ? '0' : v === color ? '1' : '2';
    }
  }
  return s;
}

const PATTERNS = [
  [['11111'], FIVE],
  [['011110'], OPEN_FOUR],
  [['211110', '011112', '11011', '10111', '11101'], FOUR],
  [['011100', '001110', '011010', '010110'], OPEN_THREE],
  [['211100', '001112', '211010', '010112', '210110', '011012', '10011', '11001', '10101'], BROKEN_THREE],
  [['001100', '010100', '001010'], OPEN_TWO],
  [['211000', '000112', '210100', '001012', '210010', '010012', '10001', '11000', '00011', '10100', '00101'], BROKEN_TWO],
];

function patternScore(s) {
  for (const [pats, score] of PATTERNS) {
    for (const p of pats) if (s.includes(p)) return score;
  }
  return s.includes('1') ? 10 : 0;
}

// 某个空点的进攻/防守价值
export function pointScore(board, r, c, color) {
  let atk = 0;
  let def = 0;
  const opp = opponent(color);
  for (const [dr, dc] of DIRS) {
    atk = Math.max(atk, patternScore(lineWindow(board, r, c, dr, dc, color)));
    def = Math.max(def, patternScore(lineWindow(board, r, c, dr, dc, opp)));
  }
  return { atk, def, total: atk + def * 0.85 };
}

// 候选空点：已有棋子附近 radius 格以内；空盘则取中心
export function candidates(board, radius = 2) {
  const size = board.size;
  if (!board.moves.length) return [{ r: size >> 1, c: size >> 1 }];
  const seen = new Set();
  const out = [];
  for (const m of board.moves) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const r = m.r + dr;
        const c = m.c + dc;
        if (!board.isEmpty(r, c)) continue;
        const k = r * size + c;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ r, c });
      }
    }
  }
  return out;
}

function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

function activeCells(board) {
  return candidates(board, 2);
}

function threatScore(board, color, cells) {
  let best = 0;
  let second = 0;
  for (const p of cells) {
    const s = pointScore(board, p.r, p.c, color).atk;
    if (s > best) {
      second = best;
      best = s;
    } else if (s > second) {
      second = s;
    }
  }
  return best + second * 0.25;
}

function evalBoard(board, me, cells) {
  return threatScore(board, me, cells) - 1.12 * threatScore(board, opponent(me), cells);
}

function negamax(board, turn, depth, alpha, beta, deadline, me) {
  if (Date.now() > deadline) return { val: 0, timeout: true };
  if (depth <= 0) return { val: evalBoard(board, me, activeCells(board)), timeout: false };
  const cands = candidates(board, 2)
    .map((p) => ({ ...p, s: pointScore(board, p.r, p.c, turn).total }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 8);
  let best = -Infinity;
  for (const mv of cands) {
    board.place(mv.r, mv.c, turn);
    let res;
    if (board.checkWin(mv.r, mv.c)) {
      res = { val: turn === me ? FIVE * 10 + depth * 1000 : -(FIVE * 10 + depth * 1000), timeout: false };
    } else {
      const sub = negamax(board, opponent(turn), depth - 1, -beta, -alpha, deadline, me);
      res = { val: -sub.val, timeout: sub.timeout };
    }
    board.undo();
    if (res.timeout) return res;
    if (res.val > best) best = res.val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  if (best === -Infinity) best = evalBoard(board, me, activeCells(board));
  return { val: best, timeout: false };
}

function searchRoot(board, me, depth, deadline) {
  const rootCands = candidates(board, 2)
    .map((p) => ({ ...p, s: pointScore(board, p.r, p.c, me).total }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 10);
  let bestMove = rootCands[0] || null;
  let bestVal = -Infinity;
  let alpha = -Infinity;
  for (const mv of rootCands) {
    if (Date.now() > deadline) return { move: bestMove, timeout: true };
    board.place(mv.r, mv.c, me);
    let res;
    if (board.checkWin(mv.r, mv.c)) {
      res = { val: FIVE * 100, timeout: false };
    } else {
      const sub = negamax(board, opponent(me), depth - 1, -Infinity, -alpha, deadline, me);
      res = { val: sub.val === -Infinity ? -Infinity : -sub.val, timeout: sub.timeout };
    }
    board.undo();
    if (res.timeout) return { move: bestMove, timeout: true };
    if (res.val > bestVal) {
      bestVal = res.val;
      bestMove = mv;
      alpha = res.val;
    }
  }
  return { move: bestMove, timeout: false };
}

function minimaxMove(board, color, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let best = null;
  for (const depth of [2, 4]) {
    const res = searchRoot(board, color, depth, deadline);
    if (res.move && (!res.timeout || !best)) best = res.move;
    if (res.timeout) break;
  }
  return best;
}

// 正式入口：返回 {r,c} 或 null（无处可下）
export function chooseMove(board, color, level = 'hard', opts = {}) {
  const cands = candidates(board, 2);
  if (!cands.length) return null;
  if (!board.moves.length) return { r: board.size >> 1, c: board.size >> 1 };

  const scored = cands.map((p) => ({ ...p, ...pointScore(board, p.r, p.c, color) }));

  // 通用优先级：自己成五 > 挡对方成五（所有档位都遵守，避免出现低级送分）
  const win = scored.filter((s) => s.atk >= FIVE);
  if (win.length) return pick(win);
  const block = scored.filter((s) => s.def >= FIVE);
  if (block.length) return pick(block);

  scored.sort((a, b) => b.total - a.total);

  if (level === 'easy') {
    if (Math.random() < 0.12) return pick(cands);
    return pick(scored.slice(0, Math.min(5, scored.length)));
  }

  if (level === 'medium') {
    const best = scored[0].total;
    const near = scored.filter((s) => s.total >= best * 0.9);
    return pick(near.slice(0, 3));
  }

  // hard
  const makeFour = scored.filter((s) => s.atk >= OPEN_FOUR);
  if (makeFour.length) return pick(makeFour);
  const stopFour = scored.filter((s) => s.def >= OPEN_FOUR);
  if (stopFour.length) return pick(stopFour);

  const budgetMs = opts.budgetMs ?? 1800;
  const mv = minimaxMove(board, color, budgetMs);
  return mv || pick(scored.slice(0, 3));
}

// ---- Worker 封装：优先在 Worker 中计算，避免阻塞 UI；失败则内联兜底 ----
let worker = null;
let workerBroken = false;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data?.taskId);
      if (p) {
        pending.delete(e.data.taskId);
        p.resolve(e.data.move);
      }
    };
    worker.onerror = () => {
      workerBroken = true;
      for (const p of pending.values()) p.reject(new Error('算法 Worker 异常'));
      pending.clear();
      try { worker?.terminate(); } catch { /* 忽略 */ }
      worker = null;
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

export async function chooseMoveAsync(board, color, level = 'hard', opts = {}) {
  const w = typeof Worker !== 'undefined' ? getWorker() : null;
  if (!w) return chooseMove(board, color, level, opts);
  const taskId = ++seq;
  try {
    return await new Promise((resolve, reject) => {
      pending.set(taskId, { resolve, reject });
      w.postMessage({
        taskId,
        size: board.size,
        cells: Array.from(board.cells),
        moves: board.moves.map((m) => ({ r: m.r, c: m.c, color: m.color })),
        color,
        level,
        budgetMs: opts.budgetMs,
      });
    });
  } catch {
    // Worker 异常（如 file:// 加载失败）：内联兜底计算
    pending.delete(taskId);
    return chooseMove(board, color, level, opts);
  }
}