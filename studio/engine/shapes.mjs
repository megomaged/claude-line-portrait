// Inputs → one common shape: polylines of light (x, y, intensity, width per vertex) + particles, in source pixels (y down).
//   portrait / image   → baked data folder (scripts/flowlines.py or scripts/image2lines.py): meta.json, lines.bin, lines_idx.bin, dots.bin
//   svg (icon / logo)  → vector outlines sampled from the SVG geometry + inner contour lines from its filled area
//   text (any font)    → HarfBuzz shaping (Arabic joins, RTL, ligatures) → glyph outlines → same as svg
//   png icon           → traced: alpha (or dark-on-light luminance) mask → outline + contours
// Then resample() turns any shape into exactly S strokes × M points, so two shapes can morph point-for-point.
// Runs in the browser (studio, headless player, Remotion) — it uses DOMParser, SVG geometry and canvas.

export function rng(seed = 1) {   // mulberry32: every bake and every layout is reproducible
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const bboxOf = (polys) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of polys) for (let v = 0; v < q.x.length; v++) { const x = q.x[v], y = q.y[v]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 1, y1: 1 };
};
const poly = (xs, ys, i = 1, w = 1) => ({ x: Float32Array.from(xs), y: Float32Array.from(ys), i: new Float32Array(xs.length).fill(i), w: new Float32Array(xs.length).fill(w) });

// ---------- baked portraits / images (v1 format, unchanged) ----------
export async function loadBaked(base, { fade } = {}) {
  if (!base.endsWith('/')) base += '/';
  const get = async (f) => { const r = await fetch(base + f); if (!r.ok) throw new Error(`missing ${base + f}`); return r; };
  const meta = await (await get('meta.json')).json();
  const lb = await (await get('lines.bin')).arrayBuffer(), ix = new Uint32Array(await (await get('lines_idx.bin')).arrayBuffer());
  const IW = meta.width, IH = meta.height, NV = meta.vertices, isImage = meta.method === 'image';
  fade ??= !isImage;   // portraits melt into the frame edges; a cut-out object keeps its whole outline
  const P = new Uint16Array(lb, 0, NV * 2), I8 = new Uint8Array(lb, NV * 4, NV), W8 = new Uint8Array(lb, NV * 5, NV);
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // v1 look: the figure dissolves at the image's edges (bottom most), so a cropped photo never ends in a hard line
  const edge = (x, y) => fade ? sm(0, 0.12 * IW, x) * sm(0, 0.12 * IW, IW - x) * sm(0, 0.06 * IH, y) * sm(0, 0.24 * IH, IH - y) : 1;
  const polys = [];
  for (let p = 0; p + 1 < ix.length; p++) {
    const a = ix[p], n = ix[p + 1] - a, q = { x: new Float32Array(n), y: new Float32Array(n), i: new Float32Array(n), w: new Float32Array(n) };
    for (let v = 0; v < n; v++) { q.x[v] = P[(a + v) * 2] / 4; q.y[v] = P[(a + v) * 2 + 1] / 4; q.i[v] = I8[a + v] / 255 * edge(q.x[v], q.y[v]); q.w[v] = W8[a + v] / 16; }
    polys.push(q);
  }
  const db = await (await get('dots.bin')).arrayBuffer(), ND = meta.dots;
  const dp = new Uint16Array(db, 0, ND * 2), di = new Uint8Array(db, ND * 4, ND), dr = new Uint8Array(db, ND * 5, ND);
  const dots = { x: new Float32Array(ND), y: new Float32Array(ND), i: new Float32Array(ND), r: new Float32Array(ND) };
  for (let k = 0; k < ND; k++) { dots.x[k] = dp[k * 2] / 4; dots.y[k] = dp[k * 2 + 1] / 4; dots.i[k] = di[k] / 255 * edge(dots.x[k], dots.y[k]); dots.r[k] = dr[k] / 16; }
  const sb = isImage && meta.subject, pad = sb ? 0.02 * Math.max(sb[2] - sb[0], sb[3] - sb[1]) : 0;
  const bbox = sb ? { x0: sb[0] - pad, y0: sb[1] - pad, x1: sb[2] + pad, y1: sb[3] + pad } : { x0: 0, y0: 0, x1: IW, y1: IH };   // objects are framed by their own outline
  return { kind: isImage ? 'image' : 'portrait', polys, dots, bbox, order: 'ttb', meta };
}

