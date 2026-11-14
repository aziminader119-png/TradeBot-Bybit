import type { Bar, BarsRequest, BarSubscriptionOptions, DataFeed, SymbolMatch } from 'openalgo-charts';
import { FuturesDatafeed } from './futuresStream.ts';
import type {Timeframe} from '../../vendor/mg-chart/index.js';

const timeframeSeconds: Record<string, number> = {'1m':60,'3m':180,'5m':300,'15m':900,'30m':1800,'1h':3600,'2h':7200,'4h':14400,'6h':21600,'12h':43200,'D':86400,'W':604800,'M':2678400};
const tf: Record<string, Timeframe> = {
  '1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m',
  '1h':'1H','2h':'2H','4h':'4H','6h':'6H','12h':'12H','D':'1D','W':'1W','M':'1M'
};
/** Read-only adapter. Both history and live candles pass through the authenticated
 * Bybit Futures API and market-ws already running in TradeBot. No order routes. */
export class BybitOpenAlgoFeed implements DataFeed {
  private readonly underlying: FuturesDatafeed;
  private readonly active = new Set<()=>void>();
  private destroyed = false;
  constructor(private readonly symbol:string) { this.underlying=new FuturesDatafeed(symbol); }
  async getBars(req: BarsRequest):Promise<Bar[]> {
    if(this.destroyed) return [];
    const timeframe=tf[req.interval];
    if(!timeframe) throw Error('Unsupported Bybit interval: '+req.interval);
    // OpenAlgo supplies a bounded `to` even for the latest chart window.
    // Normalize only near-now requests to the underlying latest-page convention;
    // preserve the original end time for explicit historic paging.
    const now=Date.now()/1000;
    const to=Number(req.to)||0;
    const latest=to===0||to>=now-2*(timeframeSeconds[req.interval]||300);
    const result=await this.underlying.getBars({
      symbol:this.symbol,timeframe,
      from:latest?0:(req.from||0),to:latest?0:to,limit:Math.min(1000,Math.max(1,req.countBack||500))
    });
    if(req.signal?.aborted)return [];
    const unique=new Map(result.map(b=>[b.time,b]));
    return [...unique.values()].sort((a,b)=>a.time-b.time).map(b=>({time:b.time,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume}));
  }
  subscribeBars(req: BarsRequest,onBar:(bar:Bar)=>void,opts?:BarSubscriptionOptions):()=>void {
    if(this.destroyed)return()=>{};
    const timeframe=tf[req.interval];
    if(!timeframe)return()=>{};
    let active=true;
    const release=this.underlying.subscribe({
      symbol:req.symbol,timeframe,
      onTick:()=>{},
      onBar:b=>{
        if(active&&!this.destroyed)onBar({time:b.time,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume});
      }
    });
    const stop=()=>{if(!active)return;active=false;release();this.active.delete(stop)};
    this.active.add(stop);
    return stop;
  }
  async searchSymbols(req:{query:string;signal?:AbortSignal}):Promise<SymbolMatch[]> {
    if(req.signal?.aborted)return [];
    return this.symbol.includes(req.query.toUpperCase())?[{symbol:this.symbol,exchange:'BYBIT',name:this.symbol,assetClass:'Futures'}]:[];
  }
  destroy(){this.destroyed=true;for(const stop of [...this.active])stop();this.underlying.destroy();}
}
