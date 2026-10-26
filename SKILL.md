---
name: claude-line-portrait
version: 2
description: Line + particle motion engine. Turns portraits, photos of objects/products, SVG icons and logos, PNG icons and any text (Arabic RTL included) into glowing light lines and particles, with transitions (draw on/off, assemble/disperse as dust, shards, wind or vortex, morph A→B, wipe, light sweep, glitch, logo sting) and frame-exact output — MP4, or transparent ProRes 4444 .mov / WebM / PNG sequence for After Effects, Premiere, CapCut and Remotion. Driven headless from a JSON scene file, as a Remotion component, or from a studio page. Use for line portraits, "made of light" / neon / hologram looks, logo stings, animated text reveals, icon animations, particle transitions and morphs, and any "turn this into lines/particles" request for reels, stories or motion timelines.
---

# Claude Line Portrait v2 — a line + particle motion engine

Anything goes in: a face, a product photo, an SVG logo, a PNG icon, a line of text in any font. It comes out as light lines and particles that draw, assemble, explode, blow away, glitch and morph into each other. Output is a frame-exact video, with or without a transparent background.

## Four input types
| Input | Scene key | How it becomes lines |
|---|---|---|
| **Portrait** | `{ "portrait": "data/<name>" }` | v1 path, best quality. Image model → cinematic portrait (`prompts/01`) → line art (`prompts/02`) → `scripts/flowlines.py lineart.png studio/data/<name>`. |
| **Photo of an object / product** | `{ "image": "data/<name>" }` | `scripts/image2lines.py photo.png studio/data/<name>`. Flow lines come from edges and light, and the subject is cut out (PNG alpha or border colour). No image model is needed. |
| **Icon / logo** | `{ "svg": "logo.svg" }` (a file, or inline `<svg…>`) · `{ "png": "icon.png" }` | Exact vector outlines plus inner contour lines (`fill`: `auto`/`contours`/`hatch`/`none`). PNGs are traced from alpha, or from dark-on-light. |
| **Text** | `{ "text": "خطوط من نور\nLines of light", "font": "fonts/X.ttf" }` | HarfBuzz shapes the glyphs, so Arabic joins and runs RTL, and ligatures work. Mixed Arabic and English lines are ordered by a small bidi pass, then the glyph outlines become lines. Use `\n` for new lines. |

Python setup, once: `pip install -r scripts/requirements.txt`. Node setup, once: `npm install` (puppeteer-core and harfbuzzjs). Chrome must be installed.

