// OpenAI 兼容协议的流式对话适配器
// 支持：SSE 流式解析、非流式兜底、代理自动回退、超时/停滞保护、TTFT 与 token 统计
import { estimateTokens } from '../util.js';
import { t } from '../i18n.js';

export class ChatError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ChatError';
    this.code = opts.code || 'error'; // aborted | timeout | idle | network | http | server | parse
    this.status = opts.status;
    this.body = opts.body;
  }
}

const proxyState = { checked: false, available: false };

// 检测本地辅助服务的代理是否可用（页面由辅助服务托管时可用）
export async function detectProxy() {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    proxyState.available = r.ok;
  } catch {
    proxyState.available = false;
  }
  proxyState.checked = true;
  return proxyState.available;
}

export function proxyAvailable() {
  return proxyState.available;
}

// 由 Base URL 推导 chat/completions 端点
export function resolveEndpoint(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v1$/.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

async function readErrorBody(res) {
  try {
    const t = await res.text();
    return t.slice(0, 800);
  } catch {
    return '';
  }
}

// 发起一次请求（直连或代理）
async function doRequest(p) {
  const { endpoint, useProxy, apiKey, hdrs, bodyObj, signal, timeoutMs, idleMs, onDelta, messages } = p;
  const ctrl = new AbortController();
  let abortCode = null;
  // 两个独立定时器：总超时（不重置）与停滞超时（每收到数据就重置）
  let overallTimer = null;
  let idleTimer = null;

  const abortWith = (code) => {
    abortCode = code;
    ctrl.abort();
  };
  const armIdle = (ms) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortWith('idle'), Math.max(1000, ms));
  };
  const clearTimers = () => {
    if (overallTimer) clearTimeout(overallTimer);
    if (idleTimer) clearTimeout(idleTimer);
    overallTimer = null;
    idleTimer = null;
  };

  const onExternalAbort = () => {
    abortCode = abortCode || 'aborted';
    ctrl.abort();
  };
  if (signal) {
    if (signal.aborted) throw new ChatError(t('net.cancelled'), { code: 'aborted' });
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  overallTimer = setTimeout(() => abortWith('timeout'), Math.max(1000, timeoutMs));

  const url = useProxy ? `/proxy?url=${encodeURIComponent(endpoint)}` : endpoint;
  const t0 = performance.now();

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify(bodyObj),
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch (e) {
    clearTimers();
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    if (signal?.aborted || abortCode === 'aborted') throw new ChatError(t('net.cancelled'), { code: 'aborted' });
    if (abortCode === 'timeout') throw new ChatError(t('net.timeout', { s: Math.round(timeoutMs / 1000) }), { code: 'timeout' });
    throw new ChatError(
      t('net.networkFail', { mode: useProxy ? t('net.viaProxy') : t('net.direct'), msg: e?.message || e }),
      { code: 'network' },
    );
  }

  if (!res.ok) {
    clearTimers();
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    const body = await readErrorBody(res);
    throw new ChatError(t('net.http', { status: res.status }), { code: 'http', status: res.status, body });
  }

  const ctype = res.headers.get('content-type') || '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let timings = null;
  let finishReason = null;
  let ttftMs = null;

  if (ctype.includes('text/event-stream')) {
    // ---- SSE 流式解析 ----
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    armIdle(idleMs);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle(idleMs);
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let obj = null;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          if (obj.error) {
            throw new ChatError(obj.error.message || t('net.serverError'), { code: 'server', body: payload.slice(0, 500) });
          }
          if (obj.usage) usage = obj.usage;
          if (obj.timings) timings = obj.timings;
          const ch = obj.choices && obj.choices[0];
          if (!ch) continue;
          const d = ch.delta || {};
          const pieceC = typeof d.content === 'string' ? d.content : '';
          const pieceR = typeof d.reasoning_content === 'string'
            ? d.reasoning_content
            : (typeof d.reasoning === 'string' ? d.reasoning : (typeof d.thinking === 'string' ? d.thinking : ''));
          if ((pieceC || pieceR) && ttftMs == null) ttftMs = performance.now() - t0;
          if (pieceR) {
            reasoning += pieceR;
            onDelta?.({ type: 'reasoning', text: pieceR });
          }
          if (pieceC) {
            content += pieceC;
            onDelta?.({ type: 'content', text: pieceC });
          }
          if (ch.finish_reason) finishReason = ch.finish_reason;
        }
      }
    } catch (e) {
      if (e instanceof ChatError) throw e;
      if (signal?.aborted || abortCode === 'aborted') throw new ChatError(t('net.cancelled'), { code: 'aborted' });
      if (abortCode === 'idle') throw new ChatError(t('net.idle', { s: Math.round(idleMs / 1000) }), { code: 'idle', body: (reasoning + content).slice(-300) });
      if (abortCode === 'timeout') throw new ChatError(t('net.timeout', { s: Math.round(timeoutMs / 1000) }), { code: 'timeout', body: (reasoning + content).slice(-300) });
      throw new ChatError(t('net.streamRead', { msg: e?.message || e }), { code: 'network' });
    } finally {
      clearTimers();
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      try { reader.releaseLock(); } catch { /* 忽略 */ }
    }
  } else {
    // ---- 非流式兜底（服务端未按 SSE 返回）----
    clearTimers();
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      throw new ChatError(t('net.readFail', { msg: e?.message || e }), { code: 'network' });
    }
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new ChatError(t('net.badJson'), { code: 'parse', body: text.slice(0, 500) });
    }
    if (obj.error) throw new ChatError(obj.error.message || t('net.serverError'), { code: 'server', body: text.slice(0, 500) });
    const msg = obj.choices?.[0]?.message || {};
    content = typeof msg.content === 'string' ? msg.content : '';
    reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : (typeof msg.reasoning === 'string' ? msg.reasoning : '');
    if (content || reasoning) ttftMs = performance.now() - t0;
    usage = obj.usage || null;
    timings = obj.timings || null;
    finishReason = obj.choices?.[0]?.finish_reason || null;
    if (reasoning) onDelta?.({ type: 'reasoning', text: reasoning });
    if (content) onDelta?.({ type: 'content', text: content });
  }

  const latencyMs = performance.now() - t0;

  // usage 兜底估算（部分服务不返回 usage）
  let estimated = false;
  if (!usage || usage.completion_tokens == null) {
    const promptText = messages.map((m) => m.content).join('\n');
    const pt = estimateTokens(promptText);
    const ct = estimateTokens(reasoning + content);
    usage = { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct };
    estimated = true;
  }

  return {
    content,
    reasoning,
    usage,
    usageEstimated: estimated,
    timings,
    finishReason,
    ttftMs,
    latencyMs,
    viaProxy: useProxy,
    endpoint,
  };
}

