// Read-only Bybit connection check from the command line:  npm run bybit:check
// Uses the key stored in data/bot_database.json (or BYBIT_API_KEY / BYBIT_API_SECRET env vars).
// It never prints the key, secret or signature, and only calls read endpoints:
//   GET /v5/market/time, /v5/user/query-api, /v5/account/wallet-balance, /v5/account/info, /v5/position/list
// No order, cancel, leverage, TP or mode request exists in this script.
import fs from 'fs';
import path from 'path';
import { BybitClient, BYBIT_REST_HOSTS } from '../src/server/bybit/bybitClient.ts';

const dbFile = path.resolve(process.cwd(), 'data/bot_database.json');
let settings: any = {};
try { settings = JSON.parse(fs.readFileSync(dbFile, 'utf-8')).settings || {}; } catch { /* no DB yet */ }
const key = process.env.BYBIT_API_KEY ?? settings.apiKey ?? '';
const secret = process.env.BYBIT_API_SECRET ?? settings.apiSecret ?? '';
const testnet = (process.env.BYBIT_ENV ?? settings.environment) === 'testnet';
const host = process.env.BYBIT_API_HOST ?? settings.apiHost;
if (host && !testnet && !BYBIT_REST_HOSTS[host]) { console.error(`Unknown API host "${host}". Allowed: ${Object.keys(BYBIT_REST_HOSTS).join(', ')}`); process.exit(2); }

const client = new BybitClient(key, secret, testnet, host);
console.log(`Host: ${client.getHost()}  ·  environment: ${testnet ? 'testnet' : 'mainnet'}  ·  key: ${key ? `configured (${String(key).trim().length} chars)` : 'NOT configured'}  ·  signing: ${key ? client.getSignMethod() : '—'}`);
for (const n of client.credentialNotes) console.log(`Note: ${n}`);

const r = await client.testConnection();
if (r.success && key) {
  try { const pos = await client.getPositions(); console.log(`Positions on Bybit (read only): ${pos.length}`); } catch (e: any) { console.log(`Position list failed: ${e.message}`); }
}
console.log('\nRequests (oldest first):');
for (const t of client.getTrace().reverse()) {
  console.log(`  ${t.method} ${t.host}${t.path}${t.params.length ? '?' + t.params.join('&') : ''}`);
  console.log(`     ${t.signed ? `signed ${t.signMethod}, ts ${t.timestampSent}, recv_window ${t.recvWindow}, clock offset ${t.clockOffsetMs} ms` : 'public'}`);
  console.log(`     -> HTTP ${t.httpStatus ?? '(no response)'} · retCode ${t.retCode ?? '—'} · retMsg ${t.retMsg !== undefined ? JSON.stringify(t.retMsg) : '—'}${t.server ? ` · server ${t.server}` : ''} · ${t.durationMs} ms${t.outcome !== 'OK' && t.note ? `\n     ${t.note}` : ''}`);
}
console.log(`\nResult: ${r.success ? 'OK' : 'FAILED'} — ${r.message}`);
process.exit(r.success ? 0 : 1);
