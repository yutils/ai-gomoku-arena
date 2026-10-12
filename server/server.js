// AI 大战 AI 五子棋 —— 本地辅助服务（零依赖）
// 1) 静态托管本项目（前端为纯静态页面）
// 2) CORS 代理：/proxy?url=<encoded>  用于访问不支持跨域的服务（如 strata）
// 3) 系统信息：/api/sysinfo  CPU / 内存 / GPU 占用 / llama-server 进程
//
// 用法：node server/server.js [port]
// 环境变量：PORT / HOST（默认 127.0.0.1）

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8899);
const HOST = process.env.HOST || '0.0.0.0'; // 默认监听所有网卡（局域网可访问）；HOST=127.0.0.1 可限制为本机

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

// ---------------- 系统信息采集 ----------------
const sysState = {
  prevCpus: os.cpus(),
  cpu: { model: os.cpus()[0]?.model || '未知 CPU', cores: os.cpus().length, usagePct: null },
  mem: { totalBytes: os.totalmem(), freeBytes: os.freemem(), usedPct: null },
  gpu: { name: null, totalPct: null, dedicatedBytes: null, sharedBytes: null, engines: {}, processes: [] },
  llamas: [],
  sampledAt: 0,
  sampling: false,
};

function cpuUsagePct() {
  const cur = os.cpus();
  let idle = 0;
  let total = 0;
  for (let i = 0; i < cur.length; i++) {
    const a = cur[i].times;
    const b = sysState.prevCpus[i]?.times || a;
    idle += a.idle - b.idle;
    total += (a.user + a.nice + a.sys + a.idle + a.irq) - (b.user + b.nice + b.sys + b.idle + b.irq);
  }
  sysState.prevCpus = cur;
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

function runPowerShell(script, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve({ err, stdout: stdout || '' }),
    );
  });
}

async function sampleGpuName() {
  const { stdout } = await runPowerShell(
    "Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Virtual|MuMu|GameViewer' } | Select-Object -First 1 -ExpandProperty Name",
  );
  return stdout.trim() || null;
}

async function samplePerfCounters() {
  const sets = [
    '\\GPU Engine(*)\\Utilization Percentage',
    '\\GPU Adapter Memory(*)\\Dedicated Usage',
    '\\GPU Adapter Memory(*)\\Shared Usage',
    '\\GPU Process Memory(*)\\Dedicated Usage',
    '\\GPU Process Memory(*)\\Shared Usage',
    '\\Process(llama-server*)\\% Processor Time',
    '\\Process(llama-server*)\\Working Set',
    '\\Process(llama.exe*)\\% Processor Time',
    '\\Process(llama.exe*)\\Working Set',
  ];
  const script = [
    `$sets = @(${sets.map((s) => `'${s}'`).join(',')});`,
    "$s = Get-Counter -ErrorAction SilentlyContinue -Counter $sets;",
    'if ($s) { $s.CounterSamples | Select-Object Path, InstanceName, CookedValue | ConvertTo-Json -Compress -Depth 3 }',
  ].join(' ');
  const { stdout } = await runPowerShell(script);
  if (!stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function sampleTasklist() {
  const { stdout } = await runPowerShell(
    "tasklist /FI \"IMAGENAME eq llama-server.exe\" /FO CSV /NH; tasklist /FI \"IMAGENAME eq llama.exe\" /FO CSV /NH",
  );
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)","[^"]*","([^"]*)","([^"]*)"/.exec(line.trim());
    if (!m) continue;
    out.push({
      name: m[1],
      pid: Number(m[2]),
      memBytes: parseInt(String(m[3]).replace(/[^\d]/g, ''), 10) * 1024,
      selector: m[4],
    });
  }
  return out;
}

function parseLuid(instance) {
  const m = /luid_(0x[0-9a-fA-F]+)_(0x[0-9a-fA-F]+)/.exec(instance);
  return m ? `${m[1]}_${m[2]}` : null;
}

async function sampleOnce() {
  if (sysState.sampling) return;
  sysState.sampling = true;
  try {
    sysState.cpu.usagePct = cpuUsagePct();
    const mem = { totalBytes: os.totalmem(), freeBytes: os.freemem() };
    mem.usedPct = ((mem.totalBytes - mem.freeBytes) / mem.totalBytes) * 100;
    sysState.mem = mem;

    if (!sysState.gpu.name) sysState.gpu.name = await sampleGpuName();

    const [samples, procs] = await Promise.all([samplePerfCounters(), sampleTasklist()]);
    const gpu = { name: sysState.gpu.name, totalPct: 0, dedicatedBytes: 0, sharedBytes: 0, engines: {}, processes: [] };
    const engineByType = {};
    const procMem = new Map(); // pid -> {dedicated, shared}
    const gpuEngByPid = new Map(); // pid -> {engtype: pct}
    let procCpuPct = 0; // 进程 CPU%（每核 100% 计，最后除以核数）
    let procMemSum = 0;
    let cpuCounterSeen = false;

    for (const s of samples) {
      const p = String(s.Path || '').toLowerCase();
      const v = Number(s.CookedValue) || 0;
      const inst = String(s.InstanceName || '');
      if (p.includes('gpu engine')) {
        const typeM = /engtype_([A-Za-z0-9_]+)/.exec(inst);
        const type = typeM ? typeM[1] : 'Other';
        engineByType[type] = (engineByType[type] || 0) + v;
        const pidM = /pid_(\d+)/.exec(inst);
        const pid = pidM ? Number(pidM[1]) : 0;
        if (pid) {
          const m = gpuEngByPid.get(pid) || {};
          m[type] = (m[type] || 0) + v;
          gpuEngByPid.set(pid, m);
        }
      } else if (p.includes('gpu adapter memory')) {
        if (p.includes('dedicated')) gpu.dedicatedBytes += v;
        else gpu.sharedBytes += v;
      } else if (p.includes('gpu process memory')) {
        const pidM = /pid_(\d+)/.exec(inst);
        const pid = pidM ? Number(pidM[1]) : 0;
        const cur = procMem.get(pid) || { dedicated: 0, shared: 0 };
        if (p.includes('dedicated')) cur.dedicated += v;
        else cur.shared += v;
        procMem.set(pid, cur);
      } else if (p.includes('\\process(')) {
        const nameM = /\\process\(([^)]+)\)/.exec(p);
        const instName = nameM ? nameM[1] : '';
        const isLlama = instName.startsWith('llama-server') || instName.startsWith('llama');
        if (!isLlama) continue;
        if (p.includes('% processor time')) {
          procCpuPct += v;
          cpuCounterSeen = true;
        }
        if (p.includes('working set')) procMemSum += v;
      }
    }

    // 总体 GPU 占用：按引擎类型分别求和后取最繁忙的一类（贴近任务管理器口径）
    gpu.engines = Object.fromEntries(
      Object.entries(engineByType)
        .map(([k, v]) => [k, Math.min(100, Math.round(v * 10) / 10)])
        .sort((a, b) => b[1] - a[1]),
    );
    gpu.totalPct = Object.values(engineByType).length
      ? Math.min(100, Math.round(Math.max(...Object.values(engineByType)) * 10) / 10)
      : 0;
    gpu.processes = [...procMem.entries()]
      .map(([pid, m]) => ({ pid, dedicatedBytes: m.dedicated, sharedBytes: m.shared }))
      .sort((a, b) => b.dedicatedBytes + b.sharedBytes - (a.dedicatedBytes + a.sharedBytes))
      .slice(0, 8);

    // 单个进程的 GPU 占用：取该进程最繁忙的引擎类型
    const pidGpuPct = (pid) => {
      const m = gpuEngByPid.get(pid);
      if (!m) return null;
      return Math.min(100, Math.round(Math.max(...Object.values(m)) * 10) / 10);
    };

    const cores = sysState.cpu.cores || 1;
    sysState.gpu = gpu;
    sysState.llamas = procs.map((pr) => {
      const m = procMem.get(pr.pid) || { dedicated: 0, shared: 0 };
      return {
        name: pr.name,
        pid: pr.pid,
        memBytes: procMemSum || pr.memBytes,
        gpuPct: pidGpuPct(pr.pid),
        cpuPct: cpuCounterSeen ? Math.min(100, Math.round((procCpuPct / cores) * 10) / 10) : null,
        gpuDedicatedBytes: m.dedicated,
        gpuSharedBytes: m.shared,
      };
    });
    sysState.sampledAt = Date.now();
  } finally {
    sysState.sampling = false;
  }
}

