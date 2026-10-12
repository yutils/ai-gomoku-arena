import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMove, extractMoveCandidates } from '../js/ai/parse.js';
import { buildMessages, boardDiagram } from '../js/ai/prompt.js';
import { Board, BLACK, WHITE } from '../js/core/board.js';

test('解析标准 JSON 输出', () => {
  const r = parseMove('局面分析……\n{"move":"H8","reason":"占据天元"}', 15);
  assert.equal(r.ok, true);
  assert.equal(r.r, 7);
  assert.equal(r.c, 7);
  assert.equal(r.reason, '占据天元');
});

test('解析 MOVE: 前缀与大小写混写', () => {
  const r = parseMove('我认为最佳落点是 move: j10 位置', 15);
  assert.equal(r.ok, true);
  assert.equal(r.r, 5); // 15-10
  assert.equal(r.c, 9); // J
});

test('解析小写裸坐标（取最后出现的）', () => {
  const r = parseMove('先考虑 g7，再考虑 h8，最终选择 h8', 15);
  assert.equal(r.ok, true);
  assert.equal(r.r, 7);
  assert.equal(r.c, 7);
});

test('解析 markdown 代码块中的 JSON', () => {
  const text = '```json\n{"move": "A1", "reason": "角落"}\n```';
  const r = parseMove(text, 15);
  assert.equal(r.ok, true);
  assert.equal(r.r, 14);
  assert.equal(r.c, 0);
});

test('解析数字对坐标', () => {
  const r = parseMove('落子于 (8, 8)', 15);
  assert.equal(r.ok, true);
  assert.equal(r.r, 7);
  assert.equal(r.c, 7);
});

test('无法解析时返回 no-candidate', () => {
  const r = parseMove('这一手我选择放弃，因为局面已经无法挽回。', 15);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-candidate');
});

test('候选列表包含多个来源并去重', () => {
  const c = extractMoveCandidates('{"move":"H8"} 或者 MOVE: H8', 15);
  assert.ok(c.length >= 1);
  assert.equal(c[0].r, 7);
  assert.equal(c[0].c, 7);
});

test('提示词包含棋盘图、坐标示例与格式要求', () => {
  const b = new Board(15);
  b.place(7, 7, BLACK);
  b.place(7, 8, WHITE);
  const msgs = buildMessages({ board: b, color: BLACK, thinking: true });
  assert.equal(msgs.length, 2);
  const user = msgs[1].content;
  assert.ok(user.includes('H8'));
  assert.ok(user.includes('{"move":"<字母+数字'));
  assert.ok(user.includes('黑'));
  assert.ok(user.includes('W' + 'I8')); // 上一手：白 I8
  const diagram = boardDiagram(b);
  assert.equal(diagram.split('\n').length, 16); // 表头 + 15 行
});

test('重试反馈会附加上一次的回答', () => {
  const b = new Board(15);
  const msgs = buildMessages({
    board: b,
    color: WHITE,
    feedback: { kind: 'occupied', text: '该点已有棋子。', lastRaw: '{"move":"H8"}' },
  });
  const user = msgs[1].content;
  assert.ok(user.includes('该点已有棋子'));
  assert.ok(user.includes('H8'));
  assert.ok(user.includes('{"move":"H8"}')); // 上一次回答被引用
});