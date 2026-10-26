#!/usr/bin/env node
// Frame-exact headless renderer: scene.json → system Chrome (puppeteer-core) → renderFrame(n) → raw RGBA → ffmpeg.
//
//   node render.mjs scene.json --out film.mp4
//   node render.mjs scene.json --alpha --out logo.mov --out logo.webm --out frames/      (one render, several files)
//   node render.mjs scene.json --stills 0,45,90 --stilldir stills/                         (PNG stills, alpha kept)
//
// Outputs by extension:  .mp4 H.264 (alpha flattened over black)  ·  .mov ProRes 4444 with alpha (ProRes 422 HQ without)
//                        .webm VP9 (+alpha)  ·  .gif  ·  a folder (ends with /) → PNG sequence frame_00000.png (RGBA)
// Options: --alpha (transparent background) --from N --to N (inclusive) --width --height --fps --scale 0.5 (preview)
// Env: CHROME_PATH, FFMPEG, ANGLE=metal|gl|swiftshader
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url)), STUDIO = path.join(HERE, 'studio');
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const args = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
const sceneFile = argv.find((a) => a.endsWith('.json') && !argv[argv.indexOf(a) - 1]?.startsWith('--'));
if (!sceneFile) { console.error('usage: node render.mjs scene.json --out film.mp4 [--alpha] [--out x.mov] [--stills 0,30]'); process.exit(1); }
const SCENE = path.resolve(sceneFile), SCENE_DIR = path.dirname(SCENE);
const spec = JSON.parse(fs.readFileSync(SCENE, 'utf8'));
const ALPHA = flag('--alpha') || spec.background === 'transparent';
const scale = parseFloat(arg('--scale', '1'));
const W = Math.round((+arg('--width', 0) || spec.width || 1080) * scale / 2) * 2, H = Math.round((+arg('--height', 0) || spec.height || 1920) * scale / 2) * 2;
const FPS = +arg('--fps', 0) || spec.fps || 30;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const ANGLE = process.env.ANGLE || (process.platform === 'darwin' ? 'metal' : 'default');
const outs = args('--out').map((o) => (o.endsWith('/') ? o : path.resolve(o)));
const stills = arg('--stills') ? arg('--stills').split(',').map(Number) : null;
const stillDir = path.resolve(arg('--stilldir', 'stills'));
if (!outs.length && !stills) { console.error('nothing to do: give --out and/or --stills'); process.exit(1); }

function findChrome() {
  const c = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean);
  const hit = c.find((p) => fs.existsSync(p)); if (!hit) throw new Error('Chrome not found. Install Google Chrome or set CHROME_PATH.'); return hit;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.otf': 'font/otf', '.bin': 'application/octet-stream' };
