// Word solver running in a Web Worker.
// Compact trie (first-child / next-sibling in typed arrays) + DFS over the grid.
'use strict';

let N = 0, cap = 0;
let ch, child, sib, term;
let wordCount = 0;

function grow() {
  const nc = cap ? cap * 2 : 1 << 20;
  const a = new Uint8Array(nc); if (ch) a.set(ch); ch = a;
  const b = new Int32Array(nc); if (child) b.set(child); child = b;
  const c = new Int32Array(nc); if (sib) c.set(sib); sib = c;
  const d = new Uint8Array(nc); if (term) d.set(term); term = d;
  cap = nc;
}
function newNode(c) {
  if (N >= cap) grow();
  ch[N] = c; child[N] = -1; sib[N] = -1; term[N] = 0;
  return N++;
}
function findChild(node, c) {
  for (let k = child[node]; k !== -1; k = sib[k]) if (ch[k] === c) return k;
  return -1;
}
function insert(word) {
  let node = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i) - 65;
    if (c < 0 || c > 25) return;
    let k = findChild(node, c);
    if (k === -1) { k = newNode(c); sib[k] = child[node]; child[node] = k; }
    node = k;
  }
  if (!term[node]) { term[node] = 1; wordCount++; }
}

async function load(url) {
  N = 0; cap = 0; ch = child = sib = term = null; wordCount = 0;
  newNode(255);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Dictionary download failed (' + res.status + ')');
  const text = await res.text();
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const code = i < text.length ? text.charCodeAt(i) : 10;
    if (code === 10 || code === 13) {
      if (i > start) insert(text.slice(start, i).trim().toUpperCase());
      start = i + 1;
    }
  }
  return wordCount;
}