// ---------- raster helpers: Euclidean distance transform + marching squares ----------
function edt1d(f, n, d, v, z) {   // Felzenszwalb & Huttenlocher, squared distances
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
/** distance (px) from every inside pixel to the nearest outside pixel; 0 outside */
export function insideDistance(mask, W, H) {
  const INF = 1e20, n = Math.max(W, H), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const D = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) D[i] = mask[i] ? INF : 0;
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) f[y] = D[y * W + x]; edt1d(f, H, d, v, z); for (let y = 0; y < H; y++) D[y * W + x] = d[y]; }
  for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) f[x] = D[y * W + x]; edt1d(f, W, d, v, z); for (let x = 0; x < W; x++) D[y * W + x] = Math.sqrt(d[x]); }
  return D;
}
/** iso-lines of a scalar field at `level` → chained polylines (pixel coords) */
export function marchingSquares(F, W, H, level) {
  const adj = new Map(), pts = new Map();
  const H_ = (i, j) => (j * W + i) * 2, V_ = (i, j) => (j * W + i) * 2 + 1;
  const ep = (id) => {
    if (pts.has(id)) return; const c = id >> 1, i = c % W, j = (c / W) | 0;
    if ((id & 1) === 0) { const a = F[j * W + i], b = F[j * W + i + 1], t = (level - a) / (b - a); pts.set(id, [i + t, j]); }
    else { const a = F[j * W + i], b = F[(j + 1) * W + i], t = (level - a) / (b - a); pts.set(id, [i, j + t]); }
  };
  const link = (a, b) => { ep(a); ep(b); (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); };
  for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
    const f00 = F[j * W + i], f10 = F[j * W + i + 1], f11 = F[(j + 1) * W + i + 1], f01 = F[(j + 1) * W + i];
    const c = (f00 >= level ? 1 : 0) | (f10 >= level ? 2 : 0) | (f11 >= level ? 4 : 0) | (f01 >= level ? 8 : 0);
    if (c === 0 || c === 15) continue;
    const e = [H_(i, j), V_(i + 1, j), H_(i, j + 1), V_(i, j)];   // top, right, bottom, left
    const ctr = (f00 + f10 + f11 + f01) / 4 >= level;
    switch (c) {
      case 1: case 14: link(e[3], e[0]); break;
      case 2: case 13: link(e[0], e[1]); break;
      case 3: case 12: link(e[3], e[1]); break;
      case 4: case 11: link(e[1], e[2]); break;
      case 6: case 9: link(e[0], e[2]); break;
      case 7: case 8: link(e[3], e[2]); break;
      case 5: if (ctr) { link(e[0], e[1]); link(e[2], e[3]); } else { link(e[3], e[0]); link(e[1], e[2]); } break;
      case 10: if (ctr) { link(e[3], e[0]); link(e[1], e[2]); } else { link(e[0], e[1]); link(e[2], e[3]); } break;
    }
  }
  const seen = new Set(), out = [];
  const walk = (start) => {
    const chain = [start]; seen.add(start); let cur = start;
    for (;;) { const nx = (adj.get(cur) || []).find((n) => !seen.has(n)); if (nx === undefined) break; seen.add(nx); chain.push(nx); cur = nx; }
    return chain;
  };
  for (const [id, nb] of adj) if (!seen.has(id) && nb.length === 1) out.push(walk(id));   // open chains first (they touch the border)
  for (const id of adj.keys()) if (!seen.has(id)) { const ch = walk(id); ch.push(ch[0]); out.push(ch); }   // closed loops
  return out.map((ch) => ch.map((id) => pts.get(id)));
}
function chaikin(p, closed, it = 2) {
  for (let k = 0; k < it; k++) {
    if (p.length < 3) return p; const q = closed ? [] : [p[0]];
    for (let a = 0; a + 1 < p.length; a++) { const [x0, y0] = p[a], [x1, y1] = p[a + 1]; q.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]); }
    if (closed) q.push(q[0]); else q.push(p[p.length - 1]); p = q;
  }
  return p;
}
const plen = (p) => { let L = 0; for (let a = 1; a < p.length; a++) L += Math.hypot(p[a][0] - p[a - 1][0], p[a][1] - p[a - 1][1]); return L; };

