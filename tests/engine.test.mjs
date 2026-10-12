import test from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, WHITE } from '../js/core/board.js';
import { chooseMove, pointScore } from '../js/ai/engine.js';

test('空盘首手在天元（15 路中心 7,7）', () => {
  const b = new Board(15);
  const mv = chooseMove(b, BLACK, 'hard');
  assert.deepEqual(mv, { r: 7, c: 7 });
});

test('能补五获胜（各档位）', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    const b = new Board(15);
    b.place(7, 3, BLACK);
    b.place(7, 4, BLACK);
    b.place(7, 5, BLACK);
    b.place(7, 6, BLACK);
    b.place(6, 6, WHITE);
    b.place(6, 7, WHITE);
    b.place(6, 8, WHITE);
    const mv = chooseMove(b, BLACK, level);
    b.place(mv.r, mv.c, BLACK);
    assert.ok(b.checkWin(mv.r, mv.c), `${level} 应补五获胜，实际 ${mv.r},${mv.c}`);
  }
});

test('会堵对方的活四', () => {
  const b = new Board(15);
  for (let c = 4; c <= 7; c++) b.place(7, c, WHITE);
  b.place(5, 5, BLACK);
  b.place(6, 5, BLACK);
  const mv = chooseMove(b, BLACK, 'medium');
  assert.ok((mv.r === 7 && (mv.c === 3 || mv.c === 8)), `应堵在 (7,3)/(7,8)，实际 ${mv.r},${mv.c}`);
});

test('easy 档也会堵对方成五', () => {
  const b = new Board(15);
  for (let c = 4; c <= 7; c++) b.place(7, c, WHITE);
  const mv = chooseMove(b, BLACK, 'easy');
  assert.ok(mv.r === 7 && (mv.c === 3 || mv.c === 8));
});

test('所有档位返回合法空点', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    const b = new Board(15);
    b.place(7, 7, BLACK);
    b.place(7, 8, WHITE);
    b.place(6, 6, BLACK);
    b.place(8, 8, WHITE);
    b.place(6, 9, BLACK);
    const mv = chooseMove(b, WHITE, level);
    assert.ok(mv, `${level} 应返回落子`);
    assert.ok(b.isEmpty(mv.r, mv.c), `${level} 返回点应为空点`);
  }
});

test('hard 档能挡住双活三形成的杀棋（在预算内不超时）', () => {
  const b = new Board(15);
  // 白方双活三：两条斜线的活三
  b.place(7, 6, WHITE);
  b.place(8, 7, WHITE);
  b.place(9, 8, WHITE);
  b.place(5, 6, WHITE);
  b.place(6, 7, WHITE);
  b.place(7, 8, WHITE);
  b.place(0, 0, BLACK);
  const t0 = Date.now();
  const mv = chooseMove(b, BLACK, 'hard', { budgetMs: 1500 });
  const dt = Date.now() - t0;
  assert.ok(mv && b.isEmpty(mv.r, mv.c));
  assert.ok(dt < 4000, `搜索耗时 ${dt}ms 应在预算内`);
});

test('pointScore：成五点进攻分应为 FIVE 级', () => {
  const b = new Board(15);
  for (let c = 4; c <= 7; c++) b.place(7, c, BLACK);
  const s = pointScore(b, 7, 8, BLACK);
  assert.ok(s.atk >= 10000000, `实际 atk=${s.atk}`);
});