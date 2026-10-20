(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const other = c => (c === 'O' ? 'B' : 'O');

  // ---------------- state ----------------
  let templates = null;
  let grid = null; // { rows, cols, letters[], state[], conf[], topColor, myColor, myHome }
  let settings = loadSettings();
  let lastTotal = 0, lastTimedOut = false;
  let results = [], shown = 0, openIdx = -1, editIdx = -1;
  let dictReady = false;

  function loadSettings() {
    const def = { start: 'mine', minLen: 4, maxLen: 20, sort: 'score', fCuts: false, fReaches: false };
    try { return Object.assign(def, JSON.parse(localStorage.getItem('gwf-settings') || '{}')); } catch (e) { return def; }
  }
  function saveSettings() { try { localStorage.setItem('gwf-settings', JSON.stringify(settings)); } catch (e) {} }

  // ---------------- dictionary worker ----------------
  const worker = new Worker('solver.worker.js?v=6');
  let solveId = 0;
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'ready') {
      dictReady = true;
      setStatus(m.count.toLocaleString() + ' words', 'ok');
      updateSolveBtn();
      runPuzzle();
    } else if (m.type === 'solved' && typeof m.id === 'string') {
      if (m.id === 'pz' + pzId) pzSolved(m);
    } else if (m.type === 'solved') {
      if (m.id !== solveId) return;
      results = m.results;
      $('#solveBtn').textContent = 'Find words';
      updateSolveBtn();
      lastTotal = m.total; lastTimedOut = m.timedOut;
      renderResults(true);
      $('#resultsCard').hidden = false;
      $('#resultsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (m.type === 'looked') {
      if (m.id === pzId) renderPuzzle(m);
    } else if (m.type === 'error') {
      setStatus('Error', 'err');
      showMsg(m.message);
      $('#solveBtn').textContent = 'Find words';
      updateSolveBtn();
    }
  };
  worker.postMessage({ type: 'load', url: 'words.txt?v=1' });
  function setStatus(t, cls) { const el = $('#dictStatus'); el.textContent = t; el.className = 'pill ' + (cls || ''); }

  // ---------------- templates ----------------
  async function loadTemplates() {
    const list = await (await fetch('templates.json?v=1')).json();
    const T = LGReader.decodeTemplates(list);
    // letters missing from the sample screenshots: render them with a similar bold sans font
    const have = new Set(T.map(t => t.l));
    const c = document.createElement('canvas'); c.width = 115; c.height = 109;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (have.has(L)) continue;
      for (const font of ['bold 60px Helvetica, Arial, sans-serif', 'bold 60px Arial, Helvetica, sans-serif']) {
        ctx.fillStyle = 'rgb(30,30,30)'; ctx.fillRect(0, 0, 115, 109);
        ctx.fillStyle = '#fff'; ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(L, 57.5, 56);
        const a = LGReader.analyseCell(ctx.getImageData(0, 0, 115, 109), 0, 0, 115, 109);
        if (!a.empty) T.push({ l: L, a: a.aspect, g: a.glyph });
      }
    }
    return T;
  }
  const templatesP = loadTemplates().then(t => (templates = t)).catch(err => showMsg('Could not load letter templates: ' + err.message));

  // ---------------- image input ----------------
  $('#fileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) readImageFile(f); e.target.value = ''; });
  window.addEventListener('paste', e => {
    const item = [...(e.clipboardData || {}).items || []].find(i => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); readImageFile(item.getAsFile()); }
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
    if (f) readImageFile(f);
  });

  function showMsg(t) { const el = $('#readMsg'); el.textContent = t || ''; el.hidden = !t; }

  async function readImageFile(file) {
    showMsg('Reading screenshot…');
    await templatesP;
    try {
      const img = await fileToImage(file);
      const cv = $('#work'); cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, cv.width, cv.height);
      const r = LGReader.readBoard(data, templates);
      const n = r.rows * r.cols;
      grid = {
        rows: r.rows, cols: r.cols,
        letters: new Array(n), state: new Array(n), conf: new Array(n),
        topColor: r.topColor, myColor: r.myColor,
        myHome: r.myColor === r.topColor ? 'top' : 'bottom',
      };
      r.cells.flat().forEach((c, i) => { grid.letters[i] = c.letter; grid.state[i] = c.state; grid.conf[i] = c.conf; });
      const low = grid.conf.filter(c => c < 0.5).length;
      showMsg(low ? `Read ${r.cols}×${r.rows} board. ${low} cell${low > 1 ? 's' : ''} marked with a dashed outline — please check.` : `Read ${r.cols}×${r.rows} board. Check it matches, then tap Find words.`);
      afterGridLoaded();
    } catch (err) {
      showMsg((err && err.message ? err.message : String(err)) + ' You can type the grid manually instead.');
      if (!$('#puzzleView').hidden) $('#pzBoardInfo').textContent = (err && err.message ? err.message : String(err)) + ' Try another screenshot, or type the board in the Grid solver tab.';
    }
  }
  function fileToImage(file) {
    if (window.createImageBitmap) return createImageBitmap(file).catch(() => viaImg(file));
    return viaImg(file);
  }
  function viaImg(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); res(im); };
      im.onerror = () => rej(new Error('That file could not be opened as an image.'));
      im.src = url;
    });
  }

  // ---------------- manual board / board size ----------------
  const LIMITS = { cols: [4, 15], rows: [4, 20] };
  const size = { cols: settings.boardCols || 10, rows: settings.boardRows || 13 };
  function syncSize() {
    $('#colsOut').textContent = size.cols; $('#rowsOut').textContent = size.rows;
    document.querySelectorAll('[data-step]').forEach(b => {
      const k = b.dataset.step, d = +b.dataset.d;
      b.disabled = d < 0 ? size[k] <= LIMITS[k][0] : size[k] >= LIMITS[k][1];
    });
    $('#resizeBtn').disabled = !grid || (grid.rows === size.rows && grid.cols === size.cols);
  }
  document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    const k = b.dataset.step;
    size[k] = Math.max(LIMITS[k][0], Math.min(LIMITS[k][1], size[k] + +b.dataset.d));
    settings.boardCols = size.cols; settings.boardRows = size.rows; saveSettings();
    syncSize();
  }));
  $('#manualBox').addEventListener('toggle', () => {
    if ($('#manualBox').open && grid) { size.cols = grid.cols; size.rows = grid.rows; }
    syncSize();
  });
  syncSize();

  function blankGrid(rows, cols, topColor, myColor, myHome) {
    const n = rows * cols;
    const g = { rows, cols, letters: new Array(n).fill(''), state: new Array(n).fill('.'), conf: new Array(n).fill(1), topColor, myColor, myHome };
    for (let c = 0; c < cols; c++) { g.state[c] = topColor; g.state[(rows - 1) * cols + c] = other(topColor); }
    return g;
  }

  $('#blankBtn').addEventListener('click', () => {
    grid = blankGrid(size.rows, size.cols, 'O', 'O', 'top');
    showMsg(`Blank ${size.cols}×${size.rows} board. Tap each cell to type its letter — it moves to the next cell as you type.`);
    afterGridLoaded();
    openEditor(size.cols);
  });

  // keeps the top home row on top, the bottom home row at the bottom, and middle rows from the top down
  $('#resizeBtn').addEventListener('click', () => {
    if (!grid) return;
    const old = grid, g = blankGrid(size.rows, size.cols, old.topColor, old.myColor, old.myHome);
    for (let r = 0; r < g.rows; r++) {
      const sr = r === g.rows - 1 ? old.rows - 1 : (r < old.rows - 1 ? r : -1);
      if (sr < 0) continue;
      for (let c = 0; c < Math.min(g.cols, old.cols); c++) {
        const s = sr * old.cols + c, d = r * g.cols + c;
        g.letters[d] = old.letters[s]; g.state[d] = old.state[s]; g.conf[d] = old.conf[s];
      }
    }
    grid = g;
    showMsg(`Board resized to ${g.cols}×${g.rows}. New cells are blank — tap them to fill in letters.`);
    afterGridLoaded();
  });

  function afterGridLoaded() {
    results = []; openIdx = -1;
    $('#boardCard').hidden = false;
    $('#resultsCard').hidden = true;
    size.cols = grid.cols; size.rows = grid.rows; syncSize();
    syncControls();
    renderMainBoard();
    if (!$('#gridView').hidden) $('#boardCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------- board rendering ----------------
  function cellClass(i) {
    const r = Math.floor(i / grid.cols);
    const s = grid.state[i];
    const myHomeRow = grid.myHome === 'top' ? 0 : grid.rows - 1;
    const oppHomeRow = grid.rows - 1 - myHomeRow;
    let cls = 'cell';
    if (r === myHomeRow && s !== 'W') cls += s === grid.myColor ? ' home-mine' : ' opp';
    else if (r === oppHomeRow && s !== 'W') cls += s === other(grid.myColor) ? ' home-opp' : ' mine';
    else if (s === grid.myColor) cls += ' mine';
    else if (s === other(grid.myColor)) cls += ' opp';
    else if (s === 'W') cls += ' W';
    if (!grid.letters[i]) cls += ' empty';
    return cls;
  }
  function letterHTML(i) {
    const L = grid.letters[i];
    return L === '?' ? '<span class="w">🤔</span>' : (L || '·');
  }

  function renderMainBoard() {
    if (typeof pzBoardChanged === 'function') pzBoardChanged();
    const b = $('#board');
    b.style.gridTemplateColumns = `repeat(${grid.cols}, 1fr)`; b.style.setProperty('--cols', grid.cols);
    b.innerHTML = '';
    for (let i = 0; i < grid.rows * grid.cols; i++) {
      const d = document.createElement('div');
      d.className = cellClass(i) + (grid.conf[i] < 0.5 ? ' low' : '');
      d.innerHTML = letterHTML(i);
      d.dataset.i = i;
      b.appendChild(d);
    }
  }
  $('#board').addEventListener('click', e => {
    const c = e.target.closest('.cell'); if (c) openEditor(+c.dataset.i);
  });

  function miniBoard(res) {
    const wrap = document.createElement('div');
    wrap.className = 'board mini';
    wrap.style.gridTemplateColumns = `repeat(${grid.cols}, 1fr)`; wrap.style.setProperty('--cols', grid.cols);
    const order = new Map(res.path.map((p, k) => [p, k]));
    const wildAt = new Set(res.wild);
    for (let i = 0; i < grid.rows * grid.cols; i++) {
      const d = document.createElement('div');
      const k = order.get(i);
      d.className = cellClass(i) + (k === undefined ? (res.path.length ? ' dim' : '') : ' on');
      if (k !== undefined && wildAt.has(k)) d.innerHTML = `<span class="wl">${res.word[k]}</span>`;
      else d.innerHTML = letterHTML(i);
      if (k !== undefined) d.insertAdjacentHTML('beforeend', `<span class="n">${k + 1}</span>`);
      wrap.appendChild(d);
    }
    if (!res.path.length) return wrap;
    const W = grid.cols * 100, H = grid.rows * 95;
    const pts = res.path.map(i => `${(i % grid.cols) * 100 + 50},${Math.floor(i / grid.cols) * 95 + 47.5}`).join(' ');
    const [sx, sy] = pts.split(' ')[0].split(',');
    wrap.insertAdjacentHTML('beforeend',
      `<svg class="path" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="${pts}" fill="none" stroke="#5ee37a" stroke-opacity=".6" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${sx}" cy="${sy}" r="16" fill="none" stroke="#5ee37a" stroke-width="7"/></svg>`);
    return wrap;
  }

  // ---------------- cell editor ----------------
  function openEditor(i) {
    editIdx = i;
    const r = Math.floor(i / grid.cols), c = i % grid.cols;
    $('#sheetTitle').textContent = `Row ${r + 1}, column ${c + 1}`;
    $('#letterInput').value = grid.letters[i] === '?' ? '' : grid.letters[i];
    $('#letterInput').placeholder = grid.letters[i] === '?' ? '🤔' : '';
    markStateSeg();
    $('#sheet').hidden = false;
    setTimeout(() => { $('#letterInput').focus(); $('#letterInput').select(); }, 50);
  }
  function markStateSeg() {
    const s = grid.state[editIdx];
    const v = s === grid.myColor ? 'mine' : s === other(grid.myColor) ? 'opp' : s;
    $('#stateSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  }
  function closeEditor() { $('#sheet').hidden = true; editIdx = -1; renderMainBoard(); }
  $('#letterInput').addEventListener('input', e => {
    const v = e.target.value.toUpperCase().replace(/[^A-Z?]/g, '').slice(-1);
    e.target.value = v === '?' ? '' : v;
    if (!v) return;
    grid.letters[editIdx] = v; grid.conf[editIdx] = 1;
    // auto-advance for fast typing
    renderMainBoard();
    if (editIdx + 1 < grid.rows * grid.cols) openEditor(editIdx + 1); else closeEditor();
  });
  $('#letterInput').addEventListener('keydown', e => { if (e.key === 'Enter') closeEditor(); });
  $('#wildBtn').addEventListener('click', () => { grid.letters[editIdx] = '?'; grid.conf[editIdx] = 1; closeEditor(); });
  $('#clearBtn').addEventListener('click', () => { grid.letters[editIdx] = ''; grid.conf[editIdx] = 1; closeEditor(); });
  $('#stateSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const v = b.dataset.v;
    grid.state[editIdx] = v === 'mine' ? grid.myColor : v === 'opp' ? other(grid.myColor) : v;
    grid.conf[editIdx] = 1;
    markStateSeg(); renderMainBoard();
  });
  $('#sheetDone').addEventListener('click', closeEditor);
  $('#sheetClose').addEventListener('click', closeEditor);
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeEditor(); });

  // ---------------- controls ----------------
  function fillLen() {
    for (const id of ['minLen', 'maxLen']) {
      const s = $('#' + id); s.innerHTML = '';
      for (let k = 4; k <= 20; k++) s.insertAdjacentHTML('beforeend', `<option>${k}</option>`);
    }
  }
  fillLen();
  function syncControls() {
    $('#sideSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === grid.myHome));
    $('#startSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === settings.start));
    $('#minLen').value = settings.minLen; $('#maxLen').value = settings.maxLen;
    $('#sortSel').value = settings.sort;
    updateSolveBtn();
  }
  function updateSolveBtn() {
    const b = $('#solveBtn');
    b.disabled = !dictReady || !grid;
    if (!dictReady) b.textContent = 'Loading dictionary…';
    else if (b.textContent.startsWith('Loading')) b.textContent = 'Find words';
  }
  $('#sideSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !grid) return;
    grid.myHome = b.dataset.v;
    grid.myColor = grid.myHome === 'top' ? grid.topColor : other(grid.topColor);
    syncControls(); renderMainBoard();
  });
  $('#startSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    settings.start = b.dataset.v; saveSettings(); syncControls();
  });
  $('#minLen').addEventListener('change', e => { settings.minLen = +e.target.value; if (settings.maxLen < settings.minLen) settings.maxLen = settings.minLen; saveSettings(); syncControls(); });
  $('#maxLen').addEventListener('change', e => { settings.maxLen = +e.target.value; if (settings.minLen > settings.maxLen) settings.minLen = settings.maxLen; saveSettings(); syncControls(); });
  $('#sortSel').addEventListener('change', e => { settings.sort = e.target.value; saveSettings(); renderResults(true); });
  for (const id of ['#filterInput', '#startsInput', '#endsInput']) $(id).addEventListener('input', () => renderResults(true));
  $('#clearFilters').addEventListener('click', () => {
    for (const id of ['#filterInput', '#startsInput', '#endsInput']) $(id).value = '';
    settings.fCuts = settings.fReaches = false; saveSettings(); renderResults(true);
  });

  $('#solveBtn').addEventListener('click', () => {
    if (!grid || !dictReady) return;
    solveId++;
    $('#solveBtn').disabled = true; $('#solveBtn').textContent = 'Searching…';
    worker.postMessage({
      type: 'solve', id: solveId,
      grid: { rows: grid.rows, cols: grid.cols, letters: grid.letters, state: grid.state, myColor: grid.myColor, myHome: grid.myHome },
      opts: { minLen: settings.minLen, maxLen: settings.maxLen, start: settings.start, limit: 20000 },
    });
  });

  // ---------------- results ----------------
  function textFilter(sel) { return $(sel).value.toUpperCase().replace(/[^A-Z]/g, ''); }
  function sorted() {
    const f = $('#filterInput').value.trim().toUpperCase();
    let list = results;
    const sw = textFilter('#startsInput'), ew = textFilter('#endsInput');
    if (sw) list = list.filter(r => r.word.startsWith(sw));
    if (ew) list = list.filter(r => r.word.endsWith(ew));
    if (settings.fCuts) list = list.filter(r => r.cuts > 0);
    if (settings.fReaches) list = list.filter(r => r.reaches);
    if (f) {
      const re = new RegExp('^' + f.replace(/[^A-Z*?]/g, '').replace(/\?/g, '.').replace(/\*/g, '.*') + (f.includes('*') ? '$' : ''));
      list = list.filter(r => (f.includes('*') ? re.test(r.word) : r.word.includes(f.replace(/[^A-Z]/g, ''))));
    }
    const s = settings.sort;
    const cmp = {
      score: (a, b) => b.score - a.score || b.len - a.len,
      len: (a, b) => b.len - a.len || b.score - a.score,
      gained: (a, b) => b.gained - a.gained || b.score - a.score,
      depth: (a, b) => b.depthGain - a.depthGain || b.score - a.score,
      alpha: (a, b) => a.word.localeCompare(b.word),
    }[s];
    return list.slice().sort(cmp);
  }
  let view = [];
  function syncChips() {
    const n = { cuts: results.filter(r => r.cuts > 0).length, reaches: results.filter(r => r.reaches).length };
    document.querySelectorAll('#chips .chip').forEach(b => {
      const f = b.dataset.f, on = f === 'cuts' ? settings.fCuts : settings.fReaches;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.querySelector('.cnt').textContent = results.length ? n[f].toLocaleString() : '';
    });
  }
  $('#chips').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    if (b.dataset.f === 'cuts') settings.fCuts = !settings.fCuts; else settings.fReaches = !settings.fReaches;
    saveSettings(); renderResults(true);
  });
  function renderResults(reset) {
    if (reset) { syncChips(); view = sorted(); const filtered = settings.fCuts || settings.fReaches || $('#filterInput').value.trim() || textFilter('#startsInput') || textFilter('#endsInput');
      $('#clearFilters').hidden = !filtered;
      $('#resTitle').textContent = (filtered ? `${view.length.toLocaleString()} of ${lastTotal.toLocaleString()}` : lastTotal.toLocaleString()) + ' words' + (lastTimedOut ? ' (time limit hit)' : ''); view = sorted(); shown = 0; openIdx = -1; $('#results').innerHTML = ''; }
    const ol = $('#results');
    const end = Math.min(view.length, shown + 150);
    const frag = document.createDocumentFragment();
    for (let k = shown; k < end; k++) {
      const r = view[k];
      const li = document.createElement('li');
      li.dataset.k = k;
      const w = r.word.split('').map((ch, idx) => (r.wild.includes(idx) ? `<span class="wl">${ch}</span>` : ch)).join('');
      li.innerHTML = `<div class="res"><span class="word">${w}</span><span class="meta">${r.reaches ? '🏁' : ''}${r.cuts ? '✂' : ''}${r.whiteHits ? '★' : ''}<span class="len-b">${r.len}</span><span class="sc">${r.reaches ? r.score - 1000 : r.score}</span></span></div>`;
      frag.appendChild(li);
    }
    ol.appendChild(frag);
    shown = end;
    $('#moreBtn').hidden = shown >= view.length;
    if (!view.length) ol.innerHTML = '<li class="hint" style="padding:12px 0">No words match. Try turning off a filter, or “Next to them” / “Anywhere”.</li>';
  }
  $('#moreBtn').addEventListener('click', () => renderResults(false));
  $('#results').addEventListener('click', e => {
    const li = e.target.closest('li[data-k]'); if (!li) return;
    const k = +li.dataset.k;
    const prev = $('#results .detail'); if (prev) prev.remove();
    if (openIdx === k) { openIdx = -1; return; }
    openIdx = k;
    const r = view[k];
    const det = document.createElement('div'); det.className = 'detail';
    det.appendChild(miniBoard(r));
    const wilds = r.wild.map(idx => `🤔 = <b>${r.word[idx]}</b>`).join(', ');
    det.insertAdjacentHTML('beforeend', `<div class="facts">
      <span>Cells gained <b>${r.gained}</b></span><span>Stolen <b>${r.stolen}</b></span>${r.cuts ? `<span>Cuts through <b>${r.cuts}</b> opponent letter${r.cuts > 1 ? 's' : ''}</span>` : ''}
      <span>Rows advanced <b>${r.depthGain}</b></span>${r.whiteHits ? `<span>Capture tiles <b>${r.whiteHits}</b></span>` : ''}
      ${r.reaches ? '<span><b>🏁 Connects to opponent row</b></span>' : ''}${wilds ? `<span>${wilds}</span>` : ''}</div>`);
    li.appendChild(det);
  });

  // ---------------- tabs ----------------
  function showTab(t) {
    settings.tab = t; saveSettings();
    document.querySelectorAll('#tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t ? 'true' : 'false'));
    $('#gridView').hidden = t !== 'grid';
    $('#puzzleView').hidden = t !== 'puzzle';
    if (t === 'puzzle' && typeof syncPzBoard === 'function') { syncPzBoard(); runPuzzle(); }
    window.scrollTo(0, 0);
  }
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });

  // ---------------- puzzle solver ----------------
  let pzId = 0, pzTimer = 0;
  const pzLen = () => settings.pzLen || 0;
  (function buildLenPicker() {
    const box = $('#pzLen');
    const opts = [0]; for (let k = 4; k <= 20; k++) opts.push(k);
    box.innerHTML = opts.map(k => `<button type="button" data-len="${k}">${k || 'Any'}</button>`).join('');
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-len]'); if (!b) return;
      settings.pzLen = +b.dataset.len; saveSettings(); syncLen(); runPuzzle();
    });
  })();
  function syncLen() { document.querySelectorAll('#pzLen [data-len]').forEach(b => b.classList.toggle('on', +b.dataset.len === pzLen())); }
  syncLen();
  for (const id of ['#pzPrefix', '#pzPattern']) $(id).addEventListener('input', () => { clearTimeout(pzTimer); pzTimer = setTimeout(runPuzzle, 120); });
  $('#pzClear').addEventListener('click', () => { $('#pzPrefix').value = ''; $('#pzPattern').value = ''; settings.pzLen = 0; saveSettings(); syncLen(); runPuzzle(); $('#pzPrefix').focus(); });

  // ----- screenshot-board source -----
  let pzCache = null, pzSel = null, pzPending = null;
  const pzSrc = () => settings.pzSrc || 'dict';
  function syncSrc() {
    document.querySelectorAll('#pzSrcSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === pzSrc()));
    $('#pzBoardBox').hidden = pzSrc() !== 'board';
    syncPzBoard();
  }
  $('#pzSrcSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    settings.pzSrc = b.dataset.v; saveSettings(); pzSel = null; syncSrc(); runPuzzle();
  });
  $('#pzFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) readImageFile(f); e.target.value = ''; });
  function pzBoardChanged() { pzCache = null; pzSel = null; if (!$('#puzzleView').hidden) { syncPzBoard(); runPuzzle(); } }
  function syncPzBoard() {
    if (pzSrc() !== 'board') return;
    $('#pzFileLbl').textContent = grid ? 'Change screenshot' : 'Add screenshot';
    const low = grid ? grid.conf.filter(c => c < 0.5).length : 0;
    $('#pzBoardInfo').innerHTML = !grid ? 'Add a screenshot of the game. Words are traced through touching letters (diagonals too), each cell once.'
      : `Board ${grid.cols}×${grid.rows}.${low ? ` <b>${low}</b> cell${low > 1 ? 's' : ''} may be misread.` : ''} <button type="button" class="linkbtn inline" id="pzEdit">Fix letters in Grid solver</button>`;
    const v = $('#pzBoardView'); v.innerHTML = '';
    if (grid) {
      v.appendChild(miniBoard(pzSel || { path: [], wild: [], word: '' }));
      if (pzSel) v.insertAdjacentHTML('beforeend', `<p class="hint pz-sel">Showing <b>${pzSel.word}</b> — tap another word, or tap it again to hide.</p>`);
    }
    const ed = $('#pzEdit'); if (ed) ed.addEventListener('click', () => showTab('grid'));
  }
  function pzSolved(m) {
    pzCache = { key: pzPending, results: m.results };
    renderBoardWords();
  }
  function pzBounds() {
    const pattern = $('#pzPattern').value.toUpperCase().replace(/[^A-Z?]/g, '');
    const length = pzLen();
    if (pattern) return { min: pattern.length, max: pattern.length, conflict: length && length !== pattern.length ? 'Pattern length and number of letters differ.' : '' };
    return { min: length || 4, max: length || 20 };
  }
  function runBoardPuzzle() {
    if (!grid) { $('#pzTitle').textContent = 'Words'; $('#pzMsg').textContent = 'Add a screenshot of the game board above.'; $('#pzMsg').hidden = false; $('#pzResults').innerHTML = ''; return; }
    if (!dictReady) { $('#pzMsg').textContent = 'Loading dictionary…'; $('#pzMsg').hidden = false; return; }
    const b = pzBounds();
    if (b.conflict) { $('#pzTitle').textContent = '0 words'; $('#pzMsg').textContent = b.conflict; $('#pzMsg').hidden = false; $('#pzResults').innerHTML = ''; return; }
    const key = `${grid.rows}x${grid.cols}|${grid.letters.join(',')}|${b.min}-${b.max}`;
    if (pzCache && pzCache.key === key) return renderBoardWords();
    pzPending = key;
    $('#pzMsg').textContent = 'Searching the board…'; $('#pzMsg').hidden = false;
    worker.postMessage({
      type: 'solve', id: 'pz' + (++pzId),
      grid: { rows: grid.rows, cols: grid.cols, letters: grid.letters, state: grid.state, myColor: grid.myColor, myHome: grid.myHome },
      opts: { minLen: b.min, maxLen: b.max, start: 'anywhere', limit: 100000 },
    });
  }
  let pzMap = new Map();
  function renderBoardWords() {
    const prefix = $('#pzPrefix').value.toUpperCase().replace(/[^A-Z]/g, '');
    const pattern = $('#pzPattern').value.toUpperCase().replace(/[^A-Z?]/g, '');
    const re = pattern ? new RegExp('^' + pattern.replace(/\?/g, '.') + '$') : null;
    const list = pzCache.results.filter(r => r.word.startsWith(prefix) && (!re || re.test(r.word)))
      .sort((a, b) => a.len - b.len || (a.word < b.word ? -1 : 1));
    pzMap = new Map(list.map(r => [r.word, r]));
    $('#pzTitle').textContent = `${list.length.toLocaleString()} word${list.length === 1 ? '' : 's'} on the board`;
    const shown = list.slice(0, 3000);
    const msg = !list.length ? 'No words on this board match. Try another length or fewer starting letters.'
      : list.length > shown.length ? `Showing the first ${shown.length.toLocaleString()} — add starting letters to narrow it down.` : 'Tap a word to see its path on the board.';
    $('#pzMsg').textContent = msg; $('#pzMsg').hidden = false;
    renderWordGroups(shown.map(r => r.word), prefix, true);
  }
  $('#pzResults').addEventListener('click', e => {
    const w = e.target.closest('.pz-w[data-w]'); if (!w || pzSrc() !== 'board') return;
    const r = pzMap.get(w.dataset.w); if (!r) return;
    pzSel = pzSel && pzSel.word === r.word ? null : r;
    document.querySelectorAll('.pz-w.sel').forEach(x => x.classList.remove('sel'));
    if (pzSel) w.classList.add('sel');
    syncPzBoard();
    if (pzSel) $('#pzBoardView').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  function renderWordGroups(words, prefix, clickable) {
    const groups = new Map();
    for (const w of words) { if (!groups.has(w.length)) groups.set(w.length, []); groups.get(w.length).push(w); }
    $('#pzResults').innerHTML = [...groups].map(([len, ws]) =>
      `<div class="pz-group"><div class="lbl">${len} letters · ${ws.length.toLocaleString()}</div><div class="pz-words">${
        ws.map(w => `<span class="pz-w${clickable ? ' tap' : ''}${pzSel && pzSel.word === w ? ' sel' : ''}"${clickable ? ` data-w="${w}"` : ''}><b>${w.slice(0, prefix.length)}</b>${w.slice(prefix.length)}</span>`).join('')}</div></div>`).join('');
  }

  function runPuzzle() {
    if (pzSrc() === 'board') { $('#pzClear').hidden = !($('#pzPrefix').value || $('#pzPattern').value || pzLen()); return runBoardPuzzle(); }
    const prefix = $('#pzPrefix').value.toUpperCase().replace(/[^A-Z]/g, '');
    const pattern = $('#pzPattern').value.toUpperCase().replace(/[^A-Z?]/g, '');
    const length = pzLen();
    $('#pzClear').hidden = !(prefix || pattern || length);
    if (!prefix && !pattern && !length) { pzId++; $('#pzTitle').textContent = 'Words'; $('#pzMsg').textContent = 'Enter starting letters and/or pick a number of letters.'; $('#pzMsg').hidden = false; $('#pzResults').innerHTML = ''; return; }
    if (!dictReady) { $('#pzMsg').textContent = 'Loading dictionary…'; $('#pzMsg').hidden = false; return; }
    worker.postMessage({ type: 'lookup', id: ++pzId, query: { prefix, length, pattern, limit: 3000 } });
  }
  function renderPuzzle(m) {
        $('#pzTitle').textContent = `${m.total.toLocaleString()} word${m.total === 1 ? '' : 's'}`;
    const msg = m.conflict || (m.total === 0 ? 'No dictionary words match. (The dictionary only has words of 4–20 letters.)' : m.total > m.words.length ? `Showing the first ${m.words.length.toLocaleString()} — add more letters to narrow it down.` : '');
    $('#pzMsg').textContent = msg; $('#pzMsg').hidden = !msg;
    renderWordGroups(m.words, $('#pzPrefix').value.toUpperCase().replace(/[^A-Z]/g, ''), false);
  }
  syncSrc();
  if (settings.tab === 'puzzle') showTab('puzzle');

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