// ---------- solving ----------
// grid: { rows, cols, letters: string[] ('A'..'Z' | '?' | ''), state: string[] ('O','B','W','.'),
//         myColor: 'O'|'B', myHome: 'top'|'bottom' }
// opts: { minLen, maxLen, start: 'mine'|'adjacent'|'anywhere', limit }
function solve(grid, opts) {
  const { rows, cols, letters, state, myColor } = grid;
  const n = rows * cols;
  const oppColor = myColor === 'O' ? 'B' : 'O';
  const myHomeRow = grid.myHome === 'top' ? 0 : rows - 1;
  const oppHomeRow = rows - 1 - myHomeRow;
  const depthOf = i => { const r = Math.floor(i / cols); return grid.myHome === 'top' ? r : rows - 1 - r; };

  const mine = new Uint8Array(n), opp = new Uint8Array(n), white = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    // ownership comes from the cell's colour: in Invasion a base row can be invaded (cells of the
    // other colour) or emptied (free cells), so the row alone says nothing
    const known = state[i] === 'O' || state[i] === 'B';
    if (state[i] === myColor || (!known && state[i] !== '.' && state[i] !== 'W' && r === myHomeRow)) mine[i] = 1;
    else if (state[i] === oppColor || (!known && state[i] !== '.' && state[i] !== 'W' && r === oppHomeRow)) opp[i] = 1;
    if (state[i] === 'W') white[i] = 1;
  }
  const nbrs = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols, list = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) list.push(rr * cols + cc);
    }
    nbrs.push(list);
  }
  // deepest cell connected to my home row through owned cells (8-way)
  const seen = new Uint8Array(n), queue = new Int32Array(n);
  function connectedDepth(owned) {
    seen.fill(0);
    let h = 0, t = 0, depth = 0, reaches = false;
    for (let c = 0; c < cols; c++) { const i = myHomeRow * cols + c; if (owned(i)) { seen[i] = 1; queue[t++] = i; } }
    while (h < t) {
      const i = queue[h++];
      depth = Math.max(depth, depthOf(i));
      if (Math.floor(i / cols) === oppHomeRow) reaches = true;
      for (const j of nbrs[i]) if (!seen[j] && owned(j)) { seen[j] = 1; queue[t++] = j; }
    }
    return { depth, reaches };
  }
  const curDepth = connectedDepth(i => mine[i] === 1).depth;

  // left / right half of the board (odd widths: the centre column counts for both halves)
  const inSide = new Uint8Array(n).fill(1);
  // centre = middle columns, leaving 30% of the width on each side (10 cols -> columns 4-7)
  const cLo = Math.floor(cols * 0.3), cHi = cols - 1 - cLo;
  if (opts.side === 'left' || opts.side === 'right' || opts.side === 'center') {
    for (let i = 0; i < n; i++) {
      const c = i % cols, left = c <= (cols - 1) / 2, right = c >= (cols - 1) / 2;
      const ok = opts.side === 'left' ? left : opts.side === 'right' ? right : c >= cLo && c <= cHi;
      inSide[i] = ok ? 1 : 0;
    }
  }

  // race boards: a captured cell that a cut has separated from its base is no longer a starting point,
  // so starts only count my cells still connected (8 ways) to my home row
  let linked = null;
  if (opts.linkedStart) {
    linked = new Uint8Array(n); const qq = []; 
    for (let c = 0; c < cols; c++) { const i = myHomeRow * cols + c; if (mine[i]) { linked[i] = 1; qq.push(i); } }
    for (let h = 0; h < qq.length; h++) for (const j of nbrs[qq[h]]) if (mine[j] && !linked[j]) { linked[j] = 1; qq.push(j); }
  }
  const mineStart = i => mine[i] && (!linked || linked[i]);
  const allowedStart = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!letters[i] || !inSide[i]) continue;
    if (Number.isInteger(opts.startCell) && opts.startCell >= 0) { if (i === opts.startCell) allowedStart[i] = 1; }   // puzzle: one given starting cell
    else if (opts.start === 'anywhere') allowedStart[i] = 1;
    // only from my base (home) row, on cells that are still mine
    else if (opts.start === 'base') { if (Math.floor(i / cols) === myHomeRow && state[i] === myColor) allowedStart[i] = 1; }
    // winning-word rule: first letter on a free cell touching my cells, and not touching any cell the
    // opponent has captured (their home row doesn't count)
    else if (opts.start === 'frontier') {
      const oppCap = j => opp[j] && Math.floor(j / cols) !== oppHomeRow;
      if (!mine[i] && !opp[i] && nbrs[i].some(mineStart) && !nbrs[i].some(oppCap)) allowedStart[i] = 1;
    }
    else if (opts.start === 'opp') { if (opp[i]) allowedStart[i] = 1; }
    else if (mineStart(i)) allowedStart[i] = 1;
    else if (opts.start === 'adjacent' && !mine[i] && nbrs[i].some(mineStart)) allowedStart[i] = 1;
  }

  const minLen = opts.minLen || 4, maxLen = Math.min(opts.maxLen || 20, 20);
  const banned = Array.isArray(opts.exclude) && opts.exclude.length ? opts.exclude.map(w => String(w).toUpperCase()) : null;
  const best = new Map(); // word -> result
  const used = new Uint8Array(n);
  const path = [], wordChars = [], wild = [];
  const deadline = Date.now() + (opts.timeLimitMs || 20000);
  let timedOut = false, visits = 0;

  function score() {
    const gained = new Set();
    let whiteHits = 0;
    for (const i of path) {
      if (!mine[i]) gained.add(i);
      if (white[i]) { whiteHits++; for (const j of nbrs[i]) if (!mine[j]) gained.add(j); }
    }
    let stolen = 0, cuts = 0;
    for (const i of gained) if (opp[i]) stolen++;
    // path cells that are opponent-captured letters (not their home row)
    for (const i of path) if (opp[i] && Math.floor(i / cols) !== oppHomeRow) cuts++;
    const after = connectedDepth(i => mine[i] === 1 || gained.has(i));
    const depthGain = Math.max(0, after.depth - curDepth);
    const reaches = after.reaches;
    const len = path.length;
    const s = gained.size * 2 + stolen + depthGain * 4 + len + (reaches ? 1000 : 0);
    // winning letters: where the word lands on the opponent's base (or a capture tile that grabs it)
    let winAt;
    if (reaches) {
      winAt = [];
      path.forEach((c, k) => { if (Math.floor(c / cols) === oppHomeRow) winAt.push(k); });
      if (!winAt.length) path.forEach((c, k) => { if (white[c] && nbrs[c].some(j => Math.floor(j / cols) === oppHomeRow)) winAt.push(k); });
      if (!winAt.length) { let b = 0; path.forEach((c, k) => { if (depthOf(c) > depthOf(path[b])) b = k; }); winAt.push(b); }
    }
    return { gained: gained.size, stolen, cuts, depthGain, whiteHits, reaches, winAt, score: s };
  }

  function record(node) {
    const word = wordChars.join('');
    if (banned && banned.some(p => p.includes(word))) return;
    const sc = score();
    const prev = best.get(word);
    if (!prev || sc.score > prev.score) {
      best.set(word, { word, path: path.slice(), wild: wild.slice(), len: path.length, ...sc });
    }
  }

  function dfs(i, node) {
    if ((++visits & 0xffff) === 0 && Date.now() > deadline) { timedOut = true; }
    if (timedOut) return;
    used[i] = 1; path.push(i);
    const L = letters[i];
    if (L === '?') {
      for (let k = child[node]; k !== -1; k = sib[k]) {
        wordChars.push(String.fromCharCode(65 + ch[k])); wild.push(path.length - 1);
        step(i, k);
        wordChars.pop(); wild.pop();
      }
    } else {
      const k = findChild(node, L.charCodeAt(0) - 65);
      if (k !== -1) { wordChars.push(L); step(i, k); wordChars.pop(); }
    }
    used[i] = 0; path.pop();
  }
  function step(i, k) {
    if (term[k] && path.length >= minLen) record(k);
    if (path.length >= maxLen || child[k] === -1) return;
    for (const j of nbrs[i]) if (!used[j] && letters[j] && inSide[j]) dfs(j, k);
  }

  for (let i = 0; i < n; i++) if (allowedStart[i]) dfs(i, 0);

  const results = Array.from(best.values());
  results.sort((a, b) => b.score - a.score || b.len - a.len || a.word.localeCompare(b.word));

  // ---- wildcard follow-up: does the letter we fix a 🤔 to open new words next turn? ----
  let wildChecked = 0;
  if (opts.wildFollowUp !== false && opts.start !== 'opp') {
    const wildDeadline = Date.now() + (opts.wildTimeMs || 3000);
    const cand = results.filter(r => r.wild.length).slice(0, opts.wildTop || 120);
    for (const r of cand) {
      if (Date.now() > wildDeadline) break;
      r.followUp = followUpCount(r);
      // reward letters that keep words flowing; a 🤔 spent on a dead-end letter costs a little
      r.score += r.followUp ? Math.min(r.followUp, 40) * 0.25 : -5;
      wildChecked++;
    }
    if (wildChecked) results.sort((a, b) => b.score - a.score || b.len - a.len || a.word.localeCompare(b.word));
  }

  // words available next turn, starting on my (new) territory, that pass through a now-fixed wildcard cell
  function followUpCount(r) {
    const L = letters.slice();
    const target = new Uint8Array(n);
    r.wild.forEach(k => { const cell = r.path[k]; L[cell] = r.word[k]; target[cell] = 1; });
    const own = mine.slice();
    for (const i of r.path) { own[i] = 1; if (white[i]) for (const j of nbrs[i]) own[j] = 1; }
    const seenW = new Set(), u = new Uint8Array(n), chars = [];
    let hits = 0;
    function go(i, node) {
      const Li = L[i];
      const kids = [];
      if (Li === '?') { for (let k = child[node]; k !== -1; k = sib[k]) kids.push(k); }
      else { const k = findChild(node, Li.charCodeAt(0) - 65); if (k !== -1) kids.push(k); }
      if (!kids.length) return;
      u[i] = 1; hits += target[i];
      for (const k of kids) {
        chars.push(String.fromCharCode(65 + ch[k]));
        if (term[k] && chars.length >= minLen && hits > 0) seenW.add(chars.join(''));
        if (chars.length < maxLen && child[k] !== -1) for (const j of nbrs[i]) if (!u[j] && L[j]) go(j, k);
        chars.pop();
      }
      u[i] = 0; hits -= target[i];
    }
    for (let i = 0; i < n; i++) if (own[i] && L[i]) go(i, 0);
    return seenW.size;
  }
  return { results: results.slice(0, opts.limit || 5000), total: results.length, timedOut, curDepth, wildChecked };
}

