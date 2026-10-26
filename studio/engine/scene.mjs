// Scene spec → normalized timeline, and the exact state of every uniform at time t (pure function: frame-exact,
// random access, no state carried between frames — so a renderer can draw frame 812 without drawing 0…811).
import { EASES, EASE_ID, ease, spring, clamp01, lerp } from './ease.mjs';

export const PRESETS = {   // a = line colour, b = second colour (gradient end / highlight), mode 0 mono · 1 gradient by height · 2 by light
  white: { a: '#ffffff', b: '#cfe6ff', mode: 0, glow: 0.55, gain: 1.0, bg: '#000000' },
  ember: { a: '#8FE3D8', b: '#FF6A1A', mode: 2, glow: 0.75, gain: 0.9, bg: '#03060c' },   // Teal Fire (ADAM)
  rose: { a: '#CEAFEB', b: '#E77395', mode: 2, glow: 0.75, gain: 0.9, bg: '#0b0712' },    // Lilac Rose (EVE)
  gold: { a: '#ffd9a0', b: '#ff8a3d', mode: 1, glow: 0.65, gain: 0.95, bg: '#050302' },
  neon: { a: '#00e5ff', b: '#ff2bd6', mode: 1, glow: 0.85, gain: 0.95, bg: '#02000a' },
  ice: { a: '#d8f3ff', b: '#4fb6ff', mode: 2, glow: 0.7, gain: 0.95, bg: '#01040a' },
  claude: { a: '#ffd8c2', b: '#d97757', mode: 2, glow: 0.7, gain: 0.95, bg: '#0a0604' },
};
export const LOOK_DEFAULT = { preset: 'white', a: '#ffffff', b: '#cfe6ff', mode: 0, glow: 0.55, gain: 1, gamma: 1, width: 1.0, dots: 1, dotSize: 2.2, pulse: 0, pulseSpeed: 1, breathe: 0, bg: '#000000' };
export const FX = ['shimmer', 'scan', 'ripple', 'heartbeat', 'glitch', 'wind', 'dash', 'flicker', 'aurora', 'sweep'];
export const ORDER = { ttb: 0, ltr: 1, rtl: 2, center: 3, random: 4, path: 5, btt: 6, outside: 7 };
export const IN_TYPES = { none: 0, cut: 0, fade: 6, draw: 1, assemble: 2, wipe: 3, glitch: 4, sweep: 8, sting: 2, morph: 0 };
export const OUT_TYPES = { none: 0, cut: 0, fade: 6, draw: 1, undraw: 1, disperse: 2, wipe: 3, glitch: 4, sweep: 8 };
export const SCATTER = { explode: 0, dust: 1, wind: 2, vortex: 3 };
export const WIPE_DIR = { ltr: [1, 0], rtl: [-1, 0], ttb: [0, -1], btt: [0, 1], diag: [0.8, -0.6] };

const IN_DEF = {
  none: { dur: 0 }, cut: { dur: 0 },
  fade: { dur: 0.6, ease: 'outCubic', stagger: 0 },
  draw: { dur: 1.6, ease: 'inOutSine', stagger: 2.5 },   // stagger 2.5: each line draws in 1/3.5 of the time, the starts spread over the rest
  assemble: { dur: 1.4, ease: 'outExpo', stagger: 0.6, style: 'explode', spread: 1 },
  wipe: { dur: 1.0, ease: 'inOutCubic', stagger: 0, dir: 'ltr' },
  glitch: { dur: 0.5, ease: 'linear', stagger: 0.3 },
  sweep: { dur: 1.2, ease: 'inOutSine', stagger: 0, dir: 'diag' },
  sting: { dur: 1.6, ease: 'outExpo', stagger: 0.45, style: 'explode', spread: 1.3 },
  morph: { dur: 1.4, ease: 'inOutCubic', stagger: 0.5, swirl: 0.25 },
};
const OUT_DEF = {
  none: { dur: 0 }, cut: { dur: 0 },
  fade: { dur: 0.5, ease: 'inCubic', stagger: 0 },
  draw: { dur: 1.0, ease: 'inOutSine', stagger: 2 }, undraw: { dur: 1.0, ease: 'inOutSine', stagger: 2 },
  disperse: { dur: 1.3, ease: 'inCubic', stagger: 0.6, style: 'dust', spread: 1 },
  wipe: { dur: 0.8, ease: 'inOutCubic', stagger: 0, dir: 'ltr' },
  glitch: { dur: 0.4, ease: 'linear', stagger: 0.3 },
  sweep: { dur: 1.0, ease: 'inOutSine', stagger: 0, dir: 'diag' },
};
const tr = (t, defs, kind) => {
  if (!t) return { type: 'none', dur: 0 };
  if (typeof t === 'string') t = { type: t };
  const d = defs[t.type]; if (!d) throw new Error(`unknown ${kind} transition "${t.type}" (use: ${Object.keys(defs).join(', ')})`);
  return { ...d, ...t };
};

