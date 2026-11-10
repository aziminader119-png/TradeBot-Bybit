#!/usr/bin/env node
// Frontend-only publish: puts a new dashboard build into dist/ WITHOUT stopping or restarting the bot.
//
// Why this works: in production mode (`npm start` / `tsx server.ts --prod`) the server serves dist/ with
// express.static and reads the files from disk on every request. The engine, API, WebSocket and running
// cycles are in the server process and are not touched by this script. Open browsers pick up the new UI
// on their next refresh.
//
// Steps (no step talks to the server, Bybit, or data/):
//   1. the new build must already be in dist-next/ (`npm run build:frontend`);
//   2. copy dist-next/assets/* into dist/assets/ (new hashed file names; old ones are KEPT, so a page that
//      is still open with the old index.html keeps working);
//   3. save the current dist/index.html as dist/index.previous.html (for rollback);
//   4. replace dist/index.html in one rename (write temp file, then rename) — the switch-over point.
//
// Rollback:  node scripts/publish-frontend.mjs --rollback   (restores dist/index.previous.html)
// Dev mode (`npm run dev`) serves the source through Vite instead of dist/ — this script has no effect there.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, process.env.TRADEBOT_DIST_DIR || 'dist');
const next = path.join(root, process.env.TRADEBOT_NEXT_DIR || 'dist-next');
const live = path.join(dist, 'index.html');
const prev = path.join(dist, 'index.previous.html');

const die = (m) => { console.error(`publish-frontend: ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Windows: a rename over a file that is being read at that moment can fail with EPERM/EBUSY — retry briefly.
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(100);
    }
  }
}
async function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  await renameRetry(tmp, file);
}
// Every /assets/... file referenced by an index.html must exist in dist/assets before it goes live.
function missingAssets(html) {
  const refs = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
  return refs.filter((r) => !fs.existsSync(path.join(dist, r)));
}

if (process.argv.includes('--rollback')) {
  if (!fs.existsSync(prev)) die('no dist/index.previous.html to roll back to.');
  const html = fs.readFileSync(prev, 'utf8');
  const miss = missingAssets(html);
  if (miss.length) die(`previous version references missing files: ${miss.join(', ')}`);
  const current = fs.existsSync(live) ? fs.readFileSync(live, 'utf8') : null;
  await atomicWrite(live, html);
  if (current) fs.writeFileSync(prev, current); // a second --rollback switches back again
  console.log('publish-frontend: rolled back dist/index.html to the previous version. Refresh the browser.');
  process.exit(0);
}

if (!fs.existsSync(path.join(next, 'index.html'))) die(`${path.relative(root, next)}/index.html not found — run "npm run build:frontend" first.`);
if (!fs.existsSync(live)) die('dist/index.html does not exist — this is a first install; run "npm start" (or "npm run build") instead.');

// 1. new hashed assets next to the old ones (never deletes)
const nextAssets = path.join(next, 'assets');
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
let copied = 0;
if (fs.existsSync(nextAssets)) {
  for (const f of fs.readdirSync(nextAssets)) {
    const to = path.join(dist, 'assets', f);
    if (!fs.existsSync(to)) { fs.copyFileSync(path.join(nextAssets, f), to); copied++; }
  }
}
// other top-level static files from public/ (favicon etc.), never index.html
for (const f of fs.readdirSync(next)) {
  if (f === 'index.html' || f === 'assets') continue;
  const from = path.join(next, f);
  if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(dist, f));
}
const html = fs.readFileSync(path.join(next, 'index.html'), 'utf8');
const miss = missingAssets(html);
if (miss.length) die(`new index.html references files that are not in dist/assets: ${miss.join(', ')} — nothing was switched.`);

// 2. keep the current page for rollback, 3. switch in one rename
fs.copyFileSync(live, prev);
await atomicWrite(live, html);
console.log(`publish-frontend: ${copied} new asset file(s) added; dist/index.html switched to the new build.`);
console.log('publish-frontend: the bot process was not touched. Refresh the dashboard in the browser to load it.');
console.log('publish-frontend: undo with  node scripts/publish-frontend.mjs --rollback');