// ---------- puzzle lookup (whole dictionary, no grid) ----------
// prefix: starting letters; length: exact length or 0 for any; pattern: e.g. "RA?I?" ('?' = any letter)
function lookup({ prefix = '', length = 0, pattern = '', limit = 3000 }) {
  prefix = prefix.toUpperCase().replace(/[^A-Z]/g, '');
  pattern = pattern.toUpperCase().replace(/[^A-Z?]/g, '');
  if (pattern) {
    if (length && length !== pattern.length) return { words: [], total: 0, conflict: 'Pattern length and number of letters differ.' };
    length = pattern.length;
    for (let i = 0; i < prefix.length; i++) {
      if (i >= pattern.length) return { words: [], total: 0, conflict: 'Starting letters are longer than the pattern.' };
      if (pattern[i] !== '?' && pattern[i] !== prefix[i]) return { words: [], total: 0, conflict: 'Starting letters don’t match the pattern.' };
    }
  }
  if (length && prefix.length > length) return { words: [], total: 0, conflict: 'Starting letters are longer than the number of letters.' };
  let node = 0;
  for (let i = 0; i < prefix.length; i++) {
    node = findChild(node, prefix.charCodeAt(i) - 65);
    if (node === -1) return { words: [], total: 0 };
  }
  const maxLen = length || 20;
  const words = [];
  let total = 0;
  const buf = prefix.split('');
  (function walk(n) {
    const L = buf.length;
    if (term[n] && (!length || L === length)) { total++; if (words.length < limit) words.push(buf.join('')); }
    if (L >= maxLen) return;
    const want = pattern ? pattern[L] : '?';
    for (let k = child[n]; k !== -1; k = sib[k]) {
      const c = String.fromCharCode(65 + ch[k]);
      if (want !== '?' && want !== c) continue;
      buf.push(c); walk(k); buf.pop();
    }
  })(node);
  words.sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  return { words, total };
}