/** Fill defaults, resolve presets, compute shot start times. Throws on anything a renderer could not honour. */
export function normalize(spec) {
  const s = { width: 1080, height: 1920, fps: 30, background: '#000000', strokes: 9000, points: 8, dots: 6000, backdrop: 0, dust: 0, ...spec };
  s.transparent = s.background === 'transparent';
  if (!Array.isArray(s.shots) || !s.shots.length) throw new Error('scene needs at least one shot');
  const base = { ...LOOK_DEFAULT, ...(PRESETS[s.look?.preset] || {}), ...(s.look || {}) };
  let t = 0;
  s.shots = s.shots.map((sh, k) => {
    if (!sh.input) throw new Error(`shot ${k}: missing input`);
    if (!(sh.duration > 0)) throw new Error(`shot ${k}: duration must be > 0`);
    const look = { ...base, ...(PRESETS[sh.look?.preset] || {}), ...(sh.look || {}) };
    const inT = tr(sh.in, IN_DEF, 'in'), outT = tr(sh.out, OUT_DEF, 'out');
    if (inT.type === 'morph' && k === 0) throw new Error('shot 0 cannot morph in (nothing to morph from)');
    if (inT.dur + outT.dur > sh.duration + 1e-6) throw new Error(`shot ${k}: in (${inT.dur}s) + out (${outT.dur}s) is longer than the shot (${sh.duration}s)`);
    const fx = (sh.fx || []).map((f) => (typeof f === 'number' ? f : FX.indexOf(f))).filter((i) => i >= 0);
    const o = { ...sh, id: sh.id || `shot${k}`, index: k, start: t, end: t + sh.duration, look, in: inT, out: outT, fx, fit: sh.fit ?? 0.8, pos: sh.pos || [0, 0],
      fxAmount: sh.fxAmount ?? 1, fxSpeed: sh.fxSpeed ?? 1, accents: sh.accents || [], camera: sh.camera || {} };
    t += sh.duration;
    return o;
  });
  // a morph replaces the previous shot's exit: the previous shape stays whole until the morph takes it
  s.shots.forEach((sh, k) => { if (sh.in.type === 'morph' && s.shots[k - 1].out.type !== 'none') s.shots[k - 1].out = { type: 'none', dur: 0 }; });
  s.duration = t; s.frames = Math.round(t * s.fps);
  return s;
}

const anim = (v, e) => (Array.isArray(v) ? (Array.isArray(v[0]) ? v[0].map((_, i) => lerp(v[0][i], v[1][i], e)) : lerp(v[0], v[1], e)) : v);
const mixLook = (A, B, e) => {
  const o = { ...B };
  for (const k of ['glow', 'gain', 'gamma', 'width', 'dots', 'dotSize', 'pulse', 'breathe']) o[k] = lerp(A[k], B[k], e);
  o.aFrom = A.a; o.bFrom = B.b; o.lookMix = e; o.aPrev = A.a; o.bPrev = A.b; o.modePrev = A.mode;
  return o;
};