/** mask → outline (at the 0.5 level of the soft alpha) + concentric inner contours ("topographic" fill) or hatching */
function maskLines(alpha, W, H, { scale = 1, ox = 0, oy = 0, outline = true, fill = 'contours', spacing = 10, maxRings = 12, outlineI = 1, fillI = 0.55, angle = -30, minLen = 6 } = {}) {
  const polys = [], put = (p, i, w) => { if (p.length < 2 || plen(p) < minLen) return; polys.push(poly(p.map((q) => q[0] * scale + ox), p.map((q) => q[1] * scale + oy), i, w)); };
  if (outline) for (const p of marchingSquares(alpha, W, H, 0.5)) { const closed = p.length > 2 && p[0][0] === p.at(-1)[0] && p[0][1] === p.at(-1)[1]; put(chaikin(p, closed), outlineI, 1.8); }
  if (fill === 'contours') {
    const mask = new Uint8Array(W * H); for (let k = 0; k < W * H; k++) mask[k] = alpha[k] >= 0.5 ? 1 : 0;
    const D = insideDistance(mask, W, H); let dmax = 0; for (const d of D) if (d > dmax) dmax = d;
    for (let r = 1; r <= maxRings && r * spacing < dmax - 0.5; r++) {
      const gi = fillI * (1 - 0.45 * (r - 1) / Math.max(1, maxRings - 1));
      for (const p of marchingSquares(D, W, H, r * spacing)) { const closed = p.length > 2 && p[0][0] === p.at(-1)[0] && p[0][1] === p.at(-1)[1]; put(chaikin(p, closed), gi, 1.2); }
    }
  } else if (fill === 'hatch') {   // parallel lines clipped to the shape
    const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180), R = Math.hypot(W, H);
    for (let o = -R; o < R; o += spacing) {
      let run = null;
      for (let t = -R; t <= R; t += 1) {
        const x = W / 2 + c * t - s * o, y = H / 2 + s * t + c * o, xi = Math.round(x), yi = Math.round(y);
        const inside = xi >= 0 && yi >= 0 && xi < W && yi < H && alpha[yi * W + xi] >= 0.5;
        if (inside) (run ||= []).push([x, y]); else if (run) { put(run, fillI, 1.2); run = null; }
      }
      if (run) put(run, fillI, 1.2);
    }
  }
  return polys;
}
function sampleDots(polys, n, seed = 3) {   // particles riding the lines, more on the bright ones
  const R = rng(seed), cum = [], acc = [0];
  for (const q of polys) { let L = 0; for (let v = 1; v < q.x.length; v++) L += Math.hypot(q.x[v] - q.x[v - 1], q.y[v] - q.y[v - 1]); cum.push(L); acc.push(acc.at(-1) + L * (q.i[0] + 0.15)); }
  const T = acc.at(-1), d = { x: new Float32Array(n), y: new Float32Array(n), i: new Float32Array(n), r: new Float32Array(n) };
  if (!T) return d;
  const bb = bboxOf(polys), J = 0.004 * Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0);
  for (let k = 0; k < n; k++) {
    const u = R() * T; let lo = 0, hi = polys.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (acc[m + 1] < u) lo = m + 1; else hi = m; }
    const q = polys[lo], at = R() * cum[lo]; let L = 0, v = 1;
    for (; v < q.x.length; v++) { const s = Math.hypot(q.x[v] - q.x[v - 1], q.y[v] - q.y[v - 1]); if (L + s >= at) break; L += s; }
    v = Math.min(v, q.x.length - 1); const s = Math.max(1e-6, Math.hypot(q.x[v] - q.x[v - 1], q.y[v] - q.y[v - 1])), t = Math.min(1, (at - L) / s);
    d.x[k] = q.x[v - 1] + (q.x[v] - q.x[v - 1]) * t + (R() - 0.5) * J * 2; d.y[k] = q.y[v - 1] + (q.y[v] - q.y[v - 1]) * t + (R() - 0.5) * J * 2;
    d.i[k] = (0.35 + 0.65 * R()) * q.i[0]; d.r[k] = 0.5 + Math.pow(R(), 4) * 1.4;
  }
  return d;
}