// letters after my move: every 🤔 my word passed through is now the letter I played there
function lettersAfter(letters, move) {
  if (!move || !move.word || !move.wild || !move.wild.length) return letters;
  const L = letters.slice();
  for (const k of move.wild) { const cell = move.path[k]; if (L[cell] === '?') L[cell] = move.word[k]; }
  return L;
}

// Opponent replies are capped at 12 letters.
const REPLY_MAX = 12;
// My letters an opponent reply takes: my cells on its path, plus my cells next to any capture (white)
// tile on its path, since a capture tile also takes all the cells around it.
function cutCellsOf(path, st, myColor, rows, cols) {
  const out = new Set();
  for (const i of path) {
    if (st[i] === myColor) out.add(i);
    if (st[i] === 'W') {
      const r = Math.floor(i / cols), c = i % cols;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue; const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && st[rr * cols + cc] === myColor) out.add(rr * cols + cc);
      }
    }
  }
  return [...out];
}

// ---------- opponent replies (Invasion) ----------
// For each of my candidate moves: play it on a copy of the board (my word's cells, and the neighbours of
// any capture tile on it, become mine), then find the opponent's biggest single-word gain from there.
function replies(grid, moves, opts) {
  const { rows, cols } = grid, n = rows * cols, oppColor = grid.myColor === 'O' ? 'B' : 'O';
  const oppHome = grid.myHome === 'top' ? 'bottom' : 'top';
  const nb = i => { const r = Math.floor(i / cols), c = i % cols, o = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (!dr && !dc) continue; const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) o.push(rr * cols + cc); }
    return o; };
  return moves.map(mv => {
    const path = mv.path || mv, st = grid.state.slice();
    for (const i of path) { if (grid.state[i] === 'W') for (const j of nb(i)) st[j] = grid.myColor; st[i] = grid.myColor; }
    const exclude = (opts.exclude || []).concat(mv.word ? [mv.word] : []);
    const r = solve({ rows, cols, letters: lettersAfter(grid.letters, mv), state: st, myColor: oppColor, myHome: oppHome }, { ...opts, maxLen: Math.min(opts.maxLen || 20, REPLY_MAX), exclude, limit: 100000, wildFollowUp: false });
    let bestR = null;
    for (const x of r.results) if (!bestR || x.stolen > bestR.stolen || (x.stolen === bestR.stolen && x.len > bestR.len)) bestR = x;   // points = my letters they cut
    if (!bestR || !bestR.stolen) return { best: 0, word: '' };
    // which of my cells (after my word) their reply cuts, and where it ends
    const cutCells = cutCellsOf(bestR.path, st, grid.myColor, rows, cols);
    return { best: bestR.stolen, word: bestR.word, path: bestR.path, wild: bestR.wild, cutCells, last: bestR.path[bestR.path.length - 1] };
  });
}

