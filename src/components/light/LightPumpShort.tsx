import React, { useEffect, useState } from 'react';
import { navigate } from './navigation.ts';

type Candidate = { symbol: string; low: number; high: number; growthPct: number; retracementTarget: number; lastPrice: number; excludedShort: boolean };
type Scan = { running: boolean; checked: number; total: number; error: string | null; lastCompletedAt: number | null; candidates: Candidate[] };
const num = (n: number, digits = 5) => n.toLocaleString('en-US', { maximumFractionDigits: digits });

export function LightPumpShort() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownedPositions, setOwnedPositions] = useState(0);
  const refresh = () => fetch('/api/pump-short/scan').then(async r => {
    const data = await r.json(); if (!r.ok) throw Error(data.error || 'Scan unavailable'); setScan(data);
  }).catch(e => setError(e.message));
  useEffect(() => {
    const sync = () => { void refresh(); void fetch('/api/pump-short/positions').then(r => r.json()).then(d => {
      setOwnedPositions((d.trades || []).filter((t: { status: string }) => t.status !== 'CLOSED').length);
    }).catch(() => {}); };
    sync(); const id = setInterval(sync, 5000); return () => clearInterval(id);
  }, []);
  const begin = async () => {
    setError(null);
    try {
      const r = await fetch('/api/pump-short/scan', { method: 'POST' });
      if (!r.ok) throw Error('Cannot start scan');
      await refresh();
    } catch (e: any) { setError(e.message); }
  };
  const candidates = scan?.candidates.filter(c => !c.excludedShort) || [];
  const excluded = scan?.candidates.filter(c => c.excludedShort) || [];
  return <div className="content" data-testid="pump-short-page">
    <section className="section">
      <div className="legend">Pump Short — Market Scanner</div>
      <p>Automatic scan every 5 minutes, using hourly candles from 1 hour through the configured lookback. Existing SHORT positions are excluded. Signals are read-only until order execution is enabled.</p>
      <button className="save" type="button" disabled={Boolean(scan?.running)} onClick={() => void begin()}>{scan?.running ? 'Scanning…' : 'Scan Now'}</button>
      <p role="status">{scan?.running ? `Checked ${scan.checked} / ${scan.total}` : scan?.lastCompletedAt ? `Last completed: ${new Date(scan.lastCompletedAt).toLocaleString()} — next scan automatically` : 'Waiting for automatic scan'}</p>
      {(scan?.error || error) && <p role="alert" className="field-error">{scan?.error || error}</p>}
      <div className="metrics">
        <div className="metric"><div className="name">Eligible Pump Symbols</div><div className="val">{candidates.length}</div></div>
        <div className="metric"><div className="name">Excluded: Existing SHORT</div><div className="val">{excluded.length}</div></div>
        <div className="metric"><div className="name">Pump Short Positions</div><div className="val">{ownedPositions}</div></div>
      </div>
    </section>
    <section className="section">
      <div className="legend">Pump Candidates</div>
      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
        <thead><tr><th>Symbol</th><th>Growth</th><th>Wave Low</th><th>Wave High</th><th>Price</th><th>50% Exit</th><th>Status</th></tr></thead>
        <tbody>{(scan?.candidates || []).map(c => <tr key={c.symbol}>
          <td>{c.symbol}</td><td>{num(c.growthPct, 2)}%</td><td>{num(c.low, 8)}</td><td>{num(c.high, 8)}</td>
          <td>{num(c.lastPrice, 8)}</td><td>{num(c.retracementTarget, 8)}</td>
          <td>{c.excludedShort ? 'EXCLUDED — SHORT OPEN' : 'ELIGIBLE (NO ORDER)'}</td>
        </tr>)}</tbody>
      </table></div>
      {!scan?.candidates.length && <p>No candidates yet. Run a scan to load results.</p>}
    </section>
    <section className="section"><div className="legend">Pump Short Positions</div>
      <p>New Pump Short orders require explicit arming in REAL mode. Existing bot positions are managed separately.</p>
      <button type="button" onClick={() => navigate('/PumpPositions')}>Open Pump Positions</button>
    </section>
  </div>;
}