/** Everything the renderer needs at time t (seconds). */
export function stateAt(scene, t) {
  const shots = scene.shots;
  t = Math.min(Math.max(0, t), scene.duration - 1e-6);
  let k = shots.findIndex((s) => t < s.end); if (k < 0) k = shots.length - 1;
  const sh = shots[k], tl = t - sh.start;
  const st = { t, shot: sh, index: k, tl, morph: 1, inP: 1, outP: 0, flash: 0, glitch: 0, chroma: 0, sweep: -10, sweepWidth: 0.06, scale: 1, fade: 1, look: sh.look };
  // in
  if (sh.in.type === 'morph') {
    st.morph = sh.in.dur > 0 ? clamp01(tl / sh.in.dur) : 1;
    st.look = mixLook(shots[k - 1].look, sh.look, ease('inOutSine', st.morph));
  } else if (sh.in.dur > 0) st.inP = clamp01(tl / sh.in.dur);
  if (sh.out.dur > 0) st.outP = clamp01((tl - (sh.duration - sh.out.dur)) / sh.out.dur);
  // transition extras that live on the CPU
  if (sh.in.type === 'glitch' && st.inP < 1) { const burst = Math.floor(tl * 24) % 3 === 0 ? 1 : 0.4; st.glitch = (1 - st.inP) * burst; st.chroma = (1 - st.inP) * 0.012; }
  if (sh.out.type === 'glitch' && st.outP > 0) { const burst = Math.floor(tl * 24) % 3 === 0 ? 1 : 0.4; st.glitch = st.outP * burst; st.chroma = st.outP * 0.012; }
  if (sh.in.type === 'sting') {   // logo sting: assemble + spring-scale landing + flash on contact + a light sweep across
    const land = sh.in.dur * 0.55;
    st.scale = 0.86 + 0.14 * spring(tl, { stiffness: 120, damping: 11 });
    st.flash = 0.9 * Math.exp(-Math.pow((tl - land) / 0.07, 2)) + 0.25 * Math.exp(-Math.pow((tl - land) / 0.25, 2));
    const sp = (tl - land) / 0.9; if (sp > 0 && sp < 1) st.sweep = lerp(-0.2, 1.2, ease('inOutSine', sp));
  }
  for (const a of sh.accents) {   // one-shot accents anywhere in a shot
    const dt = tl - (a.at ?? 0), dur = a.dur ?? (a.type === 'sweep' ? 0.9 : 0.3);
    if (a.type === 'sweep' && dt > 0 && dt < dur) { st.sweep = lerp(-0.2, 1.2, ease('inOutSine', dt / dur)); st.sweepWidth = a.width ?? 0.06; }
    if (a.type === 'flash') st.flash += (a.amount ?? 0.7) * Math.exp(-Math.pow(dt / (dur * 0.35), 2)) * (dt > -dur ? 1 : 0);
    if (a.type === 'glitch' && dt > 0 && dt < dur) { st.glitch = Math.max(st.glitch, (a.amount ?? 1) * (1 - dt / dur)); st.chroma = Math.max(st.chroma, 0.01 * (1 - dt / dur)); }
    if (a.type === 'pulse') st.scale *= 1 + (a.amount ?? 0.04) * Math.exp(-Math.pow(dt / 0.12, 2)) * (dt > -0.3 ? 1 : 0);
  }
  if (sh.in.type === 'fade') st.fade *= 1;   // handled per element in the shader
  // camera: every key is [from, to] over the shot, or a constant
  const c = sh.camera, ce = ease(c.ease || 'inOutSine', tl / sh.duration);
  const pan = c.pan ?? [0, 0];   // [x, y] constant, or [[x0, y0], [x1, y1]] animated
  st.zoom = anim(c.zoom ?? 1, ce); st.pan = Array.isArray(pan[0]) ? anim(pan, ce) : pan; st.roll = anim(c.roll ?? 0, ce); st.yaw = anim(c.yaw ?? 0, ce); st.pitch = anim(c.pitch ?? 0, ce);
  return st;
}
export { EASE_ID, EASES };
