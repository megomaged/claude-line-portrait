---
name: claude-line-portrait
description: Turn any photo of a person into a glowing line portrait drawn by code — thousands of vector light lines that rebuild the face on a live web page, inside a field of flowing waves, with colour presets, glow, 11 motion effects (pulse, shimmer, scan, ripple, heartbeat, glitch, wind, dash flow, neon flicker, aurora, light sweep), 9:16/4:5/1:1/16:9 frames, PNG export and frame-exact MP4 export of any length. Use when the user wants a photo turned into line art, a line portrait, a "drawn with lines" or "made of light" portrait, a glowing/neon/hologram portrait, an animated portrait reveal for a reel or story, or "make this picture out of lines".
---

# Claude Line Portrait

One photo goes in. Out comes a page where code draws the person with light lines, and an MP4 of it being drawn.

## Pipeline (4 steps, about 2 minutes plus the image model)

| Step | What | How | Gate (look before going on) |
|---|---|---|---|
| 1 | **Cinematic portrait** | Any image model with a reference image (ChatGPT, Gemini, Midjourney, Magnific, Flux…), prompt in `prompts/01_cinematic_portrait.md` | Black background, close-up, one lit side and one shadow side, bright rim, same face |
| 2 | **Line art** | Same model, step-1 image as the reference, prompt in `prompts/02_line_art.md` | Dense white lines on black, face fully drawn, same framing |
| 3 | **Lines → code** | `python3 scripts/flowlines.py lineart.png studio/data/<name>` (about 7 s) | Prints `polylines` 5–10k and `dots` 9000 |
| 4 | **Studio** | `cd studio && node serve.mjs 8097`, open `http://127.0.0.1:8097/?d=<name>` | The face draws itself; pick a look; Download video |

Do not skip steps 1–2. The code draws where the drawing has strokes, so the image model's line art decides the quality. A plain phone photo straight into step 3 gives mush.
If the user has no image model, ask them to run the two prompts in any app they use and send you the step-2 image.

## Step 3 details (`scripts/flowlines.py`)
- Install once: `pip install -r scripts/requirements.txt` (numpy, scipy, pillow, scikit-image).
- How it works:
  - It reads the drawing's stroke direction (structure tensor) and its local brightness.
  - It redraws the drawing as evenly spaced streamlines, close together in light and sparse in shadow.
  - It drops the drawing's own background strokes, because the page draws a fresh wave field.
- Tuning:
  - `--dmin` / `--dmax`: line spacing in light and in shadow. Smaller values give more lines.
  - `--subject`: the threshold for what counts as the figure. Raise it if background scraps survive.
  - `--dots`: the number of particles.
- Output: `meta.json`, `lines.bin`, `lines_idx.bin`, `dots.bin`. All coordinates are in image pixels.

## Step 4 — the studio page (`studio/index.html`)
- Three.js; every line segment is an instanced quad, so all styling and motion happens in the shader.
- URL keys:
  - `d` — the data folder;
  - `preset` — `white`, `ember` (Teal Fire), `rose` (Lilac Rose), `gold` or `neon`;
  - `frame` — `9:16`, `4:5`, `1:1` or `16:9`;
  - `fx` — comma-separated effect numbers, for example `fx=0,8`.
- Panel:
  - **Colour:** preset, mode (mono, gradient, by light) and two colours.
  - **Lines:** width, brightness, contrast, glow and particles.
  - **Motion:** draw order, draw time, pulses and breathe.
  - **Background:** background lines and wave motion.
  - **Effects:** 0 Shimmer, 1 Scan, 2 Ripple, 3 Heartbeat, 4 Glitch, 5 Wind, 6 Dash flow, 7 Neon flicker, 8 Aurora, 9 Light sweep. They can be combined, with a shared strength and speed.
  - **Output:** frame, Replay, Save PNG, and Download video (seconds).
- **Video export** uses WebCodecs H.264 and an MP4 muxer. Each frame is rendered at its exact time (frame / 30 s) at the frame's real size, for example 1080×1920. The file never stutters on a slow machine and never picks up the screen's size or pixel density. The drawing finishes about 1 s before the end. It needs Chrome or Edge.
- The portrait is fixed; the mouse does not move it. Press H to hide the panel for clean screen recordings.

## Rules
- **Same person.** Steps 1–2 must keep the face recognisable. Never "beautify" someone or turn them into another person. Regenerate if the likeness drifts.
- **Consent.** Only use photos of the user or of people who agreed. Do not make line portraits of private people from scraped photos.
- **Look at the output.** Open the page, or screenshot it headless, before saying it is done. Check the drawing at the end and halfway through.
- No secrets or machine paths in shared files.

## Files
```
prompts/01_cinematic_portrait.md   step 1 prompt + checks
prompts/02_line_art.md             step 2 prompt + checks
scripts/flowlines.py               step 3: line art → vector lines
studio/index.html                  step 4: the page (three.js + shaders + panel + MP4 export)
studio/serve.mjs                   localhost static server
studio/data/boy, studio/data/girl  two ready examples
gallery/                           stills, pipeline steps, drawing.gif / drawing.mp4
```
