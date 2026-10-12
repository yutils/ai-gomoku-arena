// 棋盘渲染组件（对战台与回放共用）
import { BLACK, WHITE } from '../core/board.js';

const STAR_RATIOS = {
  15: [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]],
  13: [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]],
  19: [[3, 3], [3, 9], [3, 15], [9, 3], [9, 9], [9, 15], [15, 3], [15, 9], [15, 15]],
};

export function createBoardView(host, { size = 15, onCellClick = null } = {}) {
  let n = size;
  let cellEls = [];
  const state = { lastMove: null, winLine: null, humanTurn: false, interactive: true };

  const wrap = document.createElement('div');
  wrap.className = 'board-wrap';
  wrap.innerHTML = `
    <div class="board-corner"></div>
    <div class="board-col-labels"></div>
    <div class="board-row-labels"></div>
    <div class="board">
      <div class="board-lines"></div>
      <div class="board-stars"></div>
      <div class="board-cells"></div>
      <svg class="board-svg" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
      <div class="board-result" hidden><div class="result-box"></div></div>
    </div>`;
  host.appendChild(wrap);

  const boardEl = wrap.querySelector('.board');
  const cellsEl = wrap.querySelector('.board-cells');
  const starsEl = wrap.querySelector('.board-stars');
  const svgEl = wrap.querySelector('.board-svg');
  const colLabels = wrap.querySelector('.board-col-labels');
  const rowLabels = wrap.querySelector('.board-row-labels');
  const resultEl = wrap.querySelector('.board-result');

  function build() {
    boardEl.style.setProperty('--n', n);
    cellsEl.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    cellsEl.style.gridTemplateRows = `repeat(${n}, 1fr)`;
    colLabels.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    rowLabels.style.gridTemplateRows = `repeat(${n}, 1fr)`;
    cellsEl.innerHTML = '';
    cellEls = [];
    for (let r = 0; r < n; r++) {
      const row = [];
      for (let c = 0; c < n; c++) {
        const cell = document.createElement('button');
        cell.className = 'cell empty';
        cell.type = 'button';
        cell.dataset.r = r;
        cell.dataset.c = c;
        cell.addEventListener('click', () => {
          if (state.interactive && state.humanTurn) onCellClick?.(r, c);
        });
        cellsEl.appendChild(cell);
        row.push(cell);
      }
      cellEls.push(row);
    }
    colLabels.innerHTML = Array.from({ length: n }, (_, c) => `<span>${String.fromCharCode(65 + c)}</span>`).join('');
    rowLabels.innerHTML = Array.from({ length: n }, (_, r) => `<span>${n - r}</span>`).join('');
    const stars = STAR_RATIOS[n] || [[Math.floor(n / 2), Math.floor(n / 2)]];
    starsEl.innerHTML = stars
      .map(([r, c]) => `<i style="left:${((c + 0.5) / n) * 100}%;top:${((r + 0.5) / n) * 100}%"></i>`)
      .join('');
    svgEl.innerHTML = '';
    state.lastMove = null;
    state.winLine = null;
  }

  function pct(v) {
    return ((v + 0.5) / n) * 100;
  }

  function applyMove(move, { animate = true } = {}) {
    const cell = cellEls[move.r]?.[move.c];
    if (!cell) return;
    if (!cell.querySelector('.stone')) {
      const stone = document.createElement('span');
      stone.className = `stone ${move.color === BLACK ? 'black' : 'white'}${animate ? '' : ' no-anim'}`;
      cell.appendChild(stone);
    }
    cell.classList.remove('empty');
    setLast(move);
  }

  function setLast(move) {
    if (state.lastMove) cellEls[state.lastMove.r]?.[state.lastMove.c]?.classList.remove('last');
    state.lastMove = move || null;
    if (move) cellEls[move.r]?.[move.c]?.classList.add('last');
  }

  function removeLastStone(move) {
    const cell = cellEls[move.r]?.[move.c];
    if (!cell) return;
    cell.querySelector('.stone')?.remove();
    cell.classList.remove('last', 'win');
    cell.classList.add('empty');
    if (state.lastMove && state.lastMove.r === move.r && state.lastMove.c === move.c) state.lastMove = null;
  }

  function showWin(line) {
    state.winLine = line;
    for (const [r, c] of line) cellEls[r]?.[c]?.classList.add('win');
    const [r1, c1] = line[0];
    const [r2, c2] = line[line.length - 1];
    const x1 = pct(c1);
    const y1 = pct(r1);
    const x2 = pct(c2);
    const y2 = pct(r2);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) / 100 * n;
    // 两端略微延伸
    const ext = 0.35;
    const ex = (dx / len) * ext * (100 / n);
    const ey = (dy / len) * ext * (100 / n);
    svgEl.innerHTML = `<line x1="${x1 - ex}" y1="${y1 - ey}" x2="${x2 + ex}" y2="${y2 + ey}" style="--len:${(len + 0.7).toFixed(2)}"/>`;
  }

  function clearWin() {
    svgEl.innerHTML = '';
    if (state.winLine) {
      for (const [r, c] of state.winLine) cellEls[r]?.[c]?.classList.remove('win');
      state.winLine = null;
    }
  }

  function reset() {
    cellsEl.querySelectorAll('.stone').forEach((s) => s.remove());
    cellsEl.querySelectorAll('.cell').forEach((c) => {
      c.classList.remove('last', 'win');
      c.classList.add('empty');
    });
    state.lastMove = null;
    clearWin();
    resultEl.classList.remove('show');
  }

  function setHumanTurn(on) {
    state.humanTurn = !!on;
    boardEl.classList.toggle('human-turn', !!on);
  }

  function setInteractive(on) {
    state.interactive = !!on;
  }

  function showResult(html) {
    resultEl.querySelector('.result-box').innerHTML = html;
    resultEl.classList.add('show');
    resultEl.hidden = false;
  }

  function hideResult() {
    resultEl.classList.remove('show');
    resultEl.hidden = true;
  }

  build();

  return {
    el: wrap,
    boardEl,
    get size() { return n; },
    setSize(newSize) { n = newSize; build(); },
    applyMove,
    removeLastStone,
    setLast,
    showWin,
    clearWin,
    reset,
    setHumanTurn,
    setInteractive,
    showResult,
    hideResult,
  };
}