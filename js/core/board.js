// 五子棋棋盘核心：落子、胜负判定、坐标转换
// 坐标约定：行 r 从上到下 0..size-1；列 c 从左到右 0..size-1
// 显示坐标：列字母 A.. + 行号（在下为上第 1 行），如 15 路棋盘中心为 H8

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export function colorName(color) {
  return color === BLACK ? '黑' : color === WHITE ? '白' : '';
}

export function opponent(color) {
  return color === BLACK ? WHITE : BLACK;
}

export function colLetter(c) {
  return String.fromCharCode(65 + c);
}

export function rcToLabel(r, c, size) {
  return colLetter(c) + String(size - r);
}

// 解析 "H8" 形式的坐标；返回 {r,c} 或 null
export function labelToRC(label, size) {
  const m = /^([A-Za-z])\s*[-–—]?\s*(\d{1,2})$/.exec(String(label).trim());
  if (!m) return null;
  const c = m[1].toUpperCase().charCodeAt(0) - 65;
  const r = size - parseInt(m[2], 10);
  if (c < 0 || c >= size || r < 0 || r >= size) return null;
  return { r, c };
}

export class Board {
  constructor(size = 15) {
    this.size = size;
    this.cells = new Uint8Array(size * size);
    this.moves = []; // {n, color, r, c, label}
  }

  inBounds(r, c) {
    return r >= 0 && r < this.size && c >= 0 && c < this.size;
  }

  get(r, c) {
    return this.cells[r * this.size + c];
  }

  isEmpty(r, c) {
    return this.inBounds(r, c) && this.cells[r * this.size + c] === EMPTY;
  }

  place(r, c, color) {
    if (!this.inBounds(r, c)) throw new Error('落子越界');
    const i = r * this.size + c;
    if (this.cells[i] !== EMPTY) throw new Error('该点已有棋子');
    this.cells[i] = color;
    const mv = { n: this.moves.length + 1, color, r, c, label: rcToLabel(r, c, this.size) };
    this.moves.push(mv);
    return mv;
  }

  undo() {
    const mv = this.moves.pop();
    if (mv) this.cells[mv.r * this.size + mv.c] = EMPTY;
    return mv || null;
  }

  isFull() {
    return this.moves.length >= this.size * this.size;
  }

  lastMove() {
    return this.moves.length ? this.moves[this.moves.length - 1] : null;
  }

  // 检查刚落下的 (r,c) 是否形成五连（自由规则，长连也算胜）
  // 返回 {line: [[r,c],...], dir: [dr,dc]} 或 null
  checkWin(r, c) {
    const color = this.get(r, c);
    if (!color) return null;
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of dirs) {
      const line = [[r, c]];
      for (const s of [1, -1]) {
        let rr = r + dr * s;
        let cc = c + dc * s;
        while (this.inBounds(rr, cc) && this.get(rr, cc) === color) {
          line.push([rr, cc]);
          rr += dr * s;
          cc += dc * s;
        }
      }
      if (line.length >= 5) {
        line.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        return { line, dir: [dr, dc] };
      }
    }
    return null;
  }

  clone() {
    const b = new Board(this.size);
    b.cells = Uint8Array.from(this.cells);
    b.moves = this.moves.map((m) => ({ ...m }));
    return b;
  }

  static fromMoves(size, moves) {
    const b = new Board(size);
    for (const mv of moves) b.place(mv.r, mv.c, mv.color);
    return b;
  }

  // 所有空点的列表
  emptyPoints() {
    const out = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (this.cells[r * this.size + c] === EMPTY) out.push({ r, c });
      }
    }
    return out;
  }
}