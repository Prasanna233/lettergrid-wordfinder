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
    if (r === myHomeRow || state[i] === myColor) mine[i] = 1;
    else if (r === oppHomeRow || state[i] === oppColor) opp[i] = 1;
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

  const allowedStart = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!letters[i]) continue;
    if (opts.start === 'anywhere') allowedStart[i] = 1;
    else if (opts.start === 'opp') { if (opp[i]) allowedStart[i] = 1; }
    else if (mine[i]) allowedStart[i] = 1;
    else if (opts.start === 'adjacent' && nbrs[i].some(j => mine[j])) allowedStart[i] = 1;
  }

  const minLen = opts.minLen || 4, maxLen = Math.min(opts.maxLen || 20, 20);
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
    return { gained: gained.size, stolen, cuts, depthGain, whiteHits, reaches, score: s };
  }

  function record(node) {
    const word = wordChars.join('');
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
    for (const j of nbrs[i]) if (!used[j] && letters[j]) dfs(j, k);
  }

  for (let i = 0; i < n; i++) if (allowedStart[i]) dfs(i, 0);

  const results = Array.from(best.values());
  results.sort((a, b) => b.score - a.score || b.len - a.len || a.word.localeCompare(b.word));
  return { results: results.slice(0, opts.limit || 5000), total: results.length, timedOut, curDepth };
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
    } else if (m.type === 'lookup') {
      self.postMessage({ type: 'looked', id: m.id, ...lookup(m.query) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};

if (typeof module !== 'undefined') module.exports = { load, solve, lookup, insert, _reset: () => { N = 0; cap = 0; ch = child = sib = term = null; wordCount = 0; newNode(255); } };
