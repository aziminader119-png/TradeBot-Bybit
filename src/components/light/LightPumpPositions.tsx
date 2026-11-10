import React, { useEffect, useState } from 'react';
import { navigate } from './navigation.ts';

type PumpTrade = { id: string; symbol: string; status: string; entryPrice: number; exitPrice: number | null;
  target: number; waveLow: number; waveHigh: number; qty: number; entryAt: number; exitAt: number | null; note: string | null;
  markPrice: number | null; unrealizedPnl: number | null };
type Snapshot = { armed: boolean; mode: string; busy: boolean; error: string | null; trades: PumpTrade[] };
const price = (n: number | null) => n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 8 });
const when = (n: number | null) => n == null ? '—' : new Date(n).toLocaleString();

export function LightPumpPositions() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pending, setPending] = useState(false);
  const refresh = () => fetch('/api/pump-short/positions').then(async r => {
    const d = await r.json(); if (!r.ok) throw Error(d.error || 'Cannot load Pump Short positions'); setData(d);
  }).catch(e => setError(e.message));
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, []);
  const arm = async (enabled: boolean) => {
    if (enabled && !window.confirm('Enable REAL Pump Short orders? At most 10 Pump Short positions can be active. The bot will open shorts on eligible markets.')) return;
    setPending(true); setError(null);
    try {
      const r = await fetch('/api/pump-short/arm', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, confirm: enabled, pin }) });
      const d = await r.json(); if (!r.ok) throw Error(d.error || 'Cannot change Pump Short mode');
      setData(d); setPin('');
    } catch (e: any) { setError(e.message); }
    finally { setPending(false); }
  };
  const trades = data?.trades || [];
  const open = trades.filter(t => t.status !== 'CLOSED');
  const closed = trades.filter(t => t.status === 'CLOSED');
  const Table = ({ items }: { items: PumpTrade[] }) => <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
    <thead><tr><th>Symbol</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Exit</th><th>Exit Target</th><th>Wave Low</th><th>Wave High</th><th>Opened</th><th>Closed</th><th>P&L</th><th>Status</th></tr></thead>
    <tbody>{items.map(t => { const pnl = t.status === 'CLOSED' && t.exitPrice != null ? (t.entryPrice - t.exitPrice) * t.qty : t.unrealizedPnl;
      return <tr key={t.id} title={t.note || undefined}>
        <td>{t.symbol}</td><td style={{ color: '#ED4F5D' }}>SHORT</td><td>{price(t.qty)}</td>
        <td>{price(t.entryPrice)}</td><td>{price(t.markPrice)}</td><td>{price(t.exitPrice)}</td><td>{price(t.target)}</td>
        <td>{price(t.waveLow)}</td><td>{price(t.waveHigh)}</td><td>{when(t.entryAt)}</td><td>{when(t.exitAt)}</td>
        <td style={{ color: pnl == null ? undefined : pnl >= 0 ? '#39AA77' : '#ED4F5D' }}>{pnl == null ? '—' : `${pnl.toFixed(4)} USDT*`}</td>
        <td>{t.status}{t.note ? ` — ${t.note}` : ''}</td></tr>; })}</tbody>
  </table>{!items.length && <p>No positions in this section.</p>}</div>;
  return <div className="content" data-testid="pump-positions-page">
    <section className="section"><div className="legend">Pump Short Positions</div>
      <p>Only orders recorded by the independent Pump Short strategy appear here. Existing bot and external positions are unaffected.</p>
      <div className="metrics"><div className="metric"><div className="name">Open / Pending</div><div className="val">{open.length}</div></div>
        <div className="metric"><div className="name">Closed</div><div className="val">{closed.length}</div></div>
        <div className="metric"><div className="name">Trading</div><div className="val">{data?.armed ? 'ARMED' : 'DISARMED'}</div></div></div>
      <p>Main engine: {data?.mode || '—'}. Every server restart disarms Pump Short. Unknown orders are kept for review, never blindly repeated.</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input aria-label="Security PIN" type="password" value={pin} onChange={e => setPin(e.target.value)} placeholder="Security PIN (if configured)" />
        {data?.armed ? <button className="save" disabled={pending} onClick={() => void arm(false)}>Stop Pump Short Entries & Exits</button>
          : <button className="save" disabled={pending || data?.mode !== 'REAL'} onClick={() => void arm(true)}>Enable REAL Pump Short</button>}
        <button type="button" onClick={() => navigate('/PumpShort')}>View Pump Scanner</button>
      </div>
      {data?.mode !== 'REAL' && <p>Set the main bot mode to REAL before enabling Pump Short execution.</p>}
      {(error || data?.error) && <p role="alert" className="field-error">{error || data?.error}</p>}
      <small>*Gross P&L is an estimate from recorded prices, excluding fees and funding.</small>
    </section>
    <section className="section"><div className="legend">Open & Pending Pump Positions</div><Table items={open} /></section>
    <section className="section"><div className="legend">Closed Pump Positions</div><Table items={closed} /></section>
  </div>;
}
