import type {BotStateSummary} from '../../types/trading.ts';
import {tradeRecords} from '../light/positionData.ts';
export type EventKind='BUY_OPEN'|'BUY_CLOSE'|'SHORT_OPEN'|'SHORT_CLOSE';
export type TradeEvent={id:string;kind:EventKind;source:'pump'|'dump'|'general';symbol:string;side:'Buy'|'Sell';verb:string;qty:number;price:number;pnl:number|null;time:number;orderId:string};
const opens=new Set(['OPEN_INITIAL','TP_REOPEN','MANUAL_OPEN','MART_ADD']);
const closes=new Set(['TP_CLOSE','CYCLE_CLOSE','MANUAL_CLOSE']);
export function executionEvents(state:BotStateSummary):TradeEvent[]{
 const unique=new Map<string,TradeEvent>();
 for(const t of tradeRecords(state)){
  const opening=opens.has(t.action),closing=closes.has(t.action);
  if(t.mode!=='LIVE'||(!opening&&!closing)||!['Buy','Sell'].includes(t.side)||!t.orderId||!Number.isFinite(t.timestamp)||t.timestamp<=0||!Number.isFinite(t.qty)||t.qty<=0||!Number.isFinite(t.price)||t.price<=0)continue;
  const id=t.orderId+':'+t.action;
  const sourceText=`${t.cycleId} ${t.notes||''}`.toLowerCase();
  const source=sourceText.includes('pump')?'pump':sourceText.includes('dump')?'dump':'general';
  unique.set(id,{id,source,kind:((t.side==='Buy'?'BUY':'SHORT')+(opening?'_OPEN':'_CLOSE')) as EventKind,symbol:t.symbol,side:t.side,verb:t.action==='MART_ADD'?'Increased':opening?'Opened':'Closed',qty:t.qty,price:t.price,pnl:closing&&Number.isFinite(t.pnl)?t.pnl:null,time:t.timestamp,orderId:t.orderId});
 }
 return [...unique.values()].sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
}
/** The first snapshot is a baseline, never an alert/replay. Snapshots can arrive repeatedly or out of order. */
export class TradeEventCursor{
 private initialized=false;private seen=new Set<string>();private watermark=0;
 ingest(state:BotStateSummary){const events=executionEvents(state),fresh:TradeEvent[]=[];const before=this.watermark;
  for(const e of events){if(!this.seen.has(e.id)&&this.initialized&&e.time>=before-5000)fresh.push(e);this.seen.add(e.id);this.watermark=Math.max(this.watermark,e.time);}
  this.initialized=true;if(this.seen.size>5000)this.seen=new Set(events.map(e=>e.id));return fresh;
 }
}
export const EVENT_NAMES:Record<EventKind,string>={BUY_OPEN:'BUY opened',BUY_CLOSE:'BUY closed',SHORT_OPEN:'SHORT opened',SHORT_CLOSE:'SHORT closed'};
