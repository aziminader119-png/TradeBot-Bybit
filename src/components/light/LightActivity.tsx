import React, { useMemo, useState } from 'react';
import type { BotStateSummary } from '../../types/trading.ts';
import type { StrategyCycle } from '../../types/strategy.ts';
import { tradeRecords, triggerRecords } from './positionData.ts';
import { Pager, RowsPicker, SortTh, num, price, tone, usePaged, useSort, sortRows } from './table.tsx';
import { DateTime, SideLabel, SymbolSide } from './format.tsx';
import { FilterChoices } from './FilterChoices.tsx';
import { useRead } from './reports.tsx';
import { TRADES_URL } from './listCounts.ts';

/** Leverage of the recorded bot cycle side (current or archived cycle); null when the cycle is not known. */
function cycleLeverage(state: BotStateSummary | null, cycleId: string | null | undefined, side: string): number | null {
  if (!cycleId) return null;
  const c = [...Object.values(state?.strategyCycles || {}), ...(state?.cycleHistory || [])].find((x: StrategyCycle) => x.cycleId === cycleId);
  if (!c) return null;
  const v = side === 'Buy' ? c.leverageBuy ?? c.leverage : c.leverageSell ?? c.leverage;
  return typeof v === 'number' && v > 0 ? v : null;
}
type Cell = string | number | null;
type Row = { key: string; symbol: string; side: string; status: string; mode: string; at: number; lev: number | null; cells: Record<string, Cell>; note?: string };
type Column = { key: string; label: string; format?: 'price' | 'number' | 'time' | 'pnl' };
export const LightActivity: React.FC<{ state: BotStateSummary | null; view: 'trades' | 'triggers' }> = ({ state, view }) => {
  const trades = view === 'trades';
  const [q,setQ] = useState(''), [side,setSide] = useState('ALL'), [mode,setMode] = useState('LIVE'), [status,setStatus] = useState('ALL');
  const [from,setFrom] = useState(''), [to,setTo] = useState('');
  const [size,setSize] = useState(20), [page,setPage] = useState(1);
  const [sort,toggle] = useSort<string>();
  // complete stored execution list (shared cached read, same source as the sidebar count), not only the snapshot's latest 100
  const stored = useRead<{ trades: any[] }>(trades ? TRADES_URL : null, 15000);
  const records = useMemo(() => tradeRecords(state && stored.data ? { ...state, trades: stored.data.trades || [] } : null), [state, stored.data]);
  const triggers = useMemo(() => triggerRecords(state), [state]);
  const rows: Row[] = useMemo(() => trades ? records.map(t => ({
    key:t.rowKey, symbol:t.symbol, side:t.side, mode:t.mode, at:t.timestamp, status:t.action, note:t.notes,
    lev: cycleLeverage(state, t.cycleId, t.side),
    cells:{ order:t.orderId || null, time:t.timestamp, symbol:t.symbol, side:t.orderSide, position:t.side,
      type:null, qty:t.qty, price:t.price, value:t.notional, fee:t.fee, funding:null, slippage:null, pnl:t.pnl, action:t.action }
  })) : triggers.map(t => ({key:t.id, symbol:t.symbol, side:t.side, mode:t.mode, status:t.status, at:t.createdAt, note:t.note, lev:t.leverage,
    cells:{id:t.id,symbol:t.symbol,position:t.side,entry:t.entry,tp:t.tp,trigger:t.trigger,margin:t.margin,leverage:t.leverage,
      status:t.status,direction:t.direction,parent:t.parent,time:t.createdAt,order:t.orderId}
  })),[records,triggers,trades,state]);
  const filtered = useMemo(() => {
    const start = from ? new Date(from+'T00:00:00').getTime() : -Infinity;
    const end = to ? new Date(to+'T23:59:59.999').getTime() : Infinity;
    const list = rows.filter(r => (!q.trim() || r.symbol.toUpperCase().includes(q.trim().toUpperCase()) || String(r.cells.order || r.key).toUpperCase().includes(q.trim().toUpperCase()))
      && (side === 'ALL' || r.side === side) && (mode === 'ALL' || r.mode === mode) && (status === 'ALL' || r.status === status)
      && (!from && !to || Number.isFinite(r.at) && r.at >= start && r.at <= end));
    return sortRows(list.sort((a,b)=>b.at-a.at || a.key.localeCompare(b.key)),sort,(r,k)=>r.cells[k]);
  },[rows,q,side,mode,status,from,to,sort]);
  const pg=usePaged(filtered,size,page);
  const columns: Column[] = trades ? [
    {key:'order',label:'Order ID'},{key:'time',label:'Executed At',format:'time'},{key:'symbol',label:'Symbol'},
    {key:'side',label:'Order Side'},{key:'type',label:'Order Type'},
    {key:'qty',label:'Filled Qty',format:'number'},{key:'price',label:'Fill Price',format:'price'},
    {key:'value',label:'Turnover (USDT)',format:'number'},{key:'fee',label:'Fee (USDT)',format:'number'},
    {key:'funding',label:'Funding Rate'},{key:'slippage',label:'Slippage'},{key:'pnl',label:'Gross Realized P&L',format:'pnl'},{key:'action',label:'Action'}
  ] : [
    {key:'id',label:'Cycle Side / Order Link ID'},{key:'symbol',label:'Symbol'},
    {key:'entry',label:'Entry Price',format:'price'},{key:'tp',label:'TP Price',format:'price'},
    {key:'trigger',label:'Trigger Price',format:'price'},{key:'margin',label:'Margin',format:'number'},
    {key:'status',label:'Status'},{key:'direction',label:'Re-entry Rule'},
    {key:'parent',label:'Parent TP Order'},{key:'time',label:'Recorded At',format:'time'},{key:'order',label:'Re-entry Order'}
  ];
  const reset = (fn: (v:string)=>void, v:string) => {fn(v);setPage(1);};
  const stats = trades ? [
    ['Executions',filtered.length],['BUY position fills',filtered.filter(r=>r.side==='Buy').length],['SELL position fills',filtered.filter(r=>r.side==='Sell').length],
    ['Turnover (USDT)',num(filtered.reduce((s,r)=>s+(typeof r.cells.value==='number'?r.cells.value:0),0),4)],
    ['Recorded Fees',num(filtered.reduce((s,r)=>s+(typeof r.cells.fee==='number'?r.cells.fee:0),0),4)],
    ['Gross Realized P&L',num(filtered.reduce((s,r)=>s+(typeof r.cells.pnl==='number'?r.cells.pnl:0),0),4)]
  ] : [['Total',filtered.length],['Pending TP',filtered.filter(r=>r.status==='Pending TP').length],
    ['Waiting reopen',filtered.filter(r=>r.status==='Waiting reopen').length],['Executed',filtered.filter(r=>r.status==='Executed').length],
    ['Paused',filtered.filter(r=>r.status==='Paused').length],['Needs review',filtered.filter(r=>r.status==='Needs review').length]];
  // symbol + leverage + POSITION side on two lines; the order side (Buy / Sell order) is shown separately, uncoloured
  const render=(v:Cell,col:Column,r:Row):React.ReactNode => col.key==='symbol' ? <SymbolSide symbol={r.symbol} leverage={r.lev} side={r.side}/>
    : col.key==='position' ? <SideLabel side={v}/> : col.key==='side' && trades ? (v ? `${v} order` : '—')
    : v===null ? '—' : col.format==='time' ? <DateTime ts={v}/> : col.format==='price' ? price(Number(v))
    : col.format==='number' || col.format==='pnl' ? num(Number(v),6) : v;
  return <div className="workspace lp-botpos lp-activity" data-testid={trades?'trade-history-page':'trigger-orders-page'}>
    <div className="page-summary">{stats.map(([label,value])=><div className="summary-item" key={label}><div className="k">{label}</div><div className="v">{state&&(!trades||stored.data)?value:'—'}</div></div>)}</div>
    <div className="lp-toolbar">
      <div className="tb-left"><input className="search" type="search" placeholder="Search symbol or order..." aria-label="Search symbol or order" value={q} onChange={e=>reset(setQ,e.target.value)}/></div>
      <RowsPicker size={size} onSize={n=>{setSize(n);setPage(1);}}/>
      <FilterChoices label="Side" className="tb-right" value={side} options={[{value:'ALL',label:'All Sides'},{value:'Buy',label:'BUY'},{value:'Sell',label:'SHORT'}]} onChange={s=>reset(setSide,s)}/>
    </div>
    <div className="lp-risk-filter">
      <FilterChoices label="Mode" value={mode} options={[{value:'LIVE',label:'Real / LIVE'},{value:'PAPER',label:'Simulation / PAPER'},...(trades?[{value:'LEGACY',label:'Legacy / unverified'}]:[]),{value:'ALL',label:'All modes'}]} onChange={s=>reset(setMode,s)}/>
      <FilterChoices label={trades?'Action':'Status'} value={status} options={[{value:'ALL',label:'All'},...[...new Set(rows.map(r=>r.status))].sort().map(s=>({value:s,label:s}))]} onChange={s=>reset(setStatus,s)}/>
      <label>From <input type="date" value={from} onChange={e=>reset(setFrom,e.target.value)}/></label>
      <label>To <input type="date" value={to} onChange={e=>reset(setTo,e.target.value)}/></label>
    </div>
    <div className="aged-table-title"><span>{trades?'TRADE EXECUTION LOGS':'TRIGGER ORDERS'}</span></div>
    <p className="lp-source-note">{trades
      ? 'Bot execution records, not full Bybit account history. Side filters use position side. Missing order type, funding rate and slippage show —. Gross P&L excludes fees and funding.'
      : 'Internal bot TP / re-entry lifecycle, not Bybit conditional orders. Immediate re-entry has no trigger price. No create, cancel or trading action is available here.'}</p>
    <div className="table-wrap"><table className="lp-table lp-activity-table"><thead><tr>{columns.map(col=><SortTh key={col.key} k={col.key} s={sort} onSort={toggle}>{col.label}</SortTh>)}</tr></thead><tbody>
      {!pg.slice.length?<tr><td className="empty" colSpan={columns.length}>{!state||(trades&&!stored.data)?(stored.error?'Execution records unavailable: '+stored.error:'Loading bot records...'):trades?'No matching recorded executions.':'No matching internal triggers or re-entry orders.'}</td></tr>:pg.slice.map(r=><tr key={r.key} title={[r.mode,r.note].filter(Boolean).join(' · ')}>{columns.map(col=><td key={col.key} data-col={col.key} title={r.cells[col.key]===null?'Not recorded':String(r.cells[col.key])} className={col.format==='pnl'?tone(Number(r.cells[col.key])):undefined}>{render(r.cells[col.key],col,r)}</td>)}</tr>)}
    </tbody></table></div>
    <Pager from={pg.from} to={pg.to} total={filtered.length} page={pg.page} pages={pg.pages} noun={trades?'executions':'triggers / re-entries'} onPage={setPage}/>
  </div>;
};
