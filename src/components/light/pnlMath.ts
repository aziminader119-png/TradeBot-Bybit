import type {BotStateSummary} from '../../types/trading.ts';
import {tradeRecords} from './positionData.ts';
// ONE analytics model for every P&L chart and metric (the page never recalculates figures on its own).
//   GROSS = realized trading P&L as recorded for each real (LIVE) close; always available.
//   NET   = GROSS − matched entry fees − exit fee, only for closes whose fees are verified. Missing fees are never 0
//           and Gross is never substituted: an unmatched close has net = null and is excluded from Net figures, which
//           are then labelled partial with their coverage (covered / count).
// Entry fees are matched FIFO per cycle + symbol + side. When the open's trade record is no longer in the retained
// trade list, its fill is recovered from the order-intent record (kept much longer, with the exchange fill fee).
export type FeeIssue='entry-before-ledger'|'missing-entry-fee'|'missing-exit-fee'|null;
export type CloseRecord={id:string;symbol:string;side:string;time:number;gross:number;net:number|null;fee:number|null;durationMs:number|null;reason:string;orderId:string;feeIssue:FeeIssue};
export type FillIntent={orderLinkId:string;orderId?:string;cycleId:string|null;symbol:string;side:string;action:string;filledQty?:number;avgPrice?:number;fee?:number;mode:string;status:string;updatedAt:number};
type Lot={qty:number;feePerQty:number|null;time:number};
const opens=new Set(['OPEN_INITIAL','TP_REOPEN','MART_ADD','MANUAL_OPEN']);
const closes=new Set(['TP_CLOSE','CYCLE_CLOSE','MANUAL_CLOSE']);
const INTENT_OPEN:Record<string,string>={OPEN:'OPEN_INITIAL',TRIGGER_OPEN:'TP_REOPEN',MART_ADD:'MART_ADD'};
export function pnlCloseRecords(state:BotStateSummary|null,fills:FillIntent[]=[]):CloseRecord[]{
 const lots=new Map<string,Lot[]>(),out:CloseRecord[]=[],seen=new Set<string>();
 const live=tradeRecords(state).filter(t=>t.mode==='LIVE');
 // opening fills whose trade record was trimmed from the retained list: rebuild them from their order intent
 const have=new Set(live.map(t=>t.id)),haveOrder=new Set(live.map(t=>t.orderId).filter(Boolean));
 const recovered=fills.filter(i=>i.mode==='LIVE'&&(i.status==='FILLED'||i.status==='PARTIAL')&&INTENT_OPEN[i.action]&&(i.filledQty||0)>0&&!have.has('trade-'+i.orderLinkId)&&!(i.orderId&&haveOrder.has(i.orderId)))
  .map(i=>({id:'trade-'+i.orderLinkId,cycleId:i.cycleId||'manual',symbol:i.symbol,side:i.side,action:INTENT_OPEN[i.action],qty:i.filledQty!,fee:Number.isFinite(i.fee)?i.fee!:NaN,pnl:0,timestamp:i.updatedAt,orderId:i.orderId||'',mode:'LIVE'} as any));
 const first=live.length?Math.min(...live.map(t=>t.timestamp)):Infinity;
 const records=[...live,...recovered].sort((a,b)=>a.timestamp-b.timestamp||a.id.localeCompare(b.id));
 for(const t of records){
  if(seen.has(t.id)||!Number.isFinite(t.timestamp)||t.timestamp<=0)continue;seen.add(t.id);
  const key=[t.cycleId,t.symbol,t.side].join('|'),pool=lots.get(key)||[];lots.set(key,pool);
  const qty=Number.isFinite(t.qty)&&t.qty>0?t.qty:0;
  if(opens.has(t.action)){if(qty)pool.push({qty,feePerQty:Number.isFinite(t.fee)?t.fee/qty:null,time:t.timestamp});continue;}
  if(!closes.has(t.action)||!Number.isFinite(t.pnl))continue;
  let left=qty,entryFee=0,weightedAge=0,issue:FeeIssue=qty>0&&Number.isFinite(t.fee)?null:'missing-exit-fee';
  while(left>1e-10&&pool.length){const lot=pool[0],take=Math.min(left,lot.qty);if(lot.feePerQty===null)issue=issue||'missing-entry-fee';else entryFee+=take*lot.feePerQty;weightedAge+=take*Math.max(0,t.timestamp-lot.time);lot.qty-=take;left-=take;if(lot.qty<=1e-10)pool.shift();}
  if(left>Math.max(1e-10,qty*1e-9))issue=issue||(t.timestamp-first<30*86400000?'entry-before-ledger':'missing-entry-fee');
  const fee=issue===null?entryFee+t.fee:null;
  out.push({id:t.id,symbol:t.symbol,side:t.side,time:t.timestamp,gross:t.pnl,fee,net:fee===null?null:t.pnl-fee,durationMs:issue===null?weightedAge/qty:null,reason:t.action,orderId:t.orderId,feeIssue:issue});
 }
 return out;
}
export type PnlMode='NET'|'GROSS';
export const valueOf=(r:CloseRecord,mode:PnlMode)=>mode==='NET'?r.net:r.gross;
/** Statistics over the closes that HAVE a value in this mode. `complete` = every close has one; otherwise every figure
 *  covers only `covered` of `count` closes (null when none is covered). */
