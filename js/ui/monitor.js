// 系统监控：llama.cpp 服务数据（/props /health /slots /metrics）+ 本机 CPU/GPU 资源
import { loadProviders, loadUiPrefs, saveUiPrefs } from '../store/providers.js';
import { createSparkline } from './charts.js';
import { fmtBytes, fmtNum, fmtTps } from '../util.js';
import { t, applyStaticI18n } from '../i18n.js';

export function createMonitorView(el) {
  const prefs = loadUiPrefs();
  const state = {
    target: prefs.monitorTarget || '',
    timer: null,
    lastTps: null,
    lastMetrics: null,
    lastMetricsAt: null,
    sparkCpu: null,
    sparkGpu: null,
    sparkTps: null,
  };

  el.innerHTML = `<div class="view-inner">
    <div class="monitor-target">
      <span class="dim" style="font-size:13px" data-i18n="monitor.target">${t('monitor.target')}</span>
      <select id="mon-target"></select>
      <input type="text" id="mon-url" placeholder="http://127.0.0.1:8080" style="width:280px">
      <button class="btn sm" id="mon-apply" data-i18n="monitor.apply">${t('monitor.apply')}</button>
      <span class="pill" id="mon-status" data-i18n="monitor.notStarted">${t('monitor.notStarted')}</span>
    </div>
    <div class="monitor-grid">
      <div class="panel">
        <div class="section-title"><span data-i18n="monitor.localResources">${t('monitor.localResources')}</span> <span class="tail dim" style="font-size:11px" data-i18n="monitor.every3s">${t('monitor.every3s')}</span></div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
          <div>
            <div class="metric-big" id="m-cpu">—</div>
            <div class="metric-sub" id="m-cpu-sub">CPU</div>
            <div class="gauge-bar"><i id="bar-cpu" style="width:0"></i></div>
          </div>
          <div>
            <div class="metric-big" id="m-mem">—</div>
            <div class="metric-sub" id="m-mem-sub" data-i18n="monitor.mem">${t('monitor.mem')}</div>
            <div class="gauge-bar"><i id="bar-mem" style="width:0"></i></div>
          </div>
          <div>
            <div class="metric-big" id="m-gpu">—</div>
            <div class="metric-sub" id="m-gpu-sub">GPU</div>
            <div class="gauge-bar"><i id="bar-gpu" style="width:0"></i></div>
          </div>
        </div>
        <canvas class="spark" id="spark-cpu"></canvas>
        <canvas class="spark" id="spark-gpu" style="margin-top:6px"></canvas>
      </div>

      <div class="panel">
        <div class="section-title" data-i18n="monitor.gpuEngines">${t('monitor.gpuEngines')}</div>
        <div class="engine-list" id="m-engines"><div class="dim" style="font-size:12px" data-i18n="monitor.waitingSample">${t('monitor.waitingSample')}</div></div>
        <div class="section" style="margin-top:12px">
          <div class="section-title" data-i18n="monitor.llamaProc">${t('monitor.llamaProc')}</div>
          <div id="m-procs"><div class="dim" style="font-size:12px" data-i18n="monitor.noLlamaProc">${t('monitor.noLlamaProc')}</div></div>
        </div>
      </div>

      <div class="panel">
        <div class="section-title"><span data-i18n="monitor.llamaServiceInfo">${t('monitor.llamaServiceInfo')}</span> <span class="tail dim" style="font-size:11px" id="m-svc-sub"></span></div>
        <div id="m-svc"><div class="dim" style="font-size:12px" data-i18n="monitor.svcHint">${t('monitor.svcHint')}</div></div>
      </div>

      <div class="panel">
        <div class="section-title"><span data-i18n="monitor.genSpeed">${t('monitor.genSpeed')}</span> <span class="tail dim" style="font-size:11px" data-i18n="monitor.fromMetrics">${t('monitor.fromMetrics')}</span></div>
        <div class="metric-big" id="m-tps">—<span class="metric-unit">tok/s</span></div>
        <div class="metric-sub" id="m-tps-sub" data-i18n="monitor.tpsSub">${t('monitor.tpsSub')}</div>
        <canvas class="spark" id="spark-tps"></canvas>
      </div>

      <div class="panel">
        <div class="section-title"><span data-i18n="monitor.runMetrics">${t('monitor.runMetrics')}</span> <span class="tail dim" style="font-size:11px" id="m-metrics-sub"></span></div>
        <div id="m-metrics"><div class="dim" style="font-size:12px">—</div></div>
      </div>

      <div class="panel">
        <div class="section-title"><span data-i18n="monitor.slots">${t('monitor.slots')}</span> <span class="tail dim" style="font-size:11px">/slots</span></div>
        <div id="m-slots"><div class="dim" style="font-size:12px">—</div></div>
      </div>
    </div>
  </div>`;

  const $ = (id) => el.querySelector(`#${id}`);

  // 目标下拉：已配置的 provider + 手动
  function refreshTargetOptions() {
    const list = loadProviders();
    const opts = list.map((p) => {
      const root = p.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
      return `<option value="${root}">${esc(p.name)} (${root})</option>`;
    });
    opts.push(`<option value="">${t('monitor.manualOption')}</option>`);
    $('mon-target').innerHTML = opts.join('');
    const initUrl = state.target || (list[0] ? list[0].baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '') : 'http://127.0.0.1:8080');
    const matched = [...$('mon-target').options].find((o) => o.value === initUrl);
    if (matched) $('mon-target').value = initUrl;
    $('mon-url').value = initUrl;
  }

  refreshTargetOptions();
  $('mon-target').addEventListener('change', () => {
    const v = $('mon-target').value;
    if (v) $('mon-url').value = v;
  });
  $('mon-apply').addEventListener('click', () => {
    state.target = $('mon-url').value.trim().replace(/\/+$/, '');
    saveUiPrefs({ monitorTarget: state.target });
    poll(true);
  });

  // llama 接口访问（直连失败自动走本地代理）
  async function llamaFetch(path) {
    if (!state.target) return null;
    const url = `${state.target}${path}`;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      return { ok: r.ok, status: r.status, res: r };
    } catch {
      try {
        const r = await fetch(`/proxy?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
        return { ok: r.ok, status: r.status, res: r, viaProxy: true };
      } catch (e) {
        return null;
      }
    }
  }

  function parsePrometheus(text) {
    const map = {};
    for (const line of String(text).split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const i = line.lastIndexOf(' ');
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      const v = Number(line.slice(i + 1));
      if (isFinite(v)) map[k] = v;
    }
    return map;
  }

  function pickMetric(map, ...names) {
    for (const n of names) {
      for (const k of Object.keys(map)) {
        if (k === n || k.includes(n)) return { key: k, value: map[k] };
      }
    }
    return null;
  }

  async function poll(force = false) {
    if (!el.classList.contains('active') && !force) return;
    const status = $('mon-status');

    // ---- 系统信息 ----
    try {
      const r = await fetch('/api/sysinfo', { cache: 'no-store' });
      if (r.ok) {
        const s = await r.json();
        renderSys(s);
      } else {
        renderSys(null);
      }
    } catch {
      renderSys(null);
    }

    // ---- llama ----
    if (!state.target) {
      status.textContent = t('monitor.notSet');
      status.className = 'pill bad';
      return;
    }
    const propsRes = await llamaFetch('/props');
    if (!propsRes || !propsRes.ok) {
      status.textContent = t('monitor.unreachable');
      status.className = 'pill bad';
      const code = propsRes && propsRes.status ? `HTTP ${propsRes.status}` : t('monitor.noResponse');
      $('m-svc').innerHTML = `<div class="tag bad">${t('monitor.cantAccess', { target: esc(state.target), code })}</div>
        <div class="dim" style="font-size:12px;margin-top:8px">${t('monitor.checkLlama')}</div>`;
      renderMetricsUnavailable(code);
      $('m-slots').innerHTML = '<div class="dim" style="font-size:12px">—</div>';
      $('m-svc-sub').textContent = '';
      return;
    }
    status.className = 'pill ok';
    status.textContent = propsRes.viaProxy ? t('monitor.viaProxy') : t('monitor.online');
    const props = await propsRes.res.json().catch(() => ({}));
    renderServiceInfo(props);

    // health
    llamaFetch('/health').then(async (h) => {
      if (!h) return;
      const j = await h.res.json().catch(() => ({}));
      $('m-svc-sub').textContent = j.status === 'ok' ? t('monitor.healthOk') : '';
    });

    // metrics
    const metricsRes = await llamaFetch('/metrics');
    if (metricsRes && metricsRes.ok) {
      const text = await metricsRes.res.text();
      if (text.includes('#') || text.includes('llama_')) {
        renderMetrics(parsePrometheus(text));
      } else {
        renderMetricsUnavailable(t('monitor.metricsOff'));
      }
    } else {
      renderMetricsUnavailable(metricsRes ? `HTTP ${metricsRes.status}` : t('monitor.unavailable'));
    }

    // slots
    const slotsRes = await llamaFetch('/slots');
    if (slotsRes && slotsRes.ok) {
      const slots = await slotsRes.res.json().catch(() => null);
      renderSlots(slots);
    } else {
      $('m-slots').innerHTML = `<div class="tag">${t('monitor.slotsUnavailable')}</div>`;
    }
  }

  function renderSys(s) {
    if (!s) {
      $('m-cpu').textContent = '—';
      $('m-cpu-sub').textContent = t('monitor.localServiceDown');
      return;
    }
    const cpu = s.cpu?.usagePct;
    const memPct = s.mem?.usedPct;
    const gpuPct = s.gpu?.totalPct;
    $('m-cpu').innerHTML = cpu != null ? `${cpu.toFixed(1)}<span class="metric-unit">%</span>` : '—';
    $('m-cpu-sub').textContent = t('monitor.cores', { n: s.cpu?.cores || '?', cpu: truncate(s.cpu?.model, 40) });
    setBar('bar-cpu', cpu);
    $('m-mem').innerHTML = memPct != null ? `${memPct.toFixed(1)}<span class="metric-unit">%</span>` : '—';
    $('m-mem-sub').textContent = s.mem ? `${fmtBytes(s.mem.totalBytes - s.mem.freeBytes)} / ${fmtBytes(s.mem.totalBytes)}` : '';
    setBar('bar-mem', memPct);
    $('m-gpu').innerHTML = gpuPct != null ? `${gpuPct.toFixed(1)}<span class="metric-unit">%</span>` : '—';
    $('m-gpu-sub').textContent = `${s.gpu?.name || ''} · ${t('monitor.vram', { ded: fmtBytes(s.gpu?.dedicatedBytes), shared: fmtBytes(s.gpu?.sharedBytes) })}`;
    setBar('bar-gpu', gpuPct);
    state.sparkCpu?.push(cpu);
    state.sparkGpu?.push(gpuPct);

    // 引擎
    const engines = Object.entries(s.gpu?.engines || {});
    $('m-engines').innerHTML = engines.length ? engines.map(([k, v]) => `
      <div class="engine-row">
        <span class="e-name">${esc(k.toUpperCase())}</span>
        <span class="e-bar"><i style="width:${Math.min(100, v)}%"></i></span>
        <span class="e-val">${v.toFixed(1)}%</span>
      </div>`).join('') : `<div class="dim" style="font-size:12px">${t('monitor.noData')}</div>`;

    // 进程
    const procs = s.llamas || [];
    $('m-procs').innerHTML = procs.length ? procs.map((p) => `
      <div class="kv"><span class="k">${esc(p.name)} #${p.pid}</span>
        <span class="v num">${t('monitor.procMem', { mem: fmtBytes(p.memBytes) })}${p.cpuPct != null ? ` · CPU ${p.cpuPct.toFixed(1)}%` : ''}${p.gpuDedicatedBytes ? ` · ${t('monitor.vramShort', { v: fmtBytes(p.gpuDedicatedBytes) })}` : ''}</span></div>
      <div class="kv"><span class="k"></span><span class="v num">${t('monitor.gpuUsage', { pct: p.gpuPct != null ? p.gpuPct.toFixed(1) + '%' : '—' })}</span></div>`).join('')
      : `<div class="dim" style="font-size:12px">${t('monitor.noLlamaProc')}</div>`;
  }

  function setBar(id, pct) {
    const bar = $(id);
    if (!bar) return;
    const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    bar.style.width = `${v}%`;
    bar.className = v > 90 ? 'bad' : v > 70 ? 'warn' : '';
  }

  function renderServiceInfo(props) {
    const gen = props.default_generation_settings || {};
    const rows = [
      [t('monitor.modelPath'), props.model_path ? props.model_path.split(/[\\/]/).pop() : null],
      [t('monitor.ctxLen'), gen.n_ctx || props.n_ctx || null],
      [t('monitor.buildVersion'), props.build_info || null],
      [t('monitor.chatTemplate'), props.chat_template ? (props.chat_template.slice(0, 40) + '…') : null],
      [t('monitor.inferParams'), [gen.temperature != null ? `temp ${gen.temperature}` : null, props.top_p != null ? `top_p ${props.top_p}` : null].filter(Boolean).join(' · ') || null],
    ].filter(([, v]) => v != null);
    $('m-svc').innerHTML = rows.length
      ? rows.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v num" style="max-width:62%;word-break:break-all">${esc(String(v))}</span></div>`).join('')
      : `<div class="dim" style="font-size:12px">${t('monitor.noModelInfo')}</div>`;
  }

  function renderMetrics(map) {
    const predicted = pickMetric(map, 'tokens_predicted_total');
    const evaluated = pickMetric(map, 'tokens_evaluated_total', 'prompt_tokens_total');
    const cached = pickMetric(map, 'prompt_tokens_cached_total');
    const kvRatio = pickMetric(map, 'kv_cache_usage_ratio');
    const kvTokens = pickMetric(map, 'kv_cache_tokens');
    const processing = pickMetric(map, 'requests_processing');
    const deferred = pickMetric(map, 'requests_deferred');
    const avgGen = pickMetric(map, 'predicted_tokens_seconds');
    const avgPrompt = pickMetric(map, 'prompt_tokens_seconds');
    const draftN = pickMetric(map, 'spec_decode_num_draft_tokens_total');
    const draftAcc = pickMetric(map, 'spec_decode_num_accepted_tokens_total');

    const now = performance.now();
    if (predicted && state.lastMetrics) {
      const dt = (now - state.lastMetricsAt) / 1000;
      const delta = predicted.value - (state.lastMetrics.predicted || 0);
      if (dt > 0.5 && delta >= 0) {
        const tps = delta / dt;
        state.lastTps = tps;
        $('m-tps').innerHTML = `${tps.toFixed(1)}<span class="metric-unit">tok/s</span>`;
        state.sparkTps?.push(tps);
      }
    } else if (!predicted) {
      $('m-tps').innerHTML = '—<span class="metric-unit">tok/s</span>';
      $('m-tps-sub').textContent = t('monitor.needMetrics');
    }
    state.lastMetrics = { predicted: predicted?.value || 0 };
    state.lastMetricsAt = now;
    if (predicted) $('m-tps-sub').textContent = t('monitor.tpsSub');

    const rows = [];
    if (predicted) rows.push([t('monitor.genTokens'), fmtNum(predicted.value)]);
    if (evaluated) rows.push([t('monitor.promptTokens'), fmtNum(evaluated.value)]);
    if (cached) rows.push([t('monitor.cachedTokens'), fmtNum(cached.value)]);
    if (kvRatio) rows.push([t('monitor.kvUsage'), `${(kvRatio.value * 100).toFixed(1)}%`]);
    if (kvTokens) rows.push([t('monitor.kvTokens'), fmtNum(kvTokens.value)]);
    if (avgGen && avgGen.value > 0) rows.push([t('monitor.avgGen'), fmtTps(avgGen.value)]);
    if (avgPrompt && avgPrompt.value > 0) rows.push([t('monitor.avgPrompt'), fmtTps(avgPrompt.value)]);
    if (draftN && draftAcc) {
      const rate = draftN.value ? (draftAcc.value / draftN.value) * 100 : 0;
      rows.push([t('monitor.mtpDraft'), `${fmtNum(draftN.value)} / ${fmtNum(draftAcc.value)} (${rate.toFixed(1)}%)`]);
    }
    if (processing) rows.push([t('monitor.processing'), fmtNum(processing.value)]);
    if (deferred) rows.push([t('monitor.deferred'), fmtNum(deferred.value)]);
    $('m-metrics').innerHTML = rows.length
      ? rows.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v num">${v}</span></div>`).join('')
      : `<div class="dim" style="font-size:12px">${t('monitor.noMetrics')}</div>`;
    $('m-metrics-sub').textContent = t('monitor.samplingOk');
  }

  function renderMetricsUnavailable(reason) {
    $('m-metrics').innerHTML = `<div class="tag warn">/metrics ${esc(reason)}</div>
      <div class="dim" style="font-size:12px;margin-top:8px">${t('monitor.metricsHintHtml')}</div>`;
    $('m-metrics-sub').textContent = '';
    $('m-tps-sub').textContent = t('monitor.needMetrics');
  }

  function renderSlots(slots) {
    if (!Array.isArray(slots) || !slots.length) {
      $('m-slots').innerHTML = `<div class="dim" style="font-size:12px">${t('monitor.noSlotData')}</div>`;
      return;
    }
    $('m-slots').innerHTML = slots.map((sl, i) => {
      const nCtx = sl.n_ctx || 1;
      // 兼容不同版本的字段：n_past / n_prompt_tokens_processed + n_decoded
      const used = sl.n_past ?? ((sl.n_prompt_tokens_processed ?? sl.n_prompt_tokens ?? 0) + (sl.next_token?.n_decoded ?? 0));
      const pct = Math.min(100, (used / nCtx) * 100);
      const flag = sl.is_processing != null ? (sl.is_processing ? t('monitor.processingState') : t('monitor.idleState')) : (sl.state || '');
      return `<div style="margin-bottom:10px">
        <div class="kv" style="padding:0"><span class="k">${t('monitor.slot', { id: sl.id ?? i })}${sl.speculative ? ' · MTP' : ''}</span>
          <span class="v num">${esc(flag)} · ${fmtNum(used)} / ${fmtNum(nCtx)}${sl.next_token?.n_remain != null ? ` · ${t('monitor.remaining', { n: sl.next_token.n_remain })}` : ''}</span></div>
        <div class="gauge-bar"><i style="width:${pct}%"></i></div>
      </div>`;
    }).join('');
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // 图表
  state.sparkCpu = createSparkline($('spark-cpu'), { max: 100, color: '#22d3ee' });
  state.sparkGpu = createSparkline($('spark-gpu'), { max: 100, color: '#7c8cff' });
  state.sparkTps = createSparkline($('spark-tps'), { max: 120, color: '#34d399' });

  state.timer = setInterval(() => poll(false), 2500);

  return {
    el,
    show() {
      refreshTargetOptions();
      poll(true);
    },
    rerender() {
      applyStaticI18n(el);
      refreshTargetOptions();
      poll(true);
    },
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}