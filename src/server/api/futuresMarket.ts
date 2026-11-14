import {Router} from 'express';
import WebSocket,{WebSocketServer} from 'ws';
import type {Server} from 'http';
import type {AuthGate} from '../security/authGate.ts';
import {TradingEngine} from '../engine/tradingEngine.ts';
import {BotDatabase} from '../db/database.ts';
import {manualFuturesQuote,withManualRequest} from './futuresManual.ts';
import {CandleCache} from './candleCache.ts';
import {CHANGE_LIMITS,CHANGE_WINDOWS,changeFromBars} from '../../shared/priceChanges.ts';
export const FUTURES_INTERVALS=new Set(['1','3','5','15','30','60','120','240','360','720','D','W','M']);
export function futuresStreamHost(host:string):string{
 if(host==='api-testnet.bybit.com')return 'wss://stream-testnet.bybit.com/v5/public/linear';
 const regions:Record<string,string>={'api.bybit.tr':'stream.bybit.tr','api.bybit.kz':'stream.bybit.kz','api.bybit.id':'stream.bybit.id','api.bybitgeorgia.ge':'stream.bybitgeorgia.ge','api.manepa.jp':'stream.manepa.jp','api.spark-fintech.com':'stream.spark-fintech.com'};
 if(regions[host])return 'wss://'+regions[host]+'/v5/public/linear';
 if(['api.bybit.com','api.bybit.eu','api.bybit.ae','api.bybit.nl','api.bybit.com.hk'].includes(host))return 'wss://stream.bybit.com/v5/public/linear';
 throw Error('No verified Futures WebSocket host configured for this Bybit entity');
}
const symbolOf=(input:unknown)=>{const s=String(input||'').toUpperCase();if(!/^[A-Z0-9]{2,30}USDT$/.test(s))throw Error('Invalid USDT perpetual symbol');return s;};
export const futuresRouter=Router();
// Chart candles: bounded read-only cache (closed candles only; the forming candle is always fresh). Display only.
export const candleCache=new CandleCache({fetch:async(symbol,interval,limit,start,end,scope)=>{
 // never store or share candles read from a different Bybit host than the one the request was keyed for
 const client=TradingEngine.getInstance().getClient();if(scope&&client.getHost()!==scope)throw Error('Bybit host changed; retry the chart history');
 const bars=await client.getFuturesHistory(symbol,interval,limit,start,end);
 if(scope&&TradingEngine.getInstance().getClient().getHost()!==scope)throw Error('Bybit host changed during the chart history read; retry');
 return bars;
}});
// Contract metadata shown on the symbol page: 5-minute display cache per Bybit host. Manual order quotes do NOT use
// it; they always read the exchange rules fresh (futuresManual.ts).
const CONTRACT_TTL_MS=5*60000,contractCache=new Map<string,{at:number;value:any}>(),contractReads=new Map<string,Promise<any>>();
async function displayContract(symbol:string){
 const client=TradingEngine.getInstance().getClient(),key=client.getHost()+'|'+symbol,now=Date.now(),hit=contractCache.get(key);
 if(hit&&now-hit.at<CONTRACT_TTL_MS)return hit.value;
 let p=contractReads.get(key);
 if(!p){p=client.getFuturesContract(symbol).then(value=>{contractCache.delete(key);contractCache.set(key,{at:Date.now(),value});while(contractCache.size>200)contractCache.delete(contractCache.keys().next().value!);return value;}).finally(()=>contractReads.delete(key));contractReads.set(key,p);}
 return p;
}
// Exchange position-level protections, read-only. Never use local fallback TP values.
futuresRouter.get('/positions/:symbol',async(req,res)=>{
 try{const symbol=symbolOf(req.params.symbol),engine=TradingEngine.getInstance();if(engine.getConnection().state!=='CONNECTED'){res.status(409).json({error:'Connect Bybit first'});return;}
 const raw=await engine.getClient().getPositions(symbol),number=(v:unknown)=>{const n=Number(v);return v!==''&&v!==null&&v!==undefined&&Number.isFinite(n)?n:null;};
 res.setHeader('Cache-Control','no-store');res.json({symbol,checkedAt:Date.now(),positions:raw.filter(p=>p.symbol===symbol&&Number(p.size)>0&&(p.side==='Buy'||p.side==='Sell')).map(p=>({side:p.side,size:number(p.size),entryPrice:number(p.avgPrice||p.entryPrice),unrealizedPnl:number(p.unrealisedPnl),takeProfit:number(p.takeProfit),stopLoss:number(p.stopLoss)}))});
 }catch(e:any){res.status(502).json({error:e.message||'Exchange position lines unavailable'});}
});
futuresRouter.get('/instrument/:symbol',async(req,res)=>{try{const symbol=symbolOf(req.params.symbol);res.json({instrument:await displayContract(symbol)});}catch(e:any){res.status(400).json({error:e.message||'Contract metadata unavailable'});}});
futuresRouter.get('/market-price/:symbol',async(req,res)=>{try{const symbol=symbolOf(req.params.symbol);const tickers=await TradingEngine.getInstance().getClient().getTickers(symbol);const price=Number(tickers[symbol]?.lastPrice);if(!Number.isFinite(price)||price<=0)throw Error('Fresh price unavailable');res.setHeader('Cache-Control','no-store');res.json({symbol,price,checkedAt:Date.now()});}catch(e:any){res.status(502).json({error:e.message||'Fresh price unavailable'});}});
// Symbols table: 2H/4H/12H/48H/72H/1W/1M change for the symbols on the visible page only (≤ 50), from the shared
// candle cache (closed candles kept; normally one small tail read per symbol and resolution). Display only.
futuresRouter.get('/changes',async(req,res)=>{
 try{
  const list=[...new Set(String(req.query.symbols||'').split(',').filter(Boolean).map(symbolOf))].slice(0,50);
  const host=TradingEngine.getInstance().getClient().getHost(),nowS=Math.floor(Date.now()/1000),out:Record<string,Record<string,number|null>>={};
  let i=0;const worker=async()=>{while(i<list.length){const symbol=list[i++];const row:Record<string,number|null>={};
   try{
    const byInterval:Record<string,{time:number;close:number}[]>={};
    for(const iv of Object.keys(CHANGE_LIMITS))byInterval[iv]=await candleCache.history(host,symbol,iv,CHANGE_LIMITS[iv]);
    const last=byInterval['15'].at(-1),current=last&&last.close>0?last.close:null;
    for(const w of CHANGE_WINDOWS)row[w.key]=changeFromBars(byInterval[w.interval],w.hours,w.stepS,nowS,current);
   }catch{for(const w of CHANGE_WINDOWS)row[w.key]=null;}
   out[symbol]=row;}};
  await Promise.all([worker(),worker(),worker(),worker()]); // at most 4 symbols read at a time
  res.json({at:Date.now(),changes:out});
 }catch(e:any){res.status(400).json({error:e.message});}
});
futuresRouter.get('/history/:symbol',async(req,res)=>{
 try{
  const symbol=symbolOf(req.params.symbol),interval=String(req.query.interval||'60');
  if(!FUTURES_INTERVALS.has(interval))throw Error('Unsupported Futures candle interval');
  const number=(x:unknown)=>{if(x===undefined)return undefined;const v=Number(x);if(!Number.isFinite(v)||v<0)throw Error('Invalid history range');return Math.floor(v);};
  const start=number(req.query.start),end=number(req.query.end),limit=Math.min(1000,Math.max(1,number(req.query.limit)||500));
  const bars=await candleCache.history(TradingEngine.getInstance().getClient().getHost(),symbol,interval,limit,start,end);
  res.json({symbol,category:'linear',bars});
 }catch(e:any){res.status(400).json({error:e.message||'Futures history unavailable'});}
});
futuresRouter.get('/preview/:symbol',async(req,res)=>{
 try{const side=req.query.side;if(side!=='Buy'&&side!=='Sell')throw Error('Invalid side');if(typeof req.query.value!=='string'||!req.query.value.trim())throw Error('Enter position value');
 const result=await manualFuturesQuote(TradingEngine.getInstance(),BotDatabase.getInstance(),symbolOf(req.params.symbol),side,Number(req.query.value));res.json(result);
 }catch(e:any){res.status(409).json({error:e.message||'Preview failed'});}
});
futuresRouter.post('/order',async(req,res)=>{
 try{
  const body=req.body||{},side=body.side,symbol=symbolOf(body.symbol);
  if(side!=='Buy'&&side!=='Sell')throw Error('Invalid side');
  if(body.confirm!==true||typeof body.value!=='number'||!Number.isFinite(body.value)||body.value<=0||typeof body.requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(body.requestId))throw Error('Valid value, confirmation and request ID are required');
  const engine=TradingEngine.getInstance(),db=BotDatabase.getInstance();
  if(engine.getConnection().keyInfo?.readOnly)throw Error('Read-only API key');
  if(engine.getTradingMode()!=='REAL')throw Error('Enable Real trading first');
  engine.assertOrderAllowed(false,'user','Manual Futures order');
  const intent=await withManualRequest(body.requestId,()=>engine.strategy.manualExternalOpen(symbol,side,0,0,{notionalUsdt:body.value,requestId:body.requestId,prepare:()=>manualFuturesQuote(engine,db,symbol,side,body.value)}));
  res.status(intent.status==='FILLED'?200:409).json({success:intent.status==='FILLED',intent,error:intent.status==='FILLED'?undefined:intent.error||intent.status});
 }catch(e:any){res.status(409).json({error:e.message||'Order refused'});}
});
/** Confirmed manual edit of an EXTERNAL hedge position's native Bybit TP/SL.
 * Fail closed if the position changed between preview and confirmation.
 * Never allow this route to alter a bot-managed symbol or arm live trading. */
