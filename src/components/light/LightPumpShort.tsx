import React, { useEffect, useMemo, useState } from 'react';
import { navigate } from './navigation.ts';
import { FilterChoices } from './FilterChoices.tsx';
import { Pager, RowsPicker, SortTh, price, sortRows, usePaged, useSort } from './table.tsx';
import { ManualOrderDialog } from './ManualOrderDialog.tsx';
import type { BotStateSummary } from '../../types/trading.ts';

type Candidate = { symbol: string; low: number; high: number; growthPct: number; retracementTarget: number; lastPrice: number; excludedShort: boolean };
type Scan = { running: boolean; checked: number; total: number; error: string | null; lastCompletedAt: number | null; candidates: Candidate[] };
type Filter = 'ALL' | 'ELIGIBLE' | 'EXCLUDED';
type SortKey = 'symbol' | 'growthPct' | 'low' | 'high' | 'lastPrice' | 'retracementTarget' | 'status';

export function LightPumpShort({ state }: { state: BotStateSummary | null }) {
  const [manualShort, setManualShort] = useState<string | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [owned, setOwned] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [size, setSize] = useState(20);
  const [page, setPage] = useState(1);
  const [sort, toggleSort] = useSort<SortKey>();
  const refresh = () => fetch('/api/pump-short/scan').then(async r => {
    const d = await r.json(); if (!r.ok) throw Error(d.error || 'Scanner unavailable'); setScan(d);
  }).catch(e => setError(e.message));
  useEffect(() => {
    const poll = () => { void refresh(); void fetch('/api/pump-short/positions').then(r => r.json()).then(d =>
      setOwned((d.trades || []).filter((t: {status: string}) => t.status !== 'CLOSED').length)).catch(() => {}); };
    poll(); const timer = setInterval(poll, 5000); return () => clearInterval(timer);
  }, []);
  const start = async () => {
    setError(null);
    try { const r = await fetch('/api/pump-short/scan', { method: 'POST' }); if (!r.ok) throw Error('Cannot start scan'); void refresh(); }
    catch (e: any) { setError(e.message); }
  };
  const all = scan?.candidates || [];
  const eligible = all.filter(c => !c.excludedShort).length;
  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    const rows = all.filter(c => (!q || c.symbol.includes(q)) && (filter === 'ALL' ||
      (filter === 'ELIGIBLE' ? !c.excludedShort : c.excludedShort)));
    return sortRows(rows, sort, (c, k) => k === 'status' ? (c.excludedShort ? 1 : 0) : c[k]);
  }, [all, query, filter, sort]);
  const pg = usePaged(filtered, size, page);
  const change = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  return <div className="content" data-testid="pump-short-page">
    <section className="section">
      <div className="legend">Pump Short — Market Scanner</div>
      <div className="metrics">
        <div className="metric"><div className="name">Eligible</div><div className="val green">{eligible}</div></div>
        <div className="metric"><div className="name">Existing SHORT</div><div className="val red">{all.length - eligible}</div></div>
        <div className="metric"><div className="name">Pump Positions</div><div className="val">{owned}</div></div>
        <div className="metric"><div className="name">Checked</div><div className="val">{scan?.checked ?? 0} / {scan?.total ?? 0}</div></div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="save" type="button" disabled={scan?.running} onClick={() => void start()}>{scan?.running ? 'Scanning…' : 'Scan Now'}</button>
        <button type="button" onClick={() => navigate('/PumpPositions')}>Pump Positions</button>
        <span role="status" style={{ color: '#9da2ac', fontSize: 12 }}>{scan?.running ? 'Scanning…' : scan?.lastCompletedAt ? `Last update: ${new Date(scan.lastCompletedAt).toLocaleString()}` : 'Waiting for scan'}</span>
      </div>
      {(error || scan?.error) && <p role="alert" className="field-error">{error || scan?.error}</p>}
    </section>
    <section className="section">
      <div className="lp-toolbar">
        <div className="tb-left"><input className="search" type="search" aria-label="Search pump symbols" placeholder="Search by Symbol..." value={query} onChange={e => change(setQuery)(e.target.value)} /></div>
        <RowsPicker size={size} onSize={change(setSize)} />
        <FilterChoices<Filter> label="Status" className="tb-right" value={filter} onChange={change(setFilter)} options={[
          { value: 'ALL', label: 'All Candidates' }, { value: 'ELIGIBLE', label: 'Eligible' }, { value: 'EXCLUDED', label: 'SHORT Open' },
        ]}/>
      </div>
      <div className="aged-table-title"><span>Pump Candidates</span></div>
      <div className="table-wrap" role="region" tabIndex={0} aria-label="Pump candidates table">
        <table className="lp-table" data-testid="pump-candidates-table">
          <colgroup>{[16, 11, 12, 12, 12, 12, 13, 12].map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}</colgroup>
          <thead><tr>
            <SortTh k="symbol" s={sort} onSort={toggleSort}>Symbol</SortTh>
            <SortTh k="growthPct" s={sort} onSort={toggleSort}>Growth</SortTh>
            <SortTh k="low" s={sort} onSort={toggleSort}>Wave Low</SortTh>
            <SortTh k="high" s={sort} onSort={toggleSort}>Wave High</SortTh>
            <SortTh k="lastPrice" s={sort} onSort={toggleSort}>Last Price</SortTh>
            <SortTh k="retracementTarget" s={sort} onSort={toggleSort}>Exit Target</SortTh>
            <SortTh k="status" s={sort} onSort={toggleSort}>Status</SortTh>
            <th>Trade</th>
          </tr></thead>
          <tbody>{pg.slice.length ? pg.slice.map(c => <tr key={c.symbol}>
            <td className="symbol"><a href={`https://www.bybit.com/trade/usdt/${c.symbol}`} target="_blank" rel="noopener noreferrer" style={{ color: '#fafafa', fontWeight: 700 }}>{c.symbol}</a></td>
            <td><span className="green" style={{ fontWeight: 700 }}>+{c.growthPct.toFixed(2)}%</span></td>
            <td>{price(c.low)}</td><td>{price(c.high)}</td><td>{price(c.lastPrice)}</td><td>{price(c.retracementTarget)}</td>
            <td><span className={c.excludedShort ? 'red' : 'green'} style={{ fontWeight: 700 }}>{c.excludedShort ? 'SHORT OPEN' : 'ELIGIBLE'}</span></td>
            <td><button type="button" className="row-act" disabled={c.excludedShort} title={c.excludedShort ? 'This symbol already has an open SHORT' : 'Open an external SHORT with explicit Bybit confirmation'} onClick={() => setManualShort(c.symbol)}>Manual Short</button></td>
          </tr>) : <tr><td className="empty" colSpan={8}>No candidates match the filters.</td></tr>}</tbody>
        </table>
      </div>
      <Pager from={pg.from} to={pg.to} total={filtered.length} page={pg.page} pages={pg.pages} noun="symbols" onPage={setPage} />
    </section>
    {manualShort && <ManualOrderDialog key={manualShort} symbol={manualShort} side="Sell" enabled={state?.systemMetrics?.tradingMode === 'REAL' && state?.systemMetrics?.tradingState === 'RUNNING'} onClose={() => setManualShort(null)} onDone={() => void refresh()} />}
  </div>;
}
