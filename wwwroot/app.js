/* ============================================
   CS2 Voice Matcher - SPA Application v2
   Redesigned for smurf detection workflow
   ============================================ */

(function () {
  'use strict';

  // ---- State ----
  const state = {
    files: [],
    currentTab: 'upload',
    currentPlayer: null,
    playerSearchCache: null,
    demosCache: null,
    expandedDemo: null,
    currentAudioFile: null,
    compareMode: null,
    clustersCache: null,
    matchedSteamIds: new Set(),
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  async function api(path, options = {}) {
    const url = path.startsWith('http') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
    const res = await fetch(url, options);
    if (!res.ok) { const text = await res.text(); throw new Error(text || `HTTP ${res.status}`); }
    const ct = res.headers.get('content-type');
    return ct && ct.includes('application/json') ? res.json() : res.text();
  }

  // ---- Utility ----
  function formatPercent(v) { return v == null ? '-' : (v * 100).toFixed(1) + '%'; }

  function formatDuration(s) {
    if (s == null || s === 0) return '0s';
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m === 0 ? `${sec}s` : `${m}m ${sec}s`;
  }

  function formatFileSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function formatDate(d) {
    if (!d) return '-';
    try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return '-'; }
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied', 'info')).catch(() => showToast('Copy failed', 'error'));
  }

  function showToast(message, type = 'info') {
    const c = $('#toast-container'), t = document.createElement('div');
    t.className = `toast ${type}`; t.textContent = message; c.appendChild(t);
    setTimeout(() => { t.style.animation = 'toastOut 0.25s ease-in forwards'; t.addEventListener('animationend', () => t.remove()); }, 3000);
  }

  function tierColor(tier) {
    return tier === 'high' ? '#4eb748' : tier === 'medium' ? '#d4a843' : tier === 'low' ? '#dc5044' : '#8888a0';
  }

  function tierLabel(tier) {
    return tier === 'high' ? 'High' : tier === 'medium' ? 'Medium' : tier === 'low' ? 'Low' : 'Uncertain';
  }

  function simClass(v) { return v >= 0.85 ? 'high' : v >= 0.78 ? 'medium' : 'low'; }

  function extractMatchId(demoName) {
    if (!demoName) return null;
    const m = demoName.match(/^(1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return m ? m[1] : null;
  }

  function faceitLink(demoName, label) {
    const matchId = extractMatchId(demoName);
    if (!matchId) return escapeHtml(label || demoName || '-');
    const display = escapeHtml(label || demoName || matchId);
    return `<a href="https://www.faceit.com/en/cs2/room/${matchId}" target="_blank" rel="noopener" class="faceit-link" title="Open on FACEIT">${display}<svg class="inline-block w-3 h-3 ml-1 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`;
  }

  function renderSimBar(value, showLabel = true) {
    const pct = (value * 100).toFixed(1), cls = simClass(value);
    return `<div class="similarity-bar"><div class="similarity-bar-track"><div class="similarity-bar-fill ${cls}" style="width:${pct}%"></div></div>${showLabel ? `<span class="similarity-bar-value">${pct}%</span>` : ''}</div>`;
  }

  // ---- Audio ----
  function getPlayer() { return $('#audio-player'); }

  function playAudio(url) {
    const p = getPlayer(); if (!p) return;
    if (state.currentAudioFile === url && !p.paused) { stopAudio(); return; }
    p.src = url; p.play().catch(() => showToast('Playback failed', 'error'));
    state.currentAudioFile = url; updatePlayBtns();
  }

  function stopAudio() {
    const p = getPlayer(); if (!p) return;
    p.pause(); p.currentTime = 0; state.currentAudioFile = null; updatePlayBtns();
  }

  function updatePlayBtns() {
    $$('.audio-play-btn').forEach(btn => {
      const playing = state.currentAudioFile === btn.dataset.audioUrl;
      btn.classList.toggle('playing', playing);
      const icon = playing
        ? '<svg class="inline-block w-3 h-3 mr-1" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
        : '<svg class="inline-block w-3 h-3 mr-1" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
      const label = btn.dataset.label || '';
      btn.innerHTML = icon + label;
    });
  }

  function initAudioPlayer() {
    const p = getPlayer(); if (!p) return;
    p.addEventListener('ended', () => { state.currentAudioFile = null; updatePlayBtns(); });
  }

  function renderAudioBtns(files, audioPath) {
    if (!files || files.length === 0) return '<span class="text-xs text-text-dim" style="opacity:0.5">No voice data</span>';
    const sorted = [...files].sort(), MAX = 3;
    const preview = sorted.length <= MAX ? sorted : Array.from({length: MAX}, (_, i) => sorted[Math.floor(i * sorted.length / MAX)]);
    const uid = 'ac-' + Math.random().toString(36).slice(2, 8);

    const makeBtn = (file, cls) => {
      const url = `${audioPath}/${file}`;
      const label = file.replace('.wav', '').replace('round_', 'R').replace('_t_', ' @');
      return `<button class="audio-play-btn ${cls}" data-audio-url="${escapeHtml(url)}" data-label="${escapeHtml(label)}" title="${escapeHtml(file)}"><svg class="inline-block w-3 h-3 mr-1" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>${escapeHtml(label)}</button>`;
    };

    let html = '<div class="audio-section mt-2"><div class="audio-preview">' + preview.map(f => makeBtn(f, 'audio-preview-btn')).join('') + '</div>';
    if (sorted.length > MAX) {
      html += `<button class="audio-expand-toggle" data-target="${uid}">Show all ${sorted.length} clips <svg class="inline-block w-3 h-3 ml-1 chevron-mini" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></button>`;
      html += `<div class="audio-all-clips" id="${uid}">${sorted.map(f => makeBtn(f, '')).join('')}</div>`;
    }
    return html + '</div>';
  }

  function attachAudioHandlers(el) {
    el.querySelectorAll('.audio-play-btn').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); playAudio(b.dataset.audioUrl); }));
    el.querySelectorAll('.audio-expand-toggle').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const clips = document.getElementById(b.dataset.target); if (!clips) return;
      clips.classList.toggle('open');
      const ch = b.querySelector('.chevron-mini');
      if (ch) ch.style.transform = clips.classList.contains('open') ? 'rotate(180deg)' : '';
    }));
  }

  // ---- Caches ----
  function clearAllCaches() {
    state.playerSearchCache = null; state.demosCache = null; state.expandedDemo = null;
    state.currentPlayer = null; state.currentAudioFile = null; state.clustersCache = null;
    state.matchedSteamIds.clear();
  }

  async function loadMatchedSteamIds() {
    try {
      const matches = await api('/matches?threshold=0.80');
      state.matchedSteamIds.clear();
      for (const m of (Array.isArray(matches) ? matches : [])) {
        if (m.differentNames) { state.matchedSteamIds.add(m.steamId1); state.matchedSteamIds.add(m.steamId2); }
      }
    } catch {}
  }

  // ---- Stats ----
  async function loadStats() {
    try {
      const d = await api('/stats');
      $('#stat-demos').textContent = `${d.demos ?? 0} demos`;
      $('#stat-players').textContent = `${d.players ?? 0} players`;
      $('#stat-voice-matches').textContent = `${d.voiceMatches ?? 0} voice matches`;
    } catch {}
  }

  // ---- Tabs ----
  const TABS = ['upload', 'matches', 'players', 'identity-groups', 'compare'];

  function initTabs() {
    $$('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    const hash = location.hash.replace('#', '');
    if (TABS.includes(hash)) switchTab(hash);
    window.addEventListener('hashchange', () => { const h = location.hash.replace('#', ''); if (TABS.includes(h)) switchTab(h, false); });
  }

  function switchTab(tab, updateHash = true) {
    state.currentTab = tab; stopAudio();
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab-content').forEach(el => { const t = el.id === `tab-${tab}`; el.classList.toggle('hidden', !t); if (t) { el.style.animation = 'none'; el.offsetHeight; el.style.animation = ''; } });
    if (updateHash) history.replaceState(null, '', `#${tab}`);
    loadStats();
    if (tab === 'matches') { loadDemos(); loadMatchedSteamIds(); }
    else if (tab === 'players' && !state.playerSearchCache) loadPlayers();
  }

  // ---- Global Search ----
  function initGlobalSearch() {
    const i = $('#global-search-input'); if (!i) return;
    i.addEventListener('keydown', e => { if (e.key === 'Enter') { const q = i.value.trim(); if (q) { switchTab('players'); $('#player-search-input').value = q; loadPlayers(q); } } });
  }

  // ════════════════════════════════════════════
  //  UPLOAD TAB
  // ════════════════════════════════════════════

  function initUpload() {
    const dz = $('#drop-zone'), fi = $('#file-input');
    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.dem') || f.name.endsWith('.dem.zst')); if (!files.length) { showToast('Only .dem / .dem.zst files accepted', 'error'); return; } addFiles(files); });
    fi.addEventListener('change', () => { addFiles(Array.from(fi.files)); fi.value = ''; });
    $('#btn-upload-all').addEventListener('click', uploadAll);
    $('#btn-process').addEventListener('click', processAll);
    $('#btn-clear-files').addEventListener('click', clearFiles);
    $('#btn-faceit-import').addEventListener('click', importFaceit);
    $('#faceit-url-input').addEventListener('keydown', e => { if (e.key === 'Enter') importFaceit(); });
  }

  async function importFaceit() {
    const input = $('#faceit-url-input'), btn = $('#btn-faceit-import');
    const statusEl = $('#faceit-status'), infoEl = $('#faceit-info');
    const progressEl = $('#faceit-progress'), barEl = $('#faceit-bar');
    const url = input.value.trim();
    if (!url) { showToast('Paste a FACEIT match URL', 'error'); return; }
    if (!url.includes('faceit.com') && !url.startsWith('1-')) { showToast('Invalid FACEIT URL', 'error'); return; }

    btn.disabled = true; input.disabled = true;
    statusEl.classList.remove('hidden'); progressEl.classList.remove('hidden');
    barEl.style.width = '10%';
    infoEl.innerHTML = '<span class="text-text-dim">Fetching match info...</span>';

    try {
      const data = await api('/import-faceit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      barEl.style.width = '50%';
      const map = (data.mapName || '').replace('de_', '');
      const server = data.serverLocation || data.region || 'Unknown';
      const score = (data.score1 != null && data.score2 != null) ? `${data.score1}-${data.score2}` : '';
      const infoHtml = `<div class="flex flex-wrap items-center gap-2 text-sm"><span class="font-semibold">${escapeHtml(data.title || data.matchId)}</span>${score ? `<span class="badge">${score}</span>` : ''}${map ? `<span class="badge map">${escapeHtml(map)}</span>` : ''}<span class="text-text-dim">${escapeHtml(server)}</span></div>`;

      if (data.demoError) {
        barEl.style.width = '100%';
        infoEl.innerHTML = infoHtml + `<div class="text-xs mt-1" style="color:#e0a030">Warning: ${escapeHtml(data.demoError)}</div><div class="text-xs text-text-dim mt-1">Upload .dem manually.${data.demoUrl ? ` <a href="${escapeHtml(data.demoUrl)}" target="_blank" rel="noopener" class="text-accent underline">Direct link</a>` : ''}</div>`;
        showToast('Match loaded, demo download failed', 'warning');
      } else {
        infoEl.innerHTML = infoHtml + '<div class="text-xs text-success mt-1">Demo downloaded - processing...</div>';
        barEl.style.width = '60%';
        const pr = await api('/process', { method: 'POST' });
        if (pr.jobId) await pollJob(pr.jobId, null, barEl, 60);
        clearAllCaches(); loadStats(); showToast('FACEIT demo imported!', 'success');
      }
      input.value = '';
    } catch (e) {
      let msg = e.message; try { msg = JSON.parse(e.message).error || msg; } catch {}
      infoEl.innerHTML = `<span class="text-error text-sm">${escapeHtml(msg)}</span>`;
      showToast(`FACEIT import failed`, 'error');
    } finally {
      btn.disabled = false; input.disabled = false;
      setTimeout(() => { progressEl.classList.add('hidden'); barEl.style.width = '0%'; }, 3000);
    }
  }

  function addFiles(newFiles) {
    for (const f of newFiles) if (!state.files.find(sf => sf.file.name === f.name)) state.files.push({ file: f, status: 'queued' });
    renderFileList();
  }

  function clearFiles() { state.files = []; renderFileList(); }

  function renderFileList() {
    const c = $('#file-list'), a = $('#upload-actions'), e = $('#upload-empty');
    if (!state.files.length) { c.classList.add('hidden'); c.innerHTML = ''; a.classList.add('hidden'); e.classList.remove('hidden'); return; }
    e.classList.add('hidden'); c.classList.remove('hidden'); a.classList.remove('hidden');
    c.innerHTML = state.files.map(f => {
      const icon = f.status === 'done' ? '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>'
        : f.status === 'uploading' ? '<div class="spinner sm"></div>'
        : f.status === 'error' ? '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' : '';
      return `<div class="file-item"><svg class="w-4 h-4 text-text-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span class="file-name">${escapeHtml(f.file.name)}</span><span class="file-size">${formatFileSize(f.file.size)}</span><span class="file-status ${f.status}">${icon} ${f.status}</span></div>`;
    }).join('');
    const allDone = state.files.every(f => f.status === 'done');
    if (allDone && state.files.length) { $('#btn-process').classList.remove('hidden'); $('#btn-upload-all').disabled = true; }
    else { $('#btn-process').classList.add('hidden'); $('#btn-upload-all').disabled = false; }
  }

  async function uploadAll() {
    const todo = state.files.filter(f => f.status === 'queued' || f.status === 'error');
    if (!todo.length) { showToast('No files to upload', 'info'); return; }
    $('#btn-upload-all').disabled = true;
    for (const item of todo) {
      item.status = 'uploading'; renderFileList();
      try { const fd = new FormData(); fd.append('file', item.file); await api('/upload', { method: 'POST', body: fd }); item.status = 'done'; }
      catch { item.status = 'error'; showToast(`Failed: ${item.file.name}`, 'error'); }
      renderFileList();
    }
    const ok = state.files.filter(f => f.status === 'done').length;
    if (ok) { showToast(`${ok} file(s) uploaded`, 'success'); loadStats(); }
  }

  async function processAll() {
    const st = $('#processing-status'), txt = $('#processing-text'), bar = $('#processing-bar');
    st.classList.remove('hidden'); $('#btn-process').disabled = true;
    try {
      const r = await api('/process', { method: 'POST' });
      if (r.jobId) await pollJob(r.jobId, txt, bar);
      else { txt.textContent = 'Done'; bar.style.width = '100%'; showToast('Done', 'success'); }
    } catch (e) { txt.textContent = `Error: ${e.message}`; showToast('Failed', 'error'); }
    clearAllCaches(); loadStats();
    setTimeout(() => { st.classList.add('hidden'); bar.style.width = '0%'; $('#btn-process').disabled = false; }, 4000);
  }

  async function pollJob(jobId, textEl, barEl, startPct = 0) {
    return new Promise(resolve => {
      const iv = setInterval(async () => {
        try {
          const j = await api(`/jobs/${jobId}`);
          if (j.totalDemos > 0) barEl.style.width = `${startPct + Math.round((j.processedDemos / j.totalDemos) * (100 - startPct))}%`;
          if (textEl) textEl.textContent = `Processing ${j.processedDemos}/${j.totalDemos}... ${j.playersFound} players`;
          const s = (j.state || '').toLowerCase();
          if (s === 'done' || s === 'completed') { clearInterval(iv); barEl.style.width = '100%'; if (textEl) textEl.textContent = `Done! ${j.playersFound} players`; showToast('Done', 'success'); resolve(); }
          else if (s === 'failed' || s === 'error') { clearInterval(iv); if (textEl) textEl.textContent = 'Failed'; showToast('Failed', 'error'); resolve(); }
        } catch { clearInterval(iv); resolve(); }
      }, 2000);
    });
  }

  // ════════════════════════════════════════════
  //  MATCHES TAB
  // ════════════════════════════════════════════

  async function loadDemos() {
    const ld = $('#matches-loading'), list = $('#matches-list'), em = $('#matches-empty');
    ld.classList.remove('hidden'); list.innerHTML = ''; em.classList.add('hidden');
    try {
      const demos = await api('/demos'); ld.classList.add('hidden');
      const arr = Array.isArray(demos) ? demos : [];
      state.demosCache = arr;
      if (!arr.length) { em.classList.remove('hidden'); return; }
      list.innerHTML = arr.map(d => renderDemoCard(d)).join('');
      list.querySelectorAll('.demo-card-header').forEach(h => h.addEventListener('click', () => toggleDemoDetail(parseInt(h.dataset.demoId))));
    } catch (e) { ld.classList.add('hidden'); em.classList.remove('hidden'); showToast(`Failed: ${e.message}`, 'error'); }
  }

  function renderDemoCard(d) {
    const map = d.mapName ? `<span class="badge map">${escapeHtml(d.mapName)}</span>` : '';
    const title = d.title || d.fileName || `Demo #${d.demoId}`;
    const matchId = extractMatchId(d.fileName);
    const faceitBtn = matchId ? `<a href="https://www.faceit.com/en/cs2/room/${matchId}" target="_blank" rel="noopener" class="faceit-link-icon" title="Open on FACEIT" onclick="event.stopPropagation()"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>` : '';
    return `<div class="demo-card card" data-demo-id="${d.demoId}"><div class="demo-card-header p-4 cursor-pointer flex items-center justify-between" data-demo-id="${d.demoId}"><div class="flex items-center gap-3 flex-1 min-w-0">${map}<span class="font-medium text-sm truncate">${escapeHtml(title)}</span>${faceitBtn}</div><div class="flex items-center gap-4 text-xs text-text-dim flex-shrink-0"><span>${d.playerCount ?? 0} players</span><span>${formatDate(d.processedAt)}</span><svg class="chevron w-4 h-4 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div></div><div class="demo-card-body" id="demo-detail-${d.demoId}"><div class="demo-detail-content px-4 pb-4"><div class="flex justify-center py-6"><div class="spinner"></div></div></div></div></div>`;
  }

  async function toggleDemoDetail(demoId) {
    const body = $(`#demo-detail-${demoId}`); if (!body) return;
    const card = body.closest('.demo-card'), chevron = card?.querySelector('.chevron');
    if (state.expandedDemo === demoId) { body.classList.remove('open'); if (chevron) chevron.style.transform = ''; state.expandedDemo = null; stopAudio(); return; }
    if (state.expandedDemo != null) { const prev = $(`#demo-detail-${state.expandedDemo}`); if (prev) { prev.classList.remove('open'); prev.closest('.demo-card')?.querySelector('.chevron')?.removeAttribute('style'); } stopAudio(); }
    body.classList.add('open'); if (chevron) chevron.style.transform = 'rotate(180deg)'; state.expandedDemo = demoId;
    const content = body.querySelector('.demo-detail-content');
    try {
      const players = await api(`/demos/${demoId}`);
      const list = Array.isArray(players) ? players : [];
      if (!list.length) { content.innerHTML = '<p class="text-sm text-text-dim py-4">No players</p>'; return; }
      const ct = list.filter(p => p.teamNumber === 3), t = list.filter(p => p.teamNumber === 2), other = list.filter(p => p.teamNumber !== 2 && p.teamNumber !== 3);
      const side = (players, label, cls) => `<div><h4 class="text-xs font-semibold ${cls} mb-2 uppercase tracking-wider">${label}</h4>${players.length ? players.map(p => renderDemoPlayerRow(p)).join('') : '<p class="text-xs text-text-dim">None</p>'}</div>`;
      let html = '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">' + side(ct, 'CT Side', 'text-accent') + side(t, 'T Side', 'text-error') + '</div>';
      if (other.length) html += '<div class="mt-4">' + side(other, 'Other', 'text-text-dim') + '</div>';
      content.innerHTML = html;
      attachAudioHandlers(content);
      content.querySelectorAll('.player-row-name[data-steam-id]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); switchTab('players'); showPlayerDetail(el.dataset.steamId); }));
    } catch (e) { content.innerHTML = `<p class="text-sm text-error py-4">Failed: ${escapeHtml(e.message)}</p>`; }
  }

  async function navigateToDemo(demoId) {
    switchTab('matches');
    if (!state.demosCache) await loadDemos();
    const card = document.querySelector(`.demo-card[data-demo-id="${demoId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (state.expandedDemo !== demoId) {
        await toggleDemoDetail(demoId);
      }
    }
  }

  function renderDemoPlayerRow(p) {
    const name = escapeHtml(p.name || p.steamId || '-'), sid = p.steamId || '';
    const isSmurf = state.matchedSteamIds.has(sid);
    const clipCount = (p.audioFiles && p.audioFiles.length) || 0;
    const speakSec = p.speakingSeconds || 0;
    const isSilent = clipCount === 0;
    const isLowVoice = !isSilent && (clipCount <= 5 || speakSec < 10);
    const silentBadge = isSilent ? '<span class="silent-badge">silent</span>' : isLowVoice ? '<span class="low-voice-badge">low voice</span>' : '';
    return `<div class="player-row ${isSmurf ? 'smurf-highlight' : ''} ${isSilent ? 'silent-player' : ''} ${isLowVoice ? 'low-voice-player' : ''}"><div class="player-row-header"><span class="player-row-name clickable-name" data-steam-id="${escapeHtml(sid)}">${name}</span>${isSmurf ? '<span class="smurf-badge">voice match</span>' : ''}${silentBadge}<span class="player-row-time">${formatDuration(speakSec)}${clipCount > 0 ? ' / ' + clipCount + ' clips' : ''}</span></div>${renderAudioBtns(p.audioFiles, p.audioPath)}</div>`;
  }

  // ════════════════════════════════════════════
  //  PLAYERS TAB
  // ════════════════════════════════════════════

  function initPlayers() {
    $('#btn-player-search').addEventListener('click', () => loadPlayers($('#player-search-input').value.trim()));
    $('#player-search-input').addEventListener('keydown', e => { if (e.key === 'Enter') loadPlayers($('#player-search-input').value.trim()); });
    $('#btn-back-players').addEventListener('click', () => { $('#player-detail').classList.add('hidden'); $('#players-search-view').classList.remove('hidden'); state.currentPlayer = null; });
    $('#btn-find-similar').addEventListener('click', () => { if (state.currentPlayer) loadSimilarPlayers(state.currentPlayer); });
    const sb = $('#btn-open-steam');
    if (sb) sb.addEventListener('click', () => { if (state.currentPlayer) window.open(`https://steamcommunity.com/profiles/${state.currentPlayer}`, '_blank'); });
  }

  async function loadPlayers(search = '') {
    const ld = $('#players-loading'), grid = $('#player-list'), em = $('#players-empty');
    ld.classList.remove('hidden'); grid.innerHTML = ''; em.classList.add('hidden');
    $('#players-search-view').classList.remove('hidden'); $('#player-detail').classList.add('hidden');
    let url = '/players'; if (search) url += `?search=${encodeURIComponent(search)}`;
    try {
      const data = await api(url); ld.classList.add('hidden');
      const players = Array.isArray(data) ? data : []; state.playerSearchCache = players;
      if (!players.length) { em.classList.remove('hidden'); return; }
      grid.innerHTML = players.map(p => `<div class="player-card" data-steam-id="${escapeHtml(p.steamId || '')}"><div class="player-name">${escapeHtml((p.names && p.names[0]) || p.steamId || '-')}</div>${p.names && p.names.length > 1 ? `<div class="text-xs text-text-dim mb-1" style="opacity:0.7">aka ${escapeHtml(p.names.slice(1).join(', '))}</div>` : ''}<div class="player-steam-id">${escapeHtml(p.steamId || '')}</div><div class="player-meta"><span>${p.demos ?? 0} demos</span><span>${formatDuration(p.speakingSeconds ?? 0)}</span></div></div>`).join('');
      grid.querySelectorAll('.player-card').forEach(c => c.addEventListener('click', () => { if (c.dataset.steamId) showPlayerDetail(c.dataset.steamId); }));
    } catch { ld.classList.add('hidden'); em.classList.remove('hidden'); }
  }

  async function showPlayerDetail(steamId) {
    state.currentPlayer = steamId;
    $('#players-search-view').classList.add('hidden'); $('#player-detail').classList.remove('hidden');
    const hdr = $('#player-header'), stats = $('#player-stats'), demos = $('#player-demos-table'), sim = $('#similar-results');
    hdr.innerHTML = '<div class="spinner"></div>'; stats.innerHTML = ''; demos.innerHTML = ''; sim.innerHTML = '';
    try {
      const p = await api(`/players/${steamId}`);
      const name = (p.names && p.names[0]) || steamId, allNames = p.names ? p.names.join(', ') : name;
      hdr.innerHTML = `<h2 class="text-lg font-semibold">${escapeHtml(name)}</h2><p class="text-sm text-text-dim mt-1">${escapeHtml(allNames)}</p>`;
      stats.innerHTML = `<div class="stat-card"><div class="stat-label">SteamID</div><div class="stat-value mono">${escapeHtml(steamId)}<button class="copy-btn" data-copy="${escapeHtml(steamId)}" title="Copy"><svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></div></div><div class="stat-card"><div class="stat-label">Names</div><div class="stat-value">${p.names ? p.names.length : 1}</div></div><div class="stat-card"><div class="stat-label">Demos</div><div class="stat-value">${p.demos ?? 0}</div></div><div class="stat-card"><div class="stat-label">Speaking</div><div class="stat-value">${formatDuration(p.speakingSeconds ?? 0)}</div></div>`;
      stats.querySelectorAll('.copy-btn').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); copyToClipboard(b.dataset.copy); }));
      const appearances = p.appearances || [];
      if (appearances.length) {
        demos.innerHTML = `<div class="card overflow-hidden"><table class="data-table"><thead><tr><th>Demo</th><th>Map</th><th>Name</th><th>Speaking</th></tr></thead><tbody>${appearances.map(d => {
          const speakSec = d.speakingSeconds || 0;
          const speakCls = speakSec === 0 ? 'text-error' : speakSec < 10 ? 'text-warning' : '';
          return `<tr><td><span class="demo-nav-link" data-demo-id="${d.demoId}" title="Open demo in Matches tab">${faceitLink(d.demo)}</span></td><td>${escapeHtml(d.map || '-')}</td><td>${escapeHtml(d.name || '-')}</td><td class="${speakCls}">${formatDuration(speakSec)}${speakSec === 0 ? ' <span class="silent-badge">silent</span>' : speakSec < 10 ? ' <span class="low-voice-badge">low voice</span>' : ''}</td></tr>`;
        }).join('')}</tbody></table></div>`;
        demos.querySelectorAll('.demo-nav-link').forEach(el => el.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          const demoId = parseInt(el.dataset.demoId);
          if (!demoId) return;
          navigateToDemo(demoId);
        }));
      }
      loadSimilarPlayers(steamId);
    } catch (e) { hdr.innerHTML = `<p class="text-sm text-error">Failed: ${escapeHtml(e.message)}</p>`; }
  }

  async function loadSimilarPlayers(steamId) {
    const ld = $('#similar-loading'), res = $('#similar-results');
    ld.classList.remove('hidden'); res.innerHTML = '';
    try {
      const data = await api(`/players/${steamId}/similar`); ld.classList.add('hidden');
      const similar = Array.isArray(data) ? data : [];
      if (!similar.length) { res.innerHTML = '<p class="text-sm text-text-dim py-4">No similar voices found at 70% threshold</p>'; return; }
      res.innerHTML = '<div class="similar-grid">' + similar.map(s => {
        const diff = s.differentNames;
        return `<div class="similar-card ${diff ? 'diff-names' : ''}" data-steam-id="${escapeHtml(s.steamId)}"><div class="similar-card-header"><div class="similar-card-names"><span class="font-semibold text-sm">${escapeHtml((s.names && s.names[0]) || s.steamId)}</span>${diff ? '<span class="smurf-badge">Different name</span>' : ''}</div>${renderSimBar(s.similarity)}</div><div class="similar-card-meta"><span>${s.demos ?? 0} demos</span><span>${formatDuration(s.speakingSeconds ?? 0)}</span><button class="btn-compare-small" data-compare-id="${escapeHtml(s.steamId)}">Compare</button></div></div>`;
      }).join('') + '</div>';
      res.querySelectorAll('.similar-card').forEach(c => c.addEventListener('click', e => { if (e.target.closest('.btn-compare-small')) return; showPlayerDetail(c.dataset.steamId); }));
      res.querySelectorAll('.btn-compare-small').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openCompare(steamId, b.dataset.compareId); }));
    } catch (e) { ld.classList.add('hidden'); res.innerHTML = `<p class="text-sm text-error">Failed: ${escapeHtml(e.message)}</p>`; }
  }

  // ════════════════════════════════════════════
  //  COMPARE TAB
  // ════════════════════════════════════════════

  function openCompare(id1, id2) {
    state.compareMode = { steamId1: id1, steamId2: id2 };
    switchTab('compare'); loadCompare(id1, id2);
  }

  async function loadCompare(id1, id2) {
    const box = $('#compare-content');
    box.innerHTML = '<div class="flex justify-center py-12"><div class="spinner"></div></div>';
    try {
      const d = await api(`/compare/${id1}/${id2}`);
      const p1 = d.player1, p2 = d.player2, sim = d.similarity, cls = simClass(sim);
      let html = `<div class="compare-header"><div class="compare-player"><div class="compare-player-name">${escapeHtml((p1.names && p1.names[0]) || p1.steamId)}</div><div class="compare-player-id">${escapeHtml(p1.steamId)}</div><div class="compare-player-meta">${p1.demos} demos / ${formatDuration(p1.speakingSeconds)}</div>${p1.names && p1.names.length > 1 ? `<div class="text-xs text-text-dim mt-1">aka ${escapeHtml(p1.names.slice(1).join(', '))}</div>` : ''}</div><div class="compare-vs"><div class="compare-sim-circle ${cls}"><span class="compare-sim-value">${(sim * 100).toFixed(1)}%</span></div><div class="text-xs text-text-dim mt-2">Similarity</div></div><div class="compare-player"><div class="compare-player-name">${escapeHtml((p2.names && p2.names[0]) || p2.steamId)}</div><div class="compare-player-id">${escapeHtml(p2.steamId)}</div><div class="compare-player-meta">${p2.demos} demos / ${formatDuration(p2.speakingSeconds)}</div>${p2.names && p2.names.length > 1 ? `<div class="text-xs text-text-dim mt-1">aka ${escapeHtml(p2.names.slice(1).join(', '))}</div>` : ''}</div></div>`;

      // Shared demos
      if (d.sharedDemos && d.sharedDemos.length) {
        html += `<div class="compare-section"><h3 class="compare-section-title">Shared Demos (${d.sharedDemos.length})</h3><div class="card overflow-hidden"><table class="data-table"><thead><tr><th>Demo</th><th>Map</th><th>Player 1</th><th>Player 2</th></tr></thead><tbody>${d.sharedDemos.map(dd => `<tr><td>${faceitLink(dd.fileName)}</td><td>${escapeHtml(dd.mapName)}</td><td>${escapeHtml(dd.name1)} (${formatDuration(dd.speaking1)})</td><td>${escapeHtml(dd.name2)} (${formatDuration(dd.speaking2)})</td></tr>`).join('')}</tbody></table></div></div>`;
      }

      // Per-demo similarity
      if (d.perDemoSimilarity && d.perDemoSimilarity.length) {
        html += `<div class="compare-section"><h3 class="compare-section-title">Per-Demo Similarity</h3><div class="card overflow-hidden"><table class="data-table"><thead><tr><th>Demo 1</th><th>Demo 2</th><th>Similarity</th></tr></thead><tbody>${d.perDemoSimilarity.slice(0, 20).map(dd => `<tr><td class="text-xs">${faceitLink(dd.demo1)}</td><td class="text-xs">${faceitLink(dd.demo2)}</td><td>${renderSimBar(dd.similarity)}</td></tr>`).join('')}</tbody></table></div></div>`;
      }

      // Audio
      html += '<div class="compare-section"><h3 class="compare-section-title">Voice Samples</h3><div class="grid grid-cols-1 md:grid-cols-2 gap-4">';
      const renderAudioCol = (audio, label, cls) => {
        let h = `<div><h4 class="text-xs font-semibold ${cls} mb-2">${escapeHtml(label)}</h4>`;
        if (audio && audio.length) {
          for (const a of audio.slice(0, 3)) {
            h += `<div class="mb-2"><div class="text-xs text-text-dim mb-1">${escapeHtml(a.mapName)} - ${escapeHtml(a.name)}</div>${renderAudioBtns(a.files, a.audioPath)}</div>`;
          }
        } else h += '<p class="text-xs text-text-dim">No audio</p>';
        return h + '</div>';
      };
      html += renderAudioCol(d.audio1, (p1.names && p1.names[0]) || p1.steamId, 'text-accent');
      html += renderAudioCol(d.audio2, (p2.names && p2.names[0]) || p2.steamId, 'text-error');
      html += '</div></div>';

      box.innerHTML = html;
      attachAudioHandlers(box);
    } catch (e) { box.innerHTML = `<p class="text-error">Failed: ${escapeHtml(e.message)}</p>`; }
  }

  // ════════════════════════════════════════════
  //  IDENTITY GROUPS TAB
  // ════════════════════════════════════════════

  function initGroups() {
    const th = $('#group-threshold'), tv = $('#group-threshold-value');
    if (th) th.addEventListener('input', () => tv.textContent = Math.round(th.value * 100) + '%');
    const btn = $('#btn-compute-groups');
    if (btn) btn.addEventListener('click', loadGroups);
  }

  async function loadGroups() {
    const ld = $('#groups-loading'), list = $('#groups-list'), em = $('#groups-empty');
    ld.classList.remove('hidden'); list.innerHTML = ''; em.classList.add('hidden');
    const threshold = $('#group-threshold').value;
    try {
      const data = await api(`/clusters?threshold=${threshold}`); ld.classList.add('hidden');
      const clusters = Array.isArray(data) ? data : []; state.clustersCache = clusters;
      if (!clusters.length) { em.classList.remove('hidden'); return; }

      list.innerHTML = clusters.map((cluster, i) => {
        const members = cluster.members || [], pairs = cluster.pairSimilarities || [];
        const tier = cluster.confidenceTier || 'uncertain', tc = tierColor(tier);
        const allNames = cluster.allNames || members.flatMap(m => m.names || []);

        // Similarity matrix
        let matrix = '';
        if (pairs.length) {
          const pm = {};
          for (const p of pairs) { pm[`${p.steamId1}-${p.steamId2}`] = p.similarity; pm[`${p.steamId2}-${p.steamId1}`] = p.similarity; }
          matrix = '<div class="sim-matrix-container"><table class="sim-matrix"><thead><tr><th></th>';
          for (const m of members) matrix += `<th title="${m.steamId}">${escapeHtml((m.names && m.names[0]) || m.steamId).substring(0, 12)}</th>`;
          matrix += '</tr></thead><tbody>';
          for (const m1 of members) {
            matrix += `<tr><td class="matrix-label" title="${m1.steamId}">${escapeHtml((m1.names && m1.names[0]) || m1.steamId).substring(0, 12)}</td>`;
            for (const m2 of members) {
              if (m1.steamId === m2.steamId) { matrix += '<td class="matrix-cell self">\u2014</td>'; }
              else {
                const sim = pm[`${m1.steamId}-${m2.steamId}`];
                if (sim != null) {
                  const pct = (sim * 100).toFixed(1);
                  matrix += `<td class="matrix-cell ${simClass(sim)}" title="${pct}%"><button class="matrix-sim-btn" data-s1="${m1.steamId}" data-s2="${m2.steamId}">${pct}%</button></td>`;
                } else matrix += '<td class="matrix-cell">-</td>';
              }
            }
            matrix += '</tr>';
          }
          matrix += '</tbody></table></div>';
        }

        const memberRows = members.map(m => `<tr class="clickable-player" data-steam-id="${escapeHtml(m.steamId)}"><td>${escapeHtml((m.names || []).join(', ') || '-')}</td><td class="mono text-xs">${escapeHtml(m.steamId || '')}</td><td>${m.demos ?? '-'}</td><td>${formatDuration(m.speakingSeconds || 0)}</td></tr>`).join('');

        return `<div class="cluster-card"><div class="cluster-card-header"><div class="cluster-header-left"><span class="cluster-title">Group #${i + 1}</span><span class="confidence-badge" style="background:${tc}20;color:${tc};border:1px solid ${tc}40">${tierLabel(tier)}</span><span class="cluster-sim-label">min ${(cluster.minSimilarity * 100).toFixed(1)}%</span></div><div class="cluster-header-right"><span class="cluster-names">${escapeHtml(allNames.join(', '))}</span><span class="cluster-count">${members.length} accounts</span><svg class="chevron w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div></div><div class="cluster-card-body">${matrix}<div class="card overflow-hidden mt-3"><table class="data-table"><thead><tr><th>Names</th><th>SteamID</th><th>Demos</th><th>Speaking</th></tr></thead><tbody>${memberRows}</tbody></table></div></div></div>`;
      }).join('');

      // Events
      list.querySelectorAll('.cluster-card-header').forEach(h => h.addEventListener('click', () => { const b = h.nextElementSibling; b.classList.toggle('open'); h.querySelector('.chevron').classList.toggle('open'); }));
      list.querySelectorAll('.clickable-player').forEach(r => r.addEventListener('click', () => { switchTab('players'); showPlayerDetail(r.dataset.steamId); }));
      list.querySelectorAll('.matrix-sim-btn').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openCompare(b.dataset.s1, b.dataset.s2); }));
    } catch (e) { ld.classList.add('hidden'); em.classList.remove('hidden'); showToast(`Failed: ${e.message}`, 'error'); }
  }

  // ════════════════════════════════════════════
  //  DELETE ALL DATA
  // ════════════════════════════════════════════

  function initDeleteButton() {
    const btn = $('#btn-delete-data'); if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!confirm('Delete ALL data? This cannot be undone.')) return;
      try {
        await api('/data', { method: 'DELETE' });
        clearAllCaches(); stopAudio(); state.files = []; renderFileList(); loadStats();
        showToast('All data deleted', 'success');
        ['matches-list', 'player-list', 'groups-list'].forEach(id => { const el = $(`#${id}`); if (el) el.innerHTML = ''; });
      } catch (e) { showToast(`Failed: ${e.message}`, 'error'); }
    });
  }

  function initReprocessButton() {
    const btn = $('#btn-reprocess'); if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!confirm('Reprocess all voice profiles from stored WAV files? This will recompute all embeddings and matches.')) return;
      btn.disabled = true; btn.textContent = 'Reprocessing...';
      try {
        const { jobId } = await api('/reprocess', { method: 'POST' });
        const poll = setInterval(async () => {
          try {
            const job = await api(`/jobs/${jobId}`);
            btn.textContent = `Reprocessing... ${job.processedDemos || 0}/${job.totalDemos || '?'}`;
            if (job.state === 'done' || job.state === 'error') {
              clearInterval(poll); btn.disabled = false; btn.textContent = 'Reprocess All';
              if (job.state === 'done') { showToast(`Reprocessed ${job.processedDemos} demos, ${job.playersFound} profiles`, 'success'); clearAllCaches(); loadStats(); }
              else showToast('Reprocessing failed', 'error');
            }
          } catch { clearInterval(poll); btn.disabled = false; btn.textContent = 'Reprocess All'; }
        }, 1000);
      } catch (e) { btn.disabled = false; btn.textContent = 'Reprocess All'; showToast(`Failed: ${e.message}`, 'error'); }
    });
  }

  // ════════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════════

  function init() {
    initAudioPlayer(); initTabs(); initGlobalSearch();
    initUpload(); initPlayers(); initGroups(); initDeleteButton(); initReprocessButton();
    loadStats();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