// ---------- opponent's top replies to one move (Grid solver preview) ----------
// rank 'race': replies that cut my letters first, each group sorted by deepest push;
// rank 'cut' (Invasion boards): most of my letters cut first.
function topReplies(grid, move, opts, n, rank) {
  const { rows, cols } = grid, oppColor = grid.myColor === 'O' ? 'B' : 'O';
  const oppHome = grid.myHome === 'top' ? 'bottom' : 'top';
  const nb = i => { const r = Math.floor(i / cols), c = i % cols, o = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (!dr && !dc) continue; const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) o.push(rr * cols + cc); }
    return o; };
  const st = grid.state.slice();
  for (const i of move.path) { if (grid.state[i] === 'W') for (const j of nb(i)) st[j] = grid.myColor; st[i] = grid.myColor; }
  const exclude = (opts.exclude || []).concat(move.word ? [move.word] : []);
  const res = solve({ rows, cols, letters: lettersAfter(grid.letters, move), state: st, myColor: oppColor, myHome: oppHome }, { ...opts, maxLen: Math.min(opts.maxLen || 20, REPLY_MAX), linkedStart: rank !== 'cut', exclude, limit: 100000, wildFollowUp: false }).results;
  res.sort(rank === 'cut'
    ? (a, b) => b.stolen - a.stolen || b.len - a.len
    // race: replies that cut my letters come first, deepest push first; then the rest, deepest push first
    : (a, b) => ((b.stolen > 0) - (a.stolen > 0)) || b.depthGain - a.depthGain || (b.reaches - a.reaches) || b.stolen - a.stolen || b.len - a.len);
  return res.slice(0, n).map(x => {
    const cutCells = cutCellsOf(x.path, st, grid.myColor, rows, cols);
    return { word: x.word, path: x.path, wild: x.wild, reaches: !!x.reaches, depthGain: x.depthGain,
      cut: cutCells.length, cutCells, viaWhite: x.path.filter(i => st[i] === 'W').length, last: x.path[x.path.length - 1] };
  });
}

if (typeof self !== 'undefined') self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const t = Date.now();
      const count = await load(m.url);
      self.postMessage({ type: 'ready', count, ms: Date.now() - t, nodes: N });
    } else if (m.type === 'solve') {
      const t = Date.now();
      const out = solve(m.grid, m.opts);
      self.postMessage({ type: 'solved', id: m.id, ms: Date.now() - t, ...out });
    } else if (m.type === 'topReplies') {
      self.postMessage({ type: 'topReplied', id: m.id, out: topReplies(m.grid, m.move, m.opts, m.n || 5, m.rank) });
    } else if (m.type === 'replies') {
      self.postMessage({ type: 'replied', id: m.id, out: replies(m.grid, m.moves, m.opts) });
    } else if (m.type === 'lookup') {
      self.postMessage({ type: 'looked', id: m.id, ...lookup(m.query) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};

if (typeof module !== 'undefined') module.exports = { load, solve, lookup, replies, topReplies, lettersAfter, insert, _reset: () => { N = 0; cap = 0; ch = child = sib = term = null; wordCount = 0; newNode(255); } };
