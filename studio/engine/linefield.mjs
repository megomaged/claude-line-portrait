// LineField engine — draws any shape as light lines + particles, with transitions, effects, bloom and true alpha.
//   const eng = await createEngine({ canvas, width, height, assetBase, sceneBase });
//   await eng.load(spec);  eng.renderFrame(n);  eng.readPixels()  // straight (un-premultiplied) RGBA, bottom-up rows
// One engine for the studio page, the headless renderer (render.mjs) and the Remotion component.
// Every frame is a pure function of its time: no state carries from frame to frame.
import * as THREE from 'three';
import { EASE_GLSL, EASE_ID, ease } from './ease.mjs';
import { normalize, stateAt, ORDER, IN_TYPES, OUT_TYPES, SCATTER, WIPE_DIR } from './scene.mjs';
import { loadBaked, svgToShape, bitmapToShape, textToShape, resample, resampleDots, hilbert, rng } from './shapes.mjs';

const FOV = 30, DIST = 0.5 / Math.tan((FOV / 2) * Math.PI / 180);   // at this distance the frame is exactly 1 unit tall
const hash = (i) => { let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
const col = (h) => new THREE.Color().setStyle(h);

// ---------------------------------------------------------------- GLSL
const COMMON = /* glsl */`
  ${EASE_GLSL}
  uniform float uTime, uAspect, uMorph, uMorphSt, uMorphEase, uSwirl, uMorphOrder;
  uniform float uInType, uInP, uInEase, uInSt, uInOrder, uInStyle, uInSpread;
  uniform float uOutType, uOutP, uOutEase, uOutSt, uOutOrder, uOutStyle, uOutSpread;
  uniform vec2 uInDir, uOutDir;
  uniform float uFx[10], uFxAmt, uFxSpeed, uBgGain, uWave, uYaw, uSize;   // uSize = the shape's size in frame units (scatter scales with it)
  float h1(float n){ return fract(sin(n) * 43758.5453123); }
  float stag(float p, float key, float st){ return clamp(p * (1.0 + st) - key * st, 0.0, 1.0); }
  // order keys from the stroke's place in its shape (kc = centre x,y in 0..1, y down) + its random and source rank
  float orderKey(float o, vec4 k){
    if (o < 0.5) return k.y;                 // top → bottom
    if (o < 1.5) return k.x;                 // left → right
    if (o < 2.5) return 1.0 - k.x;           // right → left (Arabic)
    if (o < 3.5) return clamp(length((k.xy - 0.5) * vec2(1.0, 1.0)) * 1.42, 0.0, 1.0);   // centre out
    if (o < 4.5) return k.z;                 // random
    if (o < 5.5) return k.w;                 // the source's own order (SVG paths, glyphs)
    if (o < 6.5) return 1.0 - k.y;           // bottom → top
    return 1.0 - clamp(length(k.xy - 0.5) * 1.42, 0.0, 1.0);   // outside in
  }
  // where a piece is when it is scattered: explode / dust / wind / vortex
  vec3 scatter(vec2 m, float seed, float style, float spread, float e){
    float a = h1(seed * 1.31), b = h1(seed * 7.17 + 3.1), c = h1(seed * 3.77 + 9.2);
    vec3 o;
    if (style < 0.5) { vec2 d = normalize(m + vec2(a - 0.5, b - 0.5) * 0.35 * uSize + 1e-4); o = vec3(d * (0.35 + 1.1 * a * a) * uSize, (c - 0.35) * 1.4 * uSize); }
    else if (style < 1.5) { o = vec3((a - 0.5) * 0.25, 0.12 + 0.6 * b, (c - 0.5) * 0.4) * uSize; }
    else if (style < 2.5) { o = vec3(0.45 + 0.6 * a + 0.5 * uSize * a, (b - 0.45) * 0.3 * uSize, (c - 0.5) * 0.35 * uSize); }
    else { float r = length(m), ang = (1.2 + 2.2 * a) * (1.0 - e); vec2 rm = vec2(cos(ang) * m.x - sin(ang) * m.y, sin(ang) * m.x + cos(ang) * m.y); o = vec3(rm * (1.0 + 0.8 * b) - m, (c - 0.5) * 0.4); }
    // a little curl in flight so pieces travel in arcs, not straight lines
    o.xy += vec2(sin(seed * 11.0 + uTime * 1.7), cos(seed * 5.0 + uTime * 1.3)) * 0.06 * uSize;
    return o * spread * (1.0 - e);
  }
  vec2 fxPos(vec2 p, float bg){
    float T = uTime * uFxSpeed;
    if (uFx[4] > 0.5) { float sl = floor(p.y / 0.035), k = floor(T * 9.0), g = step(0.9, h1(sl * 7.13 + k * 3.7)); p.x += g * (h1(sl + k * 1.31) - 0.5) * 0.05 * uFxAmt; }
    if (uFx[5] > 0.5 && bg < 0.5) { float d = clamp(length(p / vec2(0.3, 0.45)), 0.0, 1.5), w = d * d;
      p.x += w * 0.014 * uFxAmt * (sin(T * 1.7 + p.y * 11.0) + 0.5 * sin(T * 3.1 + p.y * 33.0)); p.y += w * 0.006 * uFxAmt * sin(T * 2.3 + p.x * 19.0); }
    if (bg > 0.5) p.y += uWave * (0.006 * sin(p.x * 5.0 - uTime * 0.9 + p.y * 2.3) + 0.003 * sin(p.x * 11.7 + uTime * 0.6));
    return p;
  }
  // full transition stack for one point. home = after morph. returns xyz, and writes brightness/alpha/collapse
  struct Tr { vec3 p; float a; float boost; float col; float trimA; float trimB; float near; };
  // k = this piece (scatter, glitch), kp = the source line it belongs to (draw / undraw run along whole source lines)
  Tr transition(vec2 home, vec2 mid, vec4 k, vec4 kp, float seed, float u0, float u1, float bg){
    Tr r; r.p = vec3(home, 0.0); r.a = 1.0; r.boost = 0.0; r.col = 0.0; r.trimA = 0.0; r.trimB = 1.0; r.near = 1.0;
    if (bg > 0.5) return r;
    // ---- in
    if (uInType > 0.5 && uInP < 1.0) {
      float q = stag(uInP, orderKey(uInOrder, uInType < 1.5 ? kp : k), uInSt), e = easeF(q, uInEase);
      if (uInType < 1.5) {                                   // draw: the pen runs along each stroke
        float f = (e - u0) / max(1e-5, u1 - u0); r.trimB = clamp(f, 0.0, 1.0); r.a = step(1e-4, f);
        r.boost = 2.2 * exp(-pow((u1 - e) / 0.03, 2.0)) * (1.0 - step(0.999, e));
      } else if (uInType < 2.5) {                            // assemble: pieces fly home and join into lines
        float sd = uInStyle < 0.5 ? k.z * 1000.0 : seed;
        r.p += scatter(mid, sd, uInStyle, uInSpread, e); r.near = e * e; r.col = uInStyle < 0.5 ? 0.0 : 1.0 - smoothstep(0.75, 1.0, e); r.a = smoothstep(0.0, 0.18, q); r.boost = 0.8 * (1.0 - smoothstep(0.75, 1.0, e));
      } else if (uInType < 3.5 || (uInType > 7.5 && uInType < 8.5)) {
        r.a = 1.0;                                           // wipe / sweep: per pixel, in the fragment shader
      } else if (uInType < 4.5) {                            // glitch: pieces flicker on
        float fl = step(h1(seed * 3.3 + floor(uTime * 24.0) * 0.731), e * 1.25); r.a = fl; r.p.x += (1.0 - e) * (h1(floor(home.y / 0.03) + floor(uTime * 18.0)) - 0.5) * 0.12;
      } else if (uInType < 6.5) { r.a = e; }                 // fade
    }
    // ---- out
    if (uOutType > 0.5 && uOutP > 0.0) {
      float q = stag(uOutP, orderKey(uOutOrder, uOutType < 1.5 ? kp : k), uOutSt), e = easeF(q, uOutEase);
      if (uOutType < 1.5) {                                  // undraw: erased from the start, in drawing order
        float f = (e - u0) / max(1e-5, u1 - u0); r.trimA = max(r.trimA, clamp(f, 0.0, 1.0)); r.a *= 1.0 - step(0.9999, f);
        r.boost += 1.6 * exp(-pow((u0 - e) / 0.03, 2.0)) * step(1e-4, e);
      } else if (uOutType < 2.5) {                           // disperse: lines break into particles and leave
        float sd = uOutStyle < 0.5 ? k.z * 1000.0 + 17.0 : seed + 17.0;
        r.p += scatter(mid, sd, uOutStyle, uOutSpread, 1.0 - e); r.near = (1.0 - e) * (1.0 - e); r.col = max(r.col, uOutStyle < 0.5 ? 0.0 : smoothstep(0.0, 0.3, e)); r.a *= 1.0 - smoothstep(0.55, 1.0, e); r.boost += 0.9 * sin(3.14159 * min(1.0, e * 1.6));
      } else if (uOutType < 4.5 && uOutType > 3.5) {
        float fl = 1.0 - step(h1(seed * 5.1 + floor(uTime * 24.0) * 0.537), e * 1.25); r.a *= fl; r.p.x += e * (h1(floor(home.y / 0.03) + floor(uTime * 18.0)) - 0.5) * 0.12;
      } else if (uOutType > 5.5 && uOutType < 6.5) { r.a *= 1.0 - e; }
    }
    return r;
  }
  // per-pixel reveal for wipe / sweep (frame coords 0..1, y up)
  float wipeMask(vec2 fp, out float band){
    band = 0.0; float m = 1.0;
    if ((uInType > 2.5 && uInType < 3.5) || (uInType > 7.5 && uInType < 8.5)) if (uInP < 1.0) {
      float s = dot(fp - 0.5, uInDir) / (abs(uInDir.x) * 0.5 + abs(uInDir.y) * 0.5) * 0.5 + 0.5, f = mix(-0.12, 1.12, easeF(uInP, uInEase)), w = uInType > 7.5 ? 0.10 : 0.03;
      m *= smoothstep(f + 0.004, f - 0.004, s); band += exp(-pow((s - f) / w, 2.0)) * (uInType > 7.5 ? 1.3 : 2.2); }
    if ((uOutType > 2.5 && uOutType < 3.5) || (uOutType > 7.5 && uOutType < 8.5)) if (uOutP > 0.0) {
      float s = dot(fp - 0.5, uOutDir) / (abs(uOutDir.x) * 0.5 + abs(uOutDir.y) * 0.5) * 0.5 + 0.5, f = mix(-0.12, 1.12, easeF(uOutP, uOutEase)), w = uOutType > 7.5 ? 0.10 : 0.03;
      m *= smoothstep(f - 0.004, f + 0.004, s); band += exp(-pow((s - f) / w, 2.0)) * (uOutType > 7.5 ? 1.3 : 2.2) * step(0.0001, uOutP); }
    return m;
  }`;

const COLOR = /* glsl */`
  uniform vec3 uA, uB; uniform float uMode, uGain, uGamma;
  vec3 tint(float inten, float y){
    float l = pow(clamp(inten, 0.0, 1.0), uGamma);
    vec3 c = uMode < 0.5 ? uA : (uMode < 1.5 ? mix(uB, uA, clamp(y, 0.0, 1.0)) : mix(uA, uB, smoothstep(0.7, 1.0, l)));
    return c * l * uGain; }
  vec3 hsv(float h){ return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }`;

// shared fragment effects (v1's ten, in frame coordinates)
const FX_FRAG = /* glsl */`
  uniform float uSweep, uSweepW;
  vec3 effects(vec3 col, float vI, float vS, float vR, vec2 fp, float bg){
    float T = uTime * uFxSpeed, A = uFxAmt, fig = 1.0 - bg, add = 0.0, mul = 1.0;
    if (uFx[0] > 0.5) add += A * pow(max(0.0, sin(T * 5.0 + vR * 700.0 + vS * 40.0)), 40.0) * 3.0;
    if (uFx[1] > 0.5) { float p = mod(T * 0.22, 1.4) - 0.2; add += A * exp(-pow(((1.0 - fp.y) - p) / 0.025, 2.0)) * 2.0; }
    if (uFx[2] > 0.5) { float d = length((fp - vec2(0.5, 0.6)) * vec2(uAspect, 1.0)), r = mod(T * 0.3, 1.2); add += A * exp(-pow((d - r) / 0.018, 2.0)) * 2.0 * (1.0 - r / 1.2); }
    if (uFx[3] > 0.5) { float b = fract(T / 1.1); mul *= 1.0 + A * fig * (1.2 * exp(-pow((b - 0.05) / 0.035, 2.0)) + 0.8 * exp(-pow((b - 0.24) / 0.035, 2.0))); }
    if (uFx[6] > 0.5) mul *= mix(1.0, step(0.45, fract((vS - T * 0.075) / 0.015)) * 1.6, clamp(A, 0.0, 1.0));
    if (uFx[7] > 0.5) { float k = floor(T * 14.0), off = step(0.9, h1(vR * 977.0 + k)), glob = step(0.97, h1(k * 1.7)); mul *= 1.0 - min(1.0, A) * 0.9 * max(off, glob * 0.7); }
    if (uFx[8] > 0.5) { float L = dot(col, vec3(0.3, 0.59, 0.11)); col = mix(col, hsv(fract((1.0 - fp.y) * 0.7 + fp.x * 0.3 - T * 0.08)) * L * 1.5, clamp(A * 0.8, 0.0, 1.0)); }
    if (uFx[9] > 0.5) { float p = mod(T * 0.28, 1.8) - 0.4; add += A * exp(-pow(((fp.x * 0.6 + (1.0 - fp.y) * 0.4) - p) / 0.03, 2.0)) * 2.5; }
    if (uSweep > -5.0) add += exp(-pow(((fp.x * 0.6 + (1.0 - fp.y) * 0.4) - uSweep) / uSweepW, 2.0)) * 2.6 * fig;
    return col * mul + mix(uA, vec3(1.0), 0.55) * add * max(vI, 0.15) * uGain;
  }`;

const LINE_VS = /* glsl */`${COMMON}
  attribute vec4 aA, aB, aIW, aK, aP, aU; attribute vec2 aS;
  uniform vec2 uRes; uniform float uWidth, uPulse, uPSpeed, uBreathe;
  varying float vI, vAcross, vAlong, vLen, vHalf, vS, vR, vBg, vBoost, vA, vEF, vC; varying vec2 vFP;
  void main(){
    float bg = aU.w, seed = aU.z;
    float me = bg > 0.5 ? 1.0 : easeF(stag(uMorph, orderKey(uMorphOrder, aK) * 0.6 + aK.z * 0.4, uMorphSt), uMorphEase);
    vec2 p0 = mix(aA.xy, aB.xy, me), p1 = mix(aA.zw, aB.zw, me), mid = (p0 + p1) * 0.5;
    if (bg < 0.5 && me > 0.0 && me < 1.0) {   // morph in arcs: each piece bows sideways and toward the camera mid-flight
      vec2 dd = aB.xy - aA.xy; vec2 n = vec2(-dd.y, dd.x);
      vec2 off = n * uSwirl * (h1(seed * 2.3) - 0.5) * 2.0 * sin(3.14159 * me); p0 += off; p1 += off; mid += off; }
    float inten = mix(aIW.x, aIW.y, me), wid = mix(aIW.z, aIW.w, me);
    Tr r = transition(mid, mid, aK, aP, seed, aU.x, aU.y, bg);
    float morphCol = bg > 0.5 ? 0.0 : 0.5 * sin(3.14159 * me);
    float c = clamp(max(r.col, morphCol), 0.0, 1.0);
    vec2 a = mix(p0, p1, r.trimA), b = mix(p0, p1, r.trimB);
    vec2 cm = (a + b) * 0.5; a = mix(a, cm, c); b = mix(b, cm, c);
    vec3 wa = vec3(fxPos(a, bg), 0.0) + vec3(r.p.xy - mid, r.p.z), wb = vec3(fxPos(b, bg), 0.0) + vec3(r.p.xy - mid, r.p.z);
    vec4 ca = projectionMatrix * modelViewMatrix * vec4(wa, 1.0), cb = projectionMatrix * modelViewMatrix * vec4(wb, 1.0);
    vec2 sa = ca.xy / ca.w * 0.5 * uRes, sb = cb.xy / cb.w * 0.5 * uRes, d = sb - sa;
    float L = length(d); vec2 t = L > 1e-4 ? d / L : vec2(1.0, 0.0), n = vec2(-t.y, t.x);
    float pxPerUnit = 0.5 * uRes.y * projectionMatrix[1][1] / max(mix(ca.w, cb.w, 0.5), 1e-3);
    float half_ = max(0.7, wid * uWidth * pxPerUnit * 0.5 * (1.0 + 0.7 * c) + 0.45);
    float along = mix(-half_ - 1.0, L + half_ + 1.0, position.x);
    // a collapsed piece is a particle: it carries only as much light as the line length it stands for (no hot spots where pieces pile up)
    float Lrest = length(p1 - p0) * pxPerUnit;
    float spark = 0.3 + 0.7 * step(0.7, h1(seed * 9.1));
    vEF = mix(spark, clamp(Lrest / (2.0 * half_), 0.04, 1.0), mix(r.near, 1.0, step(0.001, morphCol))); vC = c;
    vec4 cc = mix(ca, cb, clamp(along / max(L, 1e-4), 0.0, 1.0));
    vec2 sp = sa + t * along + n * position.y * (half_ + 1.0);
    cc.xy = sp / (0.5 * uRes) * cc.w;
    gl_Position = (ca.w <= 0.0 || cb.w <= 0.0 || r.a <= 0.0) ? vec4(0.0, 0.0, -2.0, 1.0) : cc;
    vAlong = along; vLen = L; vAcross = position.y * (half_ + 1.0); vHalf = half_;
    vI = inten * (bg > 0.5 ? uBgGain : 1.0) * (1.0 + uBreathe * 0.25 * sin(uTime * 1.3 + mid.y * 18.0 + mid.x * 7.0));
    vBoost = r.boost + 0.15 * morphCol; vA = r.a; vBg = bg; vR = aK.z;
    vS = mix(aS.x, aS.y, position.x);
    vFP = cc.xy / cc.w * 0.5 + 0.5;
  }`;
const LINE_FS = /* glsl */`${COMMON}${COLOR}${FX_FRAG}
  uniform float uPulse, uPSpeed;
  varying float vI, vAcross, vAlong, vLen, vHalf, vS, vR, vBg, vBoost, vA, vEF, vC; varying vec2 vFP;
  void main(){
    // collapsing pieces (shorter than the line is wide) are round particles; longer ones get an exact 1-px box filter along their
    // length, so the pieces of one line add up to exactly one line however finely it was cut (no beads at the joints)
    float capped = (vC > 0.02 && vLen < vHalf * 2.0) ? 1.0 : 0.0, cov;
    if (capped > 0.5) { float dx = max(0.0, max(-vAlong, vAlong - vLen)); cov = (1.0 - smoothstep(vHalf - 0.6, vHalf + 0.6, length(vec2(dx, vAcross)))) * vEF; }
    else cov = (1.0 - smoothstep(vHalf - 0.6, vHalf + 0.6, abs(vAcross))) * clamp(min(vAlong + 0.5, vLen) - max(vAlong - 0.5, 0.0), 0.0, 1.0);
    float band; float m = wipeMask(vFP, band);
    if (cov * m * vA <= 0.001 && band <= 0.001) discard;
    float pulse = uPulse * pow(max(0.0, sin((vS - uTime * 0.085 * uPSpeed) * 22.0)), 24.0) * 2.5;
    vec3 c = tint(vI, vFP.y) * (1.0 + pulse + vBoost) + uB * pulse * 0.35 * vI;
    c = effects(c, vI, vS, vR, vFP, vBg);
    c += mix(uA, vec3(1.0), 0.6) * band * max(vI, 0.25) * uGain * (1.0 - vBg) * vA;
    gl_FragColor = vec4(c * cov * m * vA, 1.0);
  }`;

const DOT_VS = /* glsl */`${COMMON}
  attribute vec2 pA, pB; attribute vec4 pIR, pK; attribute float pBg;
  uniform vec2 uRes; uniform float uDotSize, uDots;
  varying float vI, vA, vR, vBg, vBoost; varying vec2 vFP;
  void main(){
    float seed = pIR.w, bg = pBg;
    float me = bg > 0.5 ? 1.0 : easeF(stag(uMorph, orderKey(uMorphOrder, pK) * 0.6 + pK.z * 0.4, uMorphSt), uMorphEase);
    vec2 home = mix(pA, pB, me);
    if (bg > 0.5) home += vec2(sin(uTime * 0.13 + seed * 40.0), cos(uTime * 0.11 + seed * 31.0)) * 0.03 + vec2(0.0, mod(uTime * 0.012 + seed, 1.0) - 0.5) * 0.0;
    Tr r = transition(home, home, pK, pK, seed, pK.z * 0.9, pK.z * 0.9 + 0.1, bg);
    if (uInType > 0.5 && uInType < 1.5 && uInP < 1.0) { float q = easeF(stag(uInP, orderKey(uInOrder, pK), uInSt), uInEase); r.a = smoothstep(pK.z * 0.9, pK.z * 0.9 + 0.1, q); }
    if (uOutType > 0.5 && uOutType < 1.5 && uOutP > 0.0) { float q = easeF(stag(uOutP, orderKey(uOutOrder, pK), uOutSt), uOutEase); r.a *= 1.0 - smoothstep(pK.z * 0.9, pK.z * 0.9 + 0.1, q); }
    vec3 w = vec3(fxPos(home, bg), 0.0) + vec3(r.p.xy - home, r.p.z);
    vec4 c = projectionMatrix * modelViewMatrix * vec4(w, 1.0); gl_Position = r.a <= 0.0 ? vec4(0.0, 0.0, -2.0, 1.0) : c;
    float tw = 0.65 + 0.35 * sin(uTime * (1.0 + 2.0 * h1(seed)) + seed * 60.0);
    vI = mix(pIR.x, pIR.y, me) * tw * (bg > 0.5 ? 0.5 : 1.0); vA = r.a * uDots; vR = pIR.z; vBg = bg; vBoost = r.boost + 0.2 * sin(3.14159 * me) * (1.0 - bg);
    gl_PointSize = max(1.0, pIR.z * uDotSize * uRes.y / 1920.0 * ${DIST.toFixed(5)} / max(c.w, 1e-3) + 1.0);
    vFP = c.xy / c.w * 0.5 + 0.5;
  }`;
const DOT_FS = /* glsl */`${COMMON}${COLOR}${FX_FRAG}
  varying float vI, vA, vR, vBg, vBoost; varying vec2 vFP;
  void main(){
    float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard;
    float band; float m = wipeMask(vFP, band);
    vec3 c = tint(vI, vFP.y) * (1.0 + vBoost + band * 0.6);
    c = effects(c, vI, 0.0, vR, vFP, vBg);
    gl_FragColor = vec4(c * (1.0 - r * r) * vA * m, 1.0);
  }`;

// post: bloom chain + composite (glitch slices, chroma split, flash, background or straight alpha)
const QUAD_VS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const DOWN_FS = /* glsl */`uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
  void main(){ vec2 o = uTexel; gl_FragColor = 0.25 * (texture2D(tSrc, vUv + vec2(-o.x, -o.y)) + texture2D(tSrc, vUv + vec2(o.x, -o.y)) + texture2D(tSrc, vUv + vec2(-o.x, o.y)) + texture2D(tSrc, vUv + vec2(o.x, o.y))); }`;
const BLUR_FS = /* glsl */`uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;
  void main(){ vec4 s = texture2D(tSrc, vUv) * 0.2270270;
    s += (texture2D(tSrc, vUv + uDir * 1.3846153) + texture2D(tSrc, vUv - uDir * 1.3846153)) * 0.3162162;
    s += (texture2D(tSrc, vUv + uDir * 3.2307692) + texture2D(tSrc, vUv - uDir * 3.2307692)) * 0.0702702; gl_FragColor = s; }`;
const COMP_FS = /* glsl */`uniform sampler2D tScene, tB0, tB1, tB2, tB3, tB4; uniform float uGlow, uGlitch, uChroma, uFlash, uTransparent, uTime, uFade; uniform vec3 uBg, uFlashCol; varying vec2 vUv;
  float h1(float n){ return fract(sin(n) * 43758.5453123); }
  vec3 enc(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  vec3 S(vec2 uv){ vec3 c = texture2D(tScene, uv).rgb; vec3 b = texture2D(tB0, uv).rgb * 0.5 + texture2D(tB1, uv).rgb * 0.45 + texture2D(tB2, uv).rgb * 0.4 + texture2D(tB3, uv).rgb * 0.35 + texture2D(tB4, uv).rgb * 0.3; return c + b * uGlow; }
  void main(){
    vec2 uv = vUv;
    if (uGlitch > 0.0) { float sl = floor(uv.y * 38.0), k = floor(uTime * 20.0), g = step(1.0 - 0.45 * uGlitch, h1(sl * 3.1 + k * 7.7)); uv.x += g * (h1(sl * 1.7 + k) - 0.5) * 0.12 * uGlitch; }
    vec3 c = uChroma > 0.0 ? vec3(S(uv + vec2(uChroma, 0.0)).r, S(uv).g, S(uv - vec2(uChroma, 0.0)).b) : S(uv);
    c = c * (1.0 + uFlash * 0.9) + uFlashCol * uFlash * 0.18 * smoothstep(0.0, 0.25, dot(c, vec3(0.33)));
    c *= uFade;
    if (uTransparent > 0.5) { c = enc(clamp(c, 0.0, 1.0)); float a = max(c.r, max(c.g, c.b)); gl_FragColor = vec4(a > 1e-4 ? c / a : vec3(0.0), a); }
    else gl_FragColor = vec4(enc(clamp(uBg + c, 0.0, 1.0)), 1.0);
  }`;

// ---------------------------------------------------------------- engine
export async function createEngine({ canvas, width = 1080, height = 1920, assetBase = './', sceneBase = './', pixelRatio = 1 } = {}) {
  // light adds up in linear space (hex colours are converted to linear), the composite encodes to sRGB — the v1 look
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(pixelRatio);
  renderer.autoClear = false;
  const scene3 = new THREE.Scene(), group = new THREE.Group(); scene3.add(group);
  const camera = new THREE.PerspectiveCamera(FOV, width / height, 0.01, 100);
  const U = {
    uTime: { value: 0 }, uAspect: { value: width / height }, uRes: { value: new THREE.Vector2(width, height) },
    uMorph: { value: 1 }, uMorphSt: { value: 0.5 }, uMorphEase: { value: 2 }, uSwirl: { value: 0.25 }, uMorphOrder: { value: 3 },
    uInType: { value: 0 }, uInP: { value: 1 }, uInEase: { value: 1 }, uInSt: { value: 0 }, uInOrder: { value: 0 }, uInStyle: { value: 0 }, uInSpread: { value: 1 }, uInDir: { value: new THREE.Vector2(1, 0) },
    uOutType: { value: 0 }, uOutP: { value: 0 }, uOutEase: { value: 4 }, uOutSt: { value: 0 }, uOutOrder: { value: 0 }, uOutStyle: { value: 1 }, uOutSpread: { value: 1 }, uOutDir: { value: new THREE.Vector2(1, 0) },
    uFx: { value: new Array(10).fill(0) }, uFxAmt: { value: 1 }, uFxSpeed: { value: 1 }, uBgGain: { value: 0.6 }, uWave: { value: 1 }, uYaw: { value: 0 },
    uA: { value: new THREE.Color(1, 1, 1) }, uB: { value: new THREE.Color(1, 1, 1) }, uMode: { value: 0 }, uGain: { value: 1 }, uGamma: { value: 1 },
    uWidth: { value: 1.6 / 1920 }, uPulse: { value: 0 }, uPSpeed: { value: 1 }, uBreathe: { value: 0 }, uDotSize: { value: 2.2 }, uDots: { value: 1 },
    uSweep: { value: -10 }, uSweepW: { value: 0.06 }, uSize: { value: 0.5 },
  };
  const lineMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: LINE_VS, fragmentShader: LINE_FS, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const dotMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: DOT_VS, fragmentShader: DOT_FS, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
  for (const m of [lineMat, dotMat]) { m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; }

  // post chain
  const rtOpt = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
  let rtScene, levels = [];
  const quadGeo = new THREE.PlaneGeometry(2, 2), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), quad = new THREE.Mesh(quadGeo), quadScene = new THREE.Scene(); quadScene.add(quad);
  const downMat = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, vertexShader: QUAD_VS, fragmentShader: DOWN_FS, depthTest: false, depthWrite: false });
  const blurMat = new THREE.ShaderMaterial({ uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } }, vertexShader: QUAD_VS, fragmentShader: BLUR_FS, depthTest: false, depthWrite: false });
  const compU = { tScene: { value: null }, tB0: { value: null }, tB1: { value: null }, tB2: { value: null }, tB3: { value: null }, tB4: { value: null }, uGlow: { value: 0.6 }, uGlitch: { value: 0 }, uChroma: { value: 0 }, uFlash: { value: 0 }, uFlashCol: { value: new THREE.Color(1, 1, 1) }, uTransparent: { value: 0 }, uTime: { value: 0 }, uFade: { value: 1 }, uBg: { value: new THREE.Color(0, 0, 0) } };
  const compMat = new THREE.ShaderMaterial({ uniforms: compU, vertexShader: QUAD_VS, fragmentShader: COMP_FS, depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending });
  let W = width, H = height;
  function setSize(w, h) {
    W = w; H = h; renderer.setSize(w, h, false); const pw = Math.round(w * pixelRatio), ph = Math.round(h * pixelRatio);
    rtScene?.dispose(); levels.forEach((l) => { l.a.dispose(); l.b.dispose(); });
    rtScene = new THREE.WebGLRenderTarget(pw, ph, rtOpt); levels = [];
    let lw = pw, lh = ph;
    for (let k = 0; k < 5; k++) { lw = Math.max(2, Math.round(lw / 2)); lh = Math.max(2, Math.round(lh / 2)); levels.push({ a: new THREE.WebGLRenderTarget(lw, lh, rtOpt), b: new THREE.WebGLRenderTarget(lw, lh, rtOpt), w: lw, h: lh }); }
    U.uRes.value.set(pw, ph); U.uAspect.value = w / h; camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  setSize(width, height);
  const pass = (mat, target) => { quad.material = mat; renderer.setRenderTarget(target); renderer.clear(); renderer.render(quadScene, quadCam); };

  // ---------------- assets
  const rel = (p) => (/^(https?:|data:|blob:|\/)/.test(p) ? p : sceneBase.replace(/\/?$/, '/') + p);
  const vendor = assetBase.replace(/\/?$/, '/') + 'vendor/harfbuzz/';
  const fontDefault = assetBase.replace(/\/?$/, '/') + 'fonts/IBMPlexSansArabic-Bold.ttf';
  async function loadInput(inp) {
    if (inp.shape) return inp.shape;
    if (inp.baked || inp.portrait || inp.image) return loadBaked(rel(inp.baked || inp.portrait || inp.image), { fade: inp.fade ?? true });
    if (inp.svg) { const txt = inp.svg.trim().startsWith('<') ? inp.svg : await (await fetch(rel(inp.svg))).text(); return svgToShape(txt, inp); }
    if (inp.png || inp.icon) return bitmapToShape(rel(inp.png || inp.icon), inp);
    if (inp.text != null) return textToShape(inp.text, inp.font ? rel(inp.font) : fontDefault, vendor, inp);
    throw new Error('unknown input: ' + JSON.stringify(inp).slice(0, 120));
  }

  // fit a shape into the frame: world units, frame height = 1, y up
  function fitInfo(shape, sh) {
    const bb = shape.bbox, bw = Math.max(1e-6, bb.x1 - bb.x0), bh = Math.max(1e-6, bb.y1 - bb.y0), aspect = W / H;
    const s = sh.fit * Math.min(aspect / bw, 1 / bh), cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
    return { s, cx, cy, bb, bw, bh, px: sh.pos[0], py: sh.pos[1] };
  }

  let spec = null, shapes = [], cache = new Map(), current = null, backdropMesh = null, dustPts = null;

  function buildShot(k) {
    if (cache.has(k)) return cache.get(k);
    const sh = spec.shots[k], S = spec.strokes, M = spec.points, D = spec.dots;
    const B = shapes[k], fb = fitInfo(B.shape, sh), rb = B.rs;
    const isMorph = sh.in.type === 'morph';
    let ra = rb, fa = fb, dA = B.ds;
    let pairB = null;
    if (isMorph) {   // pair every stroke of the previous shape with one of this shape, neighbours with neighbours
      const P = shapes[k - 1], ps = spec.shots[k - 1]; ra = P.rs; fa = fitInfo(P.shape, ps); dA = P.ds;
      const keyOf = (r, f) => { const ks = new Float64Array(S); for (let s = 0; s < S; s++) { const x = ((r.info.cx[s] - f.cx) * f.s + f.px) / (W / H) + 0.5, y = 0.5 - ((f.cy - r.info.cy[s]) * f.s + f.py); ks[s] = hilbert(x, y, 12) + (r.info.len[s] === 0 ? 1e9 : 0); } return ks; };
      const ka = keyOf(ra, fa), kb = keyOf(rb, fb);
      const ia = Array.from({ length: S }, (_, i) => i).sort((x, y) => ka[x] - ka[y]), ib = Array.from({ length: S }, (_, i) => i).sort((x, y) => kb[x] - kb[y]);
      pairB = new Int32Array(S); for (let j = 0; j < S; j++) pairB[ia[j]] = ib[j];
    }
    const NSeg = S * (M - 1);
    const aP = new Float32Array(NSeg * 4), aA = new Float32Array(NSeg * 4), aB = new Float32Array(NSeg * 4), aIW = new Float32Array(NSeg * 4), aK = new Float32Array(NSeg * 4), aU = new Float32Array(NSeg * 4), aS = new Float32Array(NSeg * 2);
    const wx = (f, x) => (x - f.cx) * f.s + f.px, wy = (f, y) => (f.cy - y) * f.s + f.py;
    let g = 0;
    for (let s = 0; s < S; s++) {
      const sb = pairB ? pairB[s] : s;
      // flip the target stroke if that makes the trip shorter (lines do not cross themselves mid-morph)
      let flip = false;
      if (pairB) { const a0 = s * M, a1 = s * M + M - 1, b0 = sb * M, b1 = sb * M + M - 1;
        const d = (ia, ib) => Math.hypot(wx(fa, ra.X[ia]) - wx(fb, rb.X[ib]), wy(fa, ra.Y[ia]) - wy(fb, rb.Y[ib]));
        flip = d(a0, b1) + d(a1, b0) < d(a0, b0) + d(a1, b1); }
      const kx = (rb.info.cx[sb] - fb.bb.x0) / fb.bw, ky = (rb.info.cy[sb] - fb.bb.y0) / fb.bh, kr = hash(s * 7 + 13), ksrc = rb.info.src[sb];
      const pkx = (rb.info.pcx[sb] - fb.bb.x0) / fb.bw, pky = (rb.info.pcy[sb] - fb.bb.y0) / fb.bh, pkr = hash(Math.round(rb.info.psrc[sb] * 1e6) + 5), pu0 = rb.info.pu0[sb], pu1 = rb.info.pu1[sb];
      let arc = hash(s + 991) * 3;
      for (let m = 0; m + 1 < M; m++, g++) {
        const ia0 = s * M + m, ia1 = ia0 + 1, mb0 = flip ? M - 1 - m : m, mb1 = flip ? M - 2 - m : m + 1, ib0 = sb * M + mb0, ib1 = sb * M + mb1;
        aA.set([wx(fa, ra.X[ia0]), wy(fa, ra.Y[ia0]), wx(fa, ra.X[ia1]), wy(fa, ra.Y[ia1])], g * 4);
        aB.set([wx(fb, rb.X[ib0]), wy(fb, rb.Y[ib0]), wx(fb, rb.X[ib1]), wy(fb, rb.Y[ib1])], g * 4);
        aIW.set([(ra.I[ia0] + ra.I[ia1]) / 2, (rb.I[ib0] + rb.I[ib1]) / 2, (ra.W[ia0] + ra.W[ia1]) / 2, (rb.W[ib0] + rb.W[ib1]) / 2], g * 4);
        aK.set([kx, ky, kr, ksrc], g * 4);
        aP.set([pkx, pky, pkr, rb.info.psrc[sb]], g * 4);
        aU.set([pu0 + (pu1 - pu0) * m / (M - 1), pu0 + (pu1 - pu0) * (m + 1) / (M - 1), hash(g * 3 + 1) * 100, 0], g * 4);
        const segL = Math.hypot(aB[g * 4 + 2] - aB[g * 4], aB[g * 4 + 3] - aB[g * 4 + 1]);
        aS.set([arc, arc + segL], g * 2); arc += segL;
      }
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3)); geo.setIndex([0, 1, 2, 0, 2, 3]);
    for (const [n, arr, sz] of [['aA', aA, 4], ['aB', aB, 4], ['aIW', aIW, 4], ['aK', aK, 4], ['aP', aP, 4], ['aU', aU, 4], ['aS', aS, 2]]) geo.setAttribute(n, new THREE.InstancedBufferAttribute(arr, sz));
    geo.instanceCount = NSeg;
    const lines = new THREE.Mesh(geo, lineMat); lines.frustumCulled = false;
    // particles
    const dB = B.ds, pA = new Float32Array(D * 2), pB = new Float32Array(D * 2), pIR = new Float32Array(D * 4), pK = new Float32Array(D * 4), pBg = new Float32Array(D);
    let dpair = null;
    if (isMorph) { const kd = (d, f) => Array.from({ length: D }, (_, i) => i).map((i) => [i, hilbert(((d.x[i] - f.cx) * f.s + f.px) / (W / H) + 0.5, 0.5 - ((f.cy - d.y[i]) * f.s + f.py), 12)]).sort((x, y) => x[1] - y[1]).map((x) => x[0]);
      const ia = kd(dA, fa), ib = kd(dB, fb); dpair = new Int32Array(D); for (let j = 0; j < D; j++) dpair[ia[j]] = ib[j]; }
    for (let i = 0; i < D; i++) {
      const j = dpair ? dpair[i] : i;
      pA.set([wx(fa, dA.x[i]), wy(fa, dA.y[i])], i * 2); pB.set([wx(fb, dB.x[j]), wy(fb, dB.y[j])], i * 2);
      pIR.set([dA.i[i], dB.i[j], dB.r[j], hash(i + 5) * 100], i * 4);
      pK.set([(dB.x[j] - fb.bb.x0) / fb.bw, (dB.y[j] - fb.bb.y0) / fb.bh, hash(i * 3 + 2), hash(i * 11 + 7)], i * 4);
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(D * 3), 3));
    for (const [n, arr, sz] of [['pA', pA, 2], ['pB', pB, 2], ['pIR', pIR, 4], ['pK', pK, 4], ['pBg', pBg, 1]]) dg.setAttribute(n, new THREE.BufferAttribute(arr, sz));
    const dots = new THREE.Points(dg, dotMat); dots.frustumCulled = false;
    const obj = { lines, dots, dispose() { geo.dispose(); dg.dispose(); } };
    cache.set(k, obj);
    if (cache.size > 3) { const first = cache.keys().next().value; if (first !== k) { cache.get(first).dispose(); cache.delete(first); } }
    return obj;
  }

  function buildBackdrop() {   // v1's wave sheet (optional): long gentle waves across the whole frame, behind everything
    if (backdropMesh) { scene3.remove(backdropMesh); backdropMesh.geometry.dispose(); backdropMesh = null; }
    if (dustPts) { scene3.remove(dustPts); dustPts.geometry.dispose(); dustPts = null; }
    const asp = W / H;
    if (spec.backdrop > 0) {
      const segs = []; const SP = 1 / 115, X0 = -asp * 0.8, X1 = asp * 0.8, STEP = 0.004;
      const wave = (x, y0) => 0.022 * Math.sin(x * 3.9 + y0 * 5.3 + 0.6) + 0.012 * Math.sin(x * 8.8 - y0 * 8.6 + 2.1) + 0.006 * Math.sin(x * 17.4 + y0 * 11);
      for (let k = 0, y0 = -0.65; y0 < 0.65; y0 += SP, k++) { const gain = (0.12 + 0.09 * hash(k + 3)) * spec.backdrop; let prev = null;
        for (let x = X0; x < X1; x += STEP) { const y = y0 + wave(x, y0); if (prev) segs.push([prev[0], prev[1], x, y, gain]); prev = [x, y]; } }
      const n = segs.length, aA = new Float32Array(n * 4), aIW = new Float32Array(n * 4), aK = new Float32Array(n * 4), aU = new Float32Array(n * 4), aS = new Float32Array(n * 2);
      segs.forEach((s, i) => { aA.set(s.slice(0, 4), i * 4); aIW.set([s[4], s[4], 0.8, 0.8], i * 4); aK.set([0.5, 0.5, hash(i), 0], i * 4); aU.set([0, 1, hash(i) * 100, 1], i * 4); aS.set([i * STEP, (i + 1) * STEP], i * 2); });
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3)); geo.setIndex([0, 1, 2, 0, 2, 3]);
      for (const [nm, arr, sz] of [['aA', aA, 4], ['aB', aA, 4], ['aIW', aIW, 4], ['aK', aK, 4], ['aP', aK, 4], ['aU', aU, 4], ['aS', aS, 2]]) geo.setAttribute(nm, new THREE.InstancedBufferAttribute(arr, sz));
      geo.instanceCount = n; backdropMesh = new THREE.Mesh(geo, lineMat); backdropMesh.frustumCulled = false; backdropMesh.renderOrder = -1;
      scene3.add(backdropMesh);   // stays in the scene, not the group: the camera's yaw turns the figure, not the backdrop
    }
    if (spec.dust > 0) {
      const n = Math.round(1500 * spec.dust), R = rng(77), pA = new Float32Array(n * 2), pIR = new Float32Array(n * 4), pK = new Float32Array(n * 4), pBg = new Float32Array(n).fill(1);
      for (let i = 0; i < n; i++) { pA.set([(R() - 0.5) * asp * 1.2, (R() - 0.5) * 1.2], i * 2); pIR.set([0.25 + 0.5 * R(), 0.25 + 0.5 * R(), 0.4 + R() * R() * 1.2, R() * 100], i * 4); pK.set([0.5, 0.5, R(), 0], i * 4); }
      const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      for (const [nm, arr, sz] of [['pA', pA, 2], ['pB', pA, 2], ['pIR', pIR, 4], ['pK', pK, 4], ['pBg', pBg, 1]]) dg.setAttribute(nm, new THREE.BufferAttribute(arr, sz));
      dustPts = new THREE.Points(dg, dotMat); dustPts.frustumCulled = false; scene3.add(dustPts);
    }
  }

  async function load(s) {
    spec = normalize(s);
    if (spec.width !== W || spec.height !== H) setSize(spec.width, spec.height);
    cache.forEach((c) => c.dispose()); cache = new Map(); current = null; group.clear();
    const loaded = new Map();   // the same input used twice is loaded once
    shapes = [];
    for (const sh of spec.shots) {
      const key = JSON.stringify(sh.input);
      if (!loaded.has(key)) { const shape = await loadInput(sh.input); loaded.set(key, { shape, rs: resample(shape, spec.strokes, spec.points), ds: resampleDots(shape, spec.dots) }); }
      shapes.push(loaded.get(key));
    }
    buildBackdrop();
    return { duration: spec.duration, frames: spec.frames, fps: spec.fps, width: W, height: H };
  }

  function setUniforms(st) {
    const sh = st.shot, L = st.look;
    const setTr = (pre, t, isIn, p) => {
      const T = isIn ? IN_TYPES : OUT_TYPES;
      U[`u${pre}Type`].value = T[t.type] ?? 0; U[`u${pre}P`].value = p; U[`u${pre}Ease`].value = EASE_ID[t.ease] ?? 1; U[`u${pre}St`].value = t.stagger ?? 0;
      U[`u${pre}Order`].value = ORDER[t.order || sh.order || shapes[sh.index].shape.order] ?? 0;
      U[`u${pre}Style`].value = SCATTER[t.style] ?? 0; U[`u${pre}Spread`].value = t.spread ?? 1;
      const d = WIPE_DIR[t.dir || 'ltr'] || [1, 0]; U[`u${pre}Dir`].value.set(d[0], d[1]);
    };
    // the wind / explode order: wind blows pieces away downwind-first
    const tin = { ...sh.in }, tout = { ...sh.out };
    if (tin.type === 'assemble' || tin.type === 'sting') tin.order ||= tin.style === 'wind' ? 'ltr' : tin.style === 'explode' ? 'center' : 'random';
    if (tout.type === 'disperse') tout.order ||= tout.style === 'wind' ? 'rtl' : tout.style === 'explode' ? 'outside' : 'random';
    setTr('In', tin, true, st.inP); setTr('Out', tout, false, st.outP);
    U.uMorph.value = st.morph; U.uMorphSt.value = sh.in.type === 'morph' ? (sh.in.stagger ?? 0.5) : 0; U.uMorphEase.value = EASE_ID[sh.in.ease] ?? 2; U.uSwirl.value = sh.in.swirl ?? 0.25;
    U.uMorphOrder.value = ORDER[sh.in.type === 'morph' ? (sh.in.order || 'center') : 'center'];
    const a = col(L.a), b = col(L.b);
    if (L.lookMix != null && L.lookMix < 1) { a.lerpColors(col(L.aPrev), col(L.a), L.lookMix); b.lerpColors(col(L.bPrev), col(L.b), L.lookMix); U.uMode.value = L.lookMix < 0.5 ? L.modePrev : L.mode; }
    else U.uMode.value = L.mode;
    U.uA.value.copy(a); U.uB.value.copy(b); U.uGain.value = L.gain; U.uGamma.value = L.gamma;
    U.uWidth.value = L.width / 1920; U.uPulse.value = L.pulse; U.uPSpeed.value = L.pulseSpeed; U.uBreathe.value = L.breathe; U.uDots.value = L.dots; U.uDotSize.value = L.dotSize;
    for (let i = 0; i < 10; i++) U.uFx.value[i] = sh.fx.includes(i) ? 1 : 0; U.uFxAmt.value = sh.fxAmount; U.uFxSpeed.value = sh.fxSpeed;
    U.uBgGain.value = 1; U.uWave.value = spec.wave ?? 1;
    { const f = fitInfo(shapes[sh.index].shape, sh); U.uSize.value = Math.max(f.bw, f.bh) * f.s; }
    U.uSweep.value = st.sweep; U.uSweepW.value = st.sweepWidth;
    compU.uGlow.value = L.glow; compU.uGlitch.value = st.glitch; compU.uChroma.value = st.chroma; compU.uFlash.value = st.flash; compU.uFlashCol.value.copy(a).lerp(new THREE.Color(1, 1, 1), 0.5);
    compU.uTransparent.value = spec.transparent ? 1 : 0; compU.uBg.value.copy(col(spec.transparent ? '#000000' : (spec.background === 'look' ? L.bg : spec.background))); compU.uFade.value = st.fade;
  }

  function renderTime(t) {
    if (!spec) throw new Error('load a scene first');
    const st = stateAt(spec, t);
    const obj = buildShot(st.index);
    if (current !== obj) { group.clear(); group.add(obj.lines, obj.dots); current = obj; }
    U.uTime.value = t; compU.uTime.value = t;
    setUniforms(st);
    // camera
    camera.position.set(st.pan[0], st.pan[1], DIST / Math.max(0.05, st.zoom)); camera.rotation.set(0, 0, st.roll * Math.PI / 180);
    group.rotation.set(st.pitch * Math.PI / 180, st.yaw * Math.PI / 180, 0); group.scale.setScalar(st.scale);
    camera.updateMatrixWorld();
    // scene → HDR target → bloom chain → composite
    renderer.setRenderTarget(rtScene); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene3, camera);
    let src = rtScene;
    for (const l of levels) {
      downMat.uniforms.tSrc.value = src.texture; downMat.uniforms.uTexel.value.set(0.5 / l.w, 0.5 / l.h); pass(downMat, l.a);
      blurMat.uniforms.tSrc.value = l.a.texture; blurMat.uniforms.uDir.value.set(1 / l.w, 0); pass(blurMat, l.b);
      blurMat.uniforms.tSrc.value = l.b.texture; blurMat.uniforms.uDir.value.set(0, 1 / l.h); pass(blurMat, l.a);
      src = l.a;
    }
    compU.tScene.value = rtScene.texture; levels.forEach((l, i) => (compU[`tB${i}`].value = l.a.texture));
    quad.material = compMat; renderer.setRenderTarget(null); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(quadScene, quadCam);
    return st;
  }
  const renderFrame = (n) => renderTime(n / spec.fps);
  function readPixels() {   // straight RGBA, rows bottom-up (WebGL order)
    const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf); return { w, h, buf };
  }
  return {
    load, renderTime, renderFrame, readPixels, setSize, renderer, uniforms: U, _debug: { scene3, camera, group, compU, get levels() { return levels; } },
    get spec() { return spec; }, get shapes() { return shapes; },
    dispose() { cache.forEach((c) => c.dispose()); renderer.dispose(); renderer.forceContextLoss(); },   // free the GL context now (browsers cap live contexts)
  };
}