// ---------- SVG (icons, logos) ----------
async function rasterSVG(svgEl, vw, vh, maxSide) {
  const k = maxSide / Math.max(vw, vh), W = Math.max(8, Math.round(vw * k)), H = Math.max(8, Math.round(vh * k));
  const clone = svgEl.cloneNode(true); clone.setAttribute('width', W); clone.setAttribute('height', H);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  try { const img = new Image(); img.src = url; await img.decode(); const c = document.createElement('canvas'); c.width = W + 4; c.height = H + 4;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 2, 2, W, H);
    const d = g.getImageData(0, 0, c.width, c.height).data, A = new Float32Array(c.width * c.height); for (let i = 0; i < A.length; i++) A[i] = d[i * 4 + 3] / 255;
    return { A, W: c.width, H: c.height, k, pad: 2 };
  } finally { URL.revokeObjectURL(url); }
}
/**
 * svgText → shape. opts: outline 'vector' | 'raster' | false, fill 'auto' | 'contours' | 'hatch' | 'none',
 * spacing (px at 1000 px of the SVG's long side), dots, res (raster side), rings
 */
export async function svgToShape(svgText, opts = {}) {
  const o = { outline: 'vector', fill: 'auto', spacing: 14, dots: 4000, res: 1400, rings: 10, fillI: 0.55, ...opts };
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml'), src = doc.documentElement;
  if (src.nodeName !== 'svg') throw new Error('not an SVG');
  const vb = (src.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const vw = vb.length === 4 ? vb[2] : parseFloat(src.getAttribute('width')) || 100, vh = vb.length === 4 ? vb[3] : parseFloat(src.getAttribute('height')) || 100;
  const host = document.createElement('div'); Object.assign(host.style, { position: 'absolute', left: '-99999px', top: '0', width: vw + 'px', height: vh + 'px', visibility: 'hidden' });
  const svg = document.importNode(src, true); svg.setAttribute('width', vw); svg.setAttribute('height', vh);
  host.appendChild(svg); document.body.appendChild(host);
  try {
    const geo = [...svg.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon')].filter((el) => !el.closest('defs,clipPath,mask,symbol') && getComputedStyle(el).display !== 'none');
    const filled = geo.some((el) => { const f = getComputedStyle(el).fill; return f && f !== 'none' && getComputedStyle(el).fillOpacity !== '0'; });
    const polys = [], unit = Math.max(vw, vh) / 1000;
    if (o.outline === 'vector') for (const el of geo) {   // exact outlines from the vector geometry, split where the pen jumps (subpaths)
      const L = el.getTotalLength(); if (!(L > 0)) continue;
      const M = el.getCTM();   // element → viewport px (same space the raster fill uses)
      const step = Math.max(unit * 0.8, L / 6000), n = Math.ceil(L / step);
      let xs = [], ys = [], px = null, py = null;
      for (let s = 0; s <= n; s++) {
        const p = el.getPointAtLength(Math.min(L, s * step)), x = M.a * p.x + M.c * p.y + M.e, y = M.b * p.x + M.d * p.y + M.f;
        if (px !== null && Math.hypot(x - px, y - py) > step * 3) { if (xs.length > 1) polys.push(poly(xs, ys, 1, filled ? 1.8 : 2.4)); xs = []; ys = []; }
        xs.push(x); ys.push(y); px = x; py = y;
      }
      if (xs.length > 1) polys.push(poly(xs, ys, 1, filled ? 1.8 : 2.4));
    }
    const fill = o.fill === 'auto' ? (filled ? 'contours' : 'none') : o.fill;
    if (fill !== 'none' || o.outline === 'raster') {
      const r = await rasterSVG(svg, vw, vh, o.res), sc = 1 / r.k;
      polys.push(...maskLines(r.A, r.W, r.H, { scale: sc, ox: -r.pad * sc, oy: -r.pad * sc, outline: o.outline === 'raster', fill, spacing: o.spacing * unit * r.k, maxRings: o.rings, fillI: o.fillI, angle: o.angle ?? -30, minLen: 4 }));
    }
    if (!polys.length) throw new Error('SVG has no drawable geometry');
    return { kind: o.kind || 'svg', polys, dots: sampleDots(polys, o.dots), bbox: bboxOf(polys), order: o.order || 'path' };
  } finally { host.remove(); }
}

// ---------- PNG / bitmap icons (trace) ----------
export async function bitmapToShape(url, opts = {}) {
  const o = { fill: 'contours', spacing: 14, dots: 4000, res: 1200, rings: 10, fillI: 0.55, ...opts };
  const img = new Image(); img.crossOrigin = 'anonymous'; img.src = url; await img.decode();
  const k = o.res / Math.max(img.width, img.height), W = Math.round(img.width * k) + 4, H = Math.round(img.height * k) + 4;
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 2, 2, W - 4, H - 4); const d = g.getImageData(0, 0, W, H).data, A = new Float32Array(W * H);
  let hasAlpha = false; for (let i = 0; i < W * H; i++) if (d[i * 4 + 3] < 250 && (i % W > 2 && i % W < W - 3 && i / W > 2 && i / W < H - 3)) { hasAlpha = true; break; }
  if (hasAlpha) for (let i = 0; i < W * H; i++) A[i] = d[i * 4 + 3] / 255;
  else {   // opaque icon: the ink is whichever tone the border is not
    let border = 0, nb = 0; for (let x = 2; x < W - 2; x++) for (const y of [2, H - 3]) { const i = (y * W + x) * 4; border += (d[i] + d[i + 1] + d[i + 2]) / 765; nb++; }
    const inv = border / nb > 0.5; for (let i = 0; i < W * H; i++) { const l = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 765; A[i] = inv ? 1 - l : l; }
    for (let i = 0; i < W * H; i++) { const x = i % W, y = (i / W) | 0; if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) A[i] = 0; }
  }
  const unit = Math.max(W, H) / 1000;
  const polys = maskLines(A, W, H, { outline: true, fill: o.fill, spacing: o.spacing * unit, maxRings: o.rings, fillI: o.fillI, minLen: 4 });
  if (!polys.length) throw new Error('no shape found in ' + url);
  return { kind: 'icon', polys, dots: sampleDots(polys, o.dots), bbox: bboxOf(polys), order: o.order || 'path' };
}

