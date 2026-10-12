// 应用外壳：路由、语言切换与全局初始化
import { detectProxy } from '../ai/openai.js';
import { createArenaView } from './arena.js';
import { createModelsView } from './models.js';
import { createHistoryView } from './history.js';
import { createMonitorView } from './monitor.js';
import { t, getLang, toggleLang, onLangChange, applyStaticI18n } from '../i18n.js';

const viewDefs = {
  arena: createArenaView,
  models: createModelsView,
  history: createHistoryView,
  monitor: createMonitorView,
};

const mounted = new Map();
let currentView = 'arena';
let proxyOk = null;

function updateDocTitle() {
  document.title = `${t(`nav.${currentView}`)} · ${t('app.shortTitle')}`;
}

function updateLangButton() {
  const btn = document.getElementById('lang-toggle');
  if (btn) btn.textContent = getLang() === 'zh' ? 'EN' : '中文';
}

function updateProxyPill() {
  const pill = document.getElementById('proxy-pill');
  if (!pill || proxyOk == null) return;
  if (proxyOk) {
    pill.textContent = t('app.serviceConnected');
    pill.className = 'pill ok';
    pill.title = t('app.serviceConnectedTip');
  } else {
    pill.textContent = t('app.serviceDisconnected');
    pill.className = 'pill bad';
    pill.title = t('app.serviceDisconnectedTip');
  }
}

function showView(name) {
  if (!viewDefs[name]) name = 'arena';
  currentView = name;
  if (!mounted.has(name)) {
    const el = document.getElementById(`view-${name}`);
    mounted.set(name, viewDefs[name](el));
  }
  for (const [n, v] of mounted) v.el.classList.toggle('active', n === name);
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  mounted.get(name).show?.();
  updateDocTitle();
}

function rerenderAll() {
  applyStaticI18n(document);
  updateLangButton();
  updateProxyPill();
  updateDocTitle();
  for (const v of mounted.values()) v.rerender?.();
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'arena';
  showView(hash.split('/')[0]);
}

window.addEventListener('hashchange', route);
document.getElementById('brand').addEventListener('click', () => { location.hash = '#/arena'; });
document.getElementById('lang-toggle').addEventListener('click', toggleLang);
onLangChange(() => rerenderAll());

// 初始静态骨架翻译（含首次以英文打开的情况）
applyStaticI18n(document);
updateLangButton();

route();

detectProxy().then((ok) => {
  proxyOk = ok;
  updateProxyPill();
});