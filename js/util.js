// 通用工具：格式化、DOM、网络、估算

export function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

export function fmtNum(n, digits = 0) {
  if (n == null || !isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtTps(v) {
  if (v == null || !isFinite(v) || v <= 0) return '—';
  return `${v.toFixed(1)} tok/s`;
}

export function fmtBytes(b) {
  if (b == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function deepClone(o) {
  return o == null ? o : JSON.parse(JSON.stringify(o));
}

// 粗略估算 token 数（流式响应缺少 usage 时的兜底，标记为 estimated）
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80 && code <= 0x9fff) cjk++;
    else if (code > 0x9fff && code <= 0xffef) cjk += 0.6;
    else other++;
  }
  return Math.ceil(cjk + other / 3.6);
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}