// 对外主入口
export async function chatCompletion(cfg) {
  const {
    baseUrl, apiKey = '', model, messages,
    temperature, topP, topK, maxTokens, extraBody,
    headers = [], timeoutMs = 300000, idleMs = 90000,
    signal, viaProxy = 'auto', onDelta,
  } = cfg;

  if (!baseUrl) throw new ChatError(t('net.noBaseUrl'), { code: 'config' });
  if (!model) throw new ChatError(t('net.noModel'), { code: 'config' });

  const endpoint = resolveEndpoint(baseUrl);
  const bodyObj = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (temperature != null) bodyObj.temperature = temperature;
  if (topP != null) bodyObj.top_p = topP;
  if (topK != null) bodyObj.top_k = topK;
  if (maxTokens != null) bodyObj.max_tokens = maxTokens;
  if (extraBody && typeof extraBody === 'object') Object.assign(bodyObj, extraBody);

  const hdrs = { 'Content-Type': 'application/json' };
  if (apiKey) hdrs.Authorization = `Bearer ${apiKey}`;
  for (const h of headers) {
    if (h && h.k) hdrs[h.k] = String(h.v ?? '');
  }

  const run = (useProxy) => doRequest({
    endpoint, useProxy, apiKey, hdrs, bodyObj, signal, timeoutMs, idleMs, onDelta, messages,
  });

  if (viaProxy === 'always') return run(true);
  if (viaProxy === 'never') return run(false);

  // auto：先直连，网络/CORS 失败且代理可用时自动改走代理
  try {
    return await run(false);
  } catch (e) {
    if (e.code === 'aborted') throw e;
    const retriable = (e.code === 'network') && proxyState.available;
    if (!retriable) throw e;
    try {
      return await run(true);
    } catch (e2) {
      if (e2.code === 'aborted') throw e2;
      throw new ChatError(t('net.proxyRetryFail', { msg: e.message, msg2: e2.message }), { code: e2.code, status: e2.status, body: e2.body });
    }
  }
}