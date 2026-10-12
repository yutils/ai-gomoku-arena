// 落子解析器：从 LLM 的任意文本输出中稳健地提取落子坐标
// 优先级：JSON 对象中的 move 字段 > "MOVE: H8" 前缀 > 裸字母坐标(取最后出现的) > 数字对
import { labelToRC } from '../core/board.js';

function letterClass(size) {
  return `A-${String.fromCharCode(64 + size)}`;
}

// 返回候选 [{r,c,src,raw}]，按可信度从高到低
export function extractMoveCandidates(text, size) {
  const s = String(text ?? '');
  const cands = [];
  const seen = new Set();
  const push = (r, c, src, raw) => {
    if (!Number.isInteger(r) || !Number.isInteger(c)) return;
    const k = `${r},${c}`;
    if (seen.has(k)) return;
    seen.add(k);
    cands.push({ r, c, src, raw: String(raw ?? '').slice(0, 40) });
  };

  // 1. JSON 片段（从后往前扫，模型通常把最终结论放最后）
  const jsonRe = /\{[^{}]*\}/g;
  const objs = [];
  let m;
  while ((m = jsonRe.exec(s))) objs.push(m[0]);
  for (const o of objs.reverse()) {
    try {
      const j = JSON.parse(o);
      const mv = j.move ?? j.Move ?? j.MOVE ?? j.position ?? j.coordinate ?? j.坐标;
      if (typeof mv === 'string') {
        const rc = labelToRC(mv, size);
        if (rc) push(rc.r, rc.c, 'json', o);
      } else if (Array.isArray(mv) && mv.length >= 2) {
        const n1 = Number(mv[0]);
        const n2 = Number(mv[1]);
        // 数组坐标：先按 1-based(row,col)，再按 0-based
        if (n1 >= 1 && n1 <= size && n2 >= 1 && n2 <= size) push(n1 - 1, n2 - 1, 'json', o);
        if (n1 >= 0 && n1 < size && n2 >= 0 && n2 < size) push(n1, n2, 'json', o);
      }
    } catch { /* 忽略非 JSON 片段 */ }
  }

  // 2. 带前缀的坐标（MOVE: H8 / 落子 H8 / 坐标：H8）
  const prefRe = new RegExp(`(?:move|落子|落点|坐标|position)\\s*[:：]?\\s*([${letterClass(size)}])\\s*[-–—]?\\s*(\\d{1,2})`, 'gi');
  while ((m = prefRe.exec(s))) {
    const lbl = `${m[1]}${m[2]}`;
    const rc = labelToRC(lbl, size);
    if (rc) push(rc.r, rc.c, 'prefix', lbl);
  }

  // 3. 裸字母坐标（从后往前取，结论通常在最后）
  const bareRe = new RegExp(`\\b([${letterClass(size)}])\\s*[-–—]?\\s*(\\d{1,2})\\b`, 'gi');
  const bares = [];
  while ((m = bareRe.exec(s))) bares.push(m[0]);
  for (const b of bares.reverse()) {
    const rc = labelToRC(b, size);
    if (rc) push(rc.r, rc.c, 'bare', b);
  }

  // 4. 数字对 (7,7) / 7，7 —— 依次尝试：1-based 上起、0-based、1-based 下起
  const pairRe = /\(?\s*(\d{1,2})\s*[,，]\s*(\d{1,2})\s*\)?/g;
  while ((m = pairRe.exec(s))) {
    const n1 = parseInt(m[1], 10);
    const n2 = parseInt(m[2], 10);
    if (n1 >= 1 && n1 <= size && n2 >= 1 && n2 <= size) push(n1 - 1, n2 - 1, 'pair', m[0]);
    if (n1 >= 0 && n1 < size && n2 >= 0 && n2 < size) push(n1, n2, 'pair0', m[0]);
    if (n1 >= 1 && n1 <= size && n2 >= 1 && n2 <= size) push(size - n1, n2 - 1, 'pair-bottom', m[0]);
  }

  return cands;
}

// 解析结果：
//   {ok:true, r, c, source, reason}   找到候选坐标（是否为空点由调用方校验）
//   {ok:false, code:'no-candidate'}   输出中找不到任何坐标
export function parseMove(text, size) {
  const cands = extractMoveCandidates(text, size);
  if (!cands.length) {
    return { ok: false, code: 'no-candidate', raw: String(text ?? '').slice(0, 500) };
  }
  const hit = cands[0];
  return {
    ok: true,
    r: hit.r,
    c: hit.c,
    source: hit.src,
    reason: extractReason(text),
  };
}

// 从输出的 JSON 片段里提取 reason 字段（可选）
export function extractReason(text) {
  const s = String(text ?? '');
  const jsonRe = /\{[^{}]*\}/g;
  const objs = [];
  let m;
  while ((m = jsonRe.exec(s))) objs.push(m[0]);
  for (const o of objs.reverse()) {
    try {
      const j = JSON.parse(o);
      const r = j.reason ?? j.Reason ?? j.理由 ?? j.explanation;
      if (typeof r === 'string' && r.trim()) return r.trim().slice(0, 300);
    } catch { /* 忽略 */ }
  }
  return null;
}