## Scene spec (one JSON file → one video)
```jsonc
{ "width": 1080, "height": 1920, "fps": 30,
  "background": "#000000",          // or "transparent" (straight alpha), or "look" (the preset's background)
  "strokes": 9000, "points": 8, "dots": 6000,   // budget; every shot is resampled to it so any two shots can morph
  "backdrop": 0,  "dust": 0,                     // v1 wave sheet behind (0–1) · floating motes (0–1)
  "look": { "preset": "ember", "glow": 0.75, "width": 1.0 },   // white ember(Teal Fire) rose(Lilac Rose) gold neon ice claude
  "shots": [ { "input": {…}, "duration": 3, "fit": 0.8, "pos": [0, 0],
      "in":  { "type": "draw", "dur": 1.6, "ease": "inOutSine", "order": "ttb", "stagger": 2.5 },
      "out": { "type": "disperse", "style": "wind", "dur": 1.0 },
      "fx": ["shimmer"], "accents": [{ "type": "sweep", "at": 1.2 }],
      "camera": { "zoom": [1, 1.06], "pan": [[0, 0], [0, 0.01]], "yaw": [0, 8], "roll": 0 },
      "look": { "preset": "rose" } } ] }
```
- **in:** `draw` · `assemble` (style `dust`/`explode`/`wind`/`vortex`) · `morph` (from the previous shot) · `wipe` (dir `ltr`/`rtl`/`ttb`/`btt`/`diag`) · `sweep` · `glitch` · `sting` (assemble, then a spring landing, a flash and a light sweep) · `fade` · `none`.
- **out:** `draw` (undraw) · `disperse` (same styles) · `wipe` · `sweep` · `glitch` · `fade` · `none`.
- **order:** `ttb` `btt` `ltr` `rtl` `center` `outside` `random` `path` (the source's own order). Defaults: portraits `ttb`, SVG `path`, Arabic text `rtl`.
- **ease:** `linear` `outCubic` `inOutCubic` `outExpo` `inCubic` `outBack` `inOutSine` `outQuart` …. Arrivals ease out, exits ease in, A→B moves ease in-out.
- **fx:** `shimmer` `scan` `ripple` `heartbeat` `glitch` `wind` `dash` `flicker` `aurora` `sweep`.
- **accents:** `sweep`, `flash`, `glitch` and `pulse` at any time in a shot.
- Relative paths resolve against the scene file's folder.
- Times are seconds, and every frame is a pure function of its time.

## Render
```bash
node render.mjs scene.json --out film.mp4
node render.mjs scene.json --alpha --out logo.mov --out logo.webm --out frames/   # ProRes 4444 + VP9 alpha + PNG seq, one pass
node render.mjs scene.json --stills 0,45,90 --stilldir stills/                     # look before you render
```
- Each output is checked by decoding it: the frame count must match exactly, and alpha files must have a corner alpha of 0.
- Speed is about 60 ms per frame at 1080×1920 on an Apple GPU.
- Any size or fps works: `--width --height --fps`, or `--scale 0.5` for previews.

## Three copy-paste scenes (`examples/`)
1. **Icon sting:** `examples/icon-sting.json` (transparent, 1:1). The spark logo assembles, lands with a flash and a sweep, then dissolves to dust.
2. **Arabic text reveal:** `examples/arabic-text-reveal.json`. «خطوط من نور» over "Lines of light" is drawn right to left, then a light sweep passes and it wipes out.
3. **Icon → text → portrait morph:** `examples/morph-icon-text-portrait.json`. A heart draws, morphs into «نور», then morphs into a portrait.

Also in `examples/`: `transitions.json` (every transition on alpha) and `product-photo.json`.

## In editors and code
- **After Effects / Premiere / CapCut:** import the `.mov` (ProRes 4444, straight alpha) or the PNG sequence. Use Add or Screen mode over bright footage, and Normal over dark plates. `after-effects/import_linefield.jsx` imports the file and places it at the playhead.
- **Remotion:** `remotion/LineField.tsx` takes `<LineField scene={spec} transparent />`. It is deterministic by `useCurrentFrame()` and safe with any concurrency. Setup is in the file header: copy `studio/engine/`, put harfbuzz and fonts in `public/linefield/`, and use `Config.setChromiumOpenGlRenderer("angle")`.
- **Studio page:** `cd studio && node serve.mjs 8097` → `http://127.0.0.1:8097/`.
  - Shots timeline, inputs (drop SVG, PNG, font or scene.json; type text), all transitions, v1 looks and effects, scrub.
  - Exports: MP4, WebM with alpha, PNG and scene.json.

## Rules
- **Look before done.** Render `--stills` at the start, the middle of each transition and the end, and open them. For alpha files, check the corner pixel. A clean decode is not the same as a good picture.
- **Same person, consent.** Portraits keep the face recognisable; never beautify or swap identity. Only use photos of the user or of people who agreed, never scraped photos of private people.
- **Budget.**
  - Portraits need `strokes` ≥ their polyline count (about 7–9k), or their finest lines are dropped.
  - Icon-only scenes look crisper and explode into bigger shards with 1500–3000 strokes.
- **Fonts and logos.** Only use fonts and logos you have the right to use. The bundled IBM Plex Sans Arabic and Inter are OFL.
- No secrets or machine paths in shared files.

## Files
```
SKILL.md · README.md · package.json · render.mjs (headless renderer)
studio/engine/  linefield.mjs (WebGL renderer, transitions, bloom, alpha) · scene.mjs (spec + timeline) · shapes.mjs (inputs, resampling) · ease.mjs
studio/index.html (studio page) · player.html (headless) · serve.mjs · data/ (boy, girl) · fonts/ · assets/ · vendor/ (three, harfbuzz, muxers)
scripts/  flowlines.py (line art → lines) · image2lines.py (photo → lines)
remotion/LineField.tsx · after-effects/import_linefield.jsx · prompts/ (portrait prep) · examples/ · gallery/ · tools/sheet.py (contact sheets)
```
