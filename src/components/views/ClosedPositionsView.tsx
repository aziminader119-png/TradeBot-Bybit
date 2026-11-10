import React, { useEffect, useState } from 'react';
import { C, ghost, panel, px, signed } from '../dashboard/ApiCard.tsx';

// Phase 6: real closed-position history straight from Bybit (/v5/position/closed-pnl, read-only).
type Row = { id: string; symbol: string; positionSide: string; qty: number; entryPrice: number; exitPrice: number; closedPnl: number; leverage: number | null; closedAt: number; owner: string };

export const ClosedPositionsView: React.FC = () => {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/closed-positions?days=${days}`);
      const d = await r.json();
      setRows(d.rows || []); setError(d.error || null);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [days]);
  const net = (rows || []).reduce((t, r) => t + r.closedPnl, 0);
  return (
    <div className="tb-auto" style={{ padding: '20px 20px 60px', maxWidth: 1400, margin: '0 auto', color: C.text }}>
      <div style={{ ...panel, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        {[1, 7, 30].map((d) => <button key={d} style={{ ...ghost, borderColor: d === days ? C.amber : '#333342' }} onClick={() => setDays(d)}>{d === 1 ? 'Last 24 h' : `Last ${d} days`}</button>)}
        <button style={ghost} disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Reload'}</button>
        <span style={{ color: C.soft }}>From Bybit closed P&L (net of fees, includes funding as Bybit reports it). {rows ? <>{rows.length} closed · net <b style={{ color: net >= 0 ? C.green : C.red }}>{signed(net, 4)} USDT</b></> : null}</span>
      </div>
      {error && <div style={{ ...panel, borderColor: C.red, color: C.red, fontSize: 13 }}>{error}</div>}
      <div style={panel}>
        {rows === null ? <div style={{ fontSize: 13, color: C.dim }}>Loading…</div> : rows.length === 0 ? <div style={{ fontSize: 13, color: C.dim }}>{error ? '—' : 'No closed position in this period.'}</div> : (
          <table style={{ width: '100%', fontSize: 13.5 }}>
            <thead><tr><th>Closed at</th><th>Owner</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Leverage</th><th>Closed P&L (USDT)</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.closedAt).toLocaleString()}</td>
                <td style={{ color: r.owner === 'Bot' ? C.green : C.soft }}>{r.owner}</td>
                <td>{r.symbol}</td>
                <td style={{ color: r.positionSide === 'Long' ? C.green : C.red }}>{r.positionSide}</td>
                <td>{r.qty}</td><td>{px(r.entryPrice)}</td><td>{px(r.exitPrice)}</td><td>{r.leverage ? `${r.leverage}x` : '—'}</td>
                <td style={{ color: r.closedPnl >= 0 ? C.green : C.red }}>{signed(r.closedPnl, 4)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
};
