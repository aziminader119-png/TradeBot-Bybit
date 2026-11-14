import React, { useState } from 'react';
import { ReportColumn, ReportRow, ReportSummary, ReportTable, useRead } from './reports.tsx';
import { FilterChoices } from './FilterChoices.tsx';
import { num } from './table.tsx';
import { CLOSED_DEFAULT_DAYS, closedUrl } from './listCounts.ts';
type Closed = {id:string;symbol:string;positionSide:string;qty:number;entryPrice:number;exitPrice:number;closedPnl:number;leverage:number|null;closedAt:number;owner:string};
export const LightClosed:React.FC=()=>{
  const [days,setDays]=useState(CLOSED_DEFAULT_DAYS),[side,setSide]=useState('ALL'),[owner,setOwner]=useState('ALL');
  const read=useRead<{rows:Closed[];days:number}>(closedUrl(days),60000);
  const valid=read.data&&read.data.days===days?read.data.rows:null;
  const rows=(valid||[]).filter(r=>(side==='ALL'||r.positionSide===side)&&(owner==='ALL'||(owner==='Bot'?r.owner==='Bot':r.owner!=='Bot')));
  const total=rows.reduce((s,r)=>s+r.closedPnl,0);
  const out:ReportRow[]=rows.map(r=>({...r,entryValue:r.qty*r.entryPrice,returnPct:r.qty>0&&r.entryPrice>0?r.closedPnl/(r.qty*r.entryPrice)*100:null,owner:r.owner==='Bot'?'BOT':'Unmatched / external'}));
  const cols:ReportColumn[]=[{key:'symbol',label:'Symbol',format:'symbolSide'},{key:'qty',label:'Closed Qty',format:'number'},{key:'entryValue',label:'Entry Value',format:'number'},{key:'entryPrice',label:'Average Entry',format:'price'},{key:'exitPrice',label:'Average Exit',format:'price'},{key:'closedPnl',label:'Bybit Closed P&L',format:'pnl'},{key:'returnPct',label:'P&L / Entry Value',format:'pct'},{key:'closedAt',label:'Closed Time',format:'time'},{key:'owner',label:'Recorded Ownership'},{key:'id',label:'Order / Record ID'}];
  return <div className="workspace lp-botpos" data-testid="closed-positions-page">
    <ReportSummary items={[['Closed Records',valid?rows.length:'—'],['BUY / Long',valid?rows.filter(r=>r.positionSide==='Long').length:'—'],['SELL / Short',valid?rows.filter(r=>r.positionSide==='Short').length:'—'],['Closed P&L (USDT)',valid?num(total,4):'—'],['Win Rate',valid&&rows.length?num(rows.filter(r=>r.closedPnl>0).length/rows.length*100,2)+'%':'—']]}/>
    <div className="lp-risk-filter">
      <FilterChoices<number> label="Period" value={days} options={[1,7,30].map(d=>({value:d,label:'Last '+d+' days'}))} onChange={setDays}/>
      <FilterChoices<string> label="Side" value={side} options={[{value:'ALL',label:'All Sides'},{value:'Long',label:'BUY'},{value:'Short',label:'SHORT'}]} onChange={setSide}/>
      <FilterChoices<string> label="Owner" value={owner} options={[{value:'ALL',label:'All'},{value:'Bot',label:'BOT'},{value:'External',label:'Unmatched / external'}]} onChange={setOwner}/>
    </div>
    {read.error&&<div className="lp-error" role="alert">{read.error}</div>}
    <ReportTable rows={out} columns={cols} title="CLOSED POSITIONS" empty={read.loading?'Loading Bybit history…':read.error?'Bybit history unavailable.':'No closed positions in this selection.'}/>
  </div>;
};

