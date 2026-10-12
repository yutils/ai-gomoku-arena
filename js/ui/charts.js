// 极简 Canvas 迷你曲线图（CPU / GPU / 速度等实时数据）
export function createSparkline(canvas, { max = 100, color = '#22d3ee', capacity = 90 } = {}) {
  const data = [];
  const ctx = canvas.getContext('2d');

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function redraw() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    if (!data.length) return;

    // 网格基线
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();

    const step = w / Math.max(1, capacity - 1);
    const pts = data.map((v, i) => [i * step, h - (Math.min(max, Math.max(0, v)) / max) * (h - 4) - 2]);

    // 填充
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, `${color}33`);
    grad.addColorStop(1, `${color}00`);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], h);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(pts[pts.length - 1][0], h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 折线
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 当前点
    const [lx, ly] = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(lx, ly, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function push(v) {
    if (v == null || !isFinite(v)) return;
    data.push(v);
    if (data.length > capacity) data.shift();
    redraw();
  }

  function setAll(arr) {
    data.length = 0;
    for (const v of arr.slice(-capacity)) data.push(v);
    redraw();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  return { push, setAll, redraw };
}