import React, { useEffect, useMemo, useState } from 'react';
import type { BotStateSummary } from '../../types/trading.ts';
import { FilterChoices } from './FilterChoices.tsx';
import { ManualOrderDialog } from './ManualOrderDialog.tsx';
import { Pager, RowsPicker, SortTh, price, sortRows, usePaged, useSort } from './table.tsx';

type Candidate = { symbol: string; peak: number; trough: number; lastPrice: number; dropPct: number; peakAt: number; excludedBuy: boolean };
type Scan = { running: boolean; checked: number; total: number; error: string | null; lastCompletedAt: number | null; settings: {minDropPct:number;lookbackDays:number}; candidates: Candidate[] };
type Filter = 'ALL' | 'ELIGIBLE' | 'EXCLUDED';
type SortKey = 'symbol' | 'peak' | 'trough' | 'lastPrice' | 'dropPct' | 'peakAt' | 'status';

export function LightDumpBuy({ state }: { state: BotStateSummary | null }) {
  const [scan, setScan] = useState<Scan | null>(null), [error, setError] = useState('');
  const [manualBuy, setManualBuy] = useState<string | null>(null);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<Filter>('ALL');
  const [size, setSize] = useState(20), [page, setPage] = useState(1);
  const [sort, toggleSort] = useSort<SortKey>();
  const refresh = async () => { try { const r = await fetch('/api/dump-buy/scan', { cache: 'no-store' }); const d = await r.json(); if (!r.ok) throw Error(d.error || 'Scanner unavailable'); setScan(d); } catch (e: any) { setError(e.message || 'Scanner unavailable'); } };
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, []);
  const start = async () => { try { setError(''); const r = await fetch('/api/dump-buy/scan', { method: 'POST' }); if (!r.ok) throw Error('Cannot start scan'); void refresh(); } catch (e: any) { setError(e.message || 'Cannot start scan'); } };
  const all = scan?.candidates || [];
  const eligible = all.filter(c => !c.excludedBuy).length;
  const filtered = useMemo(() => sortRows(all.filter(c => (!query || c.symbol.includes(query.trim().toUpperCase())) && (filter === 'ALL' || (filter === 'ELIGIBLE' ? !c.excludedBuy : c.excludedBuy))), sort,
    (c,k) => k === 'status' ? (c.excludedBuy ? 1 : 0) : c[k]), [all,query,filter,sort]);
  const pg = usePaged(filtered,size,page);
  const update = <T,>(fn:(value:T)=>void) => (value:T) => { fn(value); setPage(1); };
  return <div className="content" data-testid="dump-buy-page">
    <section className="section">
      <div className="legend">Dump Buy — Market Scanner</div>
      <div className="metrics">
        <div className="metric"><div className="name">Drop threshold</div><div className="val">{scan?.settings.minDropPct ?? 60}%</div></div>
        <div className="metric"><div className="name">Eligible (no BUY)</div><div className="val green">{eligible}</div></div>
        <div className="metric"><div className="name">Existing BUY</div><div className="val red">{all.length - eligible}</div></div>
        <div className="metric"><div className="name">Checked</div><div className="val">{scan?.checked ?? 0} / {scan?.total ?? 0}</div></div>
      </div>
      <div style={{ display:'flex',alignItems:'center',gap:12,flexWrap:'wrap',marginTop:12 }}>
        <button type="button" className="save" disabled={scan?.running} onClick={()=>void start()}>{scan?.running?'Scanning…':'Scan Now'}</button>
        <span style={{color:'#9da2ac',fontSize:12}}>{scan?.lastCompletedAt ? 'Last scan: '+new Date(scan.lastCompletedAt).toLocaleString() : 'Waiting for scan'} · Window: {scan?.settings.lookbackDays ?? 10} days</span>
      </div>
      {(error || scan?.error) && <p className="field-error" role="alert">{error || scan?.error}</p>}
      <p className="lp-source-note">A dump means the last traded price is at least the configured percentage below an earlier high within the lookback window, after a later low. This is a scanner, not a BUY recommendation. Orders are manual and require a separate confirmation.</p>
    </section>
    <section className="section">
      <div className="lp-toolbar">
        <div className="tb-left"><input className="search" aria-label="Search dump symbols" placeholder="Search by Symbol..." value={query} onChange={e=>update(setQuery)(e.target.value)} /></div>
        <RowsPicker size={size} onSize={update(setSize)} />
        <FilterChoices<Filter> label="Status" className="tb-right" value={filter} onChange={update(setFilter)} options={[{value:'ALL',label:'All Candidates'},{value:'ELIGIBLE',label:'Eligible'},{value:'EXCLUDED',label:'BUY Open'}]}/>
      </div>
      <div className="aged-table-title"><span>Dump Candidates</span></div>
      <div className="table-wrap" role="region" tabIndex={0} aria-label="Dump candidates table">
        <table className="lp-table" data-testid="dump-candidates-table">
          <colgroup>{[17,15,15,15,13,13,12].map((w,i)=><col key={i} style={{width:w+'%'}} />)}</colgroup>
          <thead><tr><SortTh k="symbol" s={sort} onSort={toggleSort}>Symbol</SortTh><SortTh k="dropPct" s={sort} onSort={toggleSort}>Drop %</SortTh><SortTh k="peak" s={sort} onSort={toggleSort}>Prior High</SortTh><SortTh k="trough" s={sort} onSort={toggleSort}>Wave Low</SortTh><SortTh k="lastPrice" s={sort} onSort={toggleSort}>Last Price</SortTh><SortTh k="status" s={sort} onSort={toggleSort}>Status</SortTh><th>Trade</th></tr></thead>
          <tbody>{pg.slice.length ? pg.slice.map(c=><tr key={c.symbol}>
            <td className="symbol"><a href={'https://www.bybit.com/trade/usdt/'+c.symbol} target="_blank" rel="noopener noreferrer" style={{color:'#fafafa',fontWeight:700}}>{c.symbol}</a></td>
            <td><b className="red">−{c.dropPct.toFixed(2)}%</b></td><td>{price(c.peak)}</td><td>{price(c.trough)}</td><td>{price(c.lastPrice)}</td>
            <td><b className={c.excludedBuy?'red':'green'}>{c.excludedBuy?'BUY OPEN':'ELIGIBLE'}</b></td>
            <td><button type="button" className="row-act" disabled={c.excludedBuy} onClick={()=>setManualBuy(c.symbol)} title={c.excludedBuy?'There is already an open BUY':'Open a manual external BUY with explicit confirmation'}>Manual Buy</button></td>
          </tr>) : <tr><td className="empty" colSpan={7}>No candidates match the current threshold or filters.</td></tr>}</tbody>
        </table>
      </div>
      <Pager from={pg.from} to={pg.to} total={filtered.length} page={pg.page} pages={pg.pages} noun="symbols" onPage={setPage}/>
    </section>
    {manualBuy && <ManualOrderDialog key={manualBuy} symbol={manualBuy} side="Buy" enabled={state?.systemMetrics?.tradingMode==='REAL'&&state?.systemMetrics?.tradingState==='RUNNING'} onClose={()=>setManualBuy(null)} onDone={()=>void refresh()}/>}
  </div>;
}
