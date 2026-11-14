import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {BotPosition} from '../../types/trading.ts';
import {postJson} from './Modal.tsx';
import {useDialogFocus} from './useDialogFocus.ts';

/** UI-only batch coordinator: existing single-position endpoint, ONE at a time.
 * There is intentionally no automatic retry after uncertain exchange outcomes. */
export function BulkCloseSelected({positions,onClosed,onClear}:{
 positions:BotPosition[];onClosed:(ids:string[])=>void;onClear?:()=>void
}) {
 const [open,setOpen]=useState(false);
 const [busy,setBusy]=useState(false);
 const [started,setStarted]=useState(false);
 const [results,setResults]=useState<{id:string;symbol:string;side:string;ok:boolean;message:string}[]>([]);
 const dialog=useDialogFocus(open,busy,()=>setOpen(false));
 const sent=useRef(false);
 const count=positions.length;
 const sum=positions.reduce((n,p)=>n+(Number.isFinite(p.unrealizedPnl)?p.unrealizedPnl:0),0);
 useEffect(()=>{if(!open){setResults([]);setStarted(false);sent.current=false}},[open]);
 const execute=async()=>{
  if(sent.current||busy||!positions.length)return;
  sent.current=true;setBusy(true);setStarted(true);
  const successful:string[]=[];
  try{
   for(const p of positions){
    try{
     // The existing endpoint only supports full-position market closes.
     const r=await postJson('/api/positions/'+encodeURIComponent(p.id)+'/close',{confirm:true});
     if(!r.ok){
      const problem=String(r.data?.error||r.data?.message||'Exchange outcome not confirmed; reconcile manually');
      setResults(prev=>[...prev,{id:p.id,symbol:p.symbol,side:p.side,ok:false,message:problem}]);
      break; // Never continue automatically after a rejected/uncertain execution.
     }
     successful.push(p.id);
     setResults(prev=>[...prev,{id:p.id,symbol:p.symbol,side:p.side,ok:true,message:'Close confirmed'}]);
    }catch(err:any){
     setResults(prev=>[...prev,{id:p.id,symbol:p.symbol,side:p.side,ok:false,
      message:(err?.message||'Exchange outcome unknown')+' — verify on Bybit; do not retry automatically'}]);
     break;
    }
   }
  }finally{
   setBusy(false);
   if(successful.length)onClosed(successful);
  }
 };
 return <>
  <button type="button" className="tb-v19-bulk-action" disabled={!count}
   onClick={()=>setOpen(true)} data-testid="bulk-close-selected">Close Selected ({count})</button>
  {count>0&&createPortal(<div className="tb-v19-selection-bar" role="region" aria-label="Selected position actions" data-testid="selected-position-actions">
   <span className="tb-v19-selection-count"><strong>{count}</strong> selected</span>
   <button type="button" className="tb-v19-selection-close" onClick={()=>setOpen(true)} data-testid="floating-bulk-close">Close Selected ({count})</button>
   {onClear&&<button type="button" className="tb-v19-selection-clear" onClick={onClear}>Clear selection</button>}
  </div>,document.body)}
  {open&&createPortal(<div className="tb-v19-close-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)setOpen(false)}}>
   <section ref={dialog} tabIndex={-1} className="tb-v19-close-dialog tb-v19-bulk-dialog"
     role="dialog" aria-modal="true" aria-label="Close selected positions" data-testid="bulk-close-dialog">
    <div className="tb-v19-close-heading">
      <h3>Market Close · {count} positions</h3>
      <button className="tb-v19-close-x" type="button" disabled={busy} onClick={()=>setOpen(false)} aria-label="Close dialog">×</button>
    </div>
    <p>Full market close for the selected BUY and SHORT positions. These are real exchange orders.</p>
    <div className="tb-v19-bulk-rows">
      {positions.map(p=><div className="tb-v19-bulk-row" key={p.id}>
       <strong>{p.symbol}</strong><span className={p.side==='Buy'?'green':'red'}>{p.side==='Buy'?'BUY':'SHORT'}</span>
       <span>Qty {p.size}</span><span className={p.unrealizedPnl>=0?'green':'red'}>{p.unrealizedPnl>=0?'+':''}{p.unrealizedPnl.toFixed(2)} USDT</span>
      </div>)}
    </div>
    <div className="tb-v19-bulk-total">Selected P&amp;L <strong className={sum>=0?'green':'red'}>{sum>=0?'+':''}{sum.toFixed(2)} USDT</strong></div>
    {!started?<>
      <p className="tb-v19-bulk-warning">Orders are sent individually in sequence. Processing stops at the first failure or uncertain result. Completed closes cannot be undone.</p>
    </>:<div className="tb-v19-bulk-results" role="status">
       <strong>{busy?'Closing selected positions…':'Execution finished — verify results'}</strong>
       {results.map(r=><div key={r.id} className={r.ok?'green':'red'}>
        {r.symbol} {r.side==='Buy'?'BUY':'SHORT'} — {r.ok?'CLOSED':'STOPPED'}: {r.message}
       </div>)}
       {results.length<count&&!busy&&<small>{count-results.length} remaining positions were not submitted.</small>}
     </div>}
    <div className="tb-v19-close-actions">
      {!started&&<button type="button" className="confirm" disabled={busy||!count}
       onClick={()=>void execute()}>{busy?'Closing…':'Confirm Close All ('+count+')'}</button>}
      <button type="button" className="cancel" disabled={busy} onClick={()=>setOpen(false)}>{started?'Done':'Cancel'}</button>
    </div>
   </section>
  </div>,document.body)}
 </>;
}
