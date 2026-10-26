// Easing for the timeline (CPU side). The same curves exist in the shader (EASE_GLSL) for per-line staggers.
// Rule of thumb (animation-principles): things ARRIVE on an ease-out (fast, then settle), LEAVE on an ease-in
// (gather speed, then go), and move from A to B on an ease-in-out. Springs are for one overshoot on a logo landing.
export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const lerp = (a, b, t) => a + (b - a) * t;

export const EASES = {
  linear: (t) => t,
  inSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  outSine: (t) => Math.sin((t * Math.PI) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inQuart: (t) => t * t * t * t,
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  inOutQuart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - Math.pow(-2 * t + 2, 4) / 2),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
};
// index used by the shader's ease() switch — keep in sync with EASE_GLSL
export const EASE_ID = { linear: 0, outCubic: 1, inOutCubic: 2, outExpo: 3, inCubic: 4, outBack: 5, inOutSine: 6, inExpo: 7, outQuart: 8, inOutQuart: 9, inQuart: 10, outSine: 11, inSine: 12, inOutExpo: 13 };
export const ease = (name, t) => (EASES[name] || EASES.linear)(clamp01(t));

/** Damped spring from 0 to 1 (critically under-damped: one soft overshoot). t in seconds. */
export function spring(t, { stiffness = 170, damping = 16, mass = 1 } = {}) {
  if (t <= 0) return 0;
  const w0 = Math.sqrt(stiffness / mass), zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}

export const EASE_GLSL = /* glsl */`
  float easeF(float t, float id){
    t = clamp(t, 0.0, 1.0);
    if (id < 0.5) return t;
    if (id < 1.5) return 1.0 - pow(1.0 - t, 3.0);
    if (id < 2.5) return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0;
    if (id < 3.5) return t >= 1.0 ? 1.0 : 1.0 - pow(2.0, -10.0 * t);
    if (id < 4.5) return t * t * t;
    if (id < 5.5) { float c1 = 1.70158, c3 = c1 + 1.0; return 1.0 + c3 * pow(t - 1.0, 3.0) + c1 * pow(t - 1.0, 2.0); }
    if (id < 6.5) return -(cos(3.14159265 * t) - 1.0) / 2.0;
    if (id < 7.5) return t <= 0.0 ? 0.0 : pow(2.0, 10.0 * t - 10.0);
    if (id < 8.5) return 1.0 - pow(1.0 - t, 4.0);
    if (id < 9.5) return t < 0.5 ? 8.0 * t * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 4.0) / 2.0;
    if (id < 10.5) return t * t * t * t;
    if (id < 11.5) return sin(t * 1.5707963);
    if (id < 12.5) return 1.0 - cos(t * 1.5707963);
    return t <= 0.0 ? 0.0 : (t >= 1.0 ? 1.0 : (t < 0.5 ? pow(2.0, 20.0 * t - 10.0) / 2.0 : (2.0 - pow(2.0, -20.0 * t + 10.0)) / 2.0));
  }`;
