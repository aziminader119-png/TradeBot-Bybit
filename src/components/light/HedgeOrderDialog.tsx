import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {useDialogFocus} from './useDialogFocus.ts';
import {num} from './table.tsx';
import {postJson} from './Modal.tsx';

export function HedgeOrderDialog({symbol,initialValue,enabled,onClose,onDone}:{symbol:string;initialValue:number;enabled:boolean;onClose:()=>void;onDone?:()=>void}){
 const [value,setValue]=useState(String(initialValue>0?initialValue:50));
 const [buy,setBuy]=useState<any>(null),[sell,setSell]=useState<any>(null);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false);
 const [results,setResults]=useState<{side:string;status:string;message?:string}[]|null>(null);
 const sent=useRef(false),id=useRef(crypto.randomUUID());
 const dialog=useDialogFocus(true,busy,onClose);
 const amount=Number(value);
 useEffect(()=>{
  setBuy(null);setSell(null);setError('');
  if(!Number.isFinite(amount)||amount<=0)return;
  let live=true;
  const timer=setTimeout(async()=>{
   setLoading(true);
   try{
    const read=async(side:'Buy'|'Sell')=>{
     const response=await fetch('/api/futures/preview/'+encodeURIComponent(symbol)+'?'+new URLSearchParams({side,value:String(amount)}),{cache:'no-store'});
     const data=await response.json();if(!response.ok)throw Error(side+': '+(data.error||'Quote unavailable'));return data;
    };
    const [b,s]=await Promise.all([read('Buy'),read('Sell')]);
    if(live){setBuy(b);setSell(s)}
   }catch(e:any){if(live)setError(e.message||'Quote failed')}
   finally{if(live)setLoading(false)}
  },350);
  return()=>{live=false;clearTimeout(timer)};
 },[symbol,amount]);
 const confirm=async()=>{
  if(!enabled||!buy||!sell||sent.current||busy)return;
  sent.current=true;setBusy(true);setError('');
  try{
   const response=await postJson('/api/futures/hedge-order',{symbol,value:amount,requestId:id.current,confirm:true});
   if(response.data?.results)setResults(response.data.results);
   if(!response.ok)throw Error(response.data?.error||response.data?.message||'Hedge result needs review');
   onDone?.();
  }catch(e:any){setError((e.message||'Hedge order outcome uncertain')+'. Review each side before any retry.')}
  finally{setBusy(false)}
 };
 const summary=(side:'BUY'|'SELL',quote:any)=> <div className="tb-hedge-leg">
  <h3 className={side==='BUY'?'green':'red'}>{side}</h3>
  <div><span>Price</span><strong>{quote?num(quote.price,6):'—'}</strong></div>
  <div><span>Quantity</span><strong>{quote?.quote?.qty??'—'}</strong></div>
  <div><span>Order Value</span><strong>{quote?num(quote.quote.actualNotional,4)+' USDT':'—'}</strong></div>
  <div><span>Margin</span><strong>{quote?num(quote.quote.estMargin,4)+' USDT':'—'}</strong></div>
  <div><span>Est. Fee</span><strong>{quote?num(quote.quote.estOpenFee,4)+' USDT':'—'}</strong></div>
  <div><span>Leverage</span><strong>{quote?'Cross '+quote.leverage+'x':'—'}</strong></div>
 </div>;
 return createPortal(<div className="tb-v19-order-backdrop" role="presentation">
  <section ref={dialog} tabIndex={-1} className="tb-v19-order-dialog tb-hedge-dialog" role="dialog" aria-modal="true" aria-label={'Market BUY and SELL '+symbol}>
   <div className="tb-v19-order-title"><h2><span className="buy">Market Buy</span> + <span className="sell">Sell</span> {symbol}</h2><button type="button" disabled={busy} onClick={onClose} aria-label="Close dialog">×</button></div>
   <label className="tb-v19-order-field">Value per side (USDT)<input type="number" min="0" step="any" value={value} disabled={busy||sent.current} onChange={e=>setValue(e.target.value)}/></label>
   <div className="tb-hedge-grid">{summary('BUY',buy)}{summary('SELL',sell)}</div>
   <p className="tb-v19-order-risk">One confirmation authorizes two separate market orders, BUY then SELL. They are not atomic. On any failure or uncertain fill, execution stops. The server revalidates both legs and combined margin.</p>
   {loading&&<p className="tb-v19-order-msg">Checking both Bybit quotes…</p>}
   {!enabled&&<p className="tb-v19-order-msg warn">REAL is not armed. Orders cannot be submitted.</p>}
   {results&&<div className="tb-hedge-results" role="status">{results.map((r,i)=><p key={i}>{r.side}: {r.status}{r.message?' — '+r.message:''}</p>)}</div>}
   {error&&<p className="tb-v19-order-msg error" role="alert">{error}</p>}
   <div className="tb-v19-order-actions"><button className="buy" type="button" disabled={!enabled||!buy||!sell||busy||sent.current||loading} onClick={()=>void confirm()}>Confirm BUY + SELL</button><button type="button" className="cancel" disabled={busy} onClick={onClose}>{results?'Done':'Cancel'}</button></div>
  </section>
 </div>,document.body);
}
