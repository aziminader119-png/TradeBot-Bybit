import {useEffect,useState} from 'react';
import type {Bar,Datafeed,Timeframe} from '../../vendor/mg-chart/index.js';
export const INTERVALS:Record<string,string>={'1m':'1','3m':'3','5m':'5','15m':'15','30m':'30','1H':'60','2H':'120','4H':'240','6H':'360','12H':'720','1D':'D','1W':'W','1M':'M'};
type Listener=(message:any)=>void;
export class Channel{
 private ws:WebSocket|null=null;private listeners=new Map<Listener,string|undefined>();private retry:any;private tick:any;private debounce:any;private lastSeen=0;private lastMarketSeen=0;private status:any=null;private attempts=0;private disposed=false;
 constructor(readonly symbol:string){}
 listen(fn:Listener,interval?:string){this.listeners.set(fn,interval);if(this.status)queueMicrotask(()=>{if(this.listeners.has(fn))this.notify(fn,this.status);});if(!this.ws)this.connect();else this.subscribe();return()=>{this.listeners.delete(fn);if(!this.listeners.size){this.close();channels.delete(this.symbol);}else this.subscribe();};}
 private subscribe(){clearTimeout(this.debounce);this.debounce=setTimeout(()=>{if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify({type:'SUBSCRIBE',symbol:this.symbol,intervals:[...new Set([...this.listeners.values()].filter(Boolean))].sort()}));},30);}
 private notify(fn:Listener,m:any){try{fn(m);}catch(e){console.error('[Futures consumer]',e);}}
 private emit(m:any){if(m.type==='MARKET_STATUS')this.status=m;for(const fn of this.listeners.keys())this.notify(fn,m);}
 private connect(){
  if(this.disposed)return;const ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/market-ws');this.ws=ws;this.lastSeen=this.lastMarketSeen=Date.now();
  ws.onopen=()=>{if(this.ws!==ws)return;this.subscribe();this.tick=setInterval(()=>{if(Date.now()-this.lastSeen>45000||Date.now()-this.lastMarketSeen>45000){ws.close();return;}if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'PING'}));},15000);};
  ws.onmessage=e=>{if(this.ws!==ws)return;this.lastSeen=Date.now();try{const m=JSON.parse(e.data);if(m.topic)this.lastMarketSeen=Date.now();this.attempts=0;this.emit(m);}catch{}};
  ws.onerror=()=>this.emit({type:'MARKET_STATUS',connected:false,error:'Futures data connection error'});
  ws.onclose=e=>{if(this.ws!==ws)return;this.ws=null;clearInterval(this.tick);this.emit({type:'MARKET_STATUS',connected:false,error:'Futures data disconnected'});if(e.code===4401){window.dispatchEvent(new Event('tb-auth-required'));this.close();return;}if(!this.disposed)this.retry=setTimeout(()=>this.connect(),Math.min(30000,1000*2**Math.min(this.attempts++,5)));};
 }
 resync(){this.ws?.close();}
 private close(){this.disposed=true;clearTimeout(this.retry);clearTimeout(this.debounce);clearInterval(this.tick);if(this.ws){this.ws.onclose=null;this.ws.onmessage=null;this.ws.close();this.ws=null;}}
}
const channels=new Map<string,Channel>();
const channel=(symbol:string)=>{let c=channels.get(symbol);if(!c){c=new Channel(symbol);channels.set(symbol,c);}return c;};
export type Level={price:number;amount:number;total:number};
export type BookState={asks:Level[];bids:Level[];trades:{id:string;price:number;amount:number;side:'Buy'|'Sell';timestamp:number}[];ticker:Record<string,number>|null;connected:boolean;synchronized:boolean;updatedAt:number;error:string|null};
export const emptyBook=():BookState=>({asks:[],bids:[],trades:[],ticker:null,connected:false,synchronized:false,updatedAt:0,error:null});
export class FuturesBook{
 asks=new Map<number,number>();bids=new Map<number,number>();ready=false;seq=-1;update=-1;
 reset(){this.asks.clear();this.bids.clear();this.ready=false;this.seq=-1;this.update=-1;}
 accept(m:any,symbol:string){
  const d=m.data;if(m.topic!=='orderbook.50.'+symbol||d?.s!==symbol||!Array.isArray(d.a)||!Array.isArray(d.b))return false;
  if(m.type==='snapshot'){this.reset();this.ready=true;}else if(d.u===1){this.reset();throw Error('Book restart requires a fresh snapshot');}else if(m.type!=='delta'||!this.ready)return false;
  if(m.type==='delta'&&d.u!==1&&((Number.isFinite(d.seq)&&d.seq<=this.seq)||(Number.isFinite(d.u)&&d.u<=this.update)))return false;
  for(const [map,rows]of [[this.asks,d.a],[this.bids,d.b]] as const)for(const row of rows){const p=Number(row[0]),q=Number(row[1]);if(!Number.isFinite(p)||!Number.isFinite(q)||p<=0||q<0)throw Error('Invalid order-book update');if(q===0)map.delete(p);else map.set(p,q);}
  this.seq=Number.isFinite(d.seq)?d.seq:this.seq;this.update=Number.isFinite(d.u)?d.u:this.update;
  if(this.asks.size&&this.bids.size&&Math.max(...this.bids.keys())>=Math.min(...this.asks.keys()))throw Error('Inconsistent book; resynchronizing');
  return true;
 }
 levels(map:Map<number,number>,descending=false){let total=0;return [...map].sort((a,b)=>descending?b[0]-a[0]:a[0]-b[0]).slice(0,50).map(([price,amount])=>({price,amount,total:total+=price*amount}));}
}
export function useFuturesBook(symbol:string):BookState{
 const [state,setState]=useState<BookState>(emptyBook);
 useEffect(()=>{
  setState(emptyBook());const c=channel(symbol),book=new FuturesBook();let pending:any=null,frame:ReturnType<typeof setTimeout>|undefined,disposed=false;
  const flush=()=>{frame=undefined;if(!disposed&&pending){const snapshot=pending;pending=null;setState(snapshot);}};
  let current=emptyBook();const update=(next:BookState)=>{current=next;pending=next;if(frame===undefined)frame=setTimeout(flush,250);};
  const release=c.listen(m=>{
   if(m.type==='MARKET_STATUS'){if(!m.connected){book.reset();update({...emptyBook(),error:m.error||null});}else update({...current,connected:true,error:null});return;}
   try{
    if(m.topic==='orderbook.50.'+symbol&&book.accept(m,symbol))update({...current,asks:book.levels(book.asks),bids:book.levels(book.bids,true),synchronized:true,updatedAt:Date.now(),error:null});
    else if(m.topic==='tickers.'+symbol&&m.data?.symbol===symbol){const ticker={...(m.type==='snapshot'?{}:current.ticker||{})};for(const [k,v]of Object.entries(m.data)){const n=Number(v);if(v!==''&&Number.isFinite(n))ticker[k]=n;}update({...current,ticker});}
    else if(m.topic==='publicTrade.'+symbol&&Array.isArray(m.data)){const trades=m.data.filter((t:any)=>t.s===symbol&&Number(t.p)>0&&Number(t.v)>0&&['Buy','Sell'].includes(t.S)).map((t:any)=>({id:String(t.i),price:Number(t.p),amount:Number(t.v),side:t.S,timestamp:Number(t.T)}));const unique=new Map([...trades,...current.trades].map(t=>[t.id,t]));update({...current,trades:[...unique.values()].sort((a,b)=>b.timestamp-a.timestamp).slice(0,80)});}
   }catch(e:any){book.reset();update({...emptyBook(),error:e.message});c.resync();}
  });
  return()=>{disposed=true;if(frame!==undefined)clearTimeout(frame);release();};
 },[symbol]);return state;
}
// Chart history (display only; never used for orders). Requests are deduplicated, cancellable and bounded:
// - the first view loads INITIAL_BARS (visible range + indicator warm-up); older candles load only when the user
//   scrolls back (the chart requests them page by page);
// - identical requests in flight share one fetch; a timeframe switch aborts the previous timeframe's requests and
//   destroying the chart aborts everything, so a stale response can never reach a newer chart state;
// - once the beginning of the listing is reached, further scroll-back requests are answered locally;
// - after a reconnect only candles since the last one received are fetched (not a full page).
export const INITIAL_BARS=500;
const OLDER_RETRY_MS=5000;
export async function history(symbol:string,timeframe:string,from=0,to=0,limit=500,signal?:AbortSignal):Promise<Bar[]>{
 const interval=INTERVALS[timeframe];if(!interval)throw Error('Unsupported Futures timeframe');
 const q=new URLSearchParams({interval,limit:String(Math.min(1000,Math.max(1,limit)))});if(from>0)q.set('start',String(Math.floor(from*1000)));if(to>0)q.set('end',String(Math.floor(to*1000)));
 const r=await fetch('/api/futures/history/'+encodeURIComponent(symbol)+'?'+q,{signal});const d=await r.json();if(!r.ok||d.error)throw Error(d.error||'Futures history unavailable');
 return (d.bars||[]).filter((b:Bar)=>[b.time,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)&&b.time>0&&b.open>0&&b.close>0&&b.low>0&&b.high>=b.low&&b.volume>=0);
}
const isAbort=(e:any)=>e?.name==='AbortError';
export class FuturesDatafeed implements Datafeed{
 private lastTimes=new Map<string,number>();
 private inflight=new Map<string,{promise:Promise<Bar[]>;controller:AbortController;series:string}>();
 private startOfHistory=new Map<string,number>();
 private olderFailedAt=new Map<string,number>();
 private destroyed=false;
 constructor(private symbol:string,private read:typeof history=history){}
 /** Abort every request of this chart instance (chart destroyed / symbol left). */
 destroy(){this.destroyed=true;for(const r of this.inflight.values())r.controller.abort();this.inflight.clear();}
 async getBars(p:Parameters<Datafeed['getBars']>[0]){
  if(this.destroyed)return [];
  const series=p.symbol+':'+p.timeframe,now=Date.now()/1000,latest=!(p.to>0)||p.to>=now-1;
  // a newer timeframe of the same symbol supersedes older in-flight loads (their late results are never used)
  for(const [k,r] of this.inflight)if(r.series!==series&&r.series.startsWith(p.symbol+':')){r.controller.abort();this.inflight.delete(k);}
  const first=this.startOfHistory.get(series);
  if(!latest&&first!==undefined&&p.to<first)return [];
  const limit=latest?Math.min(p.limit||INITIAL_BARS,INITIAL_BARS):p.limit;
  const key=series+'|'+(latest?'latest':p.from+':'+p.to)+'|'+limit;
  if(!latest&&Date.now()-(this.olderFailedAt.get(key)||0)<OLDER_RETRY_MS)return [];
  const shared=this.inflight.get(key);if(shared)return shared.promise;
  const controller=new AbortController();
  const promise=(async()=>{
   try{
    const bars=await this.read(p.symbol,p.timeframe,p.from,latest?0:p.to,limit,controller.signal);
    if(controller.signal.aborted)return [];
    if(bars.length)this.lastTimes.set(series,Math.max(this.lastTimes.get(series)||0,bars[bars.length-1].time));
    // fewer candles than asked for (or none) before a given time: the listing starts here
    if(!latest&&bars.length<limit)this.startOfHistory.set(series,bars.length?bars[0].time:p.to);
    if(latest&&bars.length<limit&&bars.length)this.startOfHistory.set(series,bars[0].time);
    return bars;
   }catch(e){if(isAbort(e)||controller.signal.aborted)return [];if(!latest)this.olderFailedAt.set(key,Date.now());throw e;}
   finally{if(this.inflight.get(key)?.controller===controller)this.inflight.delete(key);}
  })();
  this.inflight.set(key,{promise,controller,series});
  return promise;
 }
 subscribe(p:Parameters<Datafeed['subscribe']>[0]){
  const c=channel(p.symbol),interval=INTERVALS[p.timeframe];let lastTime=this.lastTimes.get(p.symbol+':'+p.timeframe)||0;let alive=true,syncing=true,pending:Bar[]=[],generation=0,retry:ReturnType<typeof setTimeout>|undefined,abort:AbortController|null=null;
  const deliver=(b:Bar)=>{if(!alive||b.time<lastTime)return;lastTime=b.time;p.onBar(b);}; // Complete OHLC already includes the close; do not deliver a duplicate tick.
  const sync=async()=>{
   clearTimeout(retry);abort?.abort();const own=++generation,controller=new AbortController();abort=controller;syncing=true;
   // gap recovery after (re)connect: only candles from the last received one onwards, paging back only for long gaps
   try{let end=Date.now()/1000,bars:Bar[]=[];for(let page=0;page<10;page++){const part=await this.read(p.symbol,p.timeframe,lastTime,end,1000,controller.signal);bars=[...part,...bars];if(!part.length||!lastTime||part[0].time<=lastTime)break;end=part[0].time-.001;if(page===9)throw Error('Chart gap exceeds recovery window; reload the symbol');}
    if(!alive||own!==generation)return;const unique=new Map<number,Bar>();for(const b of [...bars,...pending])unique.set(b.time,b);pending=[];syncing=false;window.dispatchEvent(new CustomEvent('ft-chart-ok',{detail:{symbol:p.symbol}}));[...unique.values()].sort((a,b)=>a.time-b.time).forEach(deliver);
   }catch(e:any){if(isAbort(e)||controller.signal.aborted)return;if(alive&&own===generation){window.dispatchEvent(new CustomEvent('ft-chart-error',{detail:{symbol:p.symbol,message:e.message}}));retry=setTimeout(()=>void sync(),3000);}}
  };
  const release=c.listen(m=>{
   if(m.type==='MARKET_STATUS'){if(m.connected)void sync();else{generation++;abort?.abort();clearTimeout(retry);syncing=true;pending=[];}return;}
   if(m.topic!=='kline.'+interval+'.'+p.symbol||!Array.isArray(m.data))return;
   for(const row of m.data){const b={time:Number(row.start)/1000,open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume),confirmed:row.confirm===true};if(![b.time,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)||b.open<=0||b.close<=0||b.low<=0||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.volume<0)continue;if(syncing)pending.push(b);else deliver(b);}
  },interval);
  return()=>{alive=false;generation++;abort?.abort();clearTimeout(retry);release();};
 }
 async searchSymbols(q:string){return this.symbol.includes(q.toUpperCase())?[{symbol:this.symbol,name:this.symbol,exchange:'Bybit Futures',type:'futures' as const,pricePrecision:8,qtyPrecision:8,minMove:.00000001}]:[];}
}