function sysinfoPayload() {
  return {
    ts: Date.now(),
    sampledAt: sysState.sampledAt,
    cpu: sysState.cpu,
    mem: sysState.mem,
    gpu: sysState.gpu,
    llamas: sysState.llamas,
  };
}

// 启动即采样，之后每 3 秒一次
sampleOnce();
setInterval(() => { sampleOnce(); }, 3000);

// ---------------- HTTP 服务 ----------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function setCors(res, req) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization');
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.resolve(ROOT, '.' + rel);
  if (!filePath.startsWith(ROOT)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      await serveStatic(req, res, path.join(rel, 'index.html'));
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    // 无扩展名的路径回退到 index.html（hash 路由）
    if (!path.extname(rel)) {
      const idx = path.join(ROOT, 'index.html');
      const stat = await fsp.stat(idx);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': stat.size });
      fs.createReadStream(idx).pipe(res);
      return;
    }
    sendJson(res, 404, { error: 'not found', path: rel });
  }
}

async function handleProxy(req, res, urlObj) {
  setCors(res, req);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const target = urlObj.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    sendJson(res, 400, { error: '缺少合法的 url 参数（需 http/https）' });
    return;
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (['host', 'origin', 'referer', 'connection', 'accept-encoding', 'content-length', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest'].includes(key)) continue;
    headers[k] = v;
  }
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }
  try {
    const upstream = await fetch(target, { method: req.method, headers, body });
    const outHeaders = {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Proxy-Status': String(upstream.status),
    };
    res.writeHead(upstream.status, outHeaders);
    res.flushHeaders?.();
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (!res.write(Buffer.from(chunk))) {
          await new Promise((r) => res.once('drain', r));
        }
      }
    }
    res.end();
  } catch (e) {
    sendJson(res, 502, { error: `代理请求失败：${e.message}`, target });
  }
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  if (pathname === '/api/ping') {
    setCors(res, req);
    sendJson(res, 200, { ok: true, service: 'aivsai-helper', pid: process.pid });
    return;
  }
  if (pathname === '/api/sysinfo') {
    setCors(res, req);
    if (Date.now() - sysState.sampledAt > 2500) sampleOnce();
    sendJson(res, 200, sysinfoPayload());
    return;
  }
  if (pathname === '/proxy') {
    await handleProxy(req, res, urlObj);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  await serveStatic(req, res, pathname);
});

server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log(`\n  AI 大战 AI 五子棋 · 本地服务已启动`);
  console.log(`  本机访问:  http://127.0.0.1:${PORT}/`);
  if (HOST === '0.0.0.0' && lan.length) {
    console.log(`  局域网访问: ${lan.map((ip) => `http://${ip}:${PORT}/`).join('  ')}`);
  }
  console.log(`  监听地址:  ${HOST}:${PORT}${HOST === '0.0.0.0' ? '（限制本机请用 HOST=127.0.0.1）' : ''}`);
  console.log(`  系统信息:  http://127.0.0.1:${PORT}/api/sysinfo`);
  console.log(`  CORS 代理: /proxy?url=<encoded target url>\n`);
});