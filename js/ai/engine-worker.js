// 传统算法 Worker：在后台线程执行搜索，避免阻塞界面
import { Board } from '../core/board.js';
import { chooseMove } from './engine.js';

self.onmessage = (e) => {
  const { taskId, size, cells, moves, color, level, budgetMs } = e.data || {};
  try {
    const board = new Board(size);
    board.cells = Uint8Array.from(cells);
    board.moves = moves.map((m, i) => ({ ...m, n: i + 1 }));
    const move = chooseMove(board, color, level, { budgetMs });
    self.postMessage({ taskId, move });
  } catch (err) {
    self.postMessage({ taskId, move: null, error: String(err?.message || err) });
  }
};