import {visibleLog} from '../../shared/visibleLog.ts';
import React, { useMemo, useState } from 'react';
import type { AlertItem, BotStateSummary, TradeLog } from '../../types/trading.ts';
import { tradeRecords } from './positionData.ts';
import { ReportColumn, ReportRow, ReportSummary, ReportTable, useRead } from './reports.tsx';
import { FilterChoices } from './FilterChoices.tsx';
import { num } from './table.tsx';
import { ALERTS_URL, TRADES_URL, isMartAlert } from './listCounts.ts';
// a UTC calendar day 'YYYY-MM-DD' shown as MM/DD/YYYY (the buckets stay UTC days)
const utcDay=(d:string)=>{const [y,m,dd]=d.split('-');return m+'/'+dd+'/'+y;};
type View='alerts'|'smart'|'logs'|'analytics'|'statistics';
const closeActions=new Set(['TP_CLOSE','CYCLE_CLOSE','MANUAL_CLOSE']);
export const LightReports:React.FC<{state:BotStateSummary|null;view:View}>=({state,view})=>{
  const isAlerts=view==='alerts'||view==='smart', isStats=view==='analytics'||view==='statistics';
  const source=useRead<{alerts?:AlertItem[];trades?:TradeLog[]}>(isAlerts?ALERTS_URL:isStats?TRADES_URL:null);
  const [side,setSide]=useState('ALL'),[category,setCategory]=useState('ALL'),[days,setDays]=useState(30);
  const all=useMemo(()=>tradeRecords(state?{...state,trades:source.data?.trades||[]}:null).filter(t=>t.mode==='LIVE'),[state,source.data]);
  const selected=all.filter(t=>(side==='ALL'||t.side===side)&&t.timestamp>=Date.now()-days*86400000);
  const closes=selected.filter(t=>closeActions.has(t.action)),wins=closes.filter(t=>t.pnl>0).length;
  const gross=selected.reduce((s,t)=>s+t.pnl,0),fees=selected.reduce((s,t)=>s+t.fee,0),net=gross-fees;
  const rows:ReportRow[]=[];
  let columns:ReportColumn[]=[], title='',note='';
  let summary:[string,string|number][]=[];
  if(isAlerts){
    let alerts=source.data?.alerts||[];
    if(view==='smart')alerts=alerts.filter(isMartAlert);
    if(category!=='ALL')alerts=alerts.filter(a=>a.level===category);
    alerts=alerts.slice().sort((a,b)=>b.timestamp-a.timestamp);
    for(const a of alerts)rows.push({id:a.id,time:a.timestamp,symbol:a.symbol||null,category:a.level,title:a.title,message:a.message,read:a.read?'Read':'Unread',ema:null,signal:null,manual:null});
    title=view==='smart'?'SMART MART ALERTS':'ALERT HISTORY';
    note=view==='smart'?'Recorded MART-related alerts only. EMA crossover signals and manual MART execution are not enabled.':'Stored bot alerts. Reading this page does not acknowledge or delete alerts.';
    columns=[{key:'time',label:'Recorded At',format:'time'},{key:'symbol',label:'Symbol'},{key:'category',label:'Level'},{key:'title',label:'Alert'},{key:'message',label:'Message'},{key:'read',label:'Read Status'},{key:'id',label:'Alert ID'}];
    if(view==='smart')columns.push({key:'ema',label:'1H EMA 50'},{key:'signal',label:'Crossover'},{key:'manual',label:'Manual MART'});
    summary=[['Stored Alerts',source.data?alerts.length:'—'],['Unread',source.data?alerts.filter(a=>!a.read).length:'—'],['Errors',source.data?alerts.filter(a=>a.level==='error').length:'—']];
  } else if(view==='logs'){
    for(const l of (state?.recentLogs||[]).filter(visibleLog).filter(l=>category==='ALL'||l.category===category).slice().sort((a,b)=>b.timestamp-a.timestamp))
      rows.push({id:l.id,time:l.timestamp,category:l.category,symbol:l.symbol||null,event:l.reason,message:l.result});
    title='BOT LOGS';note='Latest important bot logs. Routine funding-recovery messages are hidden; the complete audit record remains available in CSV.';
    columns=[{key:'time',label:'Time',format:'time'},{key:'category',label:'Category'},{key:'event',label:'Event'},{key:'symbol',label:'Symbol'},{key:'message',label:'Message'}];
    summary=[['Displayed Logs',state?rows.length:'—'],['Errors',state?rows.filter(r=>r.category==='ERROR').length:'—'],['Source','Bot audit log']];
  } else {
    const known=Boolean(source.data);
    summary=[['Recorded Closes',known?closes.length:'—'],['Gross Realized P&L',known?num(gross,4):'—'],['Recorded Fees',known?num(fees,4):'—'],['Realized Less Fees',known?num(net,4):'—'],['Gross Win Rate',known&&closes.length?num(wins/closes.length*100,2)+'%':'—'],['Funding','Not included']];
    const groups=new Map<string,{count:number;gross:number;fees:number;wins:number}>();
    for(const t of selected){
      const key=view==='analytics'?t.symbol+' · '+t.side:t.action;
      const g=groups.get(key)||{count:0,gross:0,fees:0,wins:0};
      if(closeActions.has(t.action)){g.count++;if(t.pnl>0)g.wins++;}
      g.gross+=t.pnl;g.fees+=t.fee;groups.set(key,g);
    }
    for(const [key,g] of groups)rows.push({id:key,group:key,count:g.count,gross:g.gross,fees:g.fees,net:g.gross-g.fees,win:g.count?g.wins/g.count*100:null});
    rows.sort((a,b)=>Number(b.net)-Number(a.net));
    title=view==='analytics'?'P&L BY SYMBOL / SIDE':'STATISTICS BY ACTION';
    note='Real bot execution records for the selected period. Includes all recorded opening and closing fees; excludes funding and unverified legacy records. Win rate uses gross P&L of recorded closes, not complete-cycle returns.';
    columns=[{key:'group',label:view==='analytics'?'Symbol / Side':'Action'},{key:'count',label:'Closes'},{key:'gross',label:'Gross Realized',format:'pnl'},{key:'fees',label:'Recorded Fees',format:'number'},{key:'net',label:'Realized Less Fees',format:'pnl'},{key:'win',label:'Gross Win Rate',format:'pct'}];
  }
  const daily=useMemo(()=>{
    const map=new Map<string,number>();
    for(const t of selected){if(!Number.isFinite(t.timestamp))continue;const day=new Date(t.timestamp).toISOString().slice(0,10);map.set(day,(map.get(day)||0)+t.pnl-t.fee);}
    return [...map].sort(([a],[b])=>a.localeCompare(b));
  },[all,days,side]);
  const max=Math.max(1,...daily.map(([,v])=>Math.abs(v)));
  return <div className="workspace lp-botpos lp-reports" data-testid={view+'-page'}>
    <ReportSummary items={summary}/>
    <div className="lp-risk-filter">
      {isStats?<><FilterChoices<number> label="Period" value={days} options={[1,7,30,90,365].map(d=>({value:d,label:'Last '+d+' days'}))} onChange={setDays}/><FilterChoices<string> label="Side" value={side} options={[{value:'ALL',label:'All Sides'},{value:'Buy',label:'BUY'},{value:'Sell',label:'SHORT'}]} onChange={setSide}/></>
       :<FilterChoices<string> label={view==='logs'?'Category':'Level'} value={category} options={[{value:'ALL',label:'All'},...(view==='logs'?[...new Set((state?.recentLogs||[]).map(l=>l.category))]:['info','success','warning','error']).map(c=>({value:c,label:c}))]} onChange={setCategory}/>}
      {view==='logs'&&<a className="report-link" href="/api/export/logs-csv" download>Export complete logs CSV</a>}
    </div>
    {source.error&&<div role="alert" className="lp-error">{source.error}</div>}
    <p className="lp-source-note">{note}</p>
    {view==='analytics'&&daily.length>0&&<section className="report-chart" aria-label="Daily realized P&L less recorded fees"><h3>Daily realized less fees (USDT, UTC days)</h3><div className="daily-bars">{daily.map(([day,v])=><div className="daily-bar" key={day} title={utcDay(day)+' UTC: '+num(v,4)+' USDT'}><span className={v>=0?'green':'red'}>{num(v,3)}</span><div className={'bar '+(v>=0?'positive':'negative')} style={{height:Math.max(2,Math.abs(v)/max*100)}}/><small>{utcDay(day)}</small></div>)}</div></section>}
    <ReportTable rows={rows} columns={columns} title={title} empty={source.loading?'Loading records…':source.error?'Data unavailable.':view==='smart'?'No recorded MART alerts.':'No recorded data in this selection.'}/>
  </div>;
};

