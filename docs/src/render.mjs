// node docs/src/render.mjs <page.html> <out.png> [out.svg] [--transparent]
// Serves this folder over http, opens the page in headless Chrome, waits for window.__done,
// screenshots #root at 2x, and (optionally) saves the page's <svg id="d"> as a standalone file.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const transparent = args.includes('--transparent');
const [page, outPng, outSvg] = args.filter((a) => !a.startsWith('--'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  try {
    const p = join(here, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(here)) throw 0;
    const body = readFileSync(p);
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const httpPort = server.address().port;

const port = 9800 + Math.floor(Math.random() * 150);
const prof = `/tmp/claude-render-${port}`;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${port}`, '--hide-scrollbars', `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60; i++) {
  try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); ws = new WebSocket(t.find((x) => x.type === 'page').webSocketDebuggerUrl); break; } catch { await sleep(200); }
}
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 1600, deviceScaleFactor: 2, mobile: false });
if (transparent) await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/${page}` });
for (let i = 0; i < 100 && !(await ev('window.__done === true')); i++) await sleep(200);
const box = await ev('(() => { const r = document.getElementById("root").getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()');
const warn = await ev('JSON.stringify(window.__warnings || [])');
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: true });
writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
if (outSvg) writeFileSync(outSvg, await ev('window.__svg()'));
console.log(outPng, box.width + 'x' + box.height, 'warnings:', warn);
chrome.kill(); server.close();
await sleep(300); try { rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(0);
