// 历史记录：对局列表、回放、导入导出
import { listGames, getGame, deleteGame, clearGames, saveGame } from '../store/db.js';
import { Board, BLACK, WHITE } from '../core/board.js';
import { t, applyStaticI18n, uiSide, uiWord } from '../i18n.js';
import { computeTotals } from '../core/game.js';
import { createBoardView } from './boardview.js';
import { toast, confirmDialog } from './feedback.js';
import { fmtMs, fmtNum, fmtTps, fmtTime } from '../util.js';

function reasonText(reason) {
  const key = {
    five: 'history.reason.five', full: 'history.reason.full', timeout: 'history.reason.timeout',
    illegal: 'history.reason.illegal', request: 'history.reason.request', manual: 'history.reason.manual',
    engine_fallback_over: 'history.reason.engineFallbackOver',
  }[reason];
  return key ? t(key) : reason;
}

export function createHistoryView(el) {
  let rows = [];
  let replay = null;

  el.innerHTML = `<div class="view-inner">
    <div class="history-wrap">
      <div>
        <div class="section-title"><span data-i18n="history.title">${t('history.title')}</span>
          <span class="tail">
            <button class="btn ghost sm" id="btn-import" data-i18n="history.import">${t('history.import')}</button>
            <button class="btn ghost sm" id="btn-export-all" data-i18n="history.exportAll">${t('history.exportAll')}</button>
            <button class="btn ghost sm danger" id="btn-clear" data-i18n="history.clear">${t('history.clear')}</button>
          </span>
        </div>
        <div class="history-list" id="hlist"></div>
      </div>
      <div id="replay-host"></div>
    </div>
  </div>`;

  const listEl = el.querySelector('#hlist');
  const replayHost = el.querySelector('#replay-host');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.style.display = 'none';
  el.appendChild(fileInput);

  async function refresh() {
    try {
      rows = await listGames();
    } catch (e) {
      rows = [];
      toast(t('history.readFail', { err: e.message }), { type: 'bad' });
    }
    renderList();
  }

  function resultBadge(r) {
    if (!r) return `<span class="badge running">${t('history.badge.running')}</span>`;
    if (r.reason === 'manual') return `<span class="badge running">${t('history.badge.stopped')}</span>`;
    if (!r.winner) return `<span class="badge draw">${t('history.badge.draw')}</span>`;
    return `<span class="badge ${r.winner === BLACK ? 'black' : 'white'}">${t('history.badge.win', { side: uiSide(r.winner) })}</span>`;
  }

  function renderList() {
    if (!rows.length) {
      listEl.innerHTML = `<div class="empty-hint">${t('history.empty')}</div>`;
      return;
    }
    listEl.innerHTML = rows.map((g) => {
      const dur = g.endedAt && g.startedAt ? fmtMs(g.endedAt - g.startedAt) : '—';
      const tokens = (g.totals?.[BLACK]?.totalTokens || 0) + (g.totals?.[WHITE]?.totalTokens || 0);
      return `<div class="history-row" data-id="${g.id}">
        <span class="hdate">${g.startedAt ? fmtTime(g.startedAt).slice(5) : '—'}</span>
        <span class="hvs">
          <span class="mlog-round-dot black"></span>${esc(g.black)}
          <span class="vs">vs</span>
          <span class="mlog-round-dot white"></span>${esc(g.white)}
        </span>
        <span class="hres">${resultBadge(g.result)}</span>
        <span class="num dim" style="font-size:12px">${t('history.moveCount', { n: g.moveCount })}</span>
        <span class="num dim" style="font-size:12px">${dur}</span>
        <span class="num dim" style="font-size:12px">${tokens ? fmtNum(tokens) + ' tok' : '—'}</span>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.history-row').forEach((row) => {
      row.addEventListener('click', () => openReplay(row.dataset.id));
    });
  }

  async function openReplay(id) {
    const record = await getGame(id);
    if (!record) { toast(t('history.notFound'), { type: 'warn' }); return; }
    stopPlay();
    replay = { record, index: record.moves.length, speed: 700 };
    renderReplay();
  }

  function renderReplay() {
    const rec = replay.record;
    const n = rec.moves.length;
    const size = rec.settings?.size || 15;
    replayHost.innerHTML = `<div class="panel">
      <div class="section-title" style="margin-bottom:6px">${t('history.replayLabel', { black: esc(rec.players?.black?.name || t('history.blackSide')), white: esc(rec.players?.white?.name || t('history.whiteSide')) })}</div>
      <div class="dim" style="font-size:12px;margin-bottom:12px">
        ${rec.startedAt ? fmtTime(rec.startedAt) : ''} · ${resultText(rec)} · ${t('history.replayMoves', { n })}${rec.endedAt && rec.startedAt ? ` · ${t('history.replayTotal', { t: fmtMs(rec.endedAt - rec.startedAt) })}` : ''}
      </div>
      <div class="replay-board-wrap" id="replay-board"></div>
      <div class="replay-controls">
        <button class="btn sm" id="rp-prev">◀</button>
        <button class="btn sm" id="rp-play">▶</button>
        <input type="range" class="replay-slider" id="rp-slider" min="0" max="${n}" value="${replay.index}">
        <span class="num dim" id="rp-counter" style="font-size:12px;min-width:64px;text-align:right">${replay.index}/${n}</span>
        <select id="rp-speed" style="width:auto">
          <option value="1400" ${replay.speed === 1400 ? 'selected' : ''}>${t('history.speed.slow')}</option>
          <option value="700" ${replay.speed === 700 ? 'selected' : ''}>${t('history.speed.normal')}</option>
          <option value="220" ${replay.speed === 220 ? 'selected' : ''}>${t('history.speed.fast')}</option>
        </select>
      </div>
      <div id="rp-moveinfo" style="margin-top:12px"></div>
      <div class="section" id="rp-totals"></div>
      <div class="modal-actions" style="justify-content:flex-start">
        <button class="btn ghost sm" id="rp-export">${t('history.exportOne')}</button>
        <button class="btn danger sm" id="rp-delete">${t('history.deleteOne')}</button>
      </div>
    </div>`;

    const boardHost = replayHost.querySelector('#replay-board');
    replay.board = createBoardView(boardHost, { size, onCellClick: null });
    replay.board.setInteractive(false);
    drawAt(replay.index, { animate: false });

    const slider = replayHost.querySelector('#rp-slider');
    slider.addEventListener('input', () => { stopPlay(); drawAt(Number(slider.value)); });
    replayHost.querySelector('#rp-prev').addEventListener('click', () => { stopPlay(); drawAt(Math.max(0, replay.index - 1)); });
    replayHost.querySelector('#rp-play').addEventListener('click', () => {
      stopPlay();
      if (replay.index >= n) replay.index = 0;
      replay.playing = true;
      replayHost.querySelector('#rp-play').textContent = '⏸';
      replay.timer = setInterval(() => {
        if (!replay?.playing) return;
        replay.index++;
        drawAt(replay.index);
        if (replay.index >= n) stopPlay();
      }, replay.speed);
    });
    replayHost.querySelector('#rp-speed').addEventListener('change', (e) => {
      replay.speed = Number(e.target.value);
      if (replay.playing) {
        stopPlay();
        replayHost.querySelector('#rp-play').click();
      }
    });
    replayHost.querySelector('#rp-export').addEventListener('click', () => downloadJson(`aiai-game-${rec.id}.json`, rec));
    replayHost.querySelector('#rp-delete').addEventListener('click', async () => {
      if (await confirmDialog({ title: t('history.delTitle'), text: t('history.delText'), confirmText: t('history.delTitle'), danger: true })) {
        await deleteGame(rec.id);
        replay = null;
        replayHost.innerHTML = `<div class="empty-hint">${t('history.pickRecord')}</div>`;
        refresh();
        toast(t('history.deleted'), { type: 'good' });
      }
    });
    renderTotals();
  }

  function resultText(rec) {
    const r = rec.result;
    if (!r) return t('history.badge.running');
    const base = r.winner ? t('history.badge.win', { side: uiSide(r.winner) }) : t('history.badge.draw');
    return t('history.resultText', { base, reason: reasonText(r.reason) });
  }

  function stopPlay() {
    if (replay?.timer) clearInterval(replay.timer);
    if (replay) { replay.timer = null; replay.playing = false; }
    const btn = replayHost.querySelector('#rp-play');
    if (btn) btn.textContent = '▶';
  }

  function drawAt(i, { animate = true } = {}) {
    const rec = replay.record;
    const n = rec.moves.length;
    i = Math.max(0, Math.min(n, i));
    replay.index = i;
    const b = replay.board;
    b.reset();
    const tmp = new Board(rec.settings?.size || 15);
    for (let k = 0; k < i; k++) {
      const m = rec.moves[k];
      tmp.place(m.r, m.c, m.color);
      b.applyMove(m, { animate: animate && k === i - 1 });
    }
    if (!animate && i > 0) b.setLast(rec.moves[i - 1]);
    // 终局时补上胜利连线
    if (i === n && rec.result?.winner) {
      const winnerMoves = rec.moves.filter((m) => m.color === rec.result.winner);
      const last = winnerMoves[winnerMoves.length - 1];
      if (last) {
        const win = tmp.checkWin(last.r, last.c);
        if (win) b.showWin(win.line);
      }
    }
    const slider = replayHost.querySelector('#rp-slider');
    if (slider) slider.value = i;
    const counter = replayHost.querySelector('#rp-counter');
    if (counter) counter.textContent = `${i}/${n}`;
    renderMoveInfo(i);
  }

  function renderMoveInfo(i) {
    const rec = replay.record;
    const box = replayHost.querySelector('#rp-moveinfo');
    if (!box) return;
    if (!i || i > rec.moves.length) {
      box.innerHTML = `<div class="dim" style="font-size:12.5px">${t('history.hintDrag')}</div>`;
      return;
    }
    const m = rec.moves[i - 1];
    const mt = m.metrics || {};
    const chips = [
      `#${m.n}`,
      `${uiWord(m.color)} ${m.label}`,
      m.playerName,
      mt.latencyMs != null ? fmtMs(mt.latencyMs) : null,
      mt.completionTokens != null ? `${fmtNum(mt.completionTokens)} tok` : null,
      mt.decodeTps != null ? fmtTps(mt.decodeTps) : null,
    ].filter(Boolean);
    const thought = m.thought?.reasoning || m.thought?.content || '';
    box.innerHTML = `
      <div class="tags" style="margin-top:0">${chips.map((c, idx) => `<span class="tag ${idx === 0 ? 'good' : ''}">${esc(String(c))}</span>`).join('')}</div>
      ${m.reason ? `<div class="dim" style="font-size:12.5px;margin-top:8px">${t('arena.detail.reason', { text: esc(m.reason) })}</div>` : ''}
      ${thought ? `<div class="thought" style="max-height:220px;overflow-y:auto;font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;background:rgba(6,8,13,.55);border:1px solid var(--line);border-radius:8px;padding:9px 11px;margin-top:8px">${esc(thought)}</div>` : ''}`;
  }

  function renderTotals() {
    const rec = replay.record;
    const totals = rec.totals || computeTotals(rec.moves);
    const box = replayHost.querySelector('#rp-totals');
    if (!box) return;
    const row = (label, color) => {
      const tot = totals[color];
      if (!tot) return '';
      return `<div class="kv"><span class="k">${label} · ${esc(rec.players?.[color === BLACK ? 'black' : 'white']?.name || '')}</span>
        <span class="v num">${t('history.totalsMoves', { n: tot.moves })} · ${fmtMs(tot.totalMs)} · ${fmtNum(tot.totalTokens)} tok · ${t('arena.stat.tps')} ${fmtTps(tot.avgTps)}${tot.fallbacks ? ` · ${t('history.totalsFallback', { n: tot.fallbacks })}` : ''}</span></div>`;
    };
    box.innerHTML = `<div class="section-title">${t('history.totals.title')}</div>${row(t('history.blackSide'), BLACK)}${row(t('history.whiteSide'), WHITE)}`;
  }

  // ---------------- 导入导出 ----------------
  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  el.querySelector('#btn-export-all').addEventListener('click', async () => {
    const all = [];
    for (const r of rows) {
      const full = await getGame(r.id);
      if (full) all.push(full);
    }
    if (!all.length) { toast(t('history.exportEmpty'), { type: 'warn' }); return; }
    downloadJson(`aiai-history-${new Date().toISOString().slice(0, 10)}.json`, all);
    toast(t('history.exported', { n: all.length }), { type: 'good' });
  });

  el.querySelector('#btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : [data];
      let count = 0;
      for (const rec of list) {
        if (rec && rec.id && Array.isArray(rec.moves)) {
          await saveGame(rec);
          count++;
        }
      }
      toast(t('history.imported', { n: count }), { type: 'good' });
      refresh();
    } catch (e) {
      toast(t('history.importFail', { err: e.message }), { type: 'bad' });
    }
  });

  el.querySelector('#btn-clear').addEventListener('click', async () => {
    if (await confirmDialog({ title: t('history.clearTitle'), text: t('history.clearText'), confirmText: t('history.clearConfirm'), danger: true })) {
      await clearGames();
      replay = null;
      replayHost.innerHTML = `<div class="empty-hint">${t('history.pickRecord')}</div>`;
      refresh();
      toast(t('history.cleared'), { type: 'good' });
    }
  });

  replayHost.innerHTML = `<div class="empty-hint">${t('history.pickRecord')}</div>`;

  return {
    el,
    show() {
      refresh();
    },
    rerender() {
      applyStaticI18n(el);
      renderList();
      if (replay) renderReplay();
    },
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}