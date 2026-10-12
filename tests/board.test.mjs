import test from 'node:test';
import assert from 'node:assert/strict';
import { Board, BLACK, WHITE, EMPTY, rcToLabel, labelToRC, opponent } from '../js/core/board.js';

test('坐标转换：中心 H8（15 路）', () => {
  assert.equal(rcToLabel(7, 7, 15), 'H8');
  assert.deepEqual(labelToRC('H8', 15), { r: 7, c: 7 });
  assert.equal(rcToLabel(0, 0, 15), 'A15');
  assert.equal(rcToLabel(14, 14, 15), 'O1');
  assert.equal(rcToLabel(0, 7, 15), 'H15');
});

test('坐标解析：兼容大小写与分隔符', () => {
  assert.deepEqual(labelToRC('h8', 15), { r: 7, c: 7 });
  assert.deepEqual(labelToRC('A1', 15), { r: 14, c: 0 });
  assert.deepEqual(labelToRC(' O 1 ', 15), { r: 14, c: 14 });
  assert.equal(labelToRC('P1', 15), null); // 列超出
  assert.equal(labelToRC('A0', 15), null); // 行超出
  assert.equal(labelToRC('A16', 15), null);
});

test('落子与撤销', () => {
  const b = new Board(15);
  const mv = b.place(7, 7, BLACK);
  assert.equal(mv.label, 'H8');
  assert.equal(b.get(7, 7), BLACK);
  assert.equal(b.isEmpty(7, 7), false);
  assert.throws(() => b.place(7, 7, WHITE), /已有棋子/);
  b.undo();
  assert.equal(b.get(7, 7), EMPTY);
  assert.equal(b.moves.length, 0);
});

test('五连检测：横/竖/两支斜线', () => {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const b = new Board(15);
    const r0 = 7, c0 = 5;
    for (let i = 0; i < 5; i++) b.place(r0 + dr * i, c0 + dc * i, BLACK);
    const win = b.checkWin(r0 + dr * 4, c0 + dc * 4);
    assert.ok(win, `方向 ${dr},${dc} 应判胜`);
    assert.equal(win.line.length, 5);
  }
});

test('长连（六连以上）也算胜', () => {
  const b = new Board(15);
  for (let i = 0; i < 6; i++) b.place(7, 3 + i, WHITE);
  const win = b.checkWin(7, 8);
  assert.ok(win);
  assert.equal(win.line.length, 6);
});

test('四连不判胜；被隔断不判胜', () => {
  const b = new Board(15);
  for (let i = 0; i < 4; i++) b.place(7, 3 + i, BLACK);
  assert.equal(b.checkWin(7, 6), null);
  b.place(7, 8, BLACK); // 中间隔了 (7,7)
  assert.equal(b.checkWin(7, 8), null);
});

test('棋盘填满检测与克隆', () => {
  const b = new Board(3);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) b.place(r, c, (r + c) % 2 ? BLACK : WHITE);
  assert.ok(b.isFull());
  const b2 = b.clone();
  b2.undo();
  assert.ok(!b2.isFull());
  assert.ok(b.isFull());
});

test('opponent 颜色互换', () => {
  assert.equal(opponent(BLACK), WHITE);
  assert.equal(opponent(WHITE), BLACK);
});