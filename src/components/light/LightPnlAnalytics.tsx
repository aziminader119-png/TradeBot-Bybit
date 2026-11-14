import {SymbolLink} from './SymbolLink.tsx';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import type {BotStateSummary,TradeLog} from '../../types/trading.ts';
import {useRead} from './reports.tsx';
import {TRADES_URL,closedUrl} from './listCounts.ts';
import {FilterChoices} from './FilterChoices.tsx';
import {DateTime} from './format.tsx';
import {PnlMode,pnlCloseRecords,pnlStats,dailyPnl,utcKey,valueOf,topSymbols,topLosingCloses,fundingTotal,type FillIntent} from './pnlMath.ts';
import {syncedPositions} from './LightShell.tsx';
import {LightReports} from './LightReports.tsx';
const PNL_URL=TRADES_URL+'?withIntents=1';
const money=(v:number|null)=>v===null||!Number.isFinite(v)?'—':(v<0?'−':v>0?'+':'')+'$'+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const color=(v:number|null)=>v===null?'':v>0?'green':v<0?'red':'';
const n=(v:number|null,d=1)=>v===null?'—':v.toLocaleString('en-US',{maximumFractionDigits:d});
const shortDay=(s:string)=>s.slice(5,7)+'/'+s.slice(8,10);
const Reason:Record<string,string>={TP_CLOSE:'TP Execution',CYCLE_CLOSE:'Cycle Close',MANUAL_CLOSE:'Manual Close'};
const Metric:React.FC<{label:string;value:React.ReactNode;tone?:string;title?:string}>=({label,value,tone='',title})=><div className="metric" title={title}><div className="name">{label}</div><div className={'val '+tone}>{value}</div></div>;

