// node tools/debug.mjs scene.json "<js expression evaluated in the page after load>"
import puppeteer from 'puppeteer-core'; import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const [scene, expr] = process.argv.slice(2); const SD = path.dirname(path.resolve(scene)), ST = path.resolve('studio');
const srv = http.createServer((q, r) => { const u = decodeURIComponent(new URL(q.url, 'http://x').pathname); const [root, rest] = u.startsWith('/scene/') ? [SD, u.slice(7)] : [ST, u.slice(8)]; const f = path.resolve(root, rest);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' }[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage(); p.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 3000))); p.on('pageerror', (e) => console.log('[err]', e.message));
await p.goto(`${base}/studio/player.html?scene=${base}/scene/${path.basename(scene)}&width=540&height=960`); await p.waitForFunction('window.__ready||window.__error', { timeout: 120000 });
console.log(await p.evaluate(() => window.__error || 'ready'));
if (expr) console.log(JSON.stringify(await p.evaluate(expr), null, 1)?.slice(0, 4000));
await b.close(); srv.close();
