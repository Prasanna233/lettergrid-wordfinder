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
  // cell backgrounds vary with the game's theme (e.g. a tinted board fading brown -> blue), so cell
  // classification uses wider ranges than the border detection does
  function isTileLight(r, g, b) { const mn = Math.min(r, g, b), mx = Math.max(r, g, b); return mn > 160 && mx - mn < 50; }
  function isCellDark(r, g, b) { return Math.max(r, g, b) < 85; }
  // captured cells: judge by hue, so darker or lighter shades in tinted themes still count
  function hsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    return [h, mx ? d / mx : 0, mx / 255];
  }
  function isOrangeCell(r, g, b) { if (isOrange(r, g, b)) return true; const [h, s, v] = hsv(r, g, b); return h >= 12 && h <= 40 && s > 0.5 && v > 0.5; }
  function isBlueCell(r, g, b) { if (isBlue(r, g, b)) return true; const [h, s, v] = hsv(r, g, b); return h >= 195 && h <= 230 && s > 0.35 && v > 0.55; }

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

  // ---------- header name blocks ----------
  // The header bar has one coloured block per player (orange / blue) with the name on the top line.
  // For each block we return its colour and a small "shape signature" of the name's white text, so the
  // app can recognise the user's own name on either side of the header in later screenshots.
  function isPurple(r, g, b) { return r > 55 && r < 130 && g < 40 && b > 100 && b < 190; }
  function readHeader(img, boardTop) {
    const { data, width: W } = img;
    const barPx = (r, g, b) => isOrange(r, g, b) || isBlue(r, g, b) || isPurple(r, g, b) || (r > 225 && g > 95 && g < 125 && b < 30);
    const rowsY = [];
    for (let y = 0; y < boardTop; y++) {
      let n = 0;
      for (let x = 0; x < W; x += 4) { const p = (y * W + x) * 4; if (barPx(data[p], data[p + 1], data[p + 2])) n++; }
      if (n / (W / 4) > 0.4) rowsY.push(y);
    }
    if (rowsY.length < 20) return null;
    // the longest run of such rows is the bar (short gaps — rows crossing the names and avatars — are bridged)
    let best = [rowsY[0], rowsY[0]], cur = [rowsY[0], rowsY[0]];
    for (let k = 1; k < rowsY.length; k++) {
      if (rowsY[k] - cur[1] <= 12) cur[1] = rowsY[k]; else cur = [rowsY[k], rowsY[k]];
      if (cur[1] - cur[0] > best[1] - best[0]) best = cur.slice();
    }
    const [y0, y1] = best;
    // each player's colour: whichever of orange / blue dominates their half of the bar
    // (layouts differ: solid name blocks, or a purple score bar with small coloured parts)
    const colourOf = (xa, xb) => {
      let o = 0, b = 0;
      for (let y = y0; y <= y1; y += 2) for (let x = xa; x < xb; x += 2) {
        const p = (y * W + x) * 4, r = data[p], g = data[p + 1], bl = data[p + 2];
        if (isOrange(r, g, bl) || (r > 225 && g > 95 && g < 125 && bl < 30)) o++; else if (isBlue(r, g, bl)) b++;
      }
      return o === b ? null : o > b ? 'O' : 'B';
    };
    // judge each side next to its own avatar first (a long name block can reach across the middle),
    // then fall back to the whole half
    let lc = colourOf(Math.round(W * 0.13), Math.round(W * 0.3)), rc = colourOf(Math.round(W * 0.7), Math.round(W * 0.87));
    if (!lc || !rc || lc === rc) { lc = colourOf(0, Math.round(W / 2)); rc = colourOf(Math.round(W / 2), W); }
    if (!lc || !rc || lc === rc) return null;
    // names sit in the upper half, between the avatar (outer ~15%) and the middle (turn icon)
    const yName = y0 + Math.round((y1 - y0) * 0.5);
    const left = { color: lc, sig: nameSig(img, Math.round(W * 0.15), y0, Math.round(W * 0.46), yName) };
    const right = { color: rc, sig: nameSig(img, Math.round(W * 0.54), y0, Math.round(W * 0.85), yName) };
    return { left, right, y0, y1 };
  }
  function nameSig(img, x0, y0, x1, y1) {
    const { data, width: W } = img;
    const ink = (x, y) => { const p = (y * W + x) * 4; return Math.min(data[p], data[p + 1], data[p + 2]) > 200 ? 1 : 0; };
    // stay clear of the bar's white outline: skip the edges and any row that is mostly white (a border line)
    const mx = Math.round((x1 - x0) * 0.03); x0 += mx; x1 -= mx;
    const lineRow = y => { let n = 0; for (let x = x0; x < x1; x += 2) n += ink(x, y); return n / ((x1 - x0) / 2) > 0.6; };
    let bx0 = x1, bx1 = x0, by0 = y1, by1 = y0;
    for (let y = y0; y < y1; y++) { if (lineRow(y)) continue; for (let x = x0; x < x1; x++) if (ink(x, y)) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; } }
    if (bx1 <= bx0 || by1 <= by0) return null;
    // keep the name's real proportions: scale to a fixed height, width follows (letters keep their widths)
    const GH = 16, bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, GW = Math.max(8, Math.min(160, Math.round(GH * bw / bh))), g = [];
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      const sx0 = bx0 + Math.floor(gx * bw / GW), sx1 = bx0 + Math.floor((gx + 1) * bw / GW);
      const sy0 = by0 + Math.floor(gy * bh / GH), sy1 = by0 + Math.floor((gy + 1) * bh / GH);
      let t = 0, n = 0;
      for (let y = sy0; y < Math.max(sy1, sy0 + 1); y++) for (let x = sx0; x < Math.max(sx1, sx0 + 1); x++) { t += ink(x, y); n++; }
      g.push(Math.round(9 * t / n));
    }
    return { v: 2, w: GW, h: GH, a: +(bw / bh).toFixed(3), g: g.join('') };
  }
  // 0 = identical; larger = more different. The two name shapes are slid against each other a few
  // columns either way (layouts align names differently) and compared over their combined width, so
  // a different name — even one of similar length — leaves unmatched ink and scores badly.
  function sigGrid(sg) {
    const v = new Float32Array(sg.w * sg.h);
    for (let y = 0; y < sg.h; y++) for (let x = 0; x < sg.w; x++) {
      let t = 0, n = 0;
      for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx >= 0 && xx < sg.w) { t += (sg.g.charCodeAt(y * sg.w + xx) - 48) / 9; n++; } }
      v[y * sg.w + x] = t / n;
    }
    return v;
  }
  function sigDistance(a, b) {
    if (!a || !b || a.v !== 2 || b.v !== 2 || a.h !== b.h) return Infinity;   // older stored samples are ignored
    const A = sigGrid(a), B = sigGrid(b), H = a.h;
    let best = Infinity;
    for (let sh = -4; sh <= 4; sh++) {
      const x0 = Math.min(0, sh), x1 = Math.max(a.w, b.w + sh);
      let d = 0;
      for (let x = x0; x < x1; x++) for (let y = 0; y < H; y++) {
        const va = x >= 0 && x < a.w ? A[y * a.w + x] : 0, xb = x - sh, vb = xb >= 0 && xb < b.w ? B[y * b.w + xb] : 0;
        d += (va - vb) * (va - vb);
      }
      best = Math.min(best, d / ((x1 - x0) * H));
    }
    return best;
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
      if (isOrangeCell(r, g, b)) nO++; else if (isBlueCell(r, g, b)) nB++;
      else if (isTileLight(r, g, b)) nW++; else if (isCellDark(r, g, b)) nD++;
    }
    const counts = { O: nO, B: nB, W: nW, '.': nD };
    // when nothing matches, the cell is free (never assume it is a captured cell)
    const state = Object.keys(counts).reduce((a, k) => (counts[k] > counts[a] ? k : a), '.');

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

  // height of the coloured (orange or blue) stripe band at the top and at the bottom of the board
  function homeBandHeight(img, b) {
    const { data, width: W } = img;
    const colored = y => {
      let n = 0, t = 0;
      for (let x = b.left + 2; x < b.right - 2; x += 3) {
        const p = (y * W + x) * 4, r = data[p], g = data[p + 1], bl = data[p + 2];
        // band colour, or the light letters printed on it (a home row can have free/dark cells in it
        // once the opponent has cut some of its letters, so the letters must not break the band)
        t++; if (isOrangeCell(r, g, bl) || isBlueCell(r, g, bl) || (r > 230 && g > 120 && g < 170 && bl < 90) || (bl > 230 && r > 60 && r < 110) || isTileLight(r, g, bl)) n++;
      }
      return n / t > 0.55;
    };
    let top = 0; for (let y = b.top; y < b.bottom && colored(y); y++) top++;
    let bot = 0; for (let y = b.bottom; y > b.top && colored(y); y--) bot++;
    const ok = h => h > 20 && h < (b.bottom - b.top) / 4;
    if (ok(top) && ok(bot)) return Math.abs(top - bot) > 0.25 * Math.max(top, bot) ? Math.max(top, bot) : (top + bot) / 2;   // a broken band only ever measures short
    return ok(top) ? top : ok(bot) ? bot : 0;
  }

  // Pick the row count that puts the letters in the middle of their cells. The home-row band can measure
  // too tall (own cells right next to it) or too short (cut cells in it), so it is only one candidate.
  function bestRowCount(img, b, cols, guess) {
    const { data, width: W } = img;
    const bw = b.right - b.left + 1, bh = b.bottom - b.top + 1, cw = bw / cols;
    const cands = new Set([guess]);
    for (let k = 3; k <= 24; k++) { const a = bh / k / cw; if (a > 0.7 && a < 1.15) cands.add(k); }
    const lum = p => 0.3 * data[p] + 0.59 * data[p + 1] + 0.11 * data[p + 2];
    const cost = k => {
      const ch = bh / k; let tot = 0, n = 0;
      for (let r = 0; r < k; r++) for (let c = 0; c < cols; c++) {
        const x0 = Math.round(b.left + c * cw + cw * 0.15), x1 = Math.round(b.left + (c + 1) * cw - cw * 0.15);
        const y0 = Math.round(b.top + r * ch + 2), y1 = Math.round(b.top + (r + 1) * ch - 2);
        // background = brightness at the cell's corners; ink = pixels far from it
        const bg = (lum(((y0 + 3) * W + x0) * 4) + lum(((y1 - 3) * W + x1) * 4)) / 2;
        let top = -1, bot = -1, gap = 0, maxGap = 0;
        for (let y = y0; y < y1; y += 2) {
          let hit = 0;
          for (let x = x0; x < x1; x += 3) if (Math.abs(lum((y * W + x) * 4) - bg) > 70) { hit++; if (hit > 2) break; }
          if (hit > 2) { if (top < 0) top = y; bot = y; if (gap > maxGap) maxGap = gap; gap = 0; }
          else if (top >= 0) gap += 2;
        }
        if (top < 0) { tot += 0.6; n++; continue; }                     // no letter found: poor fit
        const mid = (y0 + y1) / 2, off = Math.abs((top + bot) / 2 - mid) / ch;
        const edge = (top - y0 < ch * 0.06 || y1 - bot < ch * 0.06) ? 0.4 : 0;   // ink touching an edge = cut letter
        const split = maxGap > ch * 0.12 ? 1 : 0;                         // two separate letters in one cell
        tot += off + edge + split; n++;
      }
      return tot / n;
    };
    let best = guess, bestC = Infinity;
    for (const k of cands) { const cst = cost(k); if (bestRowCount.debug) bestRowCount.debug.push([k, +cst.toFixed(3)]); if (cst < bestC - 1e-9) { bestC = cst; best = k; } }
    return best;
  }

  // number of columns = number of letters across a home row (boards come in different widths)
  function countCols(img, b, band) {
    if (!band) return 0;
    const { data, width: W } = img;
    // home-row letters are white or a tinted off-white (some themes, and colour-managed screenshots)
    const white = (x, y) => { const p = (y * W + x) * 4, r = data[p], g = data[p + 1], bl = data[p + 2]; return Math.min(r, g, bl) > 165 && Math.max(r, g, bl) - Math.min(r, g, bl) < 75; };
    const one = (yA, yB) => {
      const segs = []; let start = -1, last = -1;
      const gapMax = band * 0.18;
      for (let x = b.left + 4; x < b.right - 4; x++) {
        let on = false;
        for (let y = yA; y < yB && !on; y += 2) on = white(x, y);
        if (on) { if (start < 0) start = x; else if (x - last > gapMax) { segs.push([start, last]); start = x; } last = x; }
      }
      if (start >= 0) segs.push([start, last]);
      const real = segs.filter(([a, z]) => z - a > band * 0.035);       // ignore specks (but keep a thin I)
      if (real.length < 3) return { n: 0, spread: Infinity };
      const centres = real.map(([a, z]) => (a + z) / 2), gaps = centres.slice(1).map((c, i) => c - centres[i]);
      const mean = gaps.reduce((u, v) => u + v, 0) / gaps.length;
      const spread = Math.sqrt(gaps.reduce((u, v) => u + (v - mean) * (v - mean), 0) / gaps.length) / mean;
      return { n: real.length, spread };
    };
    const t = one(Math.round(b.top + band * 0.2), Math.round(b.top + band * 0.8));
    const u = one(Math.round(b.bottom - band * 0.8), Math.round(b.bottom - band * 0.2));
    const pick = [t, u].filter(x => x.n >= 3 && x.n <= 20 && x.spread < 0.25).sort((x, y) => y.n - x.n || x.spread - y.spread)[0];
    return pick ? pick.n : 0;
  }

  // ---------- main entry ----------
  // opts.cols / opts.rows (auto when omitted)
  function readBoard(img, templates, opts = {}) {
    const board = findBoard(img);
    if (!board) throw new Error('Could not find the game board in this image.');
    const bw = board.right - board.left + 1, bh = board.bottom - board.top + 1;
    // The home rows are exactly one cell tall, so measure them rather than assuming the cell shape
    // (it differs between phones, screen layouts and board sizes).
    const band = homeBandHeight(img, board);
    const cols = opts.cols || countCols(img, board, band) || (band ? Math.max(3, Math.round(bw / (band * 1.1))) : 10);
    const cellW = bw / cols;
    const rows = opts.rows || bestRowCount(img, board, cols, Math.max(3, Math.round(bh / (band || cellW * 0.946))));
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
    const header = readHeader(img, board.top);
    const myColor = (header && header.left.color) || detectMyColor(img, board.top) || 'O';
    return { rows, cols, board, cells, topColor, myColor, header };
  }

  // ---------- puzzle screen: a small letter box, a green starting letter, and a row of answer boxes ----------
  function isGreenMark(r, g, b) { return g > 95 && g - r > 45 && g - b > 45; }
  function readPuzzle(img, templates) {
    const { data, width: W, height: H } = img;
    const px = (x, y) => { const p = (y * W + x) * 4; return [data[p], data[p + 1], data[p + 2]]; };
    // 1. the letter box: the largest area of flat dark grey (about 30,30,30), sampled on a coarse grid
    const S = 4, gw = Math.floor(W / S), gh = Math.floor(H / S);
    const isCard = (x, y) => { const [r, g, b] = px(x, y); return Math.max(r, g, b) - Math.min(r, g, b) < 6 && r > 20 && r < 44; };
    const mask = new Uint8Array(gw * gh), lab = new Int32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) mask[y * gw + x] = isCard(x * S, y * S) ? 1 : 0;
    let best = null, nl = 0; const q = new Int32Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) {
      if (!mask[i] || lab[i]) continue;
      nl++; let h = 0, t = 0; q[t++] = i; lab[i] = nl;
      let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0;
      while (h < t) {
        const j = q[h++], x = j % gw, y = (j / gw) | 0; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const k of [j - 1, j + 1, j - gw, j + gw]) if (k >= 0 && k < gw * gh && mask[k] && !lab[k] && Math.abs((k % gw) - x) <= 1) { lab[k] = nl; q[t++] = k; }
      }
      if (!best || n > best.n) best = { n, x0, x1, y0, y1 };
    }
    if (!best || best.n < (gw * gh) * 0.03) return null;
    // fill ratio: a card is mostly grey (the letters are thin)
    const L = best.x0 * S + S, R = best.x1 * S - 1, T = best.y0 * S + S, B = best.y1 * S - 1;
    if (best.n < (best.x1 - best.x0 + 1) * (best.y1 - best.y0 + 1) * 0.5) return null;
    // 2. letter positions: white ink projected on each axis
    const light = (x, y) => { const [r, g, b] = px(x, y); return Math.min(r, g, b) > 170; };
    const colInk = new Int32Array(R - L + 1), rowInk = new Int32Array(B - T + 1);
    // skip a margin so the rounded light border never counts as ink
    const mx = Math.round((R - L) * 0.03), my = Math.round((B - T) * 0.03);
    for (let y = T + my; y <= B - my; y++) for (let x = L + mx; x <= R - mx; x++) if (light(x, y)) { colInk[x - L]++; rowInk[y - T]++; }
    const runs = (arr, minGap) => {
      const out = []; let s = -1, last = -1;
      for (let i = 0; i < arr.length; i++) if (arr[i] > 1) { if (s < 0 || i - last > minGap) { if (s >= 0) out.push([s, last]); s = i; } last = i; }
      if (s >= 0) out.push([s, last]);
      return out.filter(r => r[1] - r[0] > 4);
    };
    const cr = runs(colInk, Math.max(6, (R - L) * 0.02)), rr = runs(rowInk, Math.max(6, (B - T) * 0.02));
    if (cr.length < 2 || rr.length < 2 || cr.length > 8 || rr.length > 8) return null;
    const edges = (rs, lo, n) => { const e = [lo]; for (let i = 1; i < rs.length; i++) e.push(lo + Math.round((rs[i - 1][1] + rs[i][0]) / 2)); e.push(lo + n); return e; };
    const ex = edges(cr, L, R - L + 1), ey = edges(rr, T, B - T + 1);
    const cols = cr.length, rows = rr.length;
    // 3. read each letter; the cell with a green disc is the starting letter
    const cells = []; let start = -1, bestGreen = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x0 = ex[c], x1 = ex[c + 1], y0 = ey[r], y1 = ey[r + 1];
      const a = analyseCell(img, x0, y0, x1, y1);
      let letter = '', conf = 1;
      if (a.wildcard) letter = '?';
      else if (!a.empty && templates) { const k = classify(a, templates); letter = k.letter; conf = (k.dist > 9 || k.margin < 4) ? 0.3 : 1; }
      let g = 0, n = 0;
      for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) { n++; if (isGreenMark(...px(x, y))) g++; }
      if (g / n > 0.12 && g / n > bestGreen) { bestGreen = g / n; start = r * cols + c; }
      cells.push({ letter, conf, _a: a });
    }
    // 4. answer length: the row of green outlined boxes above the letter box
    let length = 0;
    const greenRow = y => { let n = 0; for (let x = 0; x < W; x += 2) if (isGreenMark(...px(x, y))) n++; return n * 2; };
    // horizontal green bands above the letter box; the answer boxes are a pair of thin bands
    // (top and bottom edges) with green dividers between them, the pair closest to the letter box
    const bands = []; let bs = -1;
    for (let y = Math.max(0, T - Math.round(H * 0.4)); y < T - 4; y++) {
      const on = greenRow(y) > W * 0.3;
      if (on && bs < 0) bs = y;
      if (!on && bs >= 0) { bands.push([bs, y - 1]); bs = -1; }
    }
    for (let i = bands.length - 1; i > 0 && !length; i--) {
      const lo = bands[i - 1][1], hi = bands[i][0], gap = hi - lo;
      if (gap < 30 || gap > W * 0.2) continue;
      const yy = lo + Math.round(gap * 0.15);
      let n = 0, inRun = false;
      for (let x = 0; x < W; x++) { const g = isGreenMark(...px(x, yy)); if (g && !inRun) n++; inRun = g; }
      if (n >= 3) length = n - 1;
    }
    return { rows, cols, cells, start, length, box: { left: L, right: R, top: T, bottom: B } };
  }

  const api = { readBoard, readPuzzle, readHeader, sigDistance, countCols, homeBandHeight, bestRowCount, findBoard, analyseCell, classify, decodeTemplates, encodeGlyph, G };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LGReader = api;
})(typeof self !== 'undefined' ? self : this);
