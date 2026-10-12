// Provider / Model 配置存储（参考 DeepSeek Harness 的模型配置模型）
// 存放在浏览器 localStorage；API Key 保存后在界面中只显示脱敏提示

const LS_PROVIDERS = 'aiai.providers.v1';
const LS_GAME = 'aiai.gameSettings.v1';
const LS_UI = 'aiai.ui.v1';

export const PROTOCOLS = [
  { id: 'openai-completions', name: 'OpenAI Chat Completions', available: true },
  { id: 'openai-responses', name: 'OpenAI Responses（规划中）', available: false },
  { id: 'anthropic-messages', name: 'Anthropic Messages（规划中）', available: false },
];

// 默认不预置任何服务，由用户自行添加
export function defaultProviders() {
  return [];
}

export function loadProviders() {
  try {
    const raw = localStorage.getItem(LS_PROVIDERS);
    if (!raw) {
      const seed = defaultProviders();
      saveProviders(seed);
      return seed;
    }
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : defaultProviders();
  } catch {
    return defaultProviders();
  }
}

export function saveProviders(list) {
  localStorage.setItem(LS_PROVIDERS, JSON.stringify(list));
}

export function getProvider(id) {
  return loadProviders().find((p) => p.id === id) || null;
}

export function upsertProvider(provider) {
  const list = loadProviders();
  const i = list.findIndex((p) => p.id === provider.id);
  if (i >= 0) list[i] = provider;
  else list.push(provider);
  saveProviders(list);
  return list;
}

export function deleteProvider(id) {
  const list = loadProviders().filter((p) => p.id !== id);
  saveProviders(list);
  return list;
}

export function loadGameSettings() {
  try {
    return JSON.parse(localStorage.getItem(LS_GAME) || '{}');
  } catch {
    return {};
  }
}

export function saveGameSettings(s) {
  localStorage.setItem(LS_GAME, JSON.stringify(s));
}

export function loadUiPrefs() {
  try {
    return JSON.parse(localStorage.getItem(LS_UI) || '{}');
  } catch {
    return {};
  }
}

export function saveUiPrefs(p) {
  localStorage.setItem(LS_UI, JSON.stringify({ ...loadUiPrefs(), ...p }));
}

function modelsEndpoint(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/, '');
  if (/\/v1$/.test(u)) return u + '/models';
  return u + '/v1/models';
}

// 探测服务端可用模型列表（"获取可用模型"）
export async function probeModels({ baseUrl, apiKey, viaProxy = 'auto', headers = [] }) {
  const endpoint = modelsEndpoint(baseUrl);
  const hdrs = {};
  if (apiKey) hdrs.Authorization = `Bearer ${apiKey}`;
  for (const h of headers) if (h && h.k) hdrs[h.k] = String(h.v ?? '');

  const attempt = async (useProxy) => {
    const url = useProxy ? `/proxy?url=${encodeURIComponent(endpoint)}` : endpoint;
    const res = await fetch(url, { headers: hdrs, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const data = json.data || json.models || [];
    return data.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  };

  try {
    return { ok: true, models: await attempt(viaProxy === 'always') };
  } catch (e) {
    if (viaProxy !== 'never') {
      try {
        return { ok: true, models: await attempt(true), viaProxy: true };
      } catch (e2) {
        return { ok: false, error: `${e.message}；经代理重试：${e2.message}` };
      }
    }
    return { ok: false, error: e.message };
  }
}