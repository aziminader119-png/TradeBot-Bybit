import React, { useEffect, useMemo, useState } from 'react';
import { ReportSummary, ReportTable, type ReportColumn, type ReportRow } from './reports.tsx';

type PumpTrade = { id: string; symbol: string; status: string; entryPrice: number; exitPrice: number | null;
  target: number; waveLow: number; waveHigh: number; qty: number; entryAt: number; exitAt: number | null; note: string | null;
  markPrice: number | null; unrealizedPnl: number | null };
type Snapshot = { armed: boolean; mode: string; busy: boolean; error: string | null; trades: PumpTrade[] };

const columns: ReportColumn[] = [
  { key: 'symbol', label: 'Symbol' }, { key: 'side', label: 'Side', format: 'side' },
  { key: 'size', label: 'Size', format: 'number' }, { key: 'value', label: 'Value (USDT)', format: 'number' },
  { key: 'entry', label: 'Entry', format: 'price' }, { key: 'mark', label: 'Mark', format: 'price' },
  { key: 'exit', label: 'Exit', format: 'price' }, { key: 'target', label: 'Exit Target', format: 'price' },
  { key: 'waveLow', label: 'Wave Low', format: 'price' }, { key: 'waveHigh', label: 'Wave High', format: 'price' },
  { key: 'opened', label: 'Opened', format: 'time' }, { key: 'closed', label: 'Closed', format: 'time' },
  { key: 'pnl', label: 'P&L (USDT)', format: 'pnl' }, { key: 'status', label: 'Status' },
];

function asRow(t: PumpTrade): ReportRow {
  const pnl = t.status === 'CLOSED' && t.exitPrice != null ? (t.entryPrice - t.exitPrice) * t.qty : t.unrealizedPnl;
  return { id: t.id, symbol: t.symbol, side: 'Sell', size: t.qty, value: t.qty * t.entryPrice,
    entry: t.entryPrice, mark: t.markPrice, exit: t.exitPrice, target: t.target,
    waveLow: t.waveLow, waveHigh: t.waveHigh, opened: t.entryAt, closed: t.exitAt,
    pnl, status: t.note ? `${t.status} — ${t.note}` : t.status };
}

export function LightPumpPositions() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const response = await fetch('/api/pump-short/positions');
        const body = await response.json();
        if (!response.ok) throw Error(body.error || 'Cannot load Pump Short positions');
        if (alive) { setData(body); setError(null); }
      } catch (e: any) { if (alive) setError(e.message); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const rows = useMemo(() => (data?.trades || []).map(asRow), [data?.trades]);
  const open = rows.filter(r => !String(r.status).startsWith('CLOSED'));
  const closed = rows.filter(r => String(r.status).startsWith('CLOSED'));
  const totalPnl = rows.reduce((sum, row) => sum + (typeof row.pnl === 'number' ? row.pnl : 0), 0);
  return <div className="workspace pump-positions-page" data-testid="pump-positions-page">
    {(error || data?.error) && <p role="alert" className="lp-error">{error || data?.error}</p>}
    <section className="lp-panel symbols-overview">
      <div className="section-title">Pump Short Positions</div>
      <ReportSummary items={[
        ['Open / Pending', open.length], ['Closed', closed.length],
        ['Execution', data?.armed ? 'ARMED' : 'DISARMED'],
        ['Total P&L (USDT)', totalPnl.toFixed(4)],
      ]} />
    </section>
    <section className="lp-panel pump-positions-table"><ReportTable title="Open & Pending Pump Positions" rows={open} columns={columns} empty="No open Pump Short positions." /></section>
    <section className="lp-panel pump-positions-table"><ReportTable title="Closed Pump Positions" rows={closed} columns={columns} empty="No closed Pump Short positions." /></section>
  </div>;
}
