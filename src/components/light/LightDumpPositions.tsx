import React,{useEffect,useMemo,useState} from 'react';
import {ReportSummary,ReportTable,type ReportColumn,type ReportRow} from './reports.tsx';

type Trade={id:string;symbol:string;status:string;entryPrice:number;exitPrice:number|null;qty:number;target:number;
  peak:number;trough:number;entryAt:number;exitAt:number|null;markPrice:number|null;
  unrealizedPnl:number|null;realizedPnl:number|null;note:string|null};
type Snapshot={armed:boolean;mode:string;busy:boolean;error:string|null;closedCount:number;realizedPnlUsdt:number;trades:Trade[]};
const columns:ReportColumn[]=[
  {key:'symbol',label:'Symbol'},{key:'side',label:'Side',format:'side'},
  {key:'size',label:'Size',format:'number'},{key:'value',label:'Value (USDT)',format:'number'},
  {key:'entry',label:'Entry',format:'price'},{key:'mark',label:'Mark',format:'price'},
  {key:'exit',label:'Exit',format:'price'},{key:'target',label:'Exit Target',format:'price'},
  {key:'waveLow',label:'Wave Low',format:'price'},{key:'waveHigh',label:'Wave High',format:'price'},
  {key:'opened',label:'Opened',format:'time'},{key:'closed',label:'Closed',format:'time'},
  {key:'pnl',label:'P&L (USDT)',format:'pnl'},{key:'status',label:'Status'},
];
function row(t:Trade):ReportRow{return {id:t.id,symbol:t.symbol,side:'Buy',size:t.qty,value:t.entryPrice*t.qty,
  entry:t.entryPrice,mark:t.markPrice,exit:t.exitPrice,target:t.target,waveLow:t.trough,waveHigh:t.peak,
  opened:t.entryAt,closed:t.exitAt,pnl:t.status==='CLOSED'?t.realizedPnl:t.unrealizedPnl,
  status:t.note?`${t.status} — ${t.note}`:t.status};}
export function LightDumpPositions(){
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[error,setError]=useState('');
  useEffect(()=>{let alive=true;const refresh=async()=>{try{const res=await fetch('/api/dump-buy/positions');const data=await res.json();if(!res.ok)throw Error(data.error||'Unable to load Dump BUY positions');if(alive){setSnapshot(data);setError('');}}catch(e:any){if(alive)setError(e.message||String(e));}};
    void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>{alive=false;clearInterval(timer);};},[]);
  const rows=useMemo(()=>(snapshot?.trades||[]).map(row),[snapshot?.trades]);
  const closed=rows.filter(r=>String(r.status).startsWith('CLOSED'));
  const active=rows.filter(r=>!String(r.status).startsWith('CLOSED'));
  const completed=(snapshot?.trades||[]).filter(t=>t.status==='CLOSED'&&t.exitPrice!==null);
  const closedPnl=completed.reduce((sum,t)=>sum+(t.realizedPnl??(t.exitPrice!-t.entryPrice)*t.qty),0);
  return <div className="workspace pump-positions-page" data-testid="dump-positions-page">
    {(error||snapshot?.error)&&<p className="lp-error" role="alert">{error||snapshot?.error}</p>}
    <section className="lp-panel symbols-overview"><div className="section-title">Dump BUY Positions</div>
      <ReportSummary items={[["Open / Pending",active.length],["Closed",snapshot?.closedCount||0],
        ["Execution",snapshot?.armed?'ARMED':'DISARMED'],["Realized P&L (USDT)",(snapshot?.realizedPnlUsdt||0).toFixed(4)]]}/></section>
    <section className="lp-panel pump-positions-table"><ReportTable title="Open & Pending Dump BUY Positions" rows={active} columns={columns} empty="No open Dump BUY positions."/></section>
    <section className="lp-panel pump-positions-table">
      <ReportSummary items={[[ 'Closed Positions',completed.length ],[ 'Closed P&L (USDT)',closedPnl.toFixed(4) ]]}/>
      <ReportTable title="Closed Dump BUY Positions" rows={closed} columns={columns} empty="No closed Dump BUY positions."/>
    </section>
  </div>;
}
