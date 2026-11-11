import type {TradingEngine} from '../engine/tradingEngine.ts';
import type {BotDatabase} from '../db/database.ts';
import {quoteNotional} from '../engine/strategyMath.ts';
const requestLocks=new Map<string,Promise<void>>();
export async function withManualRequest<T>(id:string,fn:()=>Promise<T>):Promise<T>{
 const previous=requestLocks.get(id)||Promise.resolve();let release!:()=>void;
 const tail=new Promise<void>(r=>{release=r;});requestLocks.set(id,tail);await previous;
 try{return await fn();}finally{release();if(requestLocks.get(id)===tail)requestLocks.delete(id);}
}
export async function manualFuturesQuote(engine:TradingEngine,db:BotDatabase,symbol:string,side:'Buy'|'Sell',notional:number){
 if(!Number.isFinite(notional)||notional<=0)throw Error('Position value must be a positive USDT number');
 if(engine.getConnection().state!=='CONNECTED')throw Error('Connect the Bybit API first');
 if(db.getSettings().emergencyStop)throw Error('Emergency stop is active');
 const cycle=db.getStrategyCycle(symbol);if(cycle&&cycle.status!=='CLOSED')throw Error('This symbol has a BOT cycle; a manual order cannot change its position or leverage');
 if(db.getIntents().some(i=>i.symbol===symbol&&(i.status==='PENDING'||i.status==='UNKNOWN')))throw Error('An order outcome on this symbol is unresolved; not sending another order');
 if(db.getIntents().some(i=>i.symbol===symbol&&i.action==='OPEN'&&i.mode==='LIVE'&&(i.status==='FILLED'||i.status==='PARTIAL')&&Date.now()-i.updatedAt<15000))throw Error('A recent fill is awaiting exchange synchronization; wait before starting another position');
 const client=engine.getClient();
 const [instruments,tickers,positions,wallet]=await Promise.all([client.getFuturesContract(symbol),client.getTickers(symbol),client.getPositions(symbol),client.getWalletBalance()]);
 if(positions.some(p=>p.side===side&&Number(p.size)>0))throw Error(`This symbol already has an open ${side === 'Buy' ? 'BUY' : 'SHORT'} position; a second order would merge into it`);
 if(positions.some(p=>Number(p.positionIdx)===0))throw Error('Switch this symbol to Hedge mode on Bybit first');
 const info=instruments,price=Number(tickers[symbol]?.lastPrice);
 if(!info||![info.qtyStep,info.minQty,info.minNotional,info.maxLeverage,info.maxMarketQty].every(v=>v!==null&&Number.isFinite(v)&&v>0)||!Number.isFinite(price)||price<=0)throw Error('Fresh price or verified instrument rules unavailable');
 const rules={qtyStep:info.qtyStep!,minQty:info.minQty!,minNotional:info.minNotional!,maxLeverage:info.maxLeverage!,maxQty:info.maxMarketQty!};
 const quote=quoteNotional(symbol,side,notional,rules.maxLeverage,price,rules,0.055);
 if(!quote.ok)throw Error(quote.error||'Invalid position size');
 if(Number.isFinite(rules.maxQty)&&quote.qty>rules.maxQty)throw Error('Quantity exceeds the current exchange market-order limit');
 const estimatedFee=quote.estOpenFee||0;
 if(!Number.isFinite(wallet.availableBalance)||quote.estMargin+estimatedFee>wallet.availableBalance)throw Error('Insufficient available balance for estimated margin and opening fee');
 const opposite = positions.find(p=>p.side!==side&&Number(p.size)>0);
 const otherSideLeverage = opposite ? Number(opposite.leverage) : null;
 if(opposite && !(otherSideLeverage && Number.isFinite(otherSideLeverage) && otherSideLeverage>0))throw Error('Existing opposite-side leverage cannot be verified; no order will be sent');
 return {quote,price,rules,leverage:rules.maxLeverage,otherSideLeverage,checkedAt:Date.now(),symbol,side,notionalUsdt:notional,feeIsEstimate:true,ownership:'external' as const};
}

