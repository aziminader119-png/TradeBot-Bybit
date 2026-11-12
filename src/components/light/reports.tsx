import {SymbolLink} from './SymbolLink.tsx';
import {ReportReadCache} from './reportReadCache.ts';
import React, { useEffect, useMemo, useState } from 'react';
import { Pager, RowsPicker, SortTh, num, price, tone, sortRows, usePaged, useSort } from './table.tsx';
import { DateTime, SideLabel, SymbolSide } from './format.tsx';
export type ReportRow = { id: string; [key: string]: string | number | null | undefined };
// symbolSide: row.symbol + row.leverage + row.positionSide on two lines; side: a POSITION side (BUY / SHORT colours)
export type ReportColumn = { key: string; label: string; format?: 'price' | 'number' | 'pnl' | 'time' | 'pct' | 'symbolSide' | 'side' };
// One loop and one private cached result per URL, shared by every mounted reader.
type Subscriber = {subs: Map<number, number>; listeners: Set<() => void>; timer: ReturnType<typeof setInterval> | null; expiry: ReturnType<typeof setTimeout> | null; ms: number};
const readers = new Map<string, Subscriber>();
const cache = new ReportReadCache((input, init) => fetch(input, init), url => readers.get(url)?.listeners.forEach(listener => listener()));
let subSeq = 0;
const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
function schedule(url: string, reader: Subscriber) {
  const ms = reader.subs.size ? Math.min(...reader.subs.values()) : 0;
  if (ms === reader.ms && (reader.timer || !ms)) return;
  if (reader.timer) clearInterval(reader.timer);
  reader.timer = ms ? setInterval(() => { if (visible()) void cache.load(url); }, ms) : null;
  reader.ms = ms;
}
export function refreshReportReads(historyOnly = false) {
  if (!visible()) return;
  for (const [url, reader] of readers) if (reader.subs.size && (!historyOnly || /^\/api\/(closed-positions|trades|alerts)(\?|$)/.test(url))) void cache.load(url);
}
export function refreshReportRead(url: string) { if (visible()) void cache.load(url); }
export function resetReportReads() { cache.reset(); refreshReportReads(); }
export function useRead<T>(url: string | null, ms = 15000) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!url) return;
    let reader = readers.get(url);
    if (!reader) { reader = {subs: new Map(), listeners: new Set(), timer: null, expiry: null, ms: 0}; readers.set(url, reader); }
    if (reader.expiry) { clearTimeout(reader.expiry); reader.expiry = null; }
    const id = ++subSeq, listener = () => force(n => n + 1), entry = cache.entry(url);
    reader.listeners.add(listener); reader.subs.set(id, ms); schedule(url, reader);
    if (visible() && (!entry.at || Date.now() - entry.at >= ms)) void cache.load(url); else listener();
    return () => {
      reader!.listeners.delete(listener); reader!.subs.delete(id); schedule(url, reader!);
      if (!reader!.subs.size) reader!.expiry = setTimeout(() => { cache.remove(url); readers.delete(url); }, 300000);
    };
  }, [url, ms]);
  const entry = url ? cache.entries.get(url) : undefined;
  return {data: (entry?.data ?? null) as T | null, error: entry?.error ?? null, loading: url ? Boolean(entry?.loading || !entry?.at) : false};
}
export function ReportSummary({items}:{items:[string,string|number][]}) {return <div className="page-summary">{items.map(([k,v])=><div className="summary-item" key={k}><div className="k">{k}</div><div className={'v '+(/P&L|Realized/.test(k)?tone(Number(String(v).replaceAll(',',''))):'')}>{v}</div></div>)}</div>;}
export function ReportTable({rows,columns,title,empty='No matching records.',renderActions}:{rows:ReportRow[];columns:ReportColumn[];title:string;empty?:string;renderActions?:(row:ReportRow)=>React.ReactNode}){
  const [q,setQ]=useState(''),[size,setSize]=useState(20),[page,setPage]=useState(1),[sort,toggle]=useSort<string>();
  const filtered=useMemo(()=>sortRows(rows.filter(r=>!q.trim()||Object.values(r).some(v=>typeof v==='string'&&v.toUpperCase().includes(q.trim().toUpperCase()))),sort,(r,k)=>r[k]),[rows,q,sort]);
  const pg=usePaged(filtered,size,page);
  const display=(v:string|number|null|undefined,c:ReportColumn,r:ReportRow):React.ReactNode=>{if(c.key==='symbol'&&typeof v==='string'&&/^[A-Z0-9]+USDT$/.test(v))return c.format==='symbolSide'?<SymbolSide symbol={v} leverage={r.leverage} side={r.positionSide}/>:<SymbolLink symbol={v} className="symbol-nav-link">{v}</SymbolLink>;if(c.format==='symbolSide')return <SymbolSide symbol={String(r.symbol??'')} leverage={r.leverage} side={r.positionSide}/>;if(c.format==='side')return <SideLabel side={v}/>;if(v===null||v===undefined||typeof v==='number'&&!Number.isFinite(v))return '—';if(c.format==='time')return <DateTime ts={v}/>;if(c.format==='price')return price(Number(v));if(c.format==='number'||c.format==='pnl')return num(Number(v),4);if(c.format==='pct')return num(Number(v),2)+'%';return v;};
  return <><div className="lp-toolbar"><div className="tb-left"><input type="search" className="search" aria-label="Search records" placeholder="Search records..." value={q} onChange={e=>{setQ(e.target.value);setPage(1);}}/></div></div>
    <div className="aged-table-title"><span>{title}</span></div><div className="table-wrap" role="region" tabIndex={0} aria-label={title+' table'}><table className="lp-table lp-report-table"><thead><tr>{columns.map(c=><SortTh key={c.key} k={c.key} s={sort} onSort={toggle}>{c.label}</SortTh>)}{renderActions && <th>Actions</th>}</tr></thead><tbody>{pg.slice.length?pg.slice.map(r=><tr key={r.id} title={'Record ID: '+r.id}>{columns.map(c=><td key={c.key} data-col={c.key} title={r[c.key]==null?'':String(r[c.key])} className={c.format==='pnl'?tone(typeof r[c.key]==='number'?r[c.key] as number:null):undefined}>{display(r[c.key],c,r)}</td>)}{renderActions && <td>{renderActions(r)}</td>}</tr>):<tr><td className="empty" colSpan={columns.length+(renderActions?1:0)}>{empty}</td></tr>}</tbody></table></div>
    <div className="tb-paging-row"><div className="tb-paging-rows"><RowsPicker size={size} onSize={n=>{setSize(n);setPage(1);}}/></div><Pager from={pg.from} to={pg.to} total={filtered.length} page={pg.page} pages={pg.pages} noun="records" onPage={setPage}/></div></>;
}



