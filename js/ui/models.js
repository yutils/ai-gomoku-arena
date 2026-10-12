// 模型配置：Provider / Model / API Key 管理（参考 DeepSeek Harness 的模型配置模型）
import { loadProviders, upsertProvider, deleteProvider, probeModels, PROTOCOLS } from '../store/providers.js';
import { toast, confirmDialog } from './feedback.js';
import { t, applyStaticI18n } from '../i18n.js';

export function createModelsView(el) {
  let selectedId = loadProviders()[0]?.id || null;
  let creating = false;

  el.innerHTML = `<div class="view-inner"><div class="models-grid">
    <div>
      <div class="section-title"><span data-i18n="models.providers"></span> <span class="tail"><button class="btn ghost sm" id="btn-add" data-i18n="models.addProvider"></button></span></div>
      <div class="provider-list" id="provider-list"></div>
      <div class="hint" data-i18n-html="models.noteHtml" style="font-size:12px;color:var(--text-faint);margin-top:14px;line-height:1.8"></div>
    </div>
    <div id="editor-host"></div>
  </div></div>`;
  applyStaticI18n(el);

  const listEl = el.querySelector('#provider-list');
  const hostEl = el.querySelector('#editor-host');

  function renderList() {
    const list = loadProviders();
    listEl.innerHTML = list.map((p) => `
      <div class="provider-item ${p.id === selectedId && !creating ? 'active' : ''}" data-id="${p.id}">
        <div class="p-name-wrap">
          <div class="p-name">${esc(p.name)}</div>
          <div class="p-meta">${esc(p.id)} · ${t('models.modelCount', { n: p.models?.length || 0 })} ${p.apiKey ? '· 🔑' : ''}</div>
        </div>
        <div class="p-actions"><button class="btn ghost sm" data-act="del">${t('common.delete')}</button></div>
      </div>`).join('') || `<div class="empty-hint">${t('models.emptyList')}</div>`;
    listEl.querySelectorAll('.provider-item').forEach((node) => {
      node.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="del"]')) return;
        creating = false;
        selectedId = node.dataset.id;
        renderList();
        renderEditor();
      });
      node.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
        const p = loadProviders().find((x) => x.id === node.dataset.id);
        if (!p) return;
        if (await confirmDialog({ title: t('models.deleteTitle'), text: t('models.deleteText', { name: p.name }), confirmText: t('models.deleteTitle'), danger: true })) {
          deleteProvider(p.id);
          if (selectedId === p.id) selectedId = loadProviders()[0]?.id || null;
          renderList();
          renderEditor();
          toast(t('models.deleted'), { type: 'good' });
        }
      });
    });
  }

  function blankProvider() {
    return {
      id: '',
      name: t('models.blankName'),
      protocol: 'openai-completions',
      baseUrl: 'https://api.example.com/v1',
      apiKey: '',
      viaProxy: 'auto',
      headers: [],
      timeoutMs: 300000,
      models: [],
    };
  }

  function provider() {
    if (creating) return blankProvider();
    return loadProviders().find((p) => p.id === selectedId) || null;
  }

  function renderEditor() {
    const p = provider();
    if (!p) {
      hostEl.innerHTML = `<div class="empty-hint">${t('models.pickOrNew')}</div>`;
      return;
    }
    const protocolOpts = PROTOCOLS.map((x) => `<option value="${x.id}" ${p.protocol === x.id ? 'selected' : ''} ${x.available ? '' : 'disabled'}>${x.name}</option>`).join('');
    hostEl.innerHTML = `<div class="editor">
      <div class="section-title">${creating ? t('models.newProvider') : t('models.edit', { name: esc(p.name) })}</div>
      <div class="form-grid">
        <label class="field"><span class="lbl">${t('models.f.id')}</span>
          <input type="text" id="f-id" value="${esc(p.id)}" ${creating ? '' : 'disabled'} placeholder="my-gateway">
        </label>
        <label class="field"><span class="lbl">${t('models.f.name')}</span>
          <input type="text" id="f-name" value="${esc(p.name)}">
        </label>
        <label class="field full"><span class="lbl">${t('models.f.baseUrl')}</span>
          <input type="text" id="f-baseurl" value="${esc(p.baseUrl)}" placeholder="http://127.0.0.1:8080/v1">
          <span class="hint">${t('models.f.baseUrlHint')}</span>
        </label>
        <label class="field"><span class="lbl">${t('models.f.protocol')}</span>
          <select id="f-protocol">${protocolOpts}</select>
        </label>
        <label class="field"><span class="lbl">${(p.apiKey && !creating) ? t('models.f.apiKeySaved') : t('models.f.apiKeyOptional')}</span>
          <input type="password" id="f-apikey" value="${creating ? esc(p.apiKey || '') : ''}" placeholder="${(p.apiKey && !creating) ? t('models.f.apikeyPlaceholderSaved') : 'sk-...'}">
        </label>
        <label class="field"><span class="lbl">${t('models.f.viaProxy')}</span>
          <select id="f-viaproxy">
            <option value="auto" ${p.viaProxy === 'auto' ? 'selected' : ''}>${t('models.f.viaProxyAuto')}</option>
            <option value="always" ${p.viaProxy === 'always' ? 'selected' : ''}>${t('models.f.viaProxyAlways')}</option>
            <option value="never" ${p.viaProxy === 'never' ? 'selected' : ''}>${t('models.f.viaProxyNever')}</option>
          </select>
        </label>
        <label class="field"><span class="lbl">${t('models.f.timeout')}</span>
          <input type="number" id="f-timeout" min="10" max="3600" value="${Math.round((p.timeoutMs || 300000) / 1000)}">
        </label>
        <label class="field full"><span class="lbl">${t('models.f.headers')}</span>
          <textarea id="f-headers" rows="2" placeholder="X-Custom-Header: value">${esc((p.headers || []).map((h) => `${h.k}: ${h.v}`).join('\n'))}</textarea>
        </label>
        <label class="field full"><span class="lbl">${t('models.f.extra')}</span>
          <textarea id="f-extra" rows="2" placeholder='{"chat_template_kwargs": {"enable_thinking": false}}'>${esc(p.extraBody ? JSON.stringify(p.extraBody) : '')}</textarea>
          <span class="hint">${t('models.f.extraHint')}</span>
        </label>
      </div>

      <div class="section">
        <div class="section-title">${t('models.modelDir')}
          <span class="tail">
            <button class="btn ghost sm" id="btn-probe">${t('models.probe')}</button>
            <button class="btn ghost sm" id="btn-addmodel">${t('models.addModel')}</button>
          </span>
        </div>
        <div class="models-scroll">
          <div class="model-row head">
            <span>${t('models.col.id')}</span><span>${t('models.col.name')}</span><span>${t('models.col.ctx')}</span><span>${t('models.col.maxTokens')}</span><span>${t('models.col.temp')}</span><span>top_p</span><span>top_k</span><span>${t('models.col.thinking')}</span><span></span>
          </div>
          <div id="model-rows"></div>
        </div>
        <div class="probe-result" id="probe-result"></div>
      </div>

      <div class="modal-actions" style="justify-content:flex-start">
        <button class="btn primary" id="btn-save">${t('models.save')}</button>
        ${!creating ? `<button class="btn ghost" id="btn-test">${t('models.test')}</button>` : ''}
      </div>
    </div>`;

    renderModelRows();

    hostEl.querySelector('#btn-addmodel').addEventListener('click', () => {
      const rows = collectModels();
      rows.push({ id: '', name: '', ctx: 262144, maxTokens: 32768, temperature: 1.0, topP: 0.95, topK: 20, thinking: false });
      paintModelRows(rows);
    });
    hostEl.querySelector('#btn-probe').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = t('models.probing');
      const baseUrl = hostEl.querySelector('#f-baseurl').value.trim();
      const apiKey = hostEl.querySelector('#f-apikey').value.trim() || p.apiKey || '';
      const headers = parseHeaders(hostEl.querySelector('#f-headers').value);
      const viaProxy = hostEl.querySelector('#f-viaproxy').value;
      const res = await probeModels({ baseUrl, apiKey, viaProxy, headers });
      btn.disabled = false;
      btn.textContent = t('models.probe');
      const box = hostEl.querySelector('#probe-result');
      if (!res.ok) {
        box.innerHTML = `<span class="tag bad">${esc(t('models.probeFailed', { err: res.error || '' }))}</span>`;
        return;
      }
      if (!res.models.length) {
        box.innerHTML = `<span class="tag">${t('models.probeEmpty')}</span>`;
        return;
      }
      const existing = new Set(collectModels().map((m) => m.id));
      box.innerHTML = res.models.map((id) => `<span class="probe-chip ${existing.has(id) ? 'added' : ''}" data-id="${esc(id)}">${esc(id)}</span>`).join('');
      box.querySelectorAll('.probe-chip:not(.added)').forEach((chip) => {
        chip.addEventListener('click', () => {
          const rows = collectModels();
          rows.push({ id: chip.dataset.id, name: chip.dataset.id, ctx: 262144, maxTokens: 32768, temperature: 1.0, topP: 0.95, topK: 20, thinking: false });
          paintModelRows(rows);
          chip.classList.add('added');
          toast(t('models.addedModel', { id: chip.dataset.id }), { type: 'info' });
        });
      });
    });
    hostEl.querySelector('#btn-save').addEventListener('click', () => save());
    hostEl.querySelector('#btn-test')?.addEventListener('click', async () => {
      const p2 = collectProvider();
      const model = p2.models[0];
      if (!model?.id) { toast(t('models.needModel'), { type: 'warn' }); return; }
      toast(t('models.testing'), { type: 'info', title: t('models.testTitle') });
      try {
        const { chatCompletion } = await import('../ai/openai.js');
        const res = await chatCompletion({
          baseUrl: p2.baseUrl,
          apiKey: p2.apiKey,
          model: model.id,
          messages: [{ role: 'user', content: t('models.pingPrompt') }],
          maxTokens: 16,
          timeoutMs: Math.min(p2.timeoutMs || 300000, 120000),
          viaProxy: p2.viaProxy,
          headers: p2.headers,
          extraBody: p2.extraBody,
        });
        const tps = res.timings?.predicted_per_second;
        toast(t('models.testOk', { tokens: res.usage.total_tokens, ms: Math.round(res.latencyMs), extra: tps ? ` · ${tps.toFixed(1)} tok/s` : '' }), { type: 'good', title: t('models.testTitle') });
      } catch (e) {
        toast(t('models.testFail', { msg: e.message }), { type: 'bad', title: t('models.testTitle'), ms: 9000 });
      }
    });
  }

  function renderModelRows() {
    paintModelRows(provider()?.models || []);
  }

  function paintModelRows(rows) {
    const host = hostEl.querySelector('#model-rows');
    if (!host) return;
    host.innerHTML = rows.map((m, i) => `
      <div class="model-row" data-i="${i}">
        <input type="text" data-f="id" value="${esc(m.id || '')}" placeholder="model-id">
        <input type="text" data-f="name" value="${esc(m.name || '')}" placeholder="${t('models.col.name')}">
        <input type="number" data-f="ctx" value="${m.ctx ?? ''}" placeholder="262144">
        <input type="number" data-f="maxTokens" value="${m.maxTokens ?? ''}" placeholder="1024">
        <input type="number" step="0.05" data-f="temperature" value="${m.temperature ?? ''}" placeholder="1.0">
        <input type="number" step="0.05" data-f="topP" value="${m.topP ?? ''}" placeholder="0.95">
        <input type="number" data-f="topK" value="${m.topK ?? ''}" placeholder="20">
        <input type="checkbox" data-f="thinking" ${m.thinking ? 'checked' : ''} style="width:auto;justify-self:center">
        <button class="del" title="${t('common.delete')}">✕</button>
      </div>`).join('') || `<div class="kv" style="padding:10px 0"><span class="k">${t('models.noModelsRow')}</span><span class="v">${t('models.noModelsRowHint')}</span></div>`;
    host.querySelectorAll('.model-row').forEach((row) => {
      row.querySelector('.del')?.addEventListener('click', () => {
        const rows2 = collectModels().filter((_, i) => i !== Number(row.dataset.i));
        paintModelRows(rows2);
      });
    });
  }

  function collectModels() {
    const rows = [];
    hostEl.querySelectorAll('#model-rows .model-row').forEach((row) => {
      const get = (f) => row.querySelector(`[data-f="${f}"]`);
      const id = get('id').value.trim();
      if (!id) return;
      rows.push({
        id,
        name: get('name').value.trim() || id,
        ctx: numOrNull(get('ctx').value),
        maxTokens: numOrNull(get('maxTokens').value),
        temperature: numOrNull(get('temperature').value),
        topP: numOrNull(get('topP').value),
        topK: numOrNull(get('topK').value),
        thinking: get('thinking').checked,
      });
    });
    return rows;
  }

  function collectProvider() {
    const p = provider() || blankProvider();
    const keyInput = hostEl.querySelector('#f-apikey')?.value.trim();
    const extraText = hostEl.querySelector('#f-extra')?.value.trim() || '';
    let extraBody = null;
    let extraError = null;
    if (extraText) {
      try {
        extraBody = JSON.parse(extraText);
      } catch (e) {
        extraError = e.message;
      }
    }
    return {
      ...p,
      id: (creating ? hostEl.querySelector('#f-id').value.trim() : p.id),
      name: hostEl.querySelector('#f-name').value.trim() || p.id,
      baseUrl: hostEl.querySelector('#f-baseurl').value.trim(),
      protocol: hostEl.querySelector('#f-protocol').value,
      apiKey: keyInput ? keyInput : (p.apiKey || ''),
      viaProxy: hostEl.querySelector('#f-viaproxy').value,
      timeoutMs: Math.max(10, Number(hostEl.querySelector('#f-timeout').value) || 300) * 1000,
      headers: parseHeaders(hostEl.querySelector('#f-headers').value),
      extraBody,
      _extraError: extraError,
      models: collectModels(),
    };
  }

  function save() {
    const p = collectProvider();
    if (p._extraError) {
      toast(t('models.extraNotJson', { err: p._extraError }), { type: 'warn' });
      return;
    }
    delete p._extraError;
    if (!/^[a-z0-9][a-z0-9-_]{0,40}$/.test(p.id)) {
      toast(t('models.badId'), { type: 'warn' });
      return;
    }
    const list = loadProviders();
    if (creating && list.some((x) => x.id === p.id)) {
      toast(t('models.dupId', { id: p.id }), { type: 'warn' });
      return;
    }
    if (!p.baseUrl) {
      toast(t('models.emptyBaseUrl'), { type: 'warn' });
      return;
    }
    upsertProvider(p);
    creating = false;
    selectedId = p.id;
    renderList();
    renderEditor();
    toast(t('models.saved', { name: p.name }), { type: 'good' });
  }

  el.querySelector('#btn-add').addEventListener('click', () => {
    creating = true;
    renderList();
    renderEditor();
  });

  renderList();
  renderEditor();

  return {
    el,
    show() {
      if (!creating && !loadProviders().some((p) => p.id === selectedId)) {
        selectedId = loadProviders()[0]?.id || null;
      }
      renderList();
      renderEditor();
    },
    rerender() {
      applyStaticI18n(el);
      renderList();
      renderEditor();
    },
  };
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function parseHeaders(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf(':');
      if (i <= 0) return null;
      return { k: line.slice(0, i).trim(), v: line.slice(i + 1).trim() };
    })
    .filter((h) => h && h.k);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}