type Point={day:string;value:number;buy?:number;sell?:number;count?:number};
type BybitClosed={id:string;symbol:string;positionSide:string;closedPnl:number;closedAt:number};
export function PnlChart({data,type='bars',empty='No recorded closed trades.'}:{data:Point[];type?:'bars'|'line'|'sides'|'count';empty?:string}){
 const [hover,setHover]=useState<number|null>(null),[width,setWidth]=useState(700);
 const wrapper=useRef<HTMLDivElement|null>(null);
 useEffect(()=>{
  const el=wrapper.current;if(!el)return;
  const size=()=>setWidth(Math.max(240,Math.round(el.getBoundingClientRect().width)));
  size();const observer=new ResizeObserver(size);observer.observe(el);return()=>observer.disconnect();
 },[Boolean(data.length)]);
 const span=width-75;
 if(!data.length)return <div className="pnl-empty">{empty}</div>;
 const values=type==='sides'?data.flatMap(d=>[d.buy||0,d.sell||0]):data.map(d=>type==='count'?d.count||0:d.value);
 const lo=Math.min(0,...values),hi=Math.max(0,...values),pad=(hi-lo||1)*.12;
 const min=lo-pad,max=hi+pad,y=(v:number)=>18+(max-v)/(max-min)*204;
 const x=(i:number)=>53+(data.length===1?span/2:i*span/(data.length-1)),step=span/Math.max(data.length,1);
 const path=(get:(p:Point)=>number)=>data.map((d,i)=>(i?'L':'M')+x(i)+','+y(get(d))).join(' ');
 const ticks=[...new Set(Array.from({length:Math.min(width<450?3:6,data.length)},(_,i)=>Math.round(i*(data.length-1)/Math.max(1,Math.min(width<450?3:6,data.length)-1))))];
 const selected=hover!==null&&hover<data.length?data[hover]:null;
 return <div ref={wrapper} className="pnl-chart-wrap"><svg className="chart" preserveAspectRatio="none" onPointerLeave={()=>setHover(null)} onPointerMove={e=>{const box=e.currentTarget.getBoundingClientRect(),px=(e.clientX-box.left)/box.width*width;setHover(Math.max(0,Math.min(data.length-1,Math.round((px-53)/span*(data.length-1)))));}} viewBox={`0 0 ${width} 255`} role="img" aria-label={type==='sides'?'BUY versus SHORT realized P&L':type==='line'?'Cumulative realized P&L':type==='count'?'Closed trades by UTC day':'Daily realized P&L'}>
  {Array.from({length:5},(_,i)=>{const v=max-(max-min)*i/4;return <g key={i}><line className="gridline" x1="53" x2={width-22} y1={y(v)} y2={y(v)}/><text className="axis" x="44" y={y(v)+4} textAnchor="end">{n(v,2)}</text></g>})}
  <line className="zero-line" x1="53" x2={width-22} y1={y(0)} y2={y(0)}/>
  {(type==='bars'||type==='count')?data.map((d,i)=>{const v=type==='count'?d.count||0:d.value;return <rect key={d.day} x={x(i)-Math.min(22,step*.65)/2} width={Math.max(1,Math.min(22,step*.65))} y={Math.min(y(v),y(0))} height={Math.max(1,Math.abs(y(v)-y(0)))} fill={type==='count'?'var(--green)':v>=0?'var(--green)':'var(--red)'}><title>{d.day+' UTC · '+(type==='count'?v+' closes':money(v))}</title></rect>})
    : type==='sides'?<><path d={path(d=>d.buy||0)} fill="none" stroke="var(--green)" strokeWidth="2"/><path d={path(d=>d.sell||0)} fill="none" stroke="var(--red)" strokeWidth="2"/></>:<path d={path(d=>d.value)} fill="none" stroke="var(--blue)" strokeWidth="2"/>}
  {data.map((d,i)=><circle key={d.day} cx={x(i)} cy={y(type==='count'?d.count||0:d.value)} r="5" fill="transparent"><title>{d.day+' UTC · '+money(d.value)+(type==='sides'?' · BUY '+money(d.buy||0)+' · SHORT '+money(d.sell||0):'')}</title></circle>)}
  {selected&&hover!==null&&<line className="pnl-hover-line" x1={x(hover)} x2={x(hover)} y1="18" y2="222"/>}
  {data.length===1&&type!=='bars'&&type!=='count'&&<circle cx={x(0)} cy={y(data[0].value)} r="3" fill="var(--blue)"/>}
  {ticks.map(i=><text className="axis" key={i} x={x(i)} y="246" textAnchor="middle">{shortDay(data[i].day)}</text>)}
 </svg>{selected&&<div className="pnl-chart-tooltip" role="status" style={{left:Math.min(65,(hover||0)/Math.max(1,data.length-1)*80)+'%'}}><strong>{selected.day} UTC</strong>{type==='count'?<span>{selected.count||0} closed trades</span>:type==='sides'?<><span className="green">BUY {money(selected.buy??0)}</span><span className="red">SHORT {money(selected.sell??0)}</span></>:<span className={color(selected.value)}>{money(selected.value)}</span>}</div>}</div>;
}
export const LightPnlAnalytics:React.FC<{state:BotStateSummary|null}>=({state})=>{
 const read=useRead<{trades:TradeLog[];fillIntents?:FillIntent[];cycleHistory?:any[]}>(PNL_URL,15000);
 const bybitClosed=useRead<{rows:BybitClosed[];days:number}>(closedUrl(30),60000);
 const [range,setRange]=useState('All Time'),[side,setSide]=useState('ALL'),[mode,setMode]=useState<PnlMode>('NET');
 const [compareSide,setCompareSide]=useState('ALL'),[profitSide,setProfitSide]=useState('ALL'),[lossSide,setLossSide]=useState('ALL');
 const [topSort,setTopSort]=useState<Record<string,{key:'symbol'|'side'|'count'|'value';desc:boolean}>>({});
 const [month,setMonth]=useState(()=>{const d=new Date();return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1);});
 const ledger=useMemo(()=>pnlCloseRecords(state&&read.data?{...state,trades:read.data.trades||[]}:null,read.data?.fillIntents||[]),[state,read.data]);
 const now=Date.now(),since=range==='Daily'?now-86400000:range==='Weekly'?now-7*86400000:range==='Monthly'?now-30*86400000:-Infinity;
 const rows=ledger.filter(r=>r.time>=since&&(side==='ALL'||r.side===side));
 const stats=pnlStats(rows,mode),available=Boolean(read.data&&state),complete=available&&stats.complete,partial=available&&!stats.complete;
 // labels for figures that cover only part of the closes (Net with unverified fees): never presented as complete
 const P=(label:string)=>partial?label+' (partial)':label;
 const funding=fundingTotal(read.data?.cycleHistory,since);
 const openUpnl=(syncedPositions(state)||[]).reduce((s,p)=>s+(Number.isFinite(p.unrealizedPnl)?p.unrealizedPnl:0),0),hasOpen=Boolean(syncedPositions(state));
 const daily=dailyPnl(rows,mode);
 let total=0;const cumulative=daily.map(d=>({...d,value:total+=d.value}));
 const comparison=dailyPnl(rows.filter(r=>compareSide==='ALL'||r.side===compareSide),mode);let b=0,s=0;
 const compare=comparison.map(d=>({...d,buy:b+=d.buy,sell:s+=d.sell,value:b+s}));
 const sideOptions=[{value:'ALL',label:'All'},{value:'Buy',label:'BUY'},{value:'Sell',label:'SHORT'}];
 const bybitLosses=useMemo(()=>{
  const bySymbol=new Map<string,{symbol:string;side:string;count:number;covered:number;value:number;partial:boolean}>();
  if(bybitClosed.data?.days!==30||!Array.isArray(bybitClosed.data?.rows))return [];
  for(const t of bybitClosed.data.rows){
   if(!Number.isFinite(t.closedPnl)||t.closedPnl>=0||!t.symbol)continue;
   const side=t.positionSide==='Long'?'Buy':t.positionSide==='Short'?'Sell':null;
   if(!side)continue;
   const key=t.symbol+'|'+side;
   const group=bySymbol.get(key)||{symbol:t.symbol,side,count:0,covered:0,value:0,partial:false};
   group.count++;group.covered++;group.value+=t.closedPnl;bySymbol.set(key,group);
  }
  return [...bySymbol.values()].sort((a,b)=>a.value-b.value).slice(0,10);
 },[bybitClosed.data]);
 const topRows=(filter:string,profitable:boolean)=>profitable?topSymbols(rows.filter(r=>filter==='ALL'||r.side===filter),mode,true):bybitLosses.filter(r=>filter==='ALL'||r.side===filter);
 const top=(profitable:boolean)=>{const id=profitable?'profit':'loss',selection=topSort[id],original=topRows(profitable?profitSide:lossSide,profitable);
  const panelAvailable=profitable?available:Boolean(bybitClosed.data?.days===30&&Array.isArray(bybitClosed.data?.rows));
  const sorted=selection?[...original].sort((a,b)=>{const x=a[selection.key],y=b[selection.key];const result=typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y));return selection.desc?-result:result;}):original;
  const sortBy=(key:'symbol'|'side'|'count'|'value')=>setTopSort(current=>({...current,[id]:{key,desc:current[id]?.key===key?!current[id].desc:key==='count'||key==='value'}}));
  return <section className="panel"><h3>Top 10 <span className={profitable?'green':'red'}>{profitable?'PROFITABLE':'LOSING'}</span> Symbols</h3>
  <div className="pnl-panel-filters"><FilterChoices<string> label="" value={profitable?profitSide:lossSide} options={sideOptions} onChange={profitable?setProfitSide:setLossSide}/></div>
  <table><thead><tr>{([['symbol','Symbol'],['side','Side'],['count','Closed Trades'],['value',profitable?'Realized P&L':'Loss on losing closes']] as const).map(([key,label])=><th key={key} className="sort" role="button" tabIndex={0} aria-sort={selection?.key===key?(selection.desc?'descending':'ascending'):'none'} onClick={()=>sortBy(key)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();sortBy(key);}}}>{label} <span aria-hidden="true">{selection?.key===key?(selection.desc?'↓':'↑'):'↕'}</span></th>)}</tr></thead><tbody>{panelAvailable&&sorted.length?sorted.map(g=><tr key={g.symbol+g.side} title={g.partial?'Some closes have unverified fees and are excluded from Net':'Recorded closed trades'}><td><SymbolLink symbol={g.symbol} title={g.symbol} className="symbol-nav-link"><strong>{g.symbol}</strong></SymbolLink></td><td className={g.side==='Buy'?'pos-buy':'pos-short'}>{g.side==='Buy'?'BUY':'SHORT'}</td><td>{g.count}</td><td className={color(g.value)}>{money(g.value)}{g.partial?' *':''}</td></tr>):<tr><td colSpan={4} className="pnl-table-empty">{profitable?(available?'No profitable closes in this selection.':'—'):bybitClosed.error?'History unavailable':panelAvailable?'No negative closed P&L in Bybit history for the last 30 days.':'Loading Bybit closed history…'}</td></tr>}</tbody></table>
 </section>};
 const reasonGroups=new Map<string,{count:number;value:number;known:boolean}>();
 for(const r of rows){const g=reasonGroups.get(r.reason)||{count:0,value:0,known:true};g.count++;const v=valueOf(r,mode);if(v===null)g.known=false;else g.value+=v;reasonGroups.set(r.reason,g);}
 const activity=new Map<string,number>();for(const r of rows)activity.set(r.symbol,(activity.get(r.symbol)||0)+1);
 const mostActive=[...activity].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]||'—';
 const timed=rows.filter(r=>r.durationMs!==null),duration=timed.length?timed.reduce((s,r)=>s+r.durationMs!,0)/timed.length/60000:null;
 const daySpan=rows.length?Math.max(1,(rows[rows.length-1].time-rows[0].time)/86400000):0;
 const dayMap=new Map(daily.map(d=>[d.day,d]));
 const md=new Date(month),year=md.getUTCFullYear(),m=md.getUTCMonth(),days=new Date(Date.UTC(year,m+1,0)).getUTCDate(),offset=(md.getUTCDay()+6)%7;
 const exportCsv=()=>{
  const csv=(v:string|number|null)=>v===null?'':typeof v==='number'?String(v):'"'+v.replaceAll('"','""')+'"';
  const lines=[['Order ID','Symbol','Position Side','Closed At UTC','Gross PnL','Matched Entry+Exit Fees','Net Excluding Funding','Duration Minutes','Close Reason'],...rows.map(r=>[r.orderId,r.symbol,r.side,new Date(r.time).toISOString(),r.gross,r.fee,r.net,r.durationMs===null?null:r.durationMs/60000,r.reason])];
  const blob=new Blob(['\uFEFF'+lines.map(row=>row.map(csv).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8;'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='tradebot-pnl-'+mode.toLowerCase()+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),0);
 };
 const chart=(data:Point[],type:'bars'|'line'|'sides'|'count'='bars')=><PnlChart data={available?data:[]} type={type} empty={!available?(read.error?'Data unavailable.':'Loading real records…'):'No recorded closed trades.'}/>;
 return <div className="pnl-design tb-v19-pnl" data-testid="pnl-analytics-page">
  <div className="tb-v19-pnl-toolbar"><FilterChoices<string> label="TIME RANGE" value={range} options={['Daily','Weekly','Monthly','All Time'].map(v=>({value:v,label:v}))} onChange={setRange}/><FilterChoices<string> label="SIDE" value={side} options={sideOptions} onChange={setSide}/><FilterChoices<PnlMode> label="P&L MODE" value={mode} options={[{value:'NET',label:'Net'},{value:'GROSS',label:'Gross'}]} onChange={setMode}/><button className="export" type="button" disabled={!available||!rows.length} onClick={exportCsv}>Export CSV</button></div>
  {read.error&&<span className="tb-v19-pnl-indicator" role="status">Data unavailable</span>}
  {partial&&<span className="tb-v19-pnl-indicator" role="status" data-testid="pnl-coverage" title="Net is calculated only for closes with verified entry and exit fees">NET PARTIAL · {stats.covered}/{stats.count}</span>}
  <div className="tb-v19-pnl-summary">
   <Metric label={P('Total P&L')} value={available?money(stats.total):'—'} tone={color(stats.total)}/><Metric label="Total Profit" value={available?money(stats.profit):'—'} tone="green"/><Metric label="Total Loss" value={available?money(stats.loss):'—'} tone="red"/>
   <Metric label="Closed Trades" value={available?(partial?stats.covered+' / '+stats.count:stats.count):'—'} title={partial?'Closes with verified fees / all closes in the selection':undefined}/><Metric label="Winning Trades" value={available?stats.wins??'—':'—'}/><Metric label="Losing Trades" value={available?stats.losses??'—':'—'}/><Metric label="Win Rate" value={available&&stats.winRate!==null?n(stats.winRate,2)+'%':'—'}/>
   <Metric label="Average P&L" value={available?money(stats.average):'—'} tone={color(stats.average)}/><Metric label="Best Trade" value={available?money(stats.best):'—'} tone={color(stats.best)}/><Metric label="Worst Trade" value={available?money(stats.worst):'—'} tone={color(stats.worst)}/>
  </div>
  <div className="tb-v19-pnl-grid">
   <section className="panel"><h3>Daily Realized P&amp;L</h3>{chart(daily)}</section>
   <section className="panel"><h3>Cumulative P&amp;L</h3>{chart(cumulative,'line')}</section>
   <section className="panel"><h3>BUY VS SHORT P&amp;L</h3><div className="pnl-panel-filters"><FilterChoices<string> label="" value={compareSide} options={sideOptions} onChange={setCompareSide}/></div>{chart(compare,'sides')}<div className="pnl-legend"><span className="green">BUY</span><span className="red">SHORT</span></div></section>
   <section className="panel"><h3>Profit Vs Loss</h3>{available&&stats.covered>0?<>
    <div className="pnl-stack" role="img" aria-label={stats.wins+' winning, '+stats.losses+' losing, '+stats.flat+' breakeven closed trades'}><span style={{width:(stats.wins!/stats.covered*100)+'%',background:'var(--green)'}}/><span style={{width:(stats.losses!/stats.covered*100)+'%',background:'var(--red)'}}/><span style={{width:(stats.flat!/stats.covered*100)+'%',background:'#585861'}}/></div>
    <div className="pnl-stack-labels"><span className="green">Winning Trades · {stats.wins} ({n(stats.winRate,1)}%)</span><span className="red">Losing Trades · {stats.losses} ({n(stats.losses!/stats.covered*100,1)}%)</span></div>{Boolean(stats.flat)&&<small className="pnl-flat">Breakeven · {stats.flat}</small>}
   </>:<div className="pnl-outcomes-empty">{!available?'Loading real records…':stats.count&&!stats.covered?'No close in this selection has verified fees for Net. Gross is available.':'No recorded closed trades.'}</div>}
    <div className="pnl-breakdown">{(['Buy','Sell'] as const).map(sd=>{const st=pnlStats(rows.filter(r=>r.side===sd),mode);return <div className="pnl-mini" key={sd}><h4 className={sd==='Buy'?'green':'red'}>{sd==='Buy'?'BUY':'SHORT'}</h4><div className="pnl-mini-row"><Metric label="Trades" value={available?st.count:'—'}/><Metric label="Wins" value={available?st.wins??'—':'—'}/><Metric label="P&L" tone={color(st.total)} value={available?money(st.total):'—'}/></div></div>})}</div>
   </section>
   {top(true)}{top(false)}
   <section className="panel"><h3>Daily Performance Calendar</h3><div className="calendar-header"><button type="button" aria-label="Previous month" onClick={()=>setMonth(Date.UTC(year,m-1,1))}>‹</button><strong>{md.toLocaleString('en-US',{month:'long',year:'numeric',timeZone:'UTC'})}</strong><button type="button" aria-label="Next month" onClick={()=>setMonth(Date.UTC(year,m+1,1))}>›</button></div><div className="calendar">{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=><div className="cal-head" key={d}>{d}</div>)}{Array.from({length:offset},(_,i)=><div className="cal-day empty" key={'empty'+i}/>)}{Array.from({length:days},(_,i)=>{const key=utcKey(Date.UTC(year,m,i+1)),d=dayMap.get(key);return <div className={'cal-day '+(d&&d.covered?d.value>0?'cal-profit':d.value<0?'cal-loss':'':'')} key={key} title={key+' UTC · '+(available?(d?.count||0)+' recorded closes'+(d&&!d.known?' ('+d.covered+' with verified fees: partial)':''):'Unavailable')}><b>{i+1}</b>{d&&<><span className={d.known?color(d.value):''}>{d.known?money(d.value):'—'}</span><small>{d.count} closes</small></>}</div>})}</div></section>
   <section className="panel"><h3>Performance Metrics</h3><div className="metrics2"><Metric label="Average Winning Trade" value={available?money(stats.avgWin):'—'} tone="green"/><Metric label="Average Losing Trade" value={available?money(stats.avgLoss):'—'} tone="red"/><Metric label="Profit Factor" value={available?stats.profitFactor===Infinity?'∞':n(stats.profitFactor,2):'—'}/><Metric label="Maximum Drawdown" title="Drawdown of this recorded realized-P&L curve, not account equity." value={available?money(stats.drawdown):'—'} tone="red"/><Metric label="Largest Profit" value={available?money(stats.best):'—'} tone={color(stats.best)}/><Metric label="Largest Loss" value={available?money(stats.worst):'—'} tone={color(stats.worst)}/><Metric label={stats.feesComplete?'Total Fees':'Total Fees (verified only)'} title={stats.feesComplete?undefined:stats.feesCovered+' of '+stats.count+' closes have verified entry and exit fees'} value={available&&stats.fees!==null?money(-stats.fees):'—'} tone="red"/><Metric label="Funding Fees" title={'Bybit funding of real closed cycles in the range ('+funding.covered+' of '+funding.count+' cycles known). Separate from trading P&L; not included in Net.'} value={available&&funding.value!==null?money(funding.value):'—'} tone={color(funding.value)}/><Metric label="Open Unrealized P&L" title="Current open positions (Bybit snapshot). Not realized; not included in any figure above." value={hasOpen?money(openUpnl):'—'} tone={color(openUpnl)}/><Metric label="Closed Trades" value={available?rows.length:'—'}/><Metric label="P&L Mode" value={mode}/></div></section>
   <section className="panel"><h3>Close Reasons</h3><div className="metrics2">{available&&reasonGroups.size?[...reasonGroups].map(([reason,g])=><div className="metric" key={reason}><div className="name">{Reason[reason]||reason}</div><div className="val">{g.count}</div><small className={g.known?color(g.value):''}>{g.known?money(g.value):'—'}</small></div>):<div className="pnl-empty">No recorded close reasons.</div>}</div></section>
   <section className="panel"><h3>Trading Activity</h3><div className="metrics2"><Metric label="Average Duration" value={available&&duration!==null?n(duration,1)+' min':'—'}/><Metric label="Trades Per Day" title="Average over the selected recorded span, with a minimum of one day." value={available&&daySpan?n(rows.length/daySpan,2):'—'}/><Metric label="Most Active Symbol" value={available&&mostActive!=='—'?<SymbolLink symbol={mostActive} className="symbol-nav-link">{mostActive}</SymbolLink>:'—'}/><Metric label="First Closed Trade" value={<DateTime ts={available?rows[0]?.time:null} utc/>}/><Metric label="Last Closed Trade" value={<DateTime ts={available?rows[rows.length-1]?.time:null} utc/>}/><Metric label="Ledger Records" value={available?rows.length:'—'}/></div></section>
   <section className="panel wide"><h3>Closed Trades By Day</h3>{chart(daily,'count')}</section>
  </div>
  <div className="pnl-merged-statistics"><h3>Statistics by Action</h3><LightReports state={state} view="statistics" /></div>
 </div>;
};