futuresRouter.post('/protection',async(req,res)=>{
 try{
  const body=req.body||{},symbol=symbolOf(body.symbol);
  const side=body.side,field=body.field,price=body.price,expected=body.expectedPrice;
  if(side!=='Buy'&&side!=='Sell')throw Error('Invalid hedge position side');
  if(field!=='takeProfit'&&field!=='stopLoss')throw Error('Invalid protection type');
  if(body.confirm!==true||typeof body.requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(body.requestId))throw Error('A confirmed request ID is required');
  if(typeof price!=='number'||!Number.isFinite(price)||price<=0)throw Error('Invalid TP/SL price');
  if(typeof expected!=='number'||!Number.isFinite(expected)||expected<0)throw Error('Invalid previous protection price');
  const engine=TradingEngine.getInstance(),db=BotDatabase.getInstance();
  if(engine.getConnection().state!=='CONNECTED'||engine.getConnection().keyInfo?.readOnly)throw Error('Writable Bybit API connection required');
  if(engine.getTradingMode()!=='REAL'||!engine.getClient().isTradingEnabled())throw Error('Live trading has not been armed');
  if(db.getSettings().emergencyStop)throw Error('Emergency stop is active');
  if(db.getStrategyCycle(symbol)?.status!=='CLOSED'&&db.getStrategyCycle(symbol))throw Error('Bot-managed symbol: external TP/SL editing is blocked');
  // Serialize protection edits for this symbol and side, then read fresh exchange state.
  const outcome=await withManualRequest('protection:'+symbol+':'+side,async()=>{
   const client=engine.getClient(),positions=await client.getPositions(symbol),idx=side==='Buy'?1:2;
   const matches=positions.filter(p=>p.symbol===symbol&&p.side===side&&Number(p.positionIdx)===idx&&Number(p.size)>0);
   if(matches.length!==1)throw Error('Exactly one verified open hedge position is required');
   const current=matches[0],entry=Number(current.avgPrice||current.entryPrice);
   const rawTicker=(await client.getTickers(symbol))[symbol] as Record<string,unknown>|undefined;
   const mark=Number(rawTicker?.markPrice);
   if(!(Number.isFinite(mark)&&mark>0&&Number.isFinite(entry)&&entry>0))throw Error('Fresh mark and entry prices required');
   const old=Number(current[field]||0);
   if(!Number.isFinite(old)||Math.abs(old-expected)>Math.max(1e-8,Math.abs(expected)*1e-8))throw Error('TP/SL changed on Bybit. Refresh before editing again');
   const validDirection=field==='takeProfit'?(side==='Buy'?price>mark:price<mark):(side==='Buy'?price<mark:price>mark);
   if(!validDirection)throw Error('TP/SL must be on the correct side of current Mark Price');
   if(Math.abs(price-old)<Math.max(1e-10,price*1e-9))throw Error('Price has not changed');
   await client.setExternalTradingStop(symbol,idx,field,price);
   return {symbol,side,field,previous:old,requested:price,positionIdx:idx};
  });
  res.setHeader('Cache-Control','no-store');res.json({success:true,...outcome});
 }catch(e:any){res.status(409).json({success:false,error:e.message||'TP/SL update refused'});}
});
/** Authenticated public-market relay. Isolated from the bot's strategy feed and order WebSocket. */
export function attachFuturesMarket(server:Server,gate:AuthGate){
 const wss=new WebSocketServer({noServer:true,maxPayload:4096});
 server.on('upgrade',(req,socket,head)=>{
  if(new URL(req.url||'/','http://local').pathname!=='/market-ws')return;
  const auth=gate.authorizeUpgrade(req);
  if(auth.ok===false){socket.write('HTTP/1.1 '+auth.status+' Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,down=>{
   let up:WebSocket|null=null,retry:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined,attempt=0,config:{symbol:string;intervals:string[]}|null=null,lastSeen=Date.now(),disposed=false,generation=0;
   const valid=()=>gate.isSessionValid(auth.sessionId);
   const send=(v:any)=>{if(!valid()){down.close(4401,'Session expired');return;}if(down.readyState===WebSocket.OPEN){if(down.bufferedAmount>2e6){down.close(1013,'Slow market client');return;}down.send(JSON.stringify(v));}};
   const stop=()=>{generation++;if(retry)clearTimeout(retry);if(heartbeat)clearInterval(heartbeat);if(up){up.removeAllListeners();up.on('error',()=>{});up.close();up=null;}};
   const connect=()=>{
    if(disposed||!config||!valid())return;stop();const own=generation,cfg=config;send({type:'MARKET_STATUS',connected:false,error:'Synchronizing Futures stream'});
    try{const engine=TradingEngine.getInstance();up=new WebSocket(futuresStreamHost(engine.getClient().getHost()),{handshakeTimeout:10000});}catch(e:any){send({type:'MARKET_STATUS',connected:false,error:e.message});return;}
    const current=up;lastSeen=Date.now();
    current.on('open',()=>{if(generation!==own)return;attempt=0;current.send(JSON.stringify({op:'subscribe',args:['orderbook.50.'+cfg.symbol,'tickers.'+cfg.symbol,'publicTrade.'+cfg.symbol,...cfg.intervals.map(i=>'kline.'+i+'.'+cfg.symbol)]}));send({type:'MARKET_STATUS',connected:true,category:'linear'});});
    current.on('message',raw=>{if(generation!==own)return;lastSeen=Date.now();if(!valid()){down.close(4401,'Session expired');return;}try{const m=JSON.parse(String(raw));if(m.success===false){send({type:'MARKET_STATUS',connected:false,error:m.ret_msg||'Subscription refused'});current.close();return;}if(typeof m.topic==='string'&&m.topic.endsWith('.'+cfg.symbol))send(m);}catch{}});
    current.on('error',()=>send({type:'MARKET_STATUS',connected:false,error:'Bybit Futures market stream unavailable'}));
    current.on('close',()=>{if(disposed||generation!==own)return;send({type:'MARKET_STATUS',connected:false,error:'Reconnecting Futures market data'});if(heartbeat)clearInterval(heartbeat);retry=setTimeout(connect,Math.min(30000,1000*2**Math.min(attempt++,5)));});
    heartbeat=setInterval(()=>{if(!valid()){down.close(4401,'Session expired');return;}if(Date.now()-lastSeen>45000){current.terminate();return;}if(current.readyState===WebSocket.OPEN)current.send(JSON.stringify({op:'ping'}));},15000);
   };
   down.on('message',raw=>{try{const msg=JSON.parse(String(raw));if(msg.type==='PING'){send({type:'PONG'});return;}if(msg.type!=='SUBSCRIBE')return;const symbol=symbolOf(msg.symbol);const intervals=[...new Set<string>(Array.isArray(msg.intervals)?msg.intervals:[])];if(intervals.length>5||intervals.some(i=>!FUTURES_INTERVALS.has(i)))throw Error('Unsupported chart subscriptions');const next={symbol,intervals};if(JSON.stringify(next)===JSON.stringify(config))return;const prev=config;config=next;if(prev&&prev.symbol===symbol&&up&&up.readyState===WebSocket.OPEN){const removed=prev.intervals.filter(i=>!intervals.includes(i)).map(i=>'kline.'+i+'.'+symbol),added=intervals.filter(i=>!prev.intervals.includes(i)).map(i=>'kline.'+i+'.'+symbol);if(removed.length)up.send(JSON.stringify({op:'unsubscribe',args:removed}));if(added.length)up.send(JSON.stringify({op:'subscribe',args:added}));return;}connect();}catch(e:any){send({type:'MARKET_STATUS',connected:false,error:e.message});}});
   const authTimer=setInterval(()=>{if(!valid())down.close(4401,'Session expired');},2000);
   down.on('close',()=>{disposed=true;stop();clearInterval(authTimer);});
   down.on('error',()=>down.close());
  });
 });
 return ()=>{for(const c of wss.clients)c.close();wss.close();};
}

