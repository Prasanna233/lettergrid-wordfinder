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
  const worker = new Worker('solver.worker.js?v=28');
  let solveId = 0;
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'ready') {
      dictReady = true;
      setStatus(m.count.toLocaleString() + ' words', 'ok');
      updateSolveBtn();
      runPuzzle();
      if (grid) checkHeavy();
      if (pendingFresh && grid) runFresh();
      if (invPending && grid) invRun();
    } else if (m.type === 'solved' && typeof m.id === 'string') {
      if (m.id === 'pz' + pzId) pzSolved(m);
      else if (m.id === 'hv' + hvId) renderHeavy(m);
      else if (m.id === 'wn' + wnId) { computeWin(m.results); paintBoard(); }
      else if (m.id === 'wpme' + wpId) { wpPart.me = m; renderWinPct(); }
      else if (m.id === 'inv' + invId) invSolved(m);
      else if (m.id === 'ivme' + ivId) { ivPart.me = m; invScore(); }
      else if (m.id === 'ivop' + ivId) { ivPart.op = m; invScore(); }
      else if (m.id === 'wpop' + wpId) { wpPart.op = m; renderWinPct(); }
    } else if (m.type === 'solved') {
      if (m.id !== solveId) return;
      results = m.results;
      if (isInvasion()) results.forEach(r => { if (r.reaches) { r.reaches = false; r.score -= 1000; } });   // reaching the base doesn't win in Invasion
      $('#solveBtn').textContent = 'Find words';
      updateSolveBtn();
      lastTotal = m.total; lastTimedOut = m.timedOut;
      renderResults(true);
      $('#resultsCard').hidden = false;
      syncWinNote();
      if (!freshRun && !$('#gridView').hidden) $('#resultsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      freshRun = false;
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
    const list = await (await fetch('templates.json?v=3')).json();
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

  // ---------------- which player am I? ----------------
  // The app learns the shape of the user's name in the header (from the side they pick) and finds it on
  // either side of the header in later screenshots. Until it has learned, it assumes the left-hand player.
  // remembered samples of the user's name (several layouts look slightly different)
  function nameSamples() { return Array.isArray(settings.mySigs) ? settings.mySigs.filter(x => x && x.v === 2) : []; }   // older-format samples are dropped
  function nameDist(sig) { return Math.min(Infinity, ...nameSamples().map(x => LGReader.sigDistance(x, sig))); }
  function learnMyName(header, color) {
    if (!header) return;
    const mineB = header.left.color === color ? header.left : header.right.color === color ? header.right : null;
    const theirs = mineB === header.left ? header.right : header.left;
    if (!mineB || !mineB.sig) return;
    // drop any sample that looks like the other player's name (e.g. a wrong first guess), then add this one
    let list = nameSamples().filter(x => !(theirs.sig && LGReader.sigDistance(x, theirs.sig) < 0.03));
    if (!list.some(x => LGReader.sigDistance(x, mineB.sig) < 0.01)) list.push(mineB.sig);
    settings.mySigs = list.slice(-8); delete settings.mySig; saveSettings();
  }
  function whoAmI(r) {
    const h = r.header;
    if (h && nameSamples().length && h.left.sig && h.right.sig) {
      const dl = nameDist(h.left.sig), dr = nameDist(h.right.sig), lo = Math.min(dl, dr), hi = Math.max(dl, dr);
      if (lo < 0.08 && hi / Math.max(lo, 1e-6) > 2) {
        const color = dl < dr ? h.left.color : h.right.color;
        learnMyName(h, color);                      // keep learning this layout's version of the name
        return { color, byName: true };
      }
    }
    const color = r.myColor;                        // not sure yet: assume the left-hand player
    const learned = !nameSamples().length && !!h && !!(h.left.sig && h.right.sig);
    if (learned) learnMyName(h, color);
    return { color, byName: false, learned, unsure: !!h && nameSamples().length > 0 };
  }

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
      const who = whoAmI(r);
      grid = {
        rows: r.rows, cols: r.cols,
        letters: new Array(n), state: new Array(n), conf: new Array(n),
        topColor: r.topColor, myColor: who.color, header: r.header,
        myHome: who.color === r.topColor ? 'top' : 'bottom',
      };
      r.cells.flat().forEach((c, i) => { grid.letters[i] = c.letter; grid.state[i] = c.state; grid.conf[i] = c.conf; });
      const low = grid.conf.filter(c => c < 0.5).length;
      const side = `You are <b>${who.color === 'O' ? 'orange' : 'blue'}</b> (${grid.myHome})${who.byName ? ', recognised by your name' : who.learned ? ' — the app has now learned your name; if this is wrong, tap the other side under “I play from” once' : who.unsure ? ' — not sure from the name on this layout; if this is wrong, tap the other side under “I play from” and the app will learn it' : ''}.`;
      showMsg(low ? `Read ${r.cols}×${r.rows} board. ${low} cell${low > 1 ? 's' : ''} marked with a dashed outline — please check.` : `Read ${r.cols}×${r.rows} board. Check it matches, then tap Find words.`);
      $('#readMsg').innerHTML += ' ' + side;
      wpNewUpload = true;
      grid.mode = r.cols < 10 ? 'invasion' : 'race';
      afterGridLoaded();
      if (grid.mode === 'invasion') {
        $('#freshNote').hidden = true;
        if ($('#invView').hidden) showTab('invasion'); else invSync();
        if (dictReady) invRun(); else invPending = true;
      } else freshStart();
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
    heavyText = ''; $('#heavyNote').hidden = true; $('#winPct').hidden = true; syncHeavyPz(); syncHalf();
    results = []; openIdx = -1;
    $('#boardCard').hidden = false;
    $('#resultsCard').hidden = true;
    size.cols = grid.cols; size.rows = grid.rows; syncSize();
    syncControls(); syncStage();
    renderMainBoard();
    if (!$('#gridView').hidden) $('#boardCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------- fresh board: opening words ----------------
  // A new game has nothing captured apart from the two home rows. For those boards the word list
  // opens automatically, sorted with words that reach the opponent first, then the ones that get closest.
  let pendingFresh = false;
  // Which of my turns this board is, judged from the cells I have captured outside the home rows:
  //   1 = my first word (nothing captured yet; the game's opening word is exactly 7 letters)
  //   2 = my second word (one word on the board: up to 7 cells, plus up to 8 more from a capture tile)
  //   0 = later in the game
  function myCaptured() {
    let n = 0;
    for (let i = 0; i < grid.rows * grid.cols; i++) {
      const r = Math.floor(i / grid.cols);
      if (r !== 0 && r !== grid.rows - 1 && grid.state[i] === grid.myColor) n++;
    }
    return n;
  }
  function guessStage() { const n = myCaptured(); return n === 0 ? 1 : n <= 15 ? 2 : 0; }
  function turnStage() { return grid ? guessStage() : 0; }
  function syncStage() {}
  function isFresh() { return turnStage() === 1; }
  function freshStart() {
    const stage = turnStage(), note = $('#freshNote');
    syncStage();
    if (!stage) {
      note.hidden = true;
      if (settings.autoLen) { settings.minLen = 4; settings.maxLen = 20; settings.autoLen = false; }
      if (settings.autoSort) { settings.sort = 'score'; settings.autoSort = false; }
      saveSettings(); syncControls(); paintBoard();
      return;
    }
    settings.sort = 'reach'; settings.autoSort = true; settings.start = 'mine'; settings.fReaches = false;
    if (stage === 1) { settings.minLen = 7; settings.maxLen = 7; settings.autoLen = true; }
    else if (settings.autoLen) { settings.minLen = 4; settings.maxLen = 20; settings.autoLen = false; }
    saveSettings(); syncControls();
    note.innerHTML = stage === 1
      ? '🆕 <b>Your first word</b> — the opening word is exactly <b>7 letters</b>, so it can\u2019t reach the opponent\u2019s base yet. These 7-letter words start on your home row; the ones that get closest to the opponent come first.'
      : '2️⃣ <b>Your second word</b> — words that <b>reach the opponent\u2019s base</b> come first (🏁 WIN), then the ones that get closest to it, longest first.';
    note.hidden = false;
    paintBoard();
    if (dictReady) runFresh(); else pendingFresh = true;
  }
  function runFresh() { pendingFresh = false; freshRun = true; $('#solveBtn').click(); }
  let freshRun = false;

  // ---------------- left / right half picker ----------------
  const half = () => settings.half || 'both';
  // keep in step with solver.worker.js: 30% of the width stays outside the centre on each side
  function centreCols(cols) { const lo = Math.floor(cols * 0.3); return [lo, cols - 1 - lo]; }
  function syncHalf() {
    for (const id of ['#halfSeg', '#pzHalfSeg']) $(id).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === half()));
    const cols = grid ? grid.cols : 10, [lo, hi] = centreCols(cols), mid = (cols - 1) / 2;
    const L = Math.floor(mid) + 1, R = Math.ceil(mid) + 1;
    const txt = { both: '', left: `Columns 1–${L}`, right: `Columns ${R}–${cols}`, center: `Centre = columns ${lo + 1}–${hi + 1} of ${cols}` }[half()];
    document.querySelectorAll('.half-hint').forEach(p => { p.textContent = txt; p.hidden = !txt; });
  }
  for (const id of ['#halfSeg', '#pzHalfSeg']) $(id).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.dataset.v === half()) return;
    settings.half = b.dataset.v; saveSettings(); syncHalf();
    if (!grid) return;
    renderMainBoard();                         // redraw dimming; also refreshes the puzzle board + results
    if (!$('#resultsCard').hidden && dictReady) $('#solveBtn').click();  // keep grid results in step
  });
  syncHalf();

  // ---------------- left / right heavy ----------------
  let hvId = 0, hvTimer = 0, heavyText = '';
  function checkHeavy() {
    if (!grid || !dictReady) return;
    worker.postMessage({
      type: 'solve', id: 'hv' + (++hvId),
      grid: { rows: grid.rows, cols: grid.cols, letters: grid.letters, state: grid.state, myColor: grid.myColor, myHome: grid.myHome },
      opts: { minLen: 4, maxLen: 20, start: 'anywhere', limit: 200000, wildFollowUp: false },
    });
    checkWinPct();
    worker.postMessage({
      type: 'solve', id: 'wn' + (++wnId),
      grid: { rows: grid.rows, cols: grid.cols, letters: grid.letters, state: grid.state, myColor: grid.myColor, myHome: grid.myHome },
      opts: { minLen: 4, maxLen: 20, start: 'frontier', limit: 200000, wildFollowUp: false },
    });
  }
  let wnId = 0;

  // ---------------- win chance (estimate) ----------------
  // Two searches: my best word this turn, and the opponent's best word on their next turn
  // (their side and colour swapped). A side with nothing captured yet is on its 7-letter opening word.
  let wpId = 0, wpPart = {}, wpNewUpload = false;
  function capturedBy(color) {
    let n = 0;
    for (let i = 0; i < grid.rows * grid.cols; i++) {
      const r = Math.floor(i / grid.cols);
      if (r !== 0 && r !== grid.rows - 1 && grid.state[i] === color) n++;
    }
    return n;
  }
  function checkWinPct() {
    if (!grid || !dictReady) return;
    wpId++; wpPart = { key: gridKey() };
    const oppColor = other(grid.myColor), oppHome = grid.myHome === 'top' ? 'bottom' : 'top';
    const base = { rows: grid.rows, cols: grid.cols, letters: grid.letters, state: grid.state };
    const lens = c => capturedBy(c) === 0 ? { minLen: 7, maxLen: 7 } : { minLen: 4, maxLen: 20 };
    worker.postMessage({ type: 'solve', id: 'wpme' + wpId, grid: { ...base, myColor: grid.myColor, myHome: grid.myHome },
      opts: { ...lens(grid.myColor), start: 'adjacent', limit: 100000, wildFollowUp: false } });
    worker.postMessage({ type: 'solve', id: 'wpop' + wpId, grid: { ...base, myColor: oppColor, myHome: oppHome },
      opts: { ...lens(oppColor), start: 'adjacent', limit: 100000, wildFollowUp: false } });
  }
  // one side's outlook: can it win on its next word, and roughly how many of its turns until it reaches the base
  function outlook(m) {
    const need = grid.rows - 1 - m.curDepth;        // rows still to cover to touch the other base
    let wins = 0, push = 0;
    for (const r of m.results) { if (r.reaches) wins++; if (r.depthGain > push) push = r.depthGain; }
    const canWin = wins > 0;
    const turns = canWin ? 1 : 1 + Math.ceil(Math.max(0, need - push) / Math.max(3, push));
    return { canWin, need, push, turns, words: wins };
  }
  function winChance(me, op) {
    if (me.canWin) return 95;                       // it's my turn: a winning word is on the board
    if (op.canWin) return 12;                       // they can win next turn unless I block it
    const mineN = capturedBy(grid.myColor), oppN = capturedBy(other(grid.myColor));
    const tot = Math.max(1, mineN + oppN);
    const logit = 1.1 * (op.turns - me.turns + 0.5) + 1.5 * (mineN - oppN) / tot;   // +0.5: I move first
    return Math.max(5, Math.min(95, Math.round(100 / (1 + Math.exp(-logit)))));
  }
  function loadHistory() { try { return JSON.parse(localStorage.getItem('gwf-turns') || '[]'); } catch (e) { return []; } }
  function saveHistory(h) { try { localStorage.setItem('gwf-turns', JSON.stringify(h.slice(-40))); } catch (e) {} }
  function renderWinPct() {
    if (isInvasion()) { $('#winPct').hidden = true; return; }          // race-mode estimate doesn't apply
    if (!wpPart.me || !wpPart.op || wpPart.key !== gridKey()) return;
    const me = outlook(wpPart.me), op = outlook(wpPart.op), pMe = winChance(me, op), pOp = 100 - pMe;
    // history: a new screenshot adds a turn (a fresh board starts a new game); edits and side switches update it
    let h = loadHistory();
    const entry = { me: pMe, op: pOp, t: Date.now() };
    if (wpNewUpload) { if (turnStage() === 1) h = []; h.push(entry); wpNewUpload = false; }
    else if (h.length) h[h.length - 1] = entry; else h.push(entry);
    saveHistory(h);
    const box = $('#winPct'); box.hidden = false;
    const why = me.canWin ? `You can win <b>this turn</b> (${me.words.toLocaleString()} word${me.words > 1 ? 's' : ''} to choose from).`
      : op.canWin ? `⚠️ The opponent can win on their <b>next turn</b> — win first or block their path.`
      : `You need <b>${me.need}</b> more row${me.need === 1 ? '' : 's'} (best word now: +${me.push}); the opponent needs <b>${op.need}</b> (their best next word: +${op.push}).`;
    box.innerHTML = `<div class="wp-head"><span class="lbl">Win chance · estimate</span><span class="wp-turn">Turn ${h.length}</span></div>
      <div class="wp-labels"><span class="wp-l-me">You ${pMe}%</span><span class="wp-l-op">Opponent ${pOp}%</span></div>
      <div class="wp-bar" role="img" aria-label="You ${pMe} percent, opponent ${pOp} percent"><span class="wp-me" style="width:${pMe}%"></span><span class="wp-op" style="width:${pOp}%"></span></div>
      <p class="wp-why">${why}</p>
      ${h.length > 1 ? `<div class="wp-hist">${h.map((x, i) => `<span class="wp-chip${i === h.length - 1 ? ' cur' : ''}"><b>T${i + 1}</b> ${x.me}–${x.op}</span>`).join('')}<button type="button" class="linkbtn inline" id="wpReset">New game</button></div>` : ''}`;
    const rs = $('#wpReset'); if (rs) rs.addEventListener('click', () => { saveHistory([entry]); renderWinPct(); });
    // colours follow the players: mine is orange or blue depending on the board
    // same scheme as the board: my tiles orange, the opponent's blue
    box.style.setProperty('--wp-me', 'var(--orange)');
    box.style.setProperty('--wp-op', 'var(--blue)');
  }
  function renderHeavy(m) {
    const mid = (grid.cols - 1) / 2;
    let L = 0, R = 0;
    for (const r of m.results) {
      let s = 0; for (const i of r.path) s += i % grid.cols;
      const avg = s / r.path.length;
      if (avg < mid - 1e-9) L++; else if (avg > mid + 1e-9) R++;
    }
    const el = $('#heavyNote');
    if (!L && !R) { heavyText = ''; el.hidden = true; syncHeavyPz(); return; }
    const pl = Math.round(100 * L / (L + R)), pr = 100 - pl;
    const f = x => x.toLocaleString();
    if (pl >= 55) { heavyText = `⬅ <b>Left heavy</b>: ${pl}% of the words on this board sit on the left half (${f(L)} vs ${f(R)}).`; el.className = 'heavy left'; }
    else if (pr >= 55) { heavyText = `<b>Right heavy</b> ➡: ${pr}% of the words on this board sit on the right half (${f(R)} vs ${f(L)}).`; el.className = 'heavy right'; }
    else { heavyText = `⚖ <b>Balanced</b>: ${pl}% of words on the left half, ${pr}% on the right.`; el.className = 'heavy'; }
    el.innerHTML = heavyText; el.hidden = false;
    syncHeavyPz();
  }
  function syncHeavyPz() { const p = $('#pzHeavy'); if (p) { p.innerHTML = heavyText; p.hidden = !heavyText; } }

  // ---------------- board rendering ----------------
  function outsideHalf(i) {
    const h = half(); if (h === 'both') return false;
    const c = i % grid.cols, mid = (grid.cols - 1) / 2;
    if (h === 'center') { const [lo, hi] = centreCols(grid.cols); return c < lo || c > hi; }
    return h === 'left' ? c > mid : c < mid;
  }
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
    if (outsideHalf(i)) cls += ' off';
    return cls;
  }
  function letterHTML(i) {
    const L = grid.letters[i];
    return L === '?' ? '<span class="w">🤔</span>' : (L || '·');
  }

  // ---------------- winning letters & words ----------------
  let win = null; // { key, cells:Set, land:Set, count }
  const gridKey = () => grid ? grid.letters.join('') + '|' + grid.state.join('') + '|' + grid.myHome + '|' + grid.rows + 'x' + grid.cols : '';
  // computed from a board-wide search (any start position, both sides), so it ignores the
  // "Word starts" and Left/Centre/Right settings and appears as soon as a board is loaded
  function computeWin(list) {
    const cells = new Set(), land = new Set(); let count = 0;
    for (const r of list) if (r.reaches) {
      count++;
      r.path.forEach(c => cells.add(c));
      (r.winAt || []).forEach(k => land.add(r.path[k]));
    }
    win = { key: gridKey(), cells, land, count };
  }
  function winFor(i) { return win && win.key === gridKey() ? { on: win.cells.has(i), land: win.land.has(i) } : { on: false, land: false }; }
  function isInvasion() { return !!grid && grid.mode === 'invasion'; }
  function syncWinNote() {
    const el = $('#winNote'); if (!el) return;
    if (!grid) { el.hidden = true; return; }
    $('#chips [data-f="reaches"]').hidden = isInvasion();
    if (isInvasion()) {
      el.className = 'win-note yes'; el.hidden = false;
      el.innerHTML = 'This is an <b>Invasion</b> board: the first to 20 cells wins and reaching the opponent\u2019s base doesn\u2019t. <button type="button" class="linkbtn inline" id="toInv">Open the Invasion tab</button>';
      $('#toInv').addEventListener('click', () => showTab('invasion'));
      return;
    }
    if (!win || win.key !== gridKey()) {
      el.className = 'win-note';
      el.textContent = dictReady ? 'Finding winning words…' : 'Winning words will be counted once the dictionary loads.';
      el.hidden = false; return;
    }
    el.hidden = false;
    el.className = 'win-note' + (win.count ? ' yes' : '');
    el.innerHTML = win.count && !isFresh()
      ? `🏁 <b>${win.count.toLocaleString()} winning word${win.count > 1 ? 's' : ''}</b> for you (playing from the <b>${grid.myHome}</b>, reaching the ${grid.myHome === 'top' ? 'bottom' : 'top'} row), starting next to your cells and away from the opponent\u2019s. <button type="button" class="linkbtn inline" id="winOnly">${showingAllWins() ? 'Show all words' : 'List them'}</button>`
      : isFresh()
        ? `🆕 <b>Your first word</b> is 7 letters, so it can\u2019t reach the opponent\u2019s base (the ${grid.myHome === 'top' ? 'bottom' : 'top'} row) yet. The 7-letter words that get closest are listed below. <button type="button" class="linkbtn inline" id="seeOpening">See opening words</button>`
        : `No winning word yet: none that starts next to your cells (away from the opponent\u2019s) reaches their base (the ${grid.myHome === 'top' ? 'bottom' : 'top'} row).`;
    const so = $('#seeOpening');
    if (so) so.addEventListener('click', () => { if ($('#resultsCard').hidden) runFresh(); else $('#resultsCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    const b = $('#winOnly');
    if (b) b.addEventListener('click', () => {
      if (showingAllWins()) { winList = false; settings.fReaches = false; saveSettings(); $('#solveBtn').click(); return; }
      // list the winning words: same start rule as the count, both sides, winning filter on
      winList = true; settings.half = 'both'; settings.fReaches = true; saveSettings();
      syncHalf(); renderMainBoard();
      $('#solveBtn').click();
    });
  }

  let winList = false;   // true while the list shows the winning words from the note
  function showingAllWins() { return winList && settings.fReaches && !$('#resultsCard').hidden; }

  function renderMainBoard() {
    clearTimeout(hvTimer); hvTimer = setTimeout(checkHeavy, 700);
    if (typeof pzBoardChanged === 'function') pzBoardChanged();
    paintBoard();
  }
  // draws the board only (no background searches), so it is safe to call from search results
  function paintBoard() {
    if (!grid) return;
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
    syncWinNote();
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
      if (k !== undefined && res.reaches && (res.winAt || []).includes(k)) { d.classList.add('land'); d.insertAdjacentHTML('beforeend', '<span class="flag">🏁</span>'); }
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
    syncSide();
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
  function syncSide() {
    for (const id of ['#sideSeg', '#pzSideSeg', '#invSideSeg']) $(id).querySelectorAll('button').forEach(b => b.classList.toggle('on', !!grid && b.dataset.v === grid.myHome));
  }
  // switching sides recomputes the winning letters (they depend on which base is the opponent's)
  for (const id of ['#sideSeg', '#pzSideSeg', '#invSideSeg']) $(id).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !grid || b.dataset.v === grid.myHome) return;
    grid.myHome = b.dataset.v;
    grid.myColor = grid.myHome === 'top' ? grid.topColor : other(grid.topColor);
    learnMyName(grid.header, grid.myColor);
    syncControls(); renderMainBoard();
    if (typeof invSync === 'function' && !$('#invView').hidden) { invSync(); if (!$('#invResultsCard').hidden) invRun(); return; }
    if (turnStage()) freshStart();
    else if (!$('#resultsCard').hidden && dictReady) $('#solveBtn').click();   // keep the word list in step
  });
  $('#startSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    settings.start = b.dataset.v; winList = false; saveSettings(); syncControls();
  });
  $('#minLen').addEventListener('change', e => { settings.minLen = +e.target.value; if (settings.maxLen < settings.minLen) settings.maxLen = settings.minLen; saveSettings(); syncControls(); });
  $('#maxLen').addEventListener('change', e => { settings.maxLen = +e.target.value; if (settings.minLen > settings.maxLen) settings.minLen = settings.maxLen; saveSettings(); syncControls(); });
  $('#sortSel').addEventListener('change', e => { settings.sort = e.target.value; settings.autoSort = false; saveSettings(); if (settings.sort !== 'reach') $('#freshNote').hidden = true; renderResults(true); });
  for (const id of ['#filterInput', '#startsInput', '#endsInput']) $(id).addEventListener('input', () => renderResults(true));
  $('#clearFilters').addEventListener('click', () => {
    for (const id of ['#filterInput', '#startsInput', '#endsInput']) $(id).value = '';
    settings.fCuts = settings.fReaches = false; saveSettings(); renderResults(true);
  });

  $('#solveBtn').addEventListener('click', e => {
    if (!grid || !dictReady) return;
    if (e.isTrusted) winList = false;   // a real tap on Find words goes back to the normal search
    solveId++;
    $('#solveBtn').disabled = true; $('#solveBtn').textContent = 'Searching…';
    worker.postMessage({
      type: 'solve', id: solveId,
      grid: { rows: grid.rows, cols: grid.cols, letters: grid.letters, state: grid.state, myColor: grid.myColor, myHome: grid.myHome },
      opts: { minLen: winList ? 4 : settings.minLen, maxLen: winList ? 20 : settings.maxLen, start: winList ? 'frontier' : settings.start, side: half(), limit: 20000 },
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
    if (settings.fReaches && !isInvasion()) list = list.filter(r => r.reaches);
    if (f) {
      const re = new RegExp('^' + f.replace(/[^A-Z*?]/g, '').replace(/\?/g, '.').replace(/\*/g, '.*') + (f.includes('*') ? '$' : ''));
      list = list.filter(r => (f.includes('*') ? re.test(r.word) : r.word.includes(f.replace(/[^A-Z]/g, ''))));
    }
    const s = settings.sort;
    const cmp = {
      score: (a, b) => b.score - a.score || b.len - a.len,
      reach: (a, b) => (b.reaches - a.reaches) || b.depthGain - a.depthGain || b.len - a.len || b.score - a.score,
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
    saveSettings(); renderResults(true); syncWinNote();
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
      if (r.reaches) li.className = 'win';
      li.innerHTML = `<div class="res"><span class="word">${w}</span><span class="meta">${r.reaches ? '<span class="win-b">🏁 WIN</span>' : ''}${r.cuts ? '✂' : ''}${r.whiteHits ? '★' : ''}${r.followUp !== undefined ? `<span class="fu" title="Follow-up words through the wildcard">🤔${r.followUp}</span>` : ''}<span class="len-b">${r.len}</span><span class="sc">${Math.round(r.reaches ? r.score - 1000 : r.score)}</span></span></div>`;
      frag.appendChild(li);
    }
    ol.appendChild(frag);
    shown = end;
    $('#moreBtn').hidden = shown >= view.length;
    if (!view.length) ol.innerHTML = '<li class="hint" style="padding:12px 0">No words match. Try turning off a filter, or another “Word starts” option.</li>';
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
    const wilds = r.wild.map(idx => `🤔 = <b>${r.word[idx]}</b>`).join(', ')
      + (r.followUp !== undefined ? (r.followUp ? ` — opens <b>${r.followUp}</b> follow-up word${r.followUp > 1 ? 's' : ''} through it next turn` : ' — <b>dead end</b>: no follow-up words through it') : '');
    det.insertAdjacentHTML('beforeend', `<div class="facts">
      <span>Cells gained <b>${r.gained}</b></span><span>Stolen <b>${r.stolen}</b></span>${r.cuts ? `<span>Cuts through <b>${r.cuts}</b> opponent letter${r.cuts > 1 ? 's' : ''}</span>` : ''}
      <span>Rows advanced <b>${r.depthGain}</b></span>${r.whiteHits ? `<span>Capture tiles <b>${r.whiteHits}</b></span>` : ''}
      ${r.reaches ? `<span class="win-fact">🏁 <b>Winning word</b> — reaches the opponent's base at ${(r.winAt || []).map(k => `<b>${r.word[k]}</b> (letter ${k + 1})`).join(', ')}</span>` : ''}${wilds ? `<span>${wilds}</span>` : ''}</div>`);
    li.appendChild(det);
  });

  // ---------------- Invasion ----------------
  // Smaller boards are played for tiles: whoever holds the most (first to the target shown in the header,
  // e.g. "6/20") wins. A word captures the tiles it passes through, including the opponent's.
  let invId = 0, ivId = 0, ivPart = {}, invPending = false, invList = [], invShown = 0, invOpen = -1;
  const invT = () => Math.max(5, +settings.invTarget || 20);
  const tiles = c => grid ? grid.state.filter(s => s === c).length : 0;
  (function invInit() {
    for (const id of ['#invMin', '#invMax']) { const s = $(id); for (let k = 4; k <= 20; k++) s.insertAdjacentHTML('beforeend', `<option>${k}</option>`); }
    $('#invFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) readImageFile(f); e.target.value = ''; });
    $('#invStartSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; settings.invStart = b.dataset.v; saveSettings(); invSync(); });
    $('#invMin').addEventListener('change', e => { settings.invMin = +e.target.value; if ((settings.invMax || 20) < settings.invMin) settings.invMax = settings.invMin; saveSettings(); invSync(); });
    $('#invMax').addEventListener('change', e => { settings.invMax = +e.target.value; if ((settings.invMin || 4) > settings.invMax) settings.invMin = settings.invMax; saveSettings(); invSync(); });
    $('#invTarget').addEventListener('change', e => { settings.invTarget = Math.max(5, Math.min(200, +e.target.value || 20)); saveSettings(); invSync(); invScore(); renderInv(true); });
    $('#invFind').addEventListener('click', () => invRun());
    $('#invMore').addEventListener('click', () => renderInv(false));
    $('#invResults').addEventListener('click', e => {
      const li = e.target.closest('li[data-k]'); if (!li) return;
      const k = +li.dataset.k, prev = $('#invResults .detail'); if (prev) prev.remove();
      if (invOpen === k) { invOpen = -1; return; }
      invOpen = k; const r = invList[k];
      const det = document.createElement('div'); det.className = 'detail';
      det.appendChild(miniBoard(r));
      const wilds = r.wild.map(idx => `🤔 = <b>${r.word[idx]}</b>`).join(', ');
      det.insertAdjacentHTML('beforeend', `<div class="facts"><span>New cells <b>+${r.free}</b> for you</span>${r.stolen ? `<span>Cuts <b>${r.stolen}</b> opponent letter${r.stolen === 1 ? '' : 's'} (+${r.stolen} for you, −${r.stolen} for them)</span>` : ''}
        <span>After this word: you <b>${r.after}</b>, opponent <b>${r.oppAfter}</b></span>${wilds ? `<span>${wilds}</span>` : ''}</div>`);
      li.appendChild(det);
    });
  })();
  function invSync() {
    $('#invTarget').value = invT();
    $('#invStartSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === (settings.invStart || 'mine')));
    $('#invMin').value = settings.invMin || 4; $('#invMax').value = settings.invMax || 20;
    $('#invFileLbl').textContent = grid ? 'Change screenshot' : 'Add screenshot';
    $('#invBody').hidden = !grid;
    if (!grid) return;
    syncSide();
    $('#invInfo').innerHTML = `Board ${grid.cols}×${grid.rows}. You are <b>${grid.myColor === 'O' ? 'orange' : 'blue'}</b>. <button type="button" class="linkbtn inline" id="invEdit">Fix letters in Grid solver</button>`;
    $('#invEdit').addEventListener('click', () => showTab('grid'));
    const v = $('#invBoard'); v.innerHTML = ''; v.appendChild(miniBoard({ path: [], wild: [], word: '' }));
    invScore();
  }
  function invOpts(start) { return { minLen: settings.invMin || 4, maxLen: settings.invMax || 20, start, limit: 100000, wildFollowUp: false }; }
  function invRun() {
    invPending = false;
    if (!grid || !dictReady) { invPending = !!grid; return; }
    const base = { rows: grid.rows, cols: grid.cols, letters: grid.letters, state: grid.state };
    const oppColor = other(grid.myColor), oppHome = grid.myHome === 'top' ? 'bottom' : 'top';
    $('#invFind').disabled = true; $('#invFind').textContent = 'Searching…';
    worker.postMessage({ type: 'solve', id: 'inv' + (++invId), grid: { ...base, myColor: grid.myColor, myHome: grid.myHome }, opts: invOpts(settings.invStart || 'mine') });
    // win chance: my best word now vs the opponent's best word next turn
    ivId++; ivPart = { key: gridKey() };
    worker.postMessage({ type: 'solve', id: 'ivme' + ivId, grid: { ...base, myColor: grid.myColor, myHome: grid.myHome }, opts: invOpts(settings.invStart || 'mine') });
    worker.postMessage({ type: 'solve', id: 'ivop' + ivId, grid: { ...base, myColor: oppColor, myHome: oppHome }, opts: invOpts(settings.invStart || 'mine') });
  }
  // Invasion points (checked against the game's own header counts): every cell my word captures is +1
  // for me — free cells and opponent letters alike — and each opponent letter it cuts is also -1 for them.
  // Reaching the opponent's base means nothing here.
  function freeOf(r) { return r.gained - r.stolen; }           // new free cells only
  function gainOf(r) { return r.gained; }                      // all cells I end up with (free + cut)
  function swingOf(r) { return r.gained + r.stolen; }          // change in (my cells - their cells)
  function invSolved(m) {
    $('#invFind').disabled = false; $('#invFind').textContent = 'Find words';
    const me = tiles(grid.myColor), op = tiles(other(grid.myColor)), T = invT();
    invList = m.results.map(r => ({ ...r, reaches: false, free: freeOf(r), swing: swingOf(r), after: me + gainOf(r), oppAfter: op - r.stolen }));
    invList.forEach(r => { r.wins = r.after >= T; });
    invList.sort((a, b) => (b.wins - a.wins) || b.swing - a.swing || b.stolen - a.stolen || b.after - a.after || b.len - a.len || a.word.localeCompare(b.word));
    $('#invResultsCard').hidden = false;
    renderInv(true);
  }
  function renderInv(reset) {
    if (reset) { invShown = 0; invOpen = -1; $('#invResults').innerHTML = ''; }
    if (!invList.length && reset) { $('#invTitle').textContent = 'No words'; $('#invResults').innerHTML = '<li class="hint" style="padding:12px 0">No words with these settings. Try “Next to them” or a wider length.</li>'; $('#invMore').hidden = true; return; }
    const T = invT(); invList.forEach(r => { r.wins = r.after >= T; });
    $('#invTitle').textContent = `${invList.length.toLocaleString()} words`;
    const end = Math.min(invList.length, invShown + 150), frag = document.createDocumentFragment();
    for (let k = invShown; k < end; k++) {
      const r = invList[k], li = document.createElement('li');
      li.dataset.k = k; if (r.wins) li.className = 'win';
      const w = r.word.split('').map((ch, i) => (r.wild.includes(i) ? `<span class="wl">${ch}</span>` : ch)).join('');
      li.innerHTML = `<div class="res"><span class="word">${w}</span><span class="meta">${r.wins ? '<span class="win-b">🏁 WIN</span>' : ''}${r.stolen ? `<span class="cut-b" title="opponent letters cut: +1 for you, −1 for them">✂${r.stolen}</span>` : ''}<span class="len-b">${r.len}</span><span class="tot" title="your cells after this word">${Math.min(r.after, 99)}/${invT()}</span></span></div>`;
      frag.appendChild(li);
    }
    $('#invResults').appendChild(frag); invShown = end;
    $('#invMore').hidden = invShown >= invList.length;
  }
  function invScore() {
    const box = $('#invScore'); if (!grid) return;
    const me = tiles(grid.myColor), op = tiles(other(grid.myColor)), T = invT();
    let html = `<div class="wp-head"><span class="lbl">Cells · first to ${T} wins</span></div>
      <div class="wp-labels"><span class="wp-l-me">You ${me}/${T}</span><span class="wp-l-op">Opponent ${op}/${T}</span></div>`;
    if (ivPart.me && ivPart.op && ivPart.key === gridKey()) {
      // best = most points this turn: new cells for me + letters cut from them
      const best = res => res.results.reduce((b, r) => (swingOf(r) > swingOf(b) ? r : b), { gained: 0, stolen: 0 });
      const mb = best(ivPart.me), ob = best(ivPart.op);
      const meAfter = me + gainOf(mb), opAfter = op - mb.stolen;
      let p;
      if (meAfter >= T) p = 95;                                  // a word on the board gets me to the target now
      else if (opAfter + gainOf(ob) >= T) p = 15;                // they could reach the target next turn
      else {
        const diff = (meAfter - opAfter) - swingOf(ob) * 0.8;   // their best reply eats into my lead
        p = Math.max(5, Math.min(95, Math.round(100 / (1 + Math.exp(-diff / 3)))));
      }
      html += `<div class="wp-labels" style="font-size:14px"><span class="wp-l-me">Win chance ${p}%</span><span class="wp-l-op">${100 - p}%</span></div>
        <div class="wp-bar"><span class="wp-me" style="width:${p}%"></span><span class="wp-op" style="width:${100 - p}%"></span></div>
        <p class="wp-why">${meAfter >= T ? `You can reach <b>${T}</b> cells with one word now.` : `Your best word now: <b>+${gainOf(mb)}</b> cell${gainOf(mb) === 1 ? '' : 's'} for you${mb.stolen ? ` (${mb.stolen} cut from them: −${mb.stolen} for them)` : ''}. Their best next word: <b>+${gainOf(ob)}</b>${ob.stolen ? `, −${ob.stolen} for you` : ''}.`} Estimate.</p>`;
    }
    box.innerHTML = html;
    // same scheme as the board: my tiles orange, the opponent's blue
    box.style.setProperty('--wp-me', 'var(--orange)');
    box.style.setProperty('--wp-op', 'var(--blue)');
  }

  // ---------------- tabs ----------------
  function showTab(t) {
    settings.tab = t; saveSettings();
    document.querySelectorAll('#tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t ? 'true' : 'false'));
    $('#gridView').hidden = t !== 'grid';
    $('#puzzleView').hidden = t !== 'puzzle';
    $('#invView').hidden = t !== 'invasion';
    if (t === 'invasion' && typeof invSync === 'function') invSync();
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
    syncSide(); $('#pzSideSeg').parentElement.hidden = !grid;
    $('#pzFileLbl').textContent = grid ? 'Change screenshot' : 'Add screenshot';
    const low = grid ? grid.conf.filter(c => c < 0.5).length : 0;
    $('#pzBoardInfo').innerHTML = !grid ? 'Add a screenshot of the game. Words are traced through touching letters (diagonals too), each cell once.'
      : `Board ${grid.cols}×${grid.rows}.${low ? ` <b>${low}</b> cell${low > 1 ? 's' : ''} may be misread.` : ''} <button type="button" class="linkbtn inline" id="pzEdit">Fix letters in Grid solver</button>`;
    syncHeavyPz();
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
    const key = `${grid.rows}x${grid.cols}|${grid.letters.join(',')}|${b.min}-${b.max}|${half()}`;
    if (pzCache && pzCache.key === key) return renderBoardWords();
    pzPending = key;
    $('#pzMsg').textContent = 'Searching the board…'; $('#pzMsg').hidden = false;
    worker.postMessage({
      type: 'solve', id: 'pz' + (++pzId),
      grid: { rows: grid.rows, cols: grid.cols, letters: grid.letters, state: grid.state, myColor: grid.myColor, myHome: grid.myHome },
      opts: { minLen: b.min, maxLen: b.max, start: 'anywhere', side: half(), limit: 100000 },
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
