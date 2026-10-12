// 提示词构建：把棋盘局面序列化为 LLM 易读的文本
import { BLACK, colorName, rcToLabel } from '../core/board.js';

// 棋盘图：带列字母与行号
export function boardDiagram(board) {
  const size = board.size;
  const head = ['  ', ...Array.from({ length: size }, (_, c) => String.fromCharCode(65 + c))].join(' ');
  const rows = [];
  for (let r = 0; r < size; r++) {
    const cells = [];
    for (let c = 0; c < size; c++) {
      const v = board.get(r, c);
      cells.push(v === 0 ? '·' : v === BLACK ? '●' : '○');
    }
    rows.push(`${String(size - r).padStart(2, ' ')} ${cells.join(' ')}`);
  }
  return [head, ...rows].join('\n');
}

export function moveHistoryText(board, window = 60) {
  const list = board.moves.slice(-window).map((m) => `${m.color === BLACK ? 'B' : 'W'}${m.label}`);
  return list.length ? list.join(' ') : '（空盘，你先行）';
}

// 已占用坐标列表：显式列出禁止落子的点，模型读图易错时靠它兜底
export function occupiedList(board) {
  return board.moves.length ? board.moves.map((m) => m.label).join(' ') : '（无，棋盘为空）';
}

const JSON_LINE_ZH = '{"move":"<字母+数字，例如 K10>","reason":"一句话理由"}';
const JSON_LINE_EN = '{"move":"<letter+number, e.g. K10>","reason":"one-line reason"}';

function zhSystem(color, size) {
  return [
    `你是五子棋（Gomoku）高手，正在与另一位选手进行一场 ${size}×${size} 无禁手五子棋对局。`,
    `规则：黑先白后，横、竖、斜任意方向先形成连续五子（或以上）者获胜。你执${colorName(color)}方。`,
    `坐标格式：列用字母 A-${String.fromCharCode(64 + size)}（从左到右），行用数字 1-${size}（从下到上）。`,
    `例如 ${size} 路棋盘的正中心是 ${rcToLabel(size >> 1, size >> 1, size)}。`,
    '你必须选择棋盘上的空点落子，禁止选择已有棋子的位置。',
    '每次只回复一手棋。',
  ].join('\n');
}

function enSystem(color, size) {
  return [
    `You are a strong Gomoku (five-in-a-row) player. The game is played on a ${size}x${size} board, freestyle rules (no forbidden moves).`,
    `Black moves first. The first player to make five or more stones in a row (horizontally, vertically or diagonally) wins. You play ${color === BLACK ? 'BLACK' : 'WHITE'}.`,
    `Coordinate format: columns are letters A-${String.fromCharCode(64 + size)} (left to right), rows are numbers 1-${size} (bottom to top).`,
    `For example the exact center of the ${size}x${size} board is ${rcToLabel(size >> 1, size >> 1, size)}.`,
    'You must play on an empty intersection; never play on an occupied point.',
    'Reply with exactly one move.',
  ].join('\n');
}

// feedback: {kind:'occupied'|'no-candidate'|'illegal'|'timeout'|'error', text, lastRaw}
export function buildMessages({ board, color, thinking = true, lang = 'zh', feedback = null }) {
  const size = board.size;
  const last = board.lastMove();
  const sys = lang === 'en' ? enSystem(color, size) : zhSystem(color, size);
  const who = lang === 'en' ? (color === BLACK ? 'BLACK' : 'WHITE') : colorName(color);

  const parts = [];
  if (lang === 'en') {
    parts.push(`[Your color] You are ${who}. Move #${board.moves.length + 1}; it is your turn to place a stone.`);
    parts.push(last ? `[Opponent's last move] ${last.color === BLACK ? 'BLACK' : 'WHITE'} played at ${last.label}.` : '[Turn order] You move first on an empty board.');
    parts.push('Current board (· empty, ● black, ○ white):');
    parts.push(boardDiagram(board));
    parts.push(`[OCCUPIED points — already have a stone, you MUST NOT play on any of these] ${occupiedList(board)}`);
    parts.push(`Move history (in order): ${moveHistoryText(board)}`);
    if (thinking) {
      parts.push('Think briefly about the position, then end your reply with a single JSON line in exactly this format:');
    } else {
      parts.push('Do not explain. Reply with a single JSON line in exactly this format:');
    }
    parts.push(JSON_LINE_EN);
  } else {
    parts.push(`【我方颜色】你是${colorName(color)}方。现在进行第 ${board.moves.length + 1} 手，轮到你落子。`);
    parts.push(last ? `【对方最后一步】${colorName(last.color)}方下在 ${last.label}。` : '【先后手】你是先手，棋盘为空，请下第一子。');
    parts.push('【当前棋盘】（· 空位，● 黑子，○ 白子）：');
    parts.push(boardDiagram(board));
    parts.push(`【已占用坐标，以下位置已有棋子，禁止落子】${occupiedList(board)}`);
    parts.push(`【落子历史（按先后顺序）】${moveHistoryText(board)}`);
    if (thinking) {
      parts.push('请简要分析局面，然后在你回复的最后单独输出一行 JSON，格式严格如下：');
    } else {
      parts.push('不要输出分析过程，直接输出一行 JSON，格式严格如下：');
    }
    parts.push(JSON_LINE_ZH);
  }

  if (feedback) {
    const prev = feedback.lastRaw ? `你上一次的回复是：\n"""\n${String(feedback.lastRaw).slice(0, 600)}\n"""\n` : '';
    if (lang === 'en') {
      parts.push(`${prev}That reply was rejected: ${feedback.text} Choose a valid EMPTY point in A1..${String.fromCharCode(64 + size)}${size} and output the JSON line again.`);
    } else {
      parts.push(`${prev}该回复被拒绝：${feedback.text} 请重新给出一个合法的空点（A1 到 ${String.fromCharCode(64 + size)}${size} 之间），并再次输出 JSON 行。`);
    }
  }

  return [
    { role: 'system', content: sys },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

// 给人看的落子描述
export function describeMove(board, r, c) {
  return rcToLabel(r, c, board.size);
}