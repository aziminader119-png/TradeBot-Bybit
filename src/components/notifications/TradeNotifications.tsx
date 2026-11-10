import {SymbolLink} from '../light/SymbolLink.tsx';
import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import type {BotStateSummary} from '../../types/trading.ts';
import {DateTime} from '../light/format.tsx';
import {SOUNDS} from './sounds.ts';
import type {AlertEvent} from '../../shared/alertRules.ts';
import {timeframeLabel} from '../../shared/alertRules.ts';
import {symbolPath} from '../light/navigation.ts';
const alertHref=(e:AlertEvent)=>symbolPath(e.symbol)+'?alert='+encodeURIComponent(e.id);
const alertText=(e:AlertEvent)=>`${e.indicator} · ${timeframeLabel(e.timeframe)} · ${e.conditionLabel}${e.mode==='intrabar'?' (intrabar)':''}${e.positionSide?` · ${e.positionOwner==='bot'?'BOT':'External'} ${e.positionSide==='Buy'?'BUY':'SELL'}`:''}`;
import {EVENT_NAMES,EventKind,TradeEvent,TradeEventCursor} from './tradeEvents.ts';
type Settings={text:boolean;sound:boolean;volume:number;sounds:Record<EventKind,string>};
const KEY='tradebot:trade-alerts:v1';
const defaults:Settings={text:true,sound:true,volume:.6,sounds:{BUY_OPEN:'apple-ringtone-1',BUY_CLOSE:'apple-ringtone-2',SHORT_OPEN:'apple-ringtone-3',SHORT_CLOSE:'apple-ringtone-4'}};
function readSettings():Settings{try{const s=JSON.parse(localStorage.getItem(KEY)||'null');if(!s)return defaults;const sounds={...defaults.sounds};for(const k of Object.keys(sounds) as EventKind[])if(SOUNDS.some(x=>x.id===s.sounds?.[k]))sounds[k]=s.sounds[k];return {text:s.text!==false,sound:s.sound!==false,volume:typeof s.volume==='number'&&Number.isFinite(s.volume)?Math.max(0,Math.min(1,s.volume)):.6,sounds};}catch{return defaults;}}
type Context={settings:Settings;save:(s:Settings)=>void;ready:boolean;preview:(id:string,volume?:number)=>void;mute:()=>void;error:string;history:TradeEvent[];unread:number;markRead:()=>void;alerts:AlertEvent[]};
const Alerts=createContext<Context|null>(null);
const amount=(n:number)=>n.toLocaleString('en-US',{maximumFractionDigits:8});
export function TradeNotifications({state,children}:{state:BotStateSummary|null;children:React.ReactNode}){
 const [unread,setUnread]=useState(0),[settings,setSettings]=useState(readSettings),[ready,setReady]=useState(false),[error,setError]=useState(''),[history,setHistory]=useState<TradeEvent[]>([]),[toasts,setToasts]=useState<(TradeEvent&{expires:number})[]>([]);
 const pendingToasts=useRef<TradeEvent[]>([]);
 const visibleToasts=useRef<(TradeEvent&{expires:number})[]>([]);
 const cursor=useRef(new TradeEventCursor()),current=useRef(settings),armed=useRef(false),player=useRef<HTMLAudioElement|null>(null),queue=useRef<string[]>([]),playing=useRef(false),audioRun=useRef(0),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),alive=useRef(true);current.current=settings;
 const stop=()=>{audioRun.current++;clearTimeout(timer.current);if(player.current){player.current.pause();player.current.onended=null;player.current.onerror=null;}playing.current=false;};
 const next=()=>{if(!alive.current||!armed.current||!current.current.sound||playing.current)return;const id=queue.current.shift();if(!id)return;const track=SOUNDS.find(s=>s.id===id);if(!track){next();return;}
  const audio=player.current||(player.current=new Audio());playing.current=true;audio.src=track.url;audio.volume=current.current.volume;
  const run=audioRun.current;const done=()=>{if(run!==audioRun.current)return;stop();next();};audio.onended=done;audio.onerror=()=>{setError('Sound could not be loaded.');done();};
  audio.play().then(()=>{if(run!==audioRun.current)return;if(alive.current)timer.current=setTimeout(done,2000);else audio.pause();}).catch(()=>{if(run!==audioRun.current||!alive.current)return;stop();armed.current=false;queue.current=[];setReady(false);setError('Click Enable Sound to allow browser audio.');});
 };
 const enqueue=async(e:TradeEvent)=>{
  if(!armed.current||!current.current.sound)return;
  // Coordinate sounds across already-unlocked tabs. This only stores an execution ID, never credentials.
  const claim=()=>{if(!armed.current||!alive.current)return;if(!current.current.sound)return;const key='tradebot:played:'+e.id;try{if(localStorage.getItem(key))return;localStorage.setItem(key,String(Date.now()));}catch{}queue.current.push(current.current.sounds[e.kind]);next();};
  try{if(navigator.locks)await navigator.locks.request('tradebot-audio-claim',claim);else claim();}catch{claim();}
 };
 const pumpToasts=()=>{const visible=visibleToasts.current.filter(e=>e.expires>Date.now());const updated=[...visible,...pendingToasts.current.splice(0,Math.max(0,4-visible.length)).map(e=>({...e,expires:Date.now()+12000}))];visibleToasts.current=updated;setToasts(updated);};
 useEffect(()=>{alive.current=true;const tick=setInterval(pumpToasts,1000);return()=>{alive.current=false;clearInterval(tick);armed.current=false;queue.current=[];stop();};},[]);
 // indicator / Smart MART alerts from the live snapshot (server-side evaluator): first snapshot = baseline, no replay
 const alertSeen=useRef<Set<string>|null>(null),[alertToasts,setAlertToasts]=useState<(AlertEvent&{expires:number})[]>([]);
 const latestAlerts=state?.indicatorAlerts?.latest||[];
 useEffect(()=>{const list=state?.indicatorAlerts?.latest;if(!list)return;if(!alertSeen.current){alertSeen.current=new Set(list.map(e=>e.id));return;}
  const fresh=list.filter(e=>!alertSeen.current!.has(e.id));for(const e of list)alertSeen.current.add(e.id);if(alertSeen.current.size>2000)alertSeen.current=new Set(list.map(e=>e.id));
  if(!fresh.length)return;setUnread(n=>n+fresh.length);if(current.current.text)setAlertToasts(t=>[...fresh.map(e=>({...e,expires:Date.now()+15000})),...t].slice(0,4));},[state?.indicatorAlerts]);
 useEffect(()=>{if(!alertToasts.length)return;const t=setTimeout(()=>setAlertToasts(x=>x.filter(e=>e.expires>Date.now())),1000);return()=>clearTimeout(t);},[alertToasts]);
 useEffect(()=>{if(!state)return;const fresh=cursor.current.ingest(state);if(!fresh.length)return;setUnread(n=>n+fresh.length);setHistory(h=>[...fresh.slice().reverse(),...h].slice(0,50));if(current.current.text){pendingToasts.current.push(...fresh);pumpToasts();}for(const e of fresh)void enqueue(e);},[state]);
 const save=(s:Settings)=>{current.current=s;setSettings(s);try{localStorage.setItem(KEY,JSON.stringify(s));}catch{setError('Browser storage is unavailable. Settings apply until this page closes.');}if(!s.sound){queue.current=[];stop();}if(!s.text){pendingToasts.current=[];visibleToasts.current=[];setToasts([]);}};
 const preview=(id:string,volume?:number)=>{const track=SOUNDS.find(s=>s.id===id);if(!track)return;queue.current=[];stop();const audio=player.current||(player.current=new Audio());audio.src=track.url;audio.volume=volume??current.current.volume;playing.current=true;const run=audioRun.current;setError('');audio.onended=()=>{if(run!==audioRun.current)return;stop();next();};audio.onerror=()=>{stop();setError('Sound could not be loaded.');};audio.play().then(()=>{if(run!==audioRun.current||!alive.current)return;armed.current=true;setReady(true);timer.current=setTimeout(()=>{stop();next();},2000);}).catch(()=>{if(run!==audioRun.current||!alive.current)return;stop();setReady(false);setError('Browser audio is blocked. Click Enable Sound again.');});};
 const mute=()=>{armed.current=false;setReady(false);queue.current=[];stop();};
 return <Alerts.Provider value={{settings,save,ready,preview,mute,error,history,unread,markRead:()=>setUnread(0),alerts:latestAlerts}}>{children}<aside className="trade-toast-stack" aria-live="polite" aria-label="Trade notifications">{alertToasts.map(e=><article className="trade-toast is-alert" key={'a:'+e.id}><button type="button" className="trade-toast-dismiss" aria-label="Dismiss notification" onClick={()=>setAlertToasts(t=>t.filter(x=>x.id!==e.id))}>×</button><strong>{e.positionId?'Smart MART alert':'Indicator alert'}</strong><a className="symbol-link" href={alertHref(e)} target="_blank" rel="noopener noreferrer">{e.symbol}</a><span>{alertText(e)}</span><span>Price {amount(e.price)} · notification only</span><small><DateTime ts={e.candleTime*1000}/></small></article>)}{toasts.map(e=><article className={'trade-toast '+(e.side==='Buy'?'is-buy':'is-short')} key={e.id}><button type="button" className="trade-toast-dismiss" aria-label="Dismiss notification" onClick={()=>{visibleToasts.current=visibleToasts.current.filter(x=>x.id!==e.id);pumpToasts();}}>×</button><strong>{e.side==='Buy'?'BUY':'SHORT'} {e.verb}</strong><SymbolLink symbol={e.symbol}>{e.symbol}</SymbolLink><span>Qty {amount(e.qty)} · Price {amount(e.price)}</span>{e.pnl!==null&&<span className={e.pnl<0?'red':'green'}>Realized P&amp;L {e.pnl>0?'+':''}{amount(e.pnl)} USDT</span>}<small><DateTime ts={e.time}/></small></article>)}</aside></Alerts.Provider>;
}
export function TradeAlertSettings(){const c=useContext(Alerts);if(!c)return null;return <TradeAlertForm context={c}/>;}
function TradeAlertForm({context:c}:{context:Context}){
 const [draft,setDraft]=useState(c.settings),[saved,setSaved]=useState(false);
 const update=(s:Settings)=>{setDraft(s);setSaved(false);};
 return <fieldset className="trade-alert-settings"><legend>Trade Alerts</legend><div className="trade-alert-switches"><label><input type="checkbox" checked={draft.text} onChange={e=>update({...draft,text:e.target.checked})}/>Text notifications</label><label><input type="checkbox" checked={draft.sound} onChange={e=>update({...draft,sound:e.target.checked})}/>Sound</label><button type="button" onClick={()=>c.ready?c.mute():c.preview(draft.sounds.BUY_OPEN,draft.volume)}>{c.ready?'Mute Sound':'Enable Sound'}</button><span className={c.ready?'green':''}>{c.ready?'Sound ready':'Click to enable audio'}</span></div><div className="trade-alert-sound-grid">{(Object.keys(EVENT_NAMES) as EventKind[]).map(k=><label key={k}><span className={k.startsWith('BUY')?'green':'red'}>{EVENT_NAMES[k]}</span><div><select aria-label={EVENT_NAMES[k]+' sound'} value={draft.sounds[k]} onChange={e=>update({...draft,sounds:{...draft.sounds,[k]:e.target.value}})}>{SOUNDS.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><button type="button" title="Preview sound" aria-label={'Preview '+EVENT_NAMES[k]} onClick={()=>c.preview(draft.sounds[k],draft.volume)}>▶</button></div></label>)}</div><div className="trade-alert-save"><label>Volume <input aria-label="Alert volume" type="range" min="0" max="100" value={Math.round(draft.volume*100)} onChange={e=>update({...draft,volume:Number(e.target.value)/100})}/>{Math.round(draft.volume*100)}%</label><button type="button" onClick={()=>{c.save(draft);setSaved(true);}}>Save</button>{saved&&<span className="green">Saved</span>}</div>{c.error&&<p className="red" role="status">{c.error}</p>}<small className="trade-alert-note">This browser · sounds play while an enabled tab is open</small>{c.history.length>0&&<details className="trade-alert-history"><summary>Recent trade notifications ({c.history.length})</summary>{c.history.map(e=><div key={e.id}><span className={e.side==='Buy'?'green':'red'}>{e.side==='Buy'?'BUY':'SHORT'} {e.verb}</span><SymbolLink symbol={e.symbol}>{e.symbol}</SymbolLink><span>{amount(e.qty)} @ {amount(e.price)}</span><DateTime ts={e.time}/></div>)}</details>}</fieldset>;
}


/** The bell uses the same global audio player as the dashboard controls. */
export function TradeNotificationBell(){
 const c=useContext(Alerts),[open,setOpen]=useState(false),root=useRef<HTMLDivElement|null>(null),button=useRef<HTMLButtonElement|null>(null);
 useEffect(()=>{
  if(!open)return;
  c?.markRead();
  const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
  const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);button.current?.focus();}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
 },[open,c?.history.length]);
 if(!c)return null;
 return <div className="notification-bell" ref={root} onBlur={e=>{if(e.relatedTarget&&!e.currentTarget.contains(e.relatedTarget as Node))setOpen(false);}}>
  <button ref={button} className="header-action-btn bell-button" type="button" aria-label={'Trade notifications'+(c.unread?', '+c.unread+' unread':'')} aria-expanded={open} aria-controls="trade-notification-panel" onClick={()=>setOpen(v=>!v)}>
   <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
   {c.unread>0&&<span className="bell-count">{c.unread>99?'99+':c.unread}</span>}
  </button>
  {open&&<section id="trade-notification-panel" className="notification-panel" aria-label="Recent trade notifications">
   <div className="notification-heading"><strong>Notifications</strong><button type="button" aria-label="Close notifications" onClick={()=>{setOpen(false);button.current?.focus();}}>×</button></div>
   <div className="notification-sound"><span className={c.ready?'green':''}>{c.ready?'Sound ready':'Sound not enabled'}</span><button type="button" onClick={()=>{if(c.ready)c.mute();else{if(!c.settings.sound)c.save({...c.settings,sound:true});c.preview(c.settings.sounds.BUY_OPEN);}}}>{c.ready?'Mute':'Enable Sound'}</button></div>
   {c.error&&<p className="red" role="status">{c.error}</p>}
   {c.alerts.length>0&&<><div className="notification-heading"><strong>Indicator alerts</strong><a href="/AlertHistory">History</a></div><ol className="notification-list" data-testid="bell-alerts">{c.alerts.slice(0,8).map(e=><li key={'a:'+e.id}><strong className={e.status==='new'?'orange':''}>{e.positionId?'Smart MART':'Indicator'}</strong><a className="symbol-link" href={alertHref(e)} target="_blank" rel="noopener noreferrer">{e.symbol}</a><span>{alertText(e)}</span><span>Price {amount(e.price)}</span><small><DateTime ts={e.candleTime*1000}/></small></li>)}</ol></>}
   {!c.history.length?<p className="notification-empty">No new trade notifications in this session.</p>:<ol className="notification-list">{c.history.map(e=><li key={e.id}>
    <strong className={e.side==='Buy'?'green':'red'}>{e.side==='Buy'?'BUY':'SHORT'} {e.verb}</strong>
    <SymbolLink symbol={e.symbol}>{e.symbol}</SymbolLink>
    <span>Qty {amount(e.qty)} · Price {amount(e.price)}</span>
    {e.pnl!==null&&<span className={e.pnl<0?'red':e.pnl>0?'green':''}>P&amp;L {e.pnl>0?'+':''}{amount(e.pnl)} USDT</span>}
    <small><DateTime ts={e.time}/></small>
   </li>)}</ol>}
  </section>}
 </div>;
}
