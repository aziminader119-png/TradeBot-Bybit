import React from 'react';
// Chart alert panel. It uses the ONE server-side alert service (src/server/alerts): alerts are evaluated on the server
// on closed candles, keep working when the browser is closed, and only notify. (The earlier browser-only price alerts
// and their separate EMA poller are replaced; existing browser alerts can be imported once.)
import {useEffect,useMemo,useState} from 'react';
import './ChartAlerts.css';
import {AlertRuleForm,blankRule,eventLink,useAlertEvents,useAlertRules,type RuleDraft,RULES_URL} from '../alerts/AlertCenter.tsx';
import {INDICATORS} from '../../shared/indicators.ts';
import {timeframeLabel} from '../../shared/alertRules.ts';
import {postJson} from '../light/Modal.tsx';
import {refreshReportRead} from '../light/reports.tsx';
import {DateTime} from '../light/format.tsx';

export const CHART_TO_ALERT_TF:Record<string,string>={'1m':'1','3m':'3','5m':'5','15m':'15','30m':'30','1H':'60','2H':'120','4H':'240','6H':'360','12H':'720','1D':'D'};
export const ALERT_TO_CHART_TF:Record<string,string>=Object.fromEntries(Object.entries(CHART_TO_ALERT_TF).map(([a,b])=>[b,a]));
type LegacyAlert={id:string;price:number;source?:'price'|'ema';emaPeriod?:number;emaInterval?:string;condition:'crosses'|'above'|'below';enabled:boolean;note:string};
const legacyKey=(symbol:string)=>'tradebot:futures:price-alerts:v2:'+symbol;
const readLegacy=(symbol:string):LegacyAlert[]=>{try{const x=JSON.parse(localStorage.getItem(legacyKey(symbol))||'[]');return Array.isArray(x)?x.filter(a=>a&&typeof a.id==='string'&&a.enabled!==false):[]}catch{return []}};
/** Convert a browser-only alert into server rules (a "crosses" alert becomes one rule per direction). */
export function legacyToRules(symbol:string,a:LegacyAlert):any[]{
 const dirs=a.condition==='crosses'?['above','below']:[a.condition];
 return dirs.map(d=>a.source==='ema'
  ?{symbol,indicator:'EMA',params:{period:a.emaPeriod||20},timeframe:['1','5','15','60','240'].includes(a.emaInterval||'')?a.emaInterval:'15',condition:d==='above'?'price_cross_above':'price_cross_below',name:a.note||undefined,cooldownMin:0}
  :{symbol,indicator:'PRICE',params:{},timeframe:'1',condition:d==='above'?'cross_above_level':'cross_below_level',level:a.price,name:a.note||undefined,cooldownMin:0,frequency:'once'});
}
export default function ChartAlerts({symbol,open,onClose,draft,frame}:{symbol:string;livePrice?:number|null;open:boolean;onClose:()=>void;draft?:RuleDraft|null;frame?:string}){
 const rules=useAlertRules(),events=useAlertEvents(symbol);
 const [editing,setEditing]=useState<RuleDraft|null>(null),[message,setMessage]=useState(''),[legacy,setLegacy]=useState<LegacyAlert[]>(()=>readLegacy(symbol));
 useEffect(()=>{setLegacy(readLegacy(symbol));setEditing(null);setMessage('')},[symbol]);
 useEffect(()=>{if(draft)setEditing(draft)},[draft]);
 const mine=useMemo(()=>(rules.data?.rules||[]).filter(r=>r.symbol===symbol),[rules.data,symbol]);
 const importLegacy=async()=>{let n=0;try{for(const a of legacy)for(const body of legacyToRules(symbol,a)){const r=await postJson(RULES_URL,body);if(!r.ok)throw Error(r.data?.error||'Import failed');n++;}try{localStorage.removeItem(legacyKey(symbol))}catch{}setLegacy([]);setMessage(n+' server alert(s) created from this browser’s alerts.');refreshReportRead(RULES_URL)}catch(e:any){setMessage(e.message)}};
 const toggle=async(id:string,enabled:boolean)=>{const r=await postJson(RULES_URL+'/'+encodeURIComponent(id)+'/enabled',{enabled});if(!r.ok)setMessage(r.data?.error||'Update failed');refreshReportRead(RULES_URL)};
 const remove=async(id:string)=>{const r=await fetch(RULES_URL+'/'+encodeURIComponent(id),{method:'DELETE',body:'{}'});if(!r.ok)setMessage('Delete failed');refreshReportRead(RULES_URL)};
 const tf=CHART_TO_ALERT_TF[frame||'']||'60';
 return <section className="nx-alert-panel" style={{display:open?undefined:'none'}} role="dialog" aria-label="Alerts" data-testid="chart-alerts">
  <header><div><strong>Alerts · {symbol}</strong><small>Server alerts: confirmed candle close, notification only (no orders).</small></div><button type="button" aria-label="Close alerts" onClick={onClose}>×</button></header>
  <div className="nx-alert-scroll">
   {legacy.length>0&&<p className="nx-alert-notice">{legacy.length} alert(s) were saved only in this browser. <button type="button" onClick={()=>void importLegacy()}>Import to server alerts</button></p>}
   {message&&<p className="nx-alert-notice" role="status">{message}</p>}
   {editing?<div className="nx-alert-block"><AlertRuleForm initial={editing} lockSymbol onDone={r=>{setEditing(null);if(r)setMessage('Alert saved: '+r.name)}}/></div>
    :<div className="nx-alert-actions"><button type="button" onClick={()=>setEditing({...blankRule(symbol,false,'PRICE'),timeframe:tf as any})}>Price alert</button><button type="button" onClick={()=>setEditing({...blankRule(symbol,false,'EMA'),timeframe:tf as any})}>Indicator alert</button><button type="button" onClick={()=>setEditing({...blankRule(symbol,true,'EMA'),timeframe:tf as any})}>Smart MART alert</button></div>}
   <div className="nx-alert-tabs"><button type="button" className="selected">This symbol ({mine.length})</button><a href="/SmartMartAlerts">Manage all</a></div>
   {mine.length===0?<p className="nx-alert-empty">{rules.loading?'Loading…':'No alerts for '+symbol+'.'}</p>:mine.map(r=><div className="nx-alert-item" key={r.id} data-rule={r.id}><div><strong>{r.name}</strong><small>{r.description}{r.requirePosition?' · positions':''}</small></div><div className="nx-alert-item-actions"><button type="button" title="Edit" onClick={()=>setEditing({...r})}>✎</button><button type="button" title={r.enabled?'Disable':'Enable'} onClick={()=>void toggle(r.id,!r.enabled)}>{r.enabled?'⏸':'▶'}</button><button type="button" title="Delete (history is kept)" onClick={()=>void remove(r.id)}>🗑</button></div></div>)}
   <div className="nx-alert-tabs"><button type="button" className="selected">Recent signals</button></div>
   {(events.data?.events||[]).slice(0,15).map(e=><div className="nx-alert-item" key={e.id}><div><strong><a href={eventLink(e)}>{INDICATORS[e.indicator]?.key} · {timeframeLabel(e.timeframe)}</a></strong><small>{e.conditionLabel}{e.mode==='intrabar'?' (intrabar)':''} at {e.price}{e.positionSide?` · ${e.positionOwner==='bot'?'BOT':'External'} ${e.positionSide==='Buy'?'BUY':'SELL'}`:''}</small><small><DateTime ts={e.candleTime*1000}/></small></div></div>)}
   <p className="nx-alert-disclaimer">Alerts never place, change or close orders. You decide whether to trade.</p>
  </div>
 </section>;
}
