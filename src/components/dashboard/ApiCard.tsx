import React, { useEffect, useState } from 'react';
import { BotStateSummary } from '../../types/trading.ts';
import { BybitTrace } from './BybitTrace.tsx';

// Bybit API connection card (read-only connect) and shared UI helpers.

export const C = { bg: '#131317', line: '#26262b', text: '#fafafa', dim: '#8d9098', soft: '#adb1b8', green: '#39aa77', red: '#ed4f5d', amber: '#dda052' };
export const panel: React.CSSProperties = { background: C.bg, border: `1px solid ${C.line}`, borderRadius: 6, padding: '16px 18px', marginBottom: 16 };
export const h2: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: C.text, margin: 0 };
export const input: React.CSSProperties = { width: '100%', background: '#101014', border: '1px solid #2c2c3a', color: C.text, padding: '8px 10px', borderRadius: 4, fontSize: 14, boxSizing: 'border-box' };
export const btn = (bg: string, fg = '#101014', extra: React.CSSProperties = {}): React.CSSProperties => ({ background: bg, color: fg, border: 0, padding: '8px 14px', borderRadius: 4, fontWeight: 700, fontSize: 13, cursor: 'pointer', ...extra });
export const ghost: React.CSSProperties = { ...btn('#20202a', C.text), border: '1px solid #333342' };
export const num = (v: any, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
export const signed = (v: any, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}` : '—');
export const px = (v: any) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? (v >= 100 ? v.toFixed(2) : v.toPrecision(6)) : '—');

export async function post(url: string, body: any = {}) {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && d.success !== false, status: r.status, data: d, error: d.error || d.message || (r.ok ? '' : `HTTP ${r.status}`) };
}

// ---------------------------------------------------------------- 1. Bybit API
export const ApiCard: React.FC<{ state: BotStateSummary | null; onRefresh: () => void }> = ({ state, onRefresh }) => {
  const s: any = state?.settings || {};
  const c: any = (state as any)?.connection;
  const configured = Boolean(s.isApiKeyConfigured);
  const [editing, setEditing] = useState(!configured);
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [env, setEnv] = useState<'mainnet' | 'testnet'>(s.environment || 'mainnet');
  const [host, setHost] = useState<string>(s.apiHost || 'api.bybit.com');
  const [hosts, setHosts] = useState<Record<string, string>>({ 'api.bybit.com': 'Bybit Global (mainnet)' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showTrace, setShowTrace] = useState(false);

  useEffect(() => { fetch('/api/bybit/status').then((r) => r.json()).then((d) => d.hosts && setHosts(d.hosts)).catch(() => undefined); }, []);
  useEffect(() => { if (!configured) setEditing(true); }, [configured]);

  const connect = async () => {
    if (!key.trim() || !secret.trim()) { setMsg({ ok: false, text: 'Enter both the API key and the API secret.' }); return; }
    setBusy(true); setMsg(null);
    const r = await post('/api/settings', { apiKey: key, apiSecret: secret, environment: env, apiHost: host });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.error }); return; }
    setKey(''); setSecret('');
    const cs = r.data.connection;
    if (cs?.state === 'CONNECTED') { setEditing(false); setMsg({ ok: true, text: 'Connected (read-only). Nothing is sent to your account until you confirm a hedge start on the Symbols page.' }); }
    else setMsg({ ok: false, text: cs?.error?.message || 'Saved, but the connection check failed — see the details below.' });
    onRefresh();
  };
  const recheck = async () => { setBusy(true); setMsg(null); const r = await post('/api/bybit/refresh'); setBusy(false); setMsg({ ok: r.ok, text: r.ok ? 'Connection checked (read-only).' : r.error }); onRefresh(); };
  const removeKey = async () => {
    if (!window.confirm('Remove the API key from this app? Positions on Bybit are not affected.')) return;
    setBusy(true); const r = await post('/api/settings', { apiKey: '__CLEAR__' }); setBusy(false);
    setMsg({ ok: r.ok, text: r.ok ? 'API key removed.' : r.error }); setEditing(true); onRefresh();
  };

  const stateColor = c?.state === 'CONNECTED' ? C.green : c?.state === 'ERROR' ? C.red : C.amber;
  const k = c?.keyInfo;
  const w: any = state?.wallet;
  const has = Boolean(w?.valuesAvailable);

  return (
    <section style={panel} data-testid="api-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <h2 style={h2}>1 · Bybit account <span style={{ color: stateColor, marginLeft: 8 }}>{configured ? c?.state || '—' : 'NOT CONNECTED'}</span></h2>
        {configured && !editing && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={ghost} disabled={busy} onClick={recheck}>{busy ? 'Checking…' : 'Check again'}</button>
            <button style={ghost} disabled={busy} onClick={() => setEditing(true)}>Change key</button>
            <button style={{ ...ghost, color: C.red }} disabled={busy} onClick={removeKey}>Remove key</button>
          </div>
        )}
      </div>

      {editing && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, alignItems: 'end', marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: C.soft }}>API key<input style={input} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder={s.apiKeyMasked ? `stored ${s.apiKeyMasked}` : ''} /></label>
          <label style={{ fontSize: 12, color: C.soft }}>API secret<input style={input} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} /></label>
          <label style={{ fontSize: 12, color: C.soft }}>Bybit site of your account
            <select style={input} value={env === 'testnet' ? '__testnet' : host} onChange={(e) => { if (e.target.value === '__testnet') setEnv('testnet'); else { setEnv('mainnet'); setHost(e.target.value); } }}>
              {Object.entries(hosts).map(([h, l]) => <option key={h} value={h}>{l}</option>)}
              <option value="__testnet">Bybit Testnet</option>
            </select>
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={btn(C.amber)} disabled={busy} onClick={connect}>{busy ? 'Connecting…' : 'Save & connect'}</button>
            {configured && <button style={ghost} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>}
          </div>
        </div>
      )}
      {editing && <div style={{ fontSize: 12, color: C.dim, marginBottom: 10 }}>The key is stored only on this computer and never shown again. Connecting is read-only: no order, close, leverage or TP change is sent.</div>}

      {msg && <div style={{ fontSize: 13, color: msg.ok ? C.green : C.red, marginBottom: 10 }}>{msg.text}</div>}

      {configured && c?.state === 'ERROR' && c?.error && (
        <div style={{ background: '#2a1618', border: `1px solid ${C.red}66`, borderRadius: 4, padding: '10px 12px', fontSize: 13, color: C.text, marginBottom: 10 }}>
          <div><b style={{ color: C.red }}>Failed request:</b> {c.error.host || c.host}{c.error.endpoint} · HTTP {c.error.httpStatus ?? 'none'} · retCode {c.error.retCode ?? '—'}</div>
          {c.error.retMsg !== undefined && <div>Bybit says: <b>{c.error.retMsg}</b></div>}
          <div style={{ color: C.soft, marginTop: 4 }}>{c.error.message}</div>
        </div>
      )}

      {configured && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 12.5, color: C.soft, marginBottom: 12 }}>
          <span>Site: <b style={{ color: C.text }}>{c?.host || '—'}</b></span>
          <span>Key: <b style={{ color: C.text }}>{k ? (k.readOnly ? 'read-only' : 'read + trade') : '—'}</b></span>
          <span>IP binding: <b style={{ color: C.text }}>{k ? (k.ipBound ? k.ips.join(', ') : 'none') : '—'}</b></span>
          <span>Account: <b style={{ color: C.text }}>{w?.accountType && has ? w.accountType : '—'}</b></span>
          <span>Margin mode: <b style={{ color: C.text }}>{c?.marginMode || '—'}</b></span>
          <span>Last check: <b style={{ color: C.text }}>{c?.lastCheckAt ? new Date(c.lastCheckAt).toLocaleTimeString() : '—'}</b></span>
          <button style={{ background: 'none', border: 0, color: C.amber, cursor: 'pointer', fontSize: 12.5, padding: 0 }} onClick={() => setShowTrace((v) => !v)}>{showTrace ? 'Hide' : 'Show'} request details</button>
        </div>
      )}
      {showTrace && <div style={{ marginBottom: 12 }}><BybitTrace rows={c?.trace} /></div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        {[['Equity (USDT)', w?.totalEquity], ['Available (USDT)', w?.availableBalance], ['Used margin (USDT)', w?.usedMargin], ['Unrealised P&L (USDT)', w?.unrealizedPnl]].map(([label, v]) => (
          <div key={label as string} style={{ background: '#101014', border: `1px solid ${C.line}`, borderRadius: 4, padding: '10px 12px' }}>
            <div style={{ fontSize: 11.5, color: C.dim }}>{label as string}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: label === 'Unrealised P&L (USDT)' && has ? ((v as number) >= 0 ? C.green : C.red) : C.text }}>{has ? num(v as number, label === 'Unrealised P&L (USDT)' ? 3 : 2) : '—'}</div>
          </div>
        ))}
      </div>
      {has && w?.stale && <div style={{ fontSize: 12, color: C.amber, marginTop: 6 }}>Last known values (stale): {w.errorMessage}</div>}
    </section>
  );
};

