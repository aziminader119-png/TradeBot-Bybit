import React, { useEffect, useState } from 'react';
import { postJson } from './Modal.tsx';

export type PumpOwnership = { id: string; symbol: string; status: string };

export function usePumpOwnership() {
  const [trades, setTrades] = useState<PumpOwnership[]>([]);
  const refresh = async () => {
    try {
      const r = await fetch('/api/pump-short/positions');
      if (r.ok) setTrades((await r.json()).trades || []);
    } catch { /* Show legacy ownership when Pump data is unavailable. */ }
  };
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, []);
  return { trades, refresh };
}

export function PositionOwnershipActions({ id, symbol, side, owner, pump, refresh }:
  { id: string; symbol: string; side: string; owner: string; pump?: PumpOwnership; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activePump = Boolean(pump && ['OPEN', 'ENTRY_PENDING', 'EXIT_PENDING'].includes(pump.status));
  const action = async (label: string, endpoint: string, body: object) => {
    if (!window.confirm(`${label} ${symbol} ${side}?\nThis changes strategy management only. The exchange position stays open; no order is placed.`)) return;
    setBusy(true); setError('');
    try {
      const r = await postJson(endpoint, body);
      if (!r.ok) throw Error(r.data?.error || r.data?.message || 'Management transfer rejected');
      await refresh();
    } catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const addPump = async () => {
    if (!window.confirm(`Move ${symbol} SHORT to Pump Positions?\nThis adopts the existing Bybit position without opening a new trade. Pump may close it automatically after being armed.`)) return;
    setBusy(true); setError('');
    try {
      let result = await postJson('/api/pump-short/positions/adopt', { symbol, confirm: true });
      if (!result.ok && String(result.data?.error || '').startsWith('WAVE_LOW_REQUIRED:')) {
        const answer = window.prompt(`The scanner has no valid wave low for ${symbol}.\nEnter its confirmed pump wave LOW price (below your SHORT entry). This sets the Pump exit target:`);
        if (answer === null) return;
        const waveLow = Number(answer);
        if (!answer.trim() || !Number.isFinite(waveLow) || waveLow <= 0) throw Error('Enter a valid positive wave low');
        result = await postJson('/api/pump-short/positions/adopt', { symbol, waveLow, confirm: true });
      }
      if (!result.ok) throw Error(result.data?.error || 'Pump transfer rejected');
      await refresh();
    } catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, minWidth: 160 }}>
    {activePump ? <button type="button" disabled={busy || pump?.status !== 'OPEN'} className="row-act" onClick={() => void action('Remove from Pump', `/api/pump-short/positions/${pump!.id}/release`, { confirm: true })}>Remove Pump</button>
      : owner === 'bot' ? <button type="button" disabled={busy} className="row-act" onClick={() => void action('Remove from BOT', `/api/positions/${id}/transfer`, { targetOwner: 'external' })}>Remove BOT</button>
        : <>
          <button type="button" disabled={busy} className="row-act" onClick={() => void action('Add to BOT', `/api/positions/${id}/transfer`, { targetOwner: 'bot' })}>Add BOT</button>
          {side === 'Sell' && <button type="button" disabled={busy} className="row-act" onClick={() => void addPump()}>Move to Pump</button>}
        </>}
    {error && <small role="alert" className="red" title={error} style={{ flexBasis: '100%' }}>{error}</small>}
  </div>;
}

/** V19 Market Close modal. The current backend closes an ENTIRE position only.
 * Partial amounts are previewed but never submitted to the full-close endpoint. */
export function PositionCloseButton({id,symbol,side,quantity,unrealizedPnl}:{
  id:string;symbol:string;side:string;quantity:number;unrealizedPnl?:number|null
}) {
  const [open,setOpen]=useState(false);
  const [percentage,setPercentage]=useState(100);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const maxQty=Number.isFinite(quantity)&&quantity>0?quantity:0;
  const full=percentage===100;
  const qty=maxQty*percentage/100;
  const qtyText=(n:number)=>Number(n.toPrecision(10)).toLocaleString('en-US',{maximumFractionDigits:10});
  const baseSymbol=symbol.endsWith('USDT')?symbol.slice(0,-4):symbol;
  const estimate=typeof unrealizedPnl==='number'&&Number.isFinite(unrealizedPnl)?unrealizedPnl*percentage/100:null;
  const estimateText=estimate===null?'—':(estimate>=0?'+':'−')+Math.abs(estimate).toFixed(4)+' USDT';
  useEffect(()=>{
    if(!open)return;
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!busy)setOpen(false)};
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  },[open,busy]);
  const close=async()=>{
    if(busy||maxQty<=0||percentage<=0)return;
    setBusy(true);setError('');
    try{
      const r=await postJson('/api/positions/'+encodeURIComponent(id)+'/close',{confirm:true,percentage});
      if(!r.ok||r.data?.success===false)throw Error(r.data?.error||r.data?.message||'Position close was rejected');
      setOpen(false);
    }catch(e:any){setError(e.message||'Close failed. Verify the exchange position before retrying.')}
    finally{setBusy(false)}
  };
  return <>
    <button type="button" className="tb-v19-close-btn" onClick={()=>{setError('');setPercentage(100);setOpen(true)}} aria-label={`Close ${symbol} ${side} position`}>Close</button>
    {open&&<div className="tb-v19-close-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)setOpen(false)}}>
      <section className="tb-v19-close-dialog" role="dialog" aria-modal="true" aria-label={`Market close ${symbol} ${side}`}>
        <div className="tb-v19-close-heading">
          <h3>Market Close</h3>
          <button type="button" className="tb-v19-close-x" disabled={busy} onClick={()=>setOpen(false)} aria-label="Dismiss close dialog">×</button>
        </div>
        <div className="tb-v19-close-target">
          <span>SYMBOL <b>{symbol}</b></span><span>SIDE <b className={side==='Buy'?'green':'red'}>{side==='Buy'?'BUY':'SHORT'}</b></span>
        </div>
        <label htmlFor={`close-qty-${id}`} className="tb-v19-close-qty-label">Closed Qty {baseSymbol}</label>
        <div className="tb-v19-close-qty-box">
          <input id={`close-qty-${id}`} type="text" value={qtyText(qty)} readOnly aria-label="Quantity to close" />
          <button className="tb-v19-close-qty-btn" type="button" disabled={busy} onClick={()=>setPercentage(v=>Math.max(0,v-25))} aria-label="Reduce close percentage">−</button>
          <button className="tb-v19-close-qty-btn" type="button" disabled={busy} onClick={()=>setPercentage(v=>Math.min(100,v+25))} aria-label="Increase close percentage">+</button>
        </div>
        <div className="tb-v19-close-slider-wrap">
          <input type="range" min="0" max="100" step="1" value={percentage}
            disabled={busy} onChange={e=>setPercentage(Number(e.target.value))}
            aria-label="Percentage of position to close"
            style={{'--close-pct':percentage+'%'} as React.CSSProperties}/>
          <div className="tb-v19-close-slider-stops">{[0,25,50,75,100].map(n=><button type="button" key={n} disabled={busy} style={{left:n+'%'}} className={percentage>=n?'filled':''} onClick={()=>setPercentage(n)} aria-label={`Close ${n}% of position`} aria-pressed={percentage===n}/>)}</div>
          <div className="tb-v19-close-slider-labels"><span>0</span><span>{percentage}% selected</span><span>100%</span></div>
        </div>
        <div className="tb-v19-close-estimate">
          <p>{qtyText(qty)} {baseSymbol} contract(s) selected for a market close.</p>
          <p>Estimated unrealized P&amp;L: <strong className={estimate!==null&&estimate<0?'red':'green'}>{estimateText}</strong></p>
          <small>Estimate uses the latest position P&amp;L; fees and slippage are not included.</small>
        </div>
        {!full&&<p role="status" className="tb-v19-close-partial-notice">The server will round the close amount down to Bybit quantity steps and reject any invalid remaining position. The actual close quantity may differ slightly.</p>}
        {error&&<p role="alert" className="tb-v19-close-error">{error}</p>}
        <div className="tb-v19-close-actions">
          <button type="button" className="confirm" disabled={busy||percentage<=0||maxQty<=0} onClick={()=>void close()}>{busy?'Closing…':'Confirm Close '+percentage+'%'}</button>
          <button type="button" className="cancel" disabled={busy} onClick={()=>setOpen(false)}>Cancel</button>
        </div>
      </section>
    </div>}
  </>;
}
