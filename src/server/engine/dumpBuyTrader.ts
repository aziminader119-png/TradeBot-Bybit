import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BotDatabase } from '../db/database.ts';
import type { TradingEngine } from './tradingEngine.ts';
import type { PumpShortScanner } from './pumpShortScanner.ts';
import { dumpBuyEntryTarget } from './dumpBuy.ts';

type Status = 'ENTRY_PENDING' | 'OPEN' | 'EXIT_PENDING' | 'CLOSED' | 'REVIEW';
export type DumpTrade = { id:string; symbol:string; status:Status; entryPrice:number; exitPrice:number|null;
  qty:number; target:number; peak:number; trough:number; entryAt:number; exitAt:number|null;
  entryLinkId:string; exitLinkId:string|null; note:string|null };

/** Independently tracked BUY cycles. Ambiguous exchange responses are never retried blindly. */
export class DumpBuyTrader {
  private readonly file=path.resolve(process.cwd(),'data','dump_buy_trades.json');
  private trades:DumpTrade[]=[];
  private armed=false;
  private busy=false;
  private error:string|null=null;
  private marks:Record<string,number>={};
  private timer:ReturnType<typeof setInterval>|null=null;
  private cooldown=new Map<string,number>();

  constructor(private engine:TradingEngine,private db:BotDatabase,private scanner:PumpShortScanner){
    if(fs.existsSync(this.file))try{
      const saved:unknown=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(!Array.isArray(saved))throw Error('Invalid Dump BUY ledger');
      this.trades=saved as DumpTrade[];
    }catch(e:any){this.error=`Cannot read Dump BUY ledger: ${e.message}`;}
  }
  private save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.trades,null,2),{mode:0o600});fs.renameSync(tmp,this.file);}
  private cfg(){return this.db.getSettings().dumpBuy||{minDropPct:50,lookbackDays:20};}
  /** Mirror Pump Short's 50% wave retracement: take profit halfway back to pre-dump peak. */
  private tp(entry:number,peak:number){return dumpBuyEntryTarget(entry,peak);}
  public snapshot(){const trades=this.trades.slice().reverse().map(t=>({...t,markPrice:this.marks[t.symbol]||null,
    unrealizedPnl:t.status==='OPEN'&&this.marks[t.symbol]?(this.marks[t.symbol]-t.entryPrice)*t.qty:null,
    realizedPnl:t.status==='CLOSED'&&t.exitPrice!==null?(t.exitPrice-t.entryPrice)*t.qty:null}));
    const closed=trades.filter(t=>t.status==='CLOSED');return {armed:this.armed,mode:this.engine.getTradingMode(),busy:this.busy,error:this.error,
      closedCount:closed.length,realizedPnlUsdt:closed.reduce((sum,t)=>sum+(t.realizedPnl||0),0),trades};}
  public arm(confirm:boolean){if(!confirm)throw Error('Explicit confirmation required');if(this.engine.getTradingMode()!=='REAL')throw Error('REAL trading mode is required');
    if(this.db.getSettings().emergencyStop)throw Error('Emergency stop is active');if(this.error?.startsWith('Cannot read'))throw Error(this.error);
    this.armed=true;this.db.addLog('SECURITY','Dump BUY ARMED','Explicitly armed automatic REAL BUY entries/exits');}
  public disarm(){this.armed=false;this.db.addLog('SECURITY','Dump BUY DISARMED','Automatic BUY orders disabled');}
  public start(){if(this.timer)return;this.timer=setInterval(()=>void this.tick(),15000);this.timer.unref?.();}
  private async tick(){if(this.busy||this.error?.startsWith('Cannot read'))return;this.busy=true;
    try{
      if(this.engine.getTradingMode()!=='REAL')this.armed=false;
      const client=this.engine.getClient();const positions=await client.getPositions();
      try{const tickers=await client.getTickers();for(const trade of this.trades){const mark=tickers[trade.symbol]?.lastPrice;if(typeof mark==='number'&&mark>0)this.marks[trade.symbol]=mark;}}catch{}
      for(const trade of this.trades){
        if(trade.status==='CLOSED'||trade.status==='REVIEW')continue;
        const live=positions.find(p=>p.symbol===trade.symbol&&p.side==='Buy'&&Number(p.size)>0);
        if(trade.status==='ENTRY_PENDING'){
          if(live){trade.status='OPEN';trade.qty=Number(live.size);trade.entryPrice=Number(live.avgPrice)||trade.entryPrice;trade.target=this.tp(trade.entryPrice,trade.peak);this.save();}
          else {try{const order=await client.getOrderByLinkId(trade.symbol,trade.entryLinkId);if(order?.orderStatus==='Rejected'||order?.orderStatus==='Cancelled'){trade.status='REVIEW';trade.note=`Entry ${order.orderStatus}`;this.save();}}catch{}}
          continue;
        }
        if(trade.status==='EXIT_PENDING'){
          if(!live&&trade.exitLinkId){try{const order=await client.getOrderByLinkId(trade.symbol,trade.exitLinkId);
            if(order?.orderStatus==='Filled'){trade.status='CLOSED';trade.exitAt=Date.now();trade.exitPrice=order.avgPrice||trade.exitPrice;trade.note=null;this.save();}
            else if(order?.orderStatus==='Rejected'||order?.orderStatus==='Cancelled'){trade.status='REVIEW';trade.note=`Exit ${order.orderStatus}`;this.save();}}
            catch(e:any){trade.note=`Exit verification pending: ${e.message}`;this.save();}}continue;
        }
        if(!live){trade.status='REVIEW';trade.note='BUY missing on exchange: manual reconciliation required';this.save();continue;}
        if(!this.armed||this.db.getSettings().emergencyStop)continue;
        const mark=this.marks[trade.symbol]||0;if(mark<trade.target)continue;
        this.engine.assertOrderAllowed(true,'automated',`Dump BUY exit ${trade.symbol}`);
        trade.status='EXIT_PENDING';trade.exitLinkId='db-x-'+crypto.randomUUID().replace(/-/g,'').slice(0,27);trade.exitPrice=mark;this.save();
        try{await client.createOrder({category:'linear',symbol:trade.symbol,side:'Sell',orderType:'Market',qty:String(Number(live.size)),positionIdx:1,reduceOnly:true,orderLinkId:trade.exitLinkId});}
        catch(e:any){if(e.rejected===true){trade.status='OPEN';trade.exitLinkId=null;trade.exitPrice=null;}trade.note=`Exit ${e.rejected===true?'rejected':'uncertain'}: ${e.message}`;this.save();}
      }
      if(!this.armed||this.db.getSettings().emergencyStop||this.engine.getTradingMode()!=='REAL')return;
      const scan=this.scanner.dumpSnapshot();if(scan.running||!scan.lastCompletedAt||Date.now()-scan.lastCompletedAt>10*60_000)return;
      const active=this.trades.filter(t=>t.status!=='CLOSED').length;if(active>=10)return;
      for(const candidate of scan.candidates){
        if(candidate.excludedBuy||this.trades.some(t=>t.symbol===candidate.symbol&&t.status!=='CLOSED')||(this.cooldown.get(candidate.symbol)||0)>Date.now())continue;
        if(positions.some(p=>p.symbol===candidate.symbol&&Number(p.size)>0))continue;
        this.cooldown.set(candidate.symbol,Date.now()+5*60_000);
        const instrument=(await client.getInstrumentsInfo(candidate.symbol))[candidate.symbol];
        const price=(await client.getTickers(candidate.symbol))[candidate.symbol]?.lastPrice||0;
        if(!instrument||instrument.missingRules?.length||!(price>0))continue;
        // The candidate may have recovered since the last scanner pass.
        if((candidate.peak-price)/candidate.peak*100<this.cfg().minDropPct)continue;
        const notional=30;const step=instrument.qtyStep,decimals=String(step).split('.')[1]?.length||0;
        const qty=Number((Math.floor(notional/price/step+1e-9)*step).toFixed(decimals));
        if(qty<instrument.minQty||qty>instrument.maxQty||qty*price<instrument.minNotional)continue;
        this.engine.assertOrderAllowed(false,'automated',`Dump BUY entry ${candidate.symbol}`);
        const tier=await client.getRiskTierMaxLeverage(candidate.symbol,qty*price);
        const leverage=Math.floor(Math.min(instrument.maxLeverage,tier));if(leverage<1)continue;
        const applied=await client.setLeverage(candidate.symbol,leverage);if(!applied.ok)continue;
        const trade:DumpTrade={id:crypto.randomUUID(),symbol:candidate.symbol,status:'ENTRY_PENDING',entryPrice:price,exitPrice:null,
          qty,target:this.tp(price,candidate.peak),peak:candidate.peak,trough:candidate.trough,entryAt:Date.now(),exitAt:null,
          entryLinkId:'db-e-'+crypto.randomUUID().replace(/-/g,'').slice(0,27),exitLinkId:null,note:null};
        this.trades.push(trade);this.save();
        try{await client.createOrder({category:'linear',symbol:candidate.symbol,side:'Buy',orderType:'Market',qty:String(qty),positionIdx:1,reduceOnly:false,orderLinkId:trade.entryLinkId});}
        catch(e:any){if(e.rejected===true)trade.status='REVIEW';trade.note=`Entry ${e.rejected===true?'rejected':'uncertain'}: ${e.message}`;this.save();}
        break;
      }
    }catch(e:any){this.error=e.message||String(e);this.db.addLog('CYCLE','Dump BUY error',this.error||'Unknown error');}
    finally{this.busy=false;}
  }
}
