// Screenshot reader: finds the board, classifies each cell's state and letter.
// Works on any {data, width, height} RGBA buffer (browser ImageData or Node).
// Pure functions, no DOM, so it can be unit-tested outside the browser.

(function (root) {
  'use strict';

  const G = 16; // normalized glyph grid size

  function isLight(r, g, b) {
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    return mn > 200 && mx - mn < 25;
  }
  function isOrange(r, g, b) { return r > 190 && g > 60 && g < 170 && b < 90 && r - g > 70; }
  function isBlue(r, g, b) { return b > 200 && r < 120 && g > 110 && g < 190 && b - r > 120; }
  function isDark(r, g, b) { return Math.max(r, g, b) < 60; }

  // ---------- board location ----------
  function findBoard(img) {
    const { data, width: W, height: H } = img;
    const light = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) light[i] = isLight(data[p], data[p + 1], data[p + 2]) ? 1 : 0;

    // vertical border lines: columns with a very long run of light-grey pixels
    const colRuns = [];
    for (let x = 0; x < W; x++) {
      let run = 0, best = 0, end = 0;
      for (let y = 0; y < H; y++) {
        run = light[y * W + x] ? run + 1 : 0;
        if (run > best) { best = run; end = y; }
      }
      if (best > H * 0.25) colRuns.push({ x, len: best, start: end - best + 1, end });
    }
    if (colRuns.length < 2) return null;
    const left = colRuns.filter(c => c.x < W / 2), right = colRuns.filter(c => c.x >= W / 2);
    if (!left.length || !right.length) return null;
    const innerLeft = Math.max(...left.map(c => c.x)) + 1;
    const innerRight = Math.min(...right.map(c => c.x)) - 1;
    const ref = left.reduce((a, b) => (b.len > a.len ? b : a));

    // horizontal border lines: search near the ends of the vertical run, in the middle column
    const mx = Math.round((innerLeft + innerRight) / 2);
    const lightRow = y => {
      let n = 0;
      for (let x = innerLeft; x <= innerRight; x += 3) n += light[y * W + x];
      return n / ((innerRight - innerLeft) / 3) > 0.6;
    };
    let innerTop = ref.start, innerBottom = ref.end;
    // nearest full-width light line to each end of the vertical border run
    for (let y = ref.start + 10; y > Math.max(0, ref.start - 80); y--) {
      if (light[y * W + mx] && lightRow(y)) { innerTop = y + 1; break; }
    }
    for (let y = ref.end - 10; y < Math.min(H, ref.end + 80); y++) {
      if (light[y * W + mx] && lightRow(y)) { innerBottom = y - 1; break; }
    }
    return { left: innerLeft, right: innerRight, top: innerTop, bottom: innerBottom };
  }

  // ---------- which colour is "me" (left block of the header bar) ----------
  function detectMyColor(img, boardTop) {
    const { data, width: W } = img;
    let o = 0, b = 0;
    for (let y = 0; y < boardTop; y += 2) {
      let ro = 0, rb = 0;
      for (let x = 0; x < W; x += 4) {
        const p = (y * W + x) * 4;
        if (isOrange(data[p], data[p + 1], data[p + 2])) ro++;
        else if (isBlue(data[p], data[p + 1], data[p + 2])) rb++;
      }
      if ((ro + rb) / (W / 4) < 0.5) continue; // not the header bar
      for (let x = Math.round(W * 0.12); x < W * 0.35; x += 3) {
        const p = (y * W + x) * 4;
        if (isOrange(data[p], data[p + 1], data[p + 2])) o++;
        else if (isBlue(data[p], data[p + 1], data[p + 2])) b++;
      }
    }
    if (o + b < 50) return null;
    return o >= b ? 'O' : 'B';
  }

  // ---------- per-cell analysis ----------
  function analyseCell(img, x0, y0, x1, y1) {
    const { data, width: W } = img;
    const w = x1 - x0, h = y1 - y0;
    // background: ring just inside the cell edge
    const ring = [];
    const m1 = 0.06, m2 = 0.16;
    for (let y = y0 + Math.round(h * m1); y < y1 - h * m1; y++) {
      for (let x = x0 + Math.round(w * m1); x < x1 - w * m1; x++) {
        const fx = (x - x0) / w, fy = (y - y0) / h;
        if (fx > m2 && fx < 1 - m2 && fy > m2 && fy < 1 - m2) continue;
        const p = (y * W + x) * 4;
        ring.push([data[p], data[p + 1], data[p + 2]]);
      }
    }
    let nO = 0, nB = 0, nW = 0, nD = 0;
    for (const [r, g, b] of ring) {
      if (isOrange(r, g, b)) nO++; else if (isBlue(r, g, b)) nB++;
      else if (isLight(r, g, b)) nW++; else if (isDark(r, g, b)) nD++;
    }
    const counts = { O: nO, B: nB, W: nW, '.': nD };
    const state = Object.keys(counts).reduce((a, k) => (counts[k] > counts[a] ? k : a), 'O');

    // background reference colours = frequent ring colours
    const hist = new Map();
    for (const [r, g, b] of ring) {
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    const refs = [];
    for (const [k, n] of hist) if (n > ring.length * 0.04) refs.push([((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4]);

    // ink mask in the inner area
    const ix0 = x0 + Math.round(w * 0.12), ix1 = x1 - Math.round(w * 0.12);
    const iy0 = y0 + Math.round(h * 0.1), iy1 = y1 - Math.round(h * 0.1);
    const iw = ix1 - ix0, ih = iy1 - iy0;
    const ink = new Float32Array(iw * ih);
    let wild = 0, inkCount = 0;
    for (let y = iy0; y < iy1; y++) {
      for (let x = ix0; x < ix1; x++) {
        const p = (y * W + x) * 4, r = data[p], g = data[p + 1], b = data[p + 2];
        let d = 1e9;
        for (const c of refs) d = Math.min(d, Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]));
        const v = Math.max(0, Math.min(1, (d - 60) / 120));
        ink[(y - iy0) * iw + (x - ix0)] = v;
        if (v > 0.5) {
          inkCount++;
          // emoji: orange/brown tones (yellow letters never have these)
          if (r > 120 && b < 70 && r - g > 50 && g < 190) wild++;
        }
      }
    }
    // bounding box of ink (ignore sparse rows/cols)
    const colSum = new Float32Array(iw), rowSum = new Float32Array(ih);
    for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) { const v = ink[y * iw + x]; colSum[x] += v; rowSum[y] += v; }
    const thr = 1.5;
    let bx0 = 0, bx1 = iw - 1, by0 = 0, by1 = ih - 1;
    while (bx0 < iw && colSum[bx0] < thr) bx0++;
    while (bx1 > bx0 && colSum[bx1] < thr) bx1--;
    while (by0 < ih && rowSum[by0] < thr) by0++;
    while (by1 > by0 && rowSum[by1] < thr) by1--;
    const empty = inkCount < iw * ih * 0.01 || bx0 >= iw;
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    const glyph = new Float32Array(G * G);
    if (!empty) {
      for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
        const sx0 = bx0 + (gx * bw) / G, sx1 = bx0 + ((gx + 1) * bw) / G;
        const sy0 = by0 + (gy * bh) / G, sy1 = by0 + ((gy + 1) * bh) / G;
        let s = 0, n = 0;
        for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) { s += ink[y * iw + x]; n++; }
        glyph[gy * G + gx] = n ? s / n : 0;
      }
    }
    return {
      state, empty,
      wildcard: !empty && wild > inkCount * 0.04,
      aspect: bw / bh,
      heightFrac: bh / h,
      glyph,
    };
  }

  // ---------- glyph classification ----------
  function glyphDistance(a, aAspect, t) {
    let d = 0;
    for (let i = 0; i < a.length; i++) { const e = a[i] - t.g[i]; d += e * e; }
    const ea = (aAspect - t.a) * 12;
    return d + ea * ea;
  }

  function classify(cell, templates) {
    const per = new Map();
    for (const t of templates) {
      const d = glyphDistance(cell.glyph, cell.aspect, t);
      if (!per.has(t.l) || d < per.get(t.l)) per.set(t.l, d);
    }
    const ranked = [...per.entries()].sort((a, b) => a[1] - b[1]);
    if (!ranked.length) return { letter: '?', dist: Infinity, margin: 0 };
    const bestD = ranked[0][1], second = ranked[1] ? ranked[1][1] : Infinity;
    return { letter: ranked[0][0], dist: bestD, margin: second - bestD, second: ranked[1] && ranked[1][0] };
  }

  function decodeTemplates(list) {
    return list.map(t => ({ l: t.l, a: t.a, g: Float32Array.from(t.g.split('').map(ch => (parseInt(ch, 36)) / 35)) }));
  }
  function encodeGlyph(g) { return Array.from(g, v => Math.round(v * 35).toString(36)).join(''); }

  // ---------- main entry ----------
  // opts.cols (default 10), opts.rows (auto when omitted)
  function readBoard(img, templates, opts = {}) {
    const board = findBoard(img);
    if (!board) throw new Error('Could not find the game board in this image.');
    const cols = opts.cols || 10;
    const bw = board.right - board.left + 1, bh = board.bottom - board.top + 1;
    const cellW = bw / cols;
    const rows = opts.rows || Math.max(3, Math.round(bh / (cellW * 0.946)));
    const cellH = bh / rows;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const x0 = Math.round(board.left + c * cellW), x1 = Math.round(board.left + (c + 1) * cellW);
        const y0 = Math.round(board.top + r * cellH), y1 = Math.round(board.top + (r + 1) * cellH);
        const a = analyseCell(img, x0, y0, x1, y1);
        let letter = '', conf = 1;
        if (a.wildcard) letter = '?';
        else if (!a.empty && templates) {
          const k = classify(a, templates);
          letter = k.letter;
          // calibrated on the sample screenshots: correct matches had dist < 5.1 and margin > 9
          conf = (k.dist > 9 || k.margin < 4) ? 0.3 : 1;
        }
        row.push({ letter, state: a.state, conf, _a: a });
      }
      cells.push(row);
    }
    // home rows: which colour is on top
    const topO = cells[0].filter(c => c.state === 'O').length, topB = cells[0].filter(c => c.state === 'B').length;
    const topColor = topO >= topB ? 'O' : 'B';
    const myColor = detectMyColor(img, board.top) || 'O';
    return { rows, cols, board, cells, topColor, myColor };
  }

  const api = { readBoard, findBoard, analyseCell, classify, decodeTemplates, encodeGlyph, G };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LGReader = api;
})(typeof self !== 'undefined' ? self : this);