// ---------- text: HarfBuzz shaping → glyph outlines ----------
let HB = null;
const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('cannot load ' + src)); document.head.appendChild(s); });
export async function harfbuzz(vendorBase) {
  if (HB) return HB;
  if (!vendorBase.endsWith('/')) vendorBase += '/';
  if (typeof window.createHarfBuzz === 'undefined') await loadScript(vendorBase + 'hb.js');
  if (typeof window.hbjs === 'undefined') await loadScript(vendorBase + 'hbjs.js');
  const inst = await window.createHarfBuzz({ locateFile: (f) => vendorBase + f });
  HB = window.hbjs(inst);
  return HB;
}
const fontCache = new Map();
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/, LTR = /[A-Za-z0-9À-ɏͰ-ϿЀ-ӿ]/;
/** minimal bidi: split a line into same-direction runs (neutrals join their neighbours), return them in visual order */
export function bidiRuns(line) {
  const cls = [...line].map((ch) => (RTL.test(ch) ? 'R' : LTR.test(ch) ? 'L' : 'N'));
  const base = cls.find((c) => c !== 'N') || 'L', chars = [...line];
  for (let k = 0; k < cls.length; k++) if (cls[k] === 'N') {   // a neutral between two runs of the same direction takes it, else the base direction
    let a = k - 1; while (a >= 0 && cls[a] === 'N') a--; let b = k + 1; while (b < cls.length && cls[b] === 'N') b++;
    const pa = a >= 0 ? cls[a] : base, pb = b < cls.length ? cls[b] : base; cls[k] = pa === pb ? pa : base;
  }
  const runs = []; for (let k = 0; k < chars.length; k++) { if (!runs.length || runs.at(-1).dir !== cls[k]) runs.push({ dir: cls[k], text: '' }); runs.at(-1).text += chars[k]; }
  return { base, runs: base === 'R' ? runs.reverse() : runs };
}
/** text → SVG with one <path> per glyph (font units, y down). Lines split on \n, centred. */
export async function textToSVG(text, fontUrl, vendorBase, { lineHeight = 1.25, features = '', letterSpacing = 0 } = {}) {
  const hb = await harfbuzz(vendorBase);
  let F = fontCache.get(fontUrl);
  if (!F) { const buf = await (await fetch(fontUrl)).arrayBuffer(); const blob = hb.createBlob(buf), face = hb.createFace(blob, 0), font = hb.createFont(face); F = { face, font, upem: face.upem }; fontCache.set(fontUrl, F); }
  const lines = String(text).split('\n'), rows = [];
  let dirAll = null;
  for (const line of lines) {
    const { base, runs } = bidiRuns(line); dirAll ||= base; const glyphs = []; let pen = 0;
    for (const run of runs) {
      const b = hb.createBuffer(); b.addText(run.text); b.guessSegmentProperties(); b.setDirection(run.dir === 'R' ? 'rtl' : 'ltr');
      hb.shape(F.font, b, features); const out = b.json(); b.destroy();
      for (const g of out) { glyphs.push({ d: F.font.glyphToPath(g.g), x: pen + g.dx, y: g.dy }); pen += g.ax + letterSpacing * F.upem; }
    }
    rows.push({ glyphs, width: pen });
  }
  const maxW = Math.max(1, ...rows.map((r) => r.width)), LH = lineHeight * F.upem, asc = 0.95 * F.upem, desc = 0.35 * F.upem;
  const H = asc + desc + LH * (rows.length - 1); let paths = '';
  rows.forEach((r, k) => { const ox = (maxW - r.width) / 2, base = asc + k * LH;
    for (const g of r.glyphs) if (g.d) paths += `<path transform="translate(${(ox + g.x).toFixed(1)} ${(base - g.y).toFixed(1)}) scale(1 -1)" d="${g.d}"/>`; });
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${maxW.toFixed(0)} ${H.toFixed(0)}" fill="#000">${paths}</svg>`, dir: dirAll === 'R' ? 'rtl' : 'ltr' };
}
export async function textToShape(text, fontUrl, vendorBase, opts = {}) {
  const { svg, dir } = await textToSVG(text, fontUrl, vendorBase, opts);
  // overlapping glyph parts (Arabic joins, accents) would leave inner seams in a vector outline, so text is traced from a sharp raster
  const sh = await svgToShape(svg, { outline: 'raster', fill: 'contours', spacing: 22, rings: 3, res: 2600, fillI: 0.5, dots: 3000, kind: 'text', ...opts });
  sh.order = opts.order || dir; sh.dir = dir;
  return sh;
}

