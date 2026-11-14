import React,{useEffect,useRef,useState,lazy,Suspense} from 'react';
import type {BotStateSummary} from '../../types/trading.ts';
import {positionLines,ExchangeChartPosition} from '../futures/positionLines.ts';
import {SymbolStatistics} from '../futures/SymbolStatistics.tsx';
const OpenAlgoFutures=lazy(()=>import('../futures/OpenAlgoFutures.tsx'));
import {useFuturesBook} from '../futures/futuresStream.ts';
import {LightPositionLists} from './LightPositionLists.tsx';
import {ManualOrderDialog} from './ManualOrderDialog.tsx';
import {HedgeOrderDialog} from './HedgeOrderDialog.tsx';
import {DateTime} from './format.tsx';
import {price,num,signedPct} from './table.tsx';
import {useRead,refreshReportRead} from './reports.tsx';
import {LightModal,postJson} from './Modal.tsx';
import '../futures/workspace.css';
export const LightSymbolWorkspace:React.FC<{state:BotStateSummary|null;symbol:string;onSymbol:(s:string)=>void;onRefresh:()=>void;onGoCycles:()=>void;onGoSymbols:()=>void}>=({state,symbol,onSymbol,onRefresh,onGoCycles,onGoSymbols})=>{
 // Reuse the authenticated live state instead of polling the same account again.
 const usdt=state?.wallet?.usdtWalletBalance;
 const contract=useRead<{instrument:any}>('/api/futures/instrument/'+encodeURIComponent(symbol)+'?environment='+encodeURIComponent(state?.settings?.environment||'mainnet')+'&entity='+encodeURIComponent(state?.settings?.apiHost||'api.bybit.com'),300000);
 const protections=useRead<{symbol:string;checkedAt:number;positions:ExchangeChartPosition[]}>('/api/futures/positions/'+encodeURIComponent(symbol)+'?environment='+encodeURIComponent(state?.settings?.environment||'mainnet')+'&entity='+encodeURIComponent(state?.settings?.apiHost||'api.bybit.com'),10000);
 const book=useFuturesBook(symbol),info=contract.data?.instrument,ticker=book.ticker;
 const [value,setValue]=useState('50'),[orderSide,setOrderSide]=useState<'Buy'|'Sell'|'Both'|null>(null),[chartError,setChartError]=useState(''),[now,setNow]=useState(Date.now());
 const [bookMode,setBookMode]=useState<'stacked'|'split'|'buy'|'sell'>('stacked');
 const [summaryTarget,setSummaryTarget]=useState<HTMLDivElement|null>(null);
 const [protectionEdit,setProtectionEdit]=useState<{side:'Buy'|'Sell';field:'takeProfit'|'stopLoss';previous:number;size:number}|null>(null);
 const [protectionPrice,setProtectionPrice]=useState('');
 const [protectionBusy,setProtectionBusy]=useState(false);
 const [protectionError,setProtectionError]=useState('');
 useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);const onError=(e:any)=>{if(e.detail?.symbol===symbol)setChartError(e.detail.message);};const onOK=(e:any)=>{if(e.detail?.symbol===symbol)setChartError('');};window.addEventListener('ft-chart-ok',onOK);window.addEventListener('ft-chart-error',onError);return()=>{clearInterval(id);window.removeEventListener('ft-chart-ok',onOK);window.removeEventListener('ft-chart-error',onError);};},[symbol]);
 const connected=state?.connection?.state==='CONNECTED',real=state?.systemMetrics?.tradingMode==='REAL'&&state?.systemMetrics?.tradingState==='RUNNING';
 const last=ticker?.lastPrice,lev=info?.maxLeverage,initial=Number(value)>0&&lev?Number(value)/lev:null;
 const previousPrice=useRef<number|null>(null),[priceDirection,setPriceDirection]=useState<"up"|"down"|null>(null);
 useEffect(()=>{if(typeof last!=="number"||!Number.isFinite(last)||last<=0)return;const prev=previousPrice.current;if(prev!==null&&last!==prev)setPriceDirection(last>prev?"up":"down");previousPrice.current=last;},[last]);
 const priceTone=priceDirection==='up'?'green':priceDirection==='down'?'red':'';
 const stale=book.updatedAt>0&&now-book.updatedAt>30000;
 const asks=book.synchronized?book.asks.slice(0,bookMode==='stacked'?12:24).reverse():[],bids=book.synchronized?book.bids.slice(0,bookMode==='stacked'?12:24):[];
 const spread=book.synchronized&&book.asks.length&&book.bids.length?book.asks[0].price-book.bids[0].price:null;
 const maxDepth=Math.max(1,...book.asks.slice(0,24).map(l=>l.total),...book.bids.slice(0,24).map(l=>l.total));
 const fundingAt=ticker?.nextFundingTime,remaining=fundingAt?Math.max(0,Math.floor((fundingAt-now)/1000)):null;
 const fundingClock=remaining===null?'—':[Math.floor(remaining/3600),Math.floor(remaining/60)%60,remaining%60].map(n=>String(n).padStart(2,'0')).join(':');
 const overlays=positionLines(symbol,state,protections.data?.symbol===symbol&&Date.now()-protections.data.checkedAt<30000?protections.data.positions:null,ticker?.markPrice);
 const openProtection=(p:ExchangeChartPosition,field:'takeProfit'|'stopLoss')=>{
  setProtectionEdit({side:p.side,field,previous:Number(p[field]||0),size:p.size});
  setProtectionPrice(p[field]?String(p[field]):'');setProtectionError('');
 };
 const handleChartProtectionDrag=(id:string,dragPrice:number)=>{
  const match=/^position:[^:]+:(Buy|Sell):(?:exchange|draft)-(tp|sl)$/.exec(id);
  if(!match)return;
  const side=match[1] as 'Buy'|'Sell',field=match[2]==='tp'?'takeProfit':'stopLoss';
  const position=protections.data?.positions?.find(p=>p.side===side&&p.size>0);
  if(!position||!Number.isFinite(dragPrice)||dragPrice<=0)return;
  openProtection(position,field);
  setProtectionPrice(String(dragPrice));
 };
 const protectionUrl='/api/futures/positions/'+encodeURIComponent(symbol)+'?environment='+encodeURIComponent(state?.settings?.environment||'mainnet')+'&entity='+encodeURIComponent(state?.settings?.apiHost||'api.bybit.com');
 const confirmProtection=async()=>{
  const edit=protectionEdit,requested=Number(protectionPrice);
  if(!edit||protectionBusy)return;
  if(!real){setProtectionError('REAL trading must be explicitly armed before modifying Bybit protections.');return;}
  if(!Number.isFinite(requested)||requested<=0){setProtectionError('Enter a positive TP/SL price.');return;}
  setProtectionBusy(true);setProtectionError('');
  try{
   const response=await postJson('/api/futures/protection',{symbol,side:edit.side,field:edit.field,price:requested,expectedPrice:edit.previous,requestId:crypto.randomUUID(),confirm:true});
   if(!response.ok)throw Error(response.data?.error||'Exchange did not confirm the protection change');
   setProtectionEdit(null);refreshReportRead(protectionUrl);onRefresh();
  }catch(e:any){setProtectionError(e?.message||'Protection update failed. The old line remains until Bybit confirms.');}
  finally{setProtectionBusy(false)}
 };
 const field=(name:string,v:React.ReactNode)=><div className="ft-stat"><small>{name}</small><strong>{v}</strong></div>;
 return <div className="ft-workspace" data-testid="futures-workspace">
  <div className="ft-market-header"><div className="ft-symbol"><h2>{symbol}</h2><span>USDT Perpetual · {lev?lev+'x max':'—'}</span></div>
   <div className="ft-header-orders" role="group" aria-label="Market orders">
    <button type="button" className="buy" disabled={!connected||!book.connected||!book.synchronized||stale} onClick={()=>setOrderSide('Buy')}>BUY</button>
    <button type="button" className="short" disabled={!connected||!book.connected||!book.synchronized||stale} onClick={()=>setOrderSide('Sell')}>SELL</button>
    <button type="button" className="both" disabled={!connected||!book.connected||!book.synchronized||stale} onClick={()=>setOrderSide('Both')}>BUY + SELL</button>
   </div><div className={'ft-last '+priceTone}>{price(last)}</div>
   {field('Mark Price',price(ticker?.markPrice))}{field('Index Price',price(ticker?.indexPrice))}{field('24H Change',ticker?.price24hPcnt!==undefined?signedPct(ticker.price24hPcnt*100):'—')}
   {field('24H High',price(ticker?.highPrice24h))}{field('24H Low',price(ticker?.lowPrice24h))}{field('24H Turnover',num(ticker?.turnover24h,2))}
   {field('Funding / Countdown',<>{ticker?.fundingRate!==undefined?num(ticker.fundingRate*100,4)+'%':'—'} / {fundingClock}</>)}
  </div>

  <div className="ft-terminal-grid">
   <section className="ft-chart-shell">{chartError&&<div className="ft-chart-error" role="alert">{chartError}</div>}{protections.error&&<span className="ft-protection-warning" title={protections.error}>Exchange TP / SL unavailable</span>}<Suspense fallback={<div className="ft-muted" role="status">Loading chart…</div>}><OpenAlgoFutures symbol={symbol} positionLines={overlays} onProtectionDrag={handleChartProtectionDrag}/></Suspense></section>
   <aside className="ft-book-column"><section className={'ft-orderbook ft-book-'+bookMode}><h3>Order Book <small className={book.connected&&book.synchronized&&!stale?'green':'red'} title={book.error||'Futures WebSocket'}>{!book.connected?'Disconnected':stale?'Stale':!book.synchronized?'Synchronizing':'Live'}</small></h3>
    <div className="ft-book-modes" role="group" aria-label="Order book layout">{([['stacked','BUY / SELL'],['split','BUY | SELL'],['buy','BUY'],['sell','SELL']] as const).map(([mode,label])=><button type="button" key={mode} className={bookMode===mode?'selected':''} aria-label={label} title={label} aria-pressed={bookMode===mode} onClick={()=>setBookMode(mode)}><svg viewBox="0 0 22 18" width="20" height="16" aria-hidden="true">{mode==='split'?<><path stroke="#0bba74" strokeWidth="3" d="M3 3h5M3 8h5M3 13h5"/><path stroke="#ff4761" strokeWidth="3" d="M13 3h5M13 8h5M13 13h5"/></>:<><path stroke={mode==='sell'?'#ff4761':mode==='buy'?'#0bba74':'#ff4761'} strokeWidth="3" d="M2 3h7M2 8h7"/><path stroke={mode==='sell'?'#ff4761':'#0bba74'} strokeWidth="3" d="M2 13h7"/><path stroke="#929AAA" strokeWidth="2" d="M12 3h8M12 8h8M12 13h8"/></>}</svg></button>)}</div>
     {bookMode!=='stacked'&&<div className="ft-book-mid"><strong className={priceTone}>{price(last)}</strong><small>Spread {spread===null?'—':price(spread)}</small></div>}
    {!book.synchronized?<div className="ft-book-empty">{book.error||'Waiting for a fresh Futures snapshot…'}</div>:<>
     <div className="ft-book-sides">
      {bookMode!=='sell'&&<div className="ft-bids"><div className="ft-book-side-title green">BUY</div><div className="ft-book-head"><span>Price</span><span>Quantity</span><span>Total USDT</span></div>{bids.map(l=><div className="ft-book-row bid" key={l.price} style={{'--depth':l.total/maxDepth*100+'%'} as React.CSSProperties}><span>{price(l.price)}</span><span>{num(l.amount,4)}</span><span>{num(l.total,2)}</span></div>)}</div>}
      {bookMode==='stacked'&&<div className="ft-book-mid"><strong className={priceTone}>{price(last)}</strong><small>Spread {spread===null?'—':price(spread)}</small></div>}
      {bookMode!=='buy'&&<div className="ft-asks"><div className="ft-book-side-title red">SELL</div><div className="ft-book-head"><span>Price</span><span>Quantity</span><span>Total USDT</span></div>{(bookMode==='stacked'?asks:[...asks].reverse()).map(l=><div className="ft-book-row ask" key={l.price} style={{'--depth':l.total/maxDepth*100+'%'} as React.CSSProperties}><span>{price(l.price)}</span><span>{num(l.amount,4)}</span><span>{num(l.total,2)}</span></div>)}</div>}
     </div>

    </>}
   </section></aside>
  </div>
  <LightPositionLists key={symbol} view="all" summaryTarget={summaryTarget} fixedSymbol={symbol} state={state} onGoCycles={onGoCycles}/>
  <section className="ft-symbol-overview ft-overview-below" aria-label="Symbol Overview"><h3>Symbol Overview</h3><div ref={setSummaryTarget}/></section>
  <SymbolStatistics key={symbol} symbol={symbol} state={state}/>
  <LightModal open={Boolean(protectionEdit)} title={protectionEdit?'Confirm '+(protectionEdit.field==='takeProfit'?'Take Profit':'Stop Loss')+' change':''} busy={protectionBusy} onClose={()=>{if(!protectionBusy)setProtectionEdit(null)}} onConfirm={()=>void confirmProtection()} confirmLabel="Confirm TP/SL" error={protectionError} testid="protection-confirmation">
   {protectionEdit&&<div className="ft-protection-review">
    <div><span>Symbol</span><strong>{symbol}</strong></div>
    <div><span>Position</span><strong>{protectionEdit.side} · Qty {protectionEdit.size}</strong></div>
    <div><span>Type</span><strong>{protectionEdit.field==='takeProfit'?'Take Profit':'Stop Loss'}</strong></div>
    <div><span>Previous price</span><strong>{protectionEdit.previous||'Not set'}</strong></div>
    <label>New price <input type="number" min="0" step="any" value={protectionPrice} disabled={protectionBusy} onChange={e=>setProtectionPrice(e.target.value)}/></label>
    <p>Only Confirm sends the new protection to Bybit. Cancel leaves the exchange position unchanged.</p>
   </div>}
  </LightModal>
  {orderSide==='Both'&&<HedgeOrderDialog key={symbol+'Both'} symbol={symbol} initialValue={Number(value)} enabled={real} onClose={()=>setOrderSide(null)} onDone={onRefresh}/>}
  {(orderSide==='Buy'||orderSide==='Sell')&&<ManualOrderDialog key={symbol+orderSide} symbol={symbol} side={orderSide} initialValue={Number(value)} enabled={real} onClose={()=>setOrderSide(null)} onDone={onRefresh}/>}
 </div>;
};