export function pnlStats(rows:CloseRecord[],mode:PnlMode){
 const vals=rows.map(r=>valueOf(r,mode)),known=vals.filter((v):v is number=>v!==null),complete=known.length===rows.length,any=known.length>0;
 const wins=known.filter(v=>v>0),losses=known.filter(v=>v<0),profit=wins.reduce((s,v)=>s+v,0),loss=losses.reduce((s,v)=>s+v,0);
 let balance=0,peak=0,drawdown=0;for(const v of vals){if(v===null)continue;balance+=v;peak=Math.max(peak,balance);drawdown=Math.min(drawdown,balance-peak);}
 const total=any?known.reduce((s,v)=>s+v,0):null;
 const fees=rows.filter(r=>r.fee!==null);
 return {count:rows.length,complete,covered:known.length,total,profit:any?profit:null,loss:any?loss:null,
  wins:any?wins.length:null,losses:any?losses.length:null,flat:any?known.filter(v=>v===0).length:null,
  winRate:any?wins.length/known.length*100:null,average:total!==null?total/known.length:null,
  best:any?Math.max(...known):null,worst:any?Math.min(...known):null,
  avgWin:wins.length?profit/wins.length:null,avgLoss:losses.length?loss/losses.length:null,
  profitFactor:any&&(wins.length||losses.length)?loss<0?profit/-loss:profit>0?Infinity:null:null,
  drawdown:any?drawdown:null,
  // verified fees only, with their own coverage
  fees:fees.length?fees.reduce((s,r)=>s+r.fee!,0):null,feesCovered:fees.length,feesComplete:fees.length===rows.length,
  issues:{entryBeforeLedger:rows.filter(r=>r.feeIssue==='entry-before-ledger').length,missingEntryFee:rows.filter(r=>r.feeIssue==='missing-entry-fee').length,missingExitFee:rows.filter(r=>r.feeIssue==='missing-exit-fee').length}};
}
export const utcKey=(time:number)=>new Date(time).toISOString().slice(0,10);
/** Daily buckets; `known` = every close of the day has a value in this mode (otherwise the day is partial). */
export function dailyPnl(rows:CloseRecord[],mode:PnlMode){
 const map=new Map<string,{day:string;value:number;buy:number;sell:number;count:number;covered:number;known:boolean}>();
 for(const r of rows){const key=utcKey(r.time),d=map.get(key)||{day:key,value:0,buy:0,sell:0,count:0,covered:0,known:true},v=valueOf(r,mode);d.count++;if(v===null)d.known=false;else{d.covered++;d.value+=v;if(r.side==='Buy')d.buy+=v;else d.sell+=v;}map.set(key,d);}
 return [...map.values()].sort((a,b)=>a.day.localeCompare(b.day));
}
/** Top symbols by value in this mode, over covered closes; `partial` marks groups with excluded closes. */
export function topSymbols(rows:CloseRecord[],mode:PnlMode,profitable:boolean,limit=10){
 const map=new Map<string,{symbol:string;side:string;count:number;covered:number;value:number}>();
 for(const r of rows){const key=r.symbol+'|'+r.side,g=map.get(key)||{symbol:r.symbol,side:r.side,count:0,covered:0,value:0};g.count++;const v=valueOf(r,mode);if(v!==null){g.covered++;g.value+=v;}map.set(key,g);}
 return [...map.values()].filter(g=>g.covered>0&&(profitable?g.value>0:g.value<0)).sort((a,b)=>profitable?b.value-a.value:a.value-b.value).slice(0,limit).map(g=>({...g,partial:g.covered<g.count}));
}
/** Funding of real closed cycles in the range (Bybit funding records; separate from trading P&L, never in Net). */
export function fundingTotal(cycles:{mode?:string;endedAt?:number;funding?:number}[]|undefined,since:number){
 const list=(cycles||[]).filter(c=>c.mode==='LIVE'&&Number.isFinite(c.endedAt)&&(c.endedAt as number)>=since);
 const known=list.filter(c=>Number.isFinite(c.funding));
 return {value:known.length?known.reduce((s,c)=>s+(c.funding as number),0):null,covered:known.length,count:list.length};
}