// ---------- resampling: any shape → exactly S strokes × M points ----------
/**
 * Splits the polylines into S pieces of about equal arc length (long lines → several pieces, short lines → one each;
 * if there are more lines than S, the weakest are dropped), each piece resampled to M evenly spaced points.
 * Returns typed arrays (length S*M) + per-stroke info (centroid, source order, length).
 */
export function resample(shape, S, M) {
  const P = shape.polys.map((q, idx) => {
    const n = q.x.length, cum = new Float32Array(n); let L = 0, I = 0;
    for (let v = 1; v < n; v++) { L += Math.hypot(q.x[v] - q.x[v - 1], q.y[v] - q.y[v - 1]); cum[v] = L; }
    for (let v = 0; v < n; v++) I += q.i[v];
    return { q, cum, L, idx, score: L * (I / n + 0.05) };
  }).filter((p) => p.L > 0);
  let keep = P;
  if (keep.length > S) keep = [...P].sort((a, b) => b.score - a.score).slice(0, S).sort((a, b) => a.idx - b.idx);
  const count = (c) => keep.reduce((s, p) => s + Math.max(1, Math.ceil(p.L / c)), 0);
  const T = keep.reduce((s, p) => s + p.L, 0);
  let lo = T / S / 8, hi = T + 1;
  for (let it = 0; it < 50; it++) { const mid = (lo + hi) / 2; if (count(mid) > S) lo = mid; else hi = mid; }
  const k = keep.map((p) => Math.max(1, Math.ceil(p.L / hi)));
  let rem = S - k.reduce((a, b) => a + b, 0);
  if (rem > 0 && keep.length) {   // hand the leftover pieces to the lines with the longest pieces
    const order = keep.map((p, j) => j).sort((a, b) => keep[b].L / k[b] - keep[a].L / k[a]);
    for (let r = 0; rem > 0; r = (r + 1) % order.length, rem--) k[order[r]]++;
  }
  const X = new Float32Array(S * M), Y = new Float32Array(S * M), I = new Float32Array(S * M), Wd = new Float32Array(S * M);
  const info = { cx: new Float32Array(S), cy: new Float32Array(S), src: new Float32Array(S), len: new Float32Array(S), pcx: new Float32Array(S), pcy: new Float32Array(S), psrc: new Float32Array(S), pu0: new Float32Array(S), pu1: new Float32Array(S) };
  let s = 0; const nSrc = Math.max(1, shape.polys.length);
  keep.forEach((p, j) => {
    const { q, cum, L } = p; let v = 1, pcx = 0, pcy = 0;
    for (let u = 0; u < q.x.length; u++) { pcx += q.x[u]; pcy += q.y[u]; } pcx /= q.x.length; pcy /= q.x.length;
    for (let c = 0; c < k[j] && s < S; c++, s++) {
      const a = L * c / k[j], b = L * (c + 1) / k[j]; let mx = 0, my = 0; v = 1;
      for (let m = 0; m < M; m++) {
        const at = a + (b - a) * m / (M - 1);
        while (v < q.x.length - 1 && cum[v] < at) v++;
        const seg = Math.max(1e-9, cum[v] - cum[v - 1]), t = Math.min(1, Math.max(0, (at - cum[v - 1]) / seg)), o = s * M + m;
        X[o] = q.x[v - 1] + (q.x[v] - q.x[v - 1]) * t; Y[o] = q.y[v - 1] + (q.y[v] - q.y[v - 1]) * t;
        I[o] = q.i[v - 1] + (q.i[v] - q.i[v - 1]) * t; Wd[o] = q.w[v - 1] + (q.w[v] - q.w[v - 1]) * t; mx += X[o]; my += Y[o];
      }
      info.cx[s] = mx / M; info.cy[s] = my / M; info.src[s] = (p.idx + c / k[j]) / nSrc; info.len[s] = b - a;
      info.pcx[s] = pcx; info.pcy[s] = pcy; info.psrc[s] = p.idx / nSrc; info.pu0[s] = c / k[j]; info.pu1[s] = (c + 1) / k[j];   // the source line this piece belongs to
    }
  });
  for (; s < S; s++) {   // empty shape: park the spare strokes, invisible, at the centre
    const bb = shape.bbox, cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
    for (let m = 0; m < M; m++) { X[s * M + m] = cx; Y[s * M + m] = cy; I[s * M + m] = 0; Wd[s * M + m] = 1; }
    info.cx[s] = cx; info.cy[s] = cy; info.src[s] = 1; info.len[s] = 0; info.pcx[s] = cx; info.pcy[s] = cy; info.psrc[s] = 1; info.pu0[s] = 0; info.pu1[s] = 1;
  }
  return { S, M, X, Y, I, W: Wd, info };
}
export function resampleDots(shape, D, seed = 11) {
  const src = shape.dots && shape.dots.x.length ? shape.dots : sampleDots(shape.polys, D, seed), n = src.x.length, R = rng(seed);
  const out = { x: new Float32Array(D), y: new Float32Array(D), i: new Float32Array(D), r: new Float32Array(D) };
  const bb = shape.bbox, J = 0.003 * Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0);
  const perm = Array.from({ length: n }, (_, k) => k); for (let k = n - 1; k > 0; k--) { const j = Math.floor(R() * (k + 1)); [perm[k], perm[j]] = [perm[j], perm[k]]; }
  for (let k = 0; k < D; k++) { const j = perm[k % n], extra = k >= n;
    out.x[k] = src.x[j] + (extra ? (R() - 0.5) * J : 0); out.y[k] = src.y[j] + (extra ? (R() - 0.5) * J : 0); out.i[k] = src.i[j] * (extra ? 0.7 : 1); out.r[k] = src.r[j]; }
  return out;
}
/** Hilbert index of (x, y) in [0,1)² — neighbours in space get neighbouring keys, so sorting by it pairs nearby strokes */
export function hilbert(x, y, order = 10) {
  const n = 1 << order; let X = Math.min(n - 1, Math.max(0, Math.floor(x * n))), Y = Math.min(n - 1, Math.max(0, Math.floor(y * n))), d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) { const rx = (X & s) > 0 ? 1 : 0, ry = (Y & s) > 0 ? 1 : 0; d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { X = s - 1 - X; Y = s - 1 - Y; } const t = X; X = Y; Y = t; } }
  return d;
}
