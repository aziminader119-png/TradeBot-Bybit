import type { Bar, BarsRequest, BarSubscriptionOptions, DataFeed, SymbolMatch } from 'openalgo-charts';
import { FuturesDatafeed } from './futuresStream.ts';

const tf: Record<string, string> = {
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
    const result=await this.underlying.getBars({
      symbol:req.symbol,timeframe,
      from:req.from||0,to:req.to||0,limit:req.countBack||500
    });
    if(req.signal?.aborted)return [];
    return result.map(b=>({time:b.time,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume}));
  }
  subscribeBars(req: BarsRequest,onBar:(bar:Bar)=>void,opts?:BarSubscriptionOptions):()=>void {
    if(this.destroyed)return()=>{};
    const timeframe=tf[req.interval];
    if(!timeframe)return()=>{};
    let active=true;
    const release=this.underlying.subscribe({
      symbol:req.symbol,timeframe,
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
