// 通知与弹窗（独立模块，避免视图之间的循环依赖）
import { t } from '../i18n.js';

const toastStack = () => document.getElementById('toasts');

function escapeText(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function toast(text, { type = 'info', title = '', ms = 4200 } = {}) {
  const stack = toastStack();
  const el = document.createElement('div');
  el.className = `toast ${type === 'info' ? '' : type}`;
  el.innerHTML = `${title ? `<div class="t-title">${escapeText(title)}</div>` : ''}<div>${escapeText(text)}</div>`;
  stack.appendChild(el);
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  };
  const timer = setTimeout(close, ms);
  el.addEventListener('click', () => { clearTimeout(timer); close(); });
  while (stack.children.length > 5) stack.firstElementChild?.remove();
  return close;
}

export function openModal(innerHtml, { onMount, onClose, width } = {}) {
  const root = document.getElementById('modal-root');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal" ${width ? `style="width:min(${width},calc(100vw - 40px))"` : ''}>${innerHtml}</div>`;
  root.appendChild(mask);
  const close = () => {
    mask.remove();
    onClose?.();
  };
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  onMount?.(mask.querySelector('.modal'), close);
  return { el: mask.querySelector('.modal'), close };
}

export function confirmDialog({ title, text, confirmText = t('common.confirm'), danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const { close } = openModal(
      `<h3>${escapeText(title)}</h3>
       <div class="dim" style="font-size:13px">${escapeText(text)}</div>
       <div class="modal-actions">
         <button class="btn ghost" data-x="cancel">${escapeText(t('common.cancel'))}</button>
         <button class="btn ${danger ? 'danger' : 'primary'}" data-x="ok">${escapeText(confirmText)}</button>
       </div>`,
      {
        onMount(el) {
          el.querySelector('[data-x="cancel"]').onclick = () => { done(false); close(); };
          el.querySelector('[data-x="ok"]').onclick = () => { done(true); close(); };
        },
        onClose: () => done(false),
      },
    );
  });
}