// /studio/* → the engine, /scene/* → the scene file's folder (its fonts, SVGs, baked data)
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [root, rest] = u.startsWith('/scene/') ? [SCENE_DIR, u.slice(7)] : u.startsWith('/studio/') ? [STUDIO, u.slice(8)] : [null, null];
  const f = root && path.resolve(root, rest);
  if (!f || !f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

function outArgs(o) {
  const vf = ['vflip'];
  if (o.endsWith('/')) { fs.mkdirSync(o, { recursive: true }); return ['-vf', vf.join(','), '-pix_fmt', 'rgba', '-start_number', '0', path.join(o, 'frame_%05d.png')]; }
  fs.mkdirSync(path.dirname(o), { recursive: true });
  const ext = path.extname(o).toLowerCase();
  if (ext === '.mp4') return ['-vf', [...vf, ...(ALPHA ? ['premultiply=inplace=1'] : []), 'format=yuv420p'].join(','), '-c:v', 'libx264', '-crf', '16', '-preset', 'slow', '-movflags', '+faststart', '-r', String(FPS), o];
  if (ext === '.mov') return ALPHA
    ? ['-vf', vf.join(','), '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0', '-r', String(FPS), o]
    : ['-vf', vf.join(','), '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0', '-r', String(FPS), o];
  if (ext === '.webm') return ['-vf', [...vf, `format=${ALPHA ? 'yuva420p' : 'yuv420p'}`].join(','), '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '22', '-row-mt', '1', '-auto-alt-ref', '0', '-r', String(FPS), o];
  if (ext === '.gif') return ['-vf', [...vf, ...(ALPHA ? ['premultiply=inplace=1'] : []), 'fps=15', `scale=${Math.min(480, W)}:-2:flags=lanczos`, 'split[a][b]', '[a]palettegen=stats_mode=diff[p]', '[b][p]paletteuse=dither=bayer:bayer_scale=4'].join(','), '-loop', '0', o];
  throw new Error('unknown output type: ' + o);
}
function probe(o, frames) {
  if (o.endsWith('/')) { const n = fs.readdirSync(o).filter((f) => /^frame_\d+\.png$/.test(f)).length; return { file: o, frames: n, ok: n === frames }; }
  // decode it (ffprobe is often missing and container metadata can lie; a decode cannot): stream line, frame count,
  // and for alpha files a decoded frame's corner alpha (must be 0) and brightest alpha (must be high)
  const ext = path.extname(o).toLowerCase(), dec = ext === '.webm' ? ['-c:v', 'libvpx-vp9'] : [];   // the native VP9 decoder drops alpha
  const r = spawnSync(FFMPEG, ['-hide_banner', ...dec, '-i', o, '-map', '0:v', '-f', 'null', '-'], { encoding: 'utf8' });
  const log = r.stderr || '', stream = (log.match(/Stream #0:0[^\n]*Video: ([^\n]*)/) || [])[1] || '';
  const n = [...log.matchAll(/frame=\s*(\d+)/g)].map((m) => +m[1]).pop();
  const res = { file: o, stream: stream.split(/,(?![^(]*\))/).slice(0, 3).join(',').trim(), frames: n, ok: ext === '.gif' ? n > 0 : n === frames };
  if (ALPHA && (ext === '.mov' || ext === '.webm')) {
    const px = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...dec, '-ss', String(Math.floor(frames / 2) / FPS), '-i', o, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
    const buf = px.stdout; let amax = 0; for (let i = 3; i < buf.length; i += 4) if (buf[i] > amax) amax = buf[i];
    res.alpha = { corner: buf[3], max: amax }; res.ok = res.ok && buf[3] === 0 && amax > 128;
  }
  return res;
}

const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: true, defaultViewport: { width: W, height: H, deviceScaleFactor: 1 }, protocolTimeout: 900000,
  args: [`--use-angle=${ANGLE}`, '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--force-color-profile=srgb'],
});
let code = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (!/GPU stall|Automatic fallback|WebGL-/.test(t)) console.log('[page]', t); });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('requestfailed', (r) => console.error('[requestfailed]', r.url()));
  const q = new URLSearchParams({ scene: `${base}/scene/${path.basename(SCENE)}`, width: W, height: H, fps: FPS, ...(ALPHA ? { alpha: '1' } : {}) });
  const t0 = Date.now();
  await page.goto(`${base}/studio/player.html?${q}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__ready === true || !!window.__error', { timeout: 600000, polling: 100 });
  const err = await page.evaluate(() => window.__error || null); if (err) throw new Error('page failed: ' + err);
  const info = await page.evaluate(() => window.LF.info);
  console.log(`scene ${path.basename(SCENE)}: ${info.frames} frames, ${info.duration.toFixed(2)} s, ${W}x${H} @ ${FPS} fps${ALPHA ? ', alpha' : ''} · ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (stills) {
    fs.mkdirSync(stillDir, { recursive: true });
    for (const n of stills) {
      const url = await page.evaluate((k) => window.LF.still(k), n);
      const f = path.join(stillDir, `frame_${String(n).padStart(5, '0')}.png`); fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); console.log('still', f);
    }
  }
  if (outs.length) {
    const from = +arg('--from', 0), to = Math.min(+arg('--to', info.frames - 1), info.frames - 1), count = to - from + 1;
    const ff = spawn(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', String(FPS), '-i', '-', '-an', ...outs.flatMap(outArgs)], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))));
    const t1 = Date.now();
    for (let n = from; n <= to; n++) {
      const b64 = await page.evaluate((k) => window.LF.frame(k), n);
      const buf = Buffer.from(b64, 'base64'); if (buf.length !== W * H * 4) throw new Error(`frame ${n}: got ${buf.length} bytes`);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if ((n - from) % 60 === 0 || n === to) { const el = (Date.now() - t1) / 1000, k = n - from + 1; console.log(`frame ${n}/${to}  ${(el / k * 1000).toFixed(0)} ms/frame  eta ${(el / k * (count - k)).toFixed(0)} s`); }
    }
    ff.stdin.end(); await done;
    for (const o of outs) { const p = probe(o, count); console.log('wrote', JSON.stringify(p)); if (!p.ok) code = 2; }
  }
} catch (e) { console.error(e.stack || e); code = 1; }
finally { await browser.close().catch(() => {}); server.close(); }
process.exit(code);
