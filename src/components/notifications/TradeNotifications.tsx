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
const INDICATOR_KINDS=['EMA','SMA','RSI','MACD','BB','ADX','ATR','SAR','VOL','VWAP','PRICE'] as const;
const EXTRA_KINDS=['PUMP_SHORT_OPEN','PUMP_SHORT_CLOSE','DUMP_BUY_OPEN','DUMP_BUY_CLOSE','SMART_MART'] as const;
type AlertKind=EventKind|typeof INDICATOR_KINDS[number]|typeof EXTRA_KINDS[number];
const ALERT_LABELS:Record<AlertKind,string>={...EVENT_NAMES,PUMP_SHORT_OPEN:'Pump SHORT opened',PUMP_SHORT_CLOSE:'Pump SHORT closed',DUMP_BUY_OPEN:'Dump BUY opened',DUMP_BUY_CLOSE:'Dump BUY closed',SMART_MART:'Smart MART alert',EMA:'EMA indicator',SMA:'SMA indicator',RSI:'RSI indicator',MACD:'MACD indicator',BB:'Bollinger Bands',ADX:'ADX indicator',ATR:'ATR indicator',SAR:'Parabolic SAR',VOL:'Volume indicator',VWAP:'VWAP indicator',PRICE:'Price alert'};
const PERSIAN_LABELS:Record<AlertKind,string>={BUY_OPEN:'پوزیشن خرید باز شد',BUY_CLOSE:'پوزیشن خرید بسته شد',SHORT_OPEN:'پوزیشن فروش باز شد',SHORT_CLOSE:'پوزیشن فروش بسته شد',PUMP_SHORT_OPEN:'شورت پامپ باز شد',PUMP_SHORT_CLOSE:'شورت پامپ بسته شد',DUMP_BUY_OPEN:'خرید دامپ باز شد',DUMP_BUY_CLOSE:'خرید دامپ بسته شد',SMART_MART:'هشدار اسمارت مارت',EMA:'هشدار ای ام ای',SMA:'هشدار اس ام ای',RSI:'هشدار آر اس آی',MACD:'هشدار مکدی',BB:'هشدار باند بولینگر',ADX:'هشدار ای دی ایکس',ATR:'هشدار ای تی آر',SAR:'هشدار پارابولیک سار',VOL:'هشدار حجم',VWAP:'هشدار وی وپ',PRICE:'هشدار قیمت'};
const ALERT_KINDS=Object.keys(ALERT_LABELS) as AlertKind[];
type Tone={sound:string;voice:string;language:'fa'|'en';enabled:boolean};
type Settings={text:boolean;sound:boolean;voice:boolean;volume:number;sounds:Record<EventKind,string>;tones:Record<AlertKind,Tone>};
const KEY='tradebot:trade-alerts:v1';
const defaultSounds:Record<EventKind,string>={BUY_OPEN:'apple-ringtone-1',BUY_CLOSE:'apple-ringtone-2',SHORT_OPEN:'apple-ringtone-3',SHORT_CLOSE:'apple-ringtone-4'};
const defaultTones=()=>Object.fromEntries(ALERT_KINDS.map((kind,i)=>[kind,{sound:defaultSounds[kind as EventKind]||SOUNDS[i%SOUNDS.length].id,voice:'cloud:fa-IR-DilaraNeural',language:'fa',enabled:true}])) as Record<AlertKind,Tone>;
const defaults:Settings={text:true,sound:true,voice:true,volume:.6,sounds:defaultSounds,tones:defaultTones()};
function readSettings():Settings{try{const s=JSON.parse(localStorage.getItem(KEY)||'null');if(!s)return defaults;const sounds={...defaultSounds};for(const k of Object.keys(sounds) as EventKind[])if(SOUNDS.some(x=>x.id===s.sounds?.[k]))sounds[k]=s.sounds[k];const tones=defaultTones();for(const kind of ALERT_KINDS){const old=s.tones?.[kind];const language=old?.language==='en'?'en':'fa';tones[kind]={sound:SOUNDS.some(x=>x.id===old?.sound)?old.sound:(sounds[kind as EventKind]||tones[kind].sound),voice:typeof old?.voice==='string'&&old.voice!=='default'?old.voice:language==='fa'?'cloud:fa-IR-DilaraNeural':'cloud:en-US-JennyNeural',language,enabled:old?.enabled!==false};}return {text:s.text!==false,sound:s.sound!==false,voice:s.voice!==false,volume:typeof s.volume==='number'&&Number.isFinite(s.volume)?Math.max(0,Math.min(1,s.volume)):.6,sounds,tones};}catch{return defaults;}}
type Context={settings:Settings;save:(s:Settings)=>void;ready:boolean;preview:(id:string,volume?:number)=>void;previewVoice:(kind:AlertKind,voice:string,language:'fa'|'en')=>void;mute:()=>void;error:string;history:TradeEvent[];unread:number;markRead:()=>void;alerts:AlertEvent[]};
const Alerts=createContext<Context|null>(null);
const amount=(n:number)=>n.toLocaleString('en-US',{maximumFractionDigits:8});
const faSymbol=(symbol:string)=>symbol.replace(/USDT$/i,' تتر');
const faTimeframe=(frame:string)=>({ '5m':'پنج دقیقه','15m':'پانزده دقیقه','30m':'سی دقیقه','1h':'یک ساعت','2h':'دو ساعت','4h':'چهار ساعت','1d':'یک روز','1D':'یک روز'} as Record<string,string>)[frame]||frame;
const faCondition=(condition:string)=>condition.replace(/price crosses above/gi,'قیمت به بالای').replace(/price crosses below/gi,'قیمت به پایینِ').replace(/crosses above/gi,'عبور به بالا').replace(/crosses below/gi,'عبور به پایین').replace(/above/gi,'بالاتر از').replace(/below/gi,'پایین‌تر از');
const voiceProfiles=[{id:'profile:clear',name:'Persian - Clear',rate:.9,pitch:1},{id:'profile:calm',name:'Persian - Calm',rate:.76,pitch:.9},{id:'profile:bright',name:'Persian - Energetic',rate:1.08,pitch:1.12}] as const;
const serverVoices=[{id:'cloud:fa-IR-DilaraNeural',name:'Persian - Dilara (Female)',language:'fa'},{id:'cloud:fa-IR-FaridNeural',name:'Persian - Farid (Male)',language:'fa'},{id:'cloud:en-US-JennyNeural',name:'English - Jenny (Female)',language:'en'},{id:'cloud:en-US-GuyNeural',name:'English - Guy (Male)',language:'en'}] as const;
const setSpeechProfile=(utterance:SpeechSynthesisUtterance,voice:string)=>{const p=voiceProfiles.find(x=>x.id===voice);if(p){utterance.rate=p.rate;utterance.pitch=p.pitch;}};
export function TradeNotifications({state,children}:{state:BotStateSummary|null;children:React.ReactNode}){
 const [unread,setUnread]=useState(0),[settings,setSettings]=useState(readSettings),[ready,setReady]=useState(false),[error,setError]=useState(''),[history,setHistory]=useState<TradeEvent[]>([]),[toasts,setToasts]=useState<(TradeEvent&{expires:number})[]>([]);
 const pendingToasts=useRef<TradeEvent[]>([]);
 const visibleToasts=useRef<(TradeEvent&{expires:number})[]>([]);
 const cursor=useRef(new TradeEventCursor()),current=useRef(settings),armed=useRef(false),player=useRef<HTMLAudioElement|null>(null),queue=useRef<string[]>([]),playing=useRef(false),audioRun=useRef(0),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),alive=useRef(true);current.current=settings;
 const speechPlayer=useRef<HTMLAudioElement|null>(null);
 const playCloud=async(message:string,voice:string)=>{
  try{
   const res=await fetch('/api/tts',{method:'POST',body:JSON.stringify({text:message.slice(0,240),voice:voice.slice(6)})});
   if(!res.ok)throw Error(`Speech service unavailable (${res.status})`);
   const url=URL.createObjectURL(await res.blob());
   const audio=speechPlayer.current||(speechPlayer.current=new Audio());audio.pause();audio.src=url;audio.volume=current.current.volume;
   try{await audio.play();}finally{audio.onended=()=>URL.revokeObjectURL(url);audio.onerror=()=>URL.revokeObjectURL(url);}
   setError('');
  }catch(error){if(alive.current)setError((error as Error).message+' — check server TTS setup');}
 };
 const stop=()=>{audioRun.current++;clearTimeout(timer.current);if(player.current){player.current.pause();player.current.onended=null;player.current.onerror=null;}playing.current=false;};
 const speak=(message:string,kind:AlertKind,force=false)=>{
  if(!force&&(!armed.current||!current.current.sound||!current.current.voice||!current.current.tones[kind].enabled))return;
  const voiceName=current.current.tones[kind].voice;
  if(voiceName.startsWith('cloud:')){void playCloud(message,voiceName);return;}
  if(!('speechSynthesis' in window))return;
  const utterance=new SpeechSynthesisUtterance(message);
  const language=current.current.tones[kind].language;utterance.lang=language==='fa'?'fa-IR':'en-US';utterance.rate=.98;utterance.volume=current.current.volume;
  const voices=window.speechSynthesis.getVoices();setSpeechProfile(utterance,voiceName);
  utterance.voice=voices.find(v=>v.voiceURI===voiceName&&v.lang.startsWith(language))||voices.find(v=>v.lang.startsWith(language)&&/natural|google|microsoft/i.test(v.name))||voices.find(v=>v.lang.startsWith(language))||null;
  window.speechSynthesis.speak(utterance);
 };
 const tradeKind=(e:TradeEvent):AlertKind=>e.source==='pump'&&e.side==='Sell'?(e.kind==='SHORT_CLOSE'?'PUMP_SHORT_CLOSE':'PUMP_SHORT_OPEN'):e.source==='dump'&&e.side==='Buy'?(e.kind==='BUY_CLOSE'?'DUMP_BUY_CLOSE':'DUMP_BUY_OPEN'):e.kind;
 const next=()=>{if(!alive.current||!armed.current||!current.current.sound||playing.current)return;const id=queue.current.shift();if(!id)return;const track=SOUNDS.find(s=>s.id===id);if(!track){next();return;}
  const audio=player.current||(player.current=new Audio());playing.current=true;audio.src=track.url;audio.volume=current.current.volume;
  const run=audioRun.current;const done=()=>{if(run!==audioRun.current)return;stop();next();};audio.onended=done;audio.onerror=()=>{setError('Sound could not be loaded.');done();};
  audio.play().then(()=>{if(run!==audioRun.current)return;if(alive.current)timer.current=setTimeout(done,2000);else audio.pause();}).catch(()=>{if(run!==audioRun.current||!alive.current)return;stop();armed.current=false;queue.current=[];setReady(false);setError('Click Enable Sound to allow browser audio.');});
 };
 const enqueue=async(e:TradeEvent)=>{
  if(!armed.current||!current.current.sound)return;
  // Coordinate sounds across already-unlocked tabs. This only stores an execution ID, never credentials.
  const claim=()=>{if(!armed.current||!alive.current)return;if(!current.current.sound)return;const key='tradebot:played:'+e.id;try{if(localStorage.getItem(key))return;localStorage.setItem(key,String(Date.now()));}catch{}const kind=tradeKind(e);if(!current.current.tones[kind].enabled)return;queue.current.push(current.current.tones[kind].sound);next();setTimeout(()=>{if(alive.current){const fa=current.current.tones[kind].language==='fa';speak(fa?`${PERSIAN_LABELS[kind]}، ارز ${faSymbol(e.symbol)}، تعداد ${e.qty}، قیمت ${e.price}.${e.pnl===null?'':` سود و زیان تحقق‌یافته ${e.pnl} تتر.`}`:`${ALERT_LABELS[kind]} for ${e.symbol}. Quantity ${e.qty}. Price ${e.price}.${e.pnl===null?'':` Realized P and L ${e.pnl} USDT.`}`,kind);}},2200);};
  try{if(navigator.locks)await navigator.locks.request('tradebot-audio-claim',claim);else claim();}catch{claim();}
 };
 const enqueueIndicator=async(e:AlertEvent)=>{
  if(!armed.current||!current.current.sound)return;
  const claim=()=>{
   if(!armed.current||!alive.current||!current.current.sound)return;
   const key='tradebot:played:indicator:'+e.id;
   try{if(localStorage.getItem(key))return;localStorage.setItem(key,String(Date.now()));}catch{}
   const kind:AlertKind=e.positionId?'SMART_MART':e.indicator as AlertKind;
   if(!current.current.tones[kind]?.enabled)return;
   queue.current.push(current.current.tones[kind].sound);next();
   setTimeout(()=>{if(alive.current){const fa=current.current.tones[kind].language==='fa';speak(fa?`${PERSIAN_LABELS[kind]} برای ${faSymbol(e.symbol)}، تایم فریم ${faTimeframe(timeframeLabel(e.timeframe))}، ${faCondition(e.conditionLabel)}، قیمت ${e.price}.`:`${ALERT_LABELS[kind]} for ${e.symbol}. ${timeframeLabel(e.timeframe)} timeframe. ${e.conditionLabel}. Price ${e.price}.`,kind);}},2200);
  };
  try{if(navigator.locks)await navigator.locks.request('tradebot-audio-claim',claim);else claim();}catch{claim();}
 };
 const pumpToasts=()=>{const visible=visibleToasts.current.filter(e=>e.expires>Date.now());const updated=[...visible,...pendingToasts.current.splice(0,Math.max(0,4-visible.length)).map(e=>({...e,expires:Date.now()+12000}))];visibleToasts.current=updated;setToasts(updated);};
 useEffect(()=>{alive.current=true;const tick=setInterval(pumpToasts,1000);return()=>{alive.current=false;clearInterval(tick);armed.current=false;queue.current=[];stop();};},[]);
 // Browsers revoke autoplay permission on reload. Keep the saved preference and
 // re-unlock silently on the first user interaction, without playing a ringtone.
 useEffect(()=>{
  let pending=false;
  const unlock=()=>{
   if(armed.current||pending||!current.current.sound)return;
   pending=true;
   const sound=SOUNDS.find(s=>s.id===current.current.sounds.BUY_OPEN);
   if(!sound){pending=false;return;}
   const audio=player.current||(player.current=new Audio());
   audio.src=sound.url;audio.muted=true;
   void audio.play().then(()=>{
    audio.pause();audio.currentTime=0;audio.muted=false;
    if(alive.current&&current.current.sound){armed.current=true;setReady(true);setError('');next();}
   }).catch(()=>{audio.muted=false;}).finally(()=>{pending=false;});
  };
  document.addEventListener('pointerdown',unlock,{capture:true});
  document.addEventListener('keydown',unlock,{capture:true});
  return()=>{document.removeEventListener('pointerdown',unlock,true);document.removeEventListener('keydown',unlock,true);};
 },[]);
 // indicator / Smart MART alerts from the live snapshot (server-side evaluator): first snapshot = baseline, no replay
 const alertSeen=useRef<Set<string>|null>(null),[alertToasts,setAlertToasts]=useState<(AlertEvent&{expires:number})[]>([]);
 const latestAlerts=state?.indicatorAlerts?.latest||[];
 useEffect(()=>{const list=state?.indicatorAlerts?.latest;if(!list)return;if(!alertSeen.current){alertSeen.current=new Set(list.map(e=>e.id));return;}
  const fresh=list.filter(e=>!alertSeen.current!.has(e.id));for(const e of list)alertSeen.current.add(e.id);if(alertSeen.current.size>2000)alertSeen.current=new Set(list.map(e=>e.id));
  if(!fresh.length)return;setUnread(n=>n+fresh.length);if(current.current.text)setAlertToasts(t=>[...fresh.map(e=>({...e,expires:Date.now()+15000})),...t].slice(0,4));for(const e of fresh)void enqueueIndicator(e);},[state?.indicatorAlerts]);
 useEffect(()=>{if(!alertToasts.length)return;const t=setTimeout(()=>setAlertToasts(x=>x.filter(e=>e.expires>Date.now())),1000);return()=>clearTimeout(t);},[alertToasts]);
 useEffect(()=>{if(!state)return;const fresh=cursor.current.ingest(state);if(!fresh.length)return;setUnread(n=>n+fresh.length);setHistory(h=>[...fresh.slice().reverse(),...h].slice(0,50));if(current.current.text){pendingToasts.current.push(...fresh);pumpToasts();}for(const e of fresh)void enqueue(e);},[state]);
 const save=(s:Settings)=>{current.current=s;setSettings(s);try{localStorage.setItem(KEY,JSON.stringify(s));}catch{setError('Browser storage is unavailable. Settings apply until this page closes.');}if(!s.sound){queue.current=[];stop();speechPlayer.current?.pause();window.speechSynthesis?.cancel();}if(!s.text){pendingToasts.current=[];visibleToasts.current=[];setToasts([]);}};
 const preview=(id:string,volume?:number)=>{const track=SOUNDS.find(s=>s.id===id);if(!track)return;queue.current=[];stop();const audio=player.current||(player.current=new Audio());audio.src=track.url;audio.volume=volume??current.current.volume;playing.current=true;const run=audioRun.current;setError('');audio.onended=()=>{if(run!==audioRun.current)return;stop();next();};audio.onerror=()=>{stop();setError('Sound could not be loaded.');};audio.play().then(()=>{if(run!==audioRun.current||!alive.current)return;armed.current=true;setReady(true);timer.current=setTimeout(()=>{stop();next();},2000);}).catch(()=>{if(run!==audioRun.current||!alive.current)return;stop();setReady(false);setError('Browser audio is blocked. Click Enable Sound again.');});};
 const previewVoice=(kind:AlertKind,voice:string,language:'fa'|'en')=>{const message=language==='fa'?`${PERSIAN_LABELS[kind]}، ارز بیت کوین تتر، قیمت صد تتر.`:`${ALERT_LABELS[kind]}. Bitcoin U S D T. Price 100 dollars.`;if(voice.startsWith('cloud:')){void playCloud(message,voice);return;}if(!('speechSynthesis' in window))return;window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(message);u.lang=language==='fa'?'fa-IR':'en-US';u.volume=current.current.volume;u.rate=.98;setSpeechProfile(u,voice);u.voice=window.speechSynthesis.getVoices().find(v=>v.voiceURI===voice&&v.lang.startsWith(language))||window.speechSynthesis.getVoices().find(v=>v.lang.startsWith(language))||null;window.speechSynthesis.speak(u);};
 const mute=()=>{save({...current.current,sound:false});armed.current=false;setReady(false);queue.current=[];stop();};
 return <Alerts.Provider value={{settings,save,ready,preview,previewVoice,mute,error,history,unread,markRead:()=>setUnread(0),alerts:latestAlerts}}>{children}<aside className="trade-toast-stack" aria-live="polite" aria-label="Trade notifications">{alertToasts.map(e=><article className="trade-toast is-alert" key={'a:'+e.id}><button type="button" className="trade-toast-dismiss" aria-label="Dismiss notification" onClick={()=>setAlertToasts(t=>t.filter(x=>x.id!==e.id))}>×</button><strong>{e.positionId?'Smart MART alert':'Indicator alert'}</strong><a className="symbol-link" href={alertHref(e)} target="_blank" rel="noopener noreferrer">{e.symbol}</a><span>{alertText(e)}</span><span>Price {amount(e.price)} · notification only</span><small><DateTime ts={e.candleTime*1000}/></small></article>)}{toasts.map(e=><article className={'trade-toast '+(e.side==='Buy'?'is-buy':'is-short')} key={e.id}><button type="button" className="trade-toast-dismiss" aria-label="Dismiss notification" onClick={()=>{visibleToasts.current=visibleToasts.current.filter(x=>x.id!==e.id);pumpToasts();}}>×</button><strong>{e.side==='Buy'?'BUY':'SHORT'} {e.verb}</strong><SymbolLink symbol={e.symbol}>{e.symbol}</SymbolLink><span>Qty {amount(e.qty)} · Price {amount(e.price)}</span>{e.pnl!==null&&<span className={e.pnl<0?'red':'green'}>Realized P&amp;L {e.pnl>0?'+':''}{amount(e.pnl)} USDT</span>}<small><DateTime ts={e.time}/></small></article>)}</aside></Alerts.Provider>;
}
export function TradeAlertSettings(){const c=useContext(Alerts);if(!c)return null;return <TradeAlertForm context={c}/>;}
function TradeAlertForm({context:c}:{context:Context}){
 const [draft,setDraft]=useState(c.settings),[saved,setSaved]=useState(false);
 const [voices,setVoices]=useState<SpeechSynthesisVoice[]>([]);
 useEffect(()=>{if(!('speechSynthesis' in window))return;const refresh=()=>setVoices(window.speechSynthesis.getVoices());refresh();window.speechSynthesis.addEventListener('voiceschanged',refresh);return()=>window.speechSynthesis.removeEventListener('voiceschanged',refresh);},[]);
 const update=(s:Settings)=>{setDraft(s);setSaved(false);};
 const changeTone=(kind:AlertKind,part:Partial<Tone>)=>update({...draft,tones:{...draft.tones,[kind]:{...draft.tones[kind],...part}}});
 const groups:[string,AlertKind[]][]=[['Positions',['BUY_OPEN','BUY_CLOSE','SHORT_OPEN','SHORT_CLOSE']],['Pump & Dump',['PUMP_SHORT_OPEN','PUMP_SHORT_CLOSE','DUMP_BUY_OPEN','DUMP_BUY_CLOSE']],['Indicators',[...INDICATOR_KINDS]],['Other',['SMART_MART']]];
 return <fieldset className="trade-alert-settings"><legend>Trade Alerts</legend>
  <div className="trade-alert-switches"><label><input type="checkbox" checked={draft.text} onChange={e=>update({...draft,text:e.target.checked})}/>Text notifications</label><label><input type="checkbox" checked={draft.sound} onChange={e=>update({...draft,sound:e.target.checked})}/>Sound</label><label><input type="checkbox" checked={draft.voice} onChange={e=>update({...draft,voice:e.target.checked})}/>Spoken alerts</label><button type="button" onClick={()=>c.ready?c.mute():c.preview(draft.tones.BUY_OPEN.sound,draft.volume)}>{c.ready?'Mute Sound':'Enable Sound'}</button><span className={c.ready?'green':''}>{c.ready?'Sound ready':'Click to enable audio'}</span></div>
  {groups.map(([group,kinds])=><section className="trade-alert-group" key={group}><h4>{group}</h4><div className="trade-alert-sound-grid">{kinds.map(kind=><div className="trade-alert-tone" key={kind}>
   <label className="trade-alert-tone-name"><input aria-label={'Enable '+ALERT_LABELS[kind]} type="checkbox" checked={draft.tones[kind].enabled} onChange={e=>changeTone(kind,{enabled:e.target.checked})}/>{ALERT_LABELS[kind]}</label>
   <div className="trade-alert-tone-control"><select aria-label={ALERT_LABELS[kind]+' ringtone'} value={draft.tones[kind].sound} onChange={e=>changeTone(kind,{sound:e.target.value})}>{SOUNDS.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><button type="button" title="Preview ringtone" onClick={()=>c.preview(draft.tones[kind].sound,draft.volume)}>▶</button></div>
   <div className="trade-alert-tone-control"><select aria-label={ALERT_LABELS[kind]+' language'} value={draft.tones[kind].language} onChange={e=>changeTone(kind,{language:e.target.value as 'fa'|'en',voice:e.target.value==='fa'?'cloud:fa-IR-DilaraNeural':'cloud:en-US-JennyNeural'})}><option value="fa">Farsi</option><option value="en">English</option></select><select aria-label={ALERT_LABELS[kind]+' voice'} value={draft.tones[kind].voice} onChange={e=>changeTone(kind,{voice:e.target.value})}><option value="default">{draft.tones[kind].language==='fa'?'Browser Persian voice':'Browser English voice'}</option>{serverVoices.filter(v=>v.language===draft.tones[kind].language).map(v=><option key={v.id} value={v.id}>{v.name}</option>)}{draft.tones[kind].language==='fa'&&voiceProfiles.map(v=><option key={v.id} value={v.id}>{v.name} (browser)</option>)}{voices.filter(v=>v.lang.startsWith(draft.tones[kind].language)).map(v=><option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}</select><button type="button" title="Preview spoken alert" onClick={()=>c.previewVoice(kind,draft.tones[kind].voice,draft.tones[kind].language)}>🗣</button></div>
  </div>)}</div></section>)}
  <div className="trade-alert-save"><label>Volume <input aria-label="Alert volume" type="range" min="0" max="100" value={Math.round(draft.volume*100)} onChange={e=>update({...draft,volume:Number(e.target.value)/100})}/>{Math.round(draft.volume*100)}%</label><button type="button" onClick={()=>{c.save(draft);setSaved(true);}}>Save</button>{saved&&<span className="green">Saved</span>}</div>
  {c.error&&<p className="red" role="status">{c.error}</p>}<small className="trade-alert-note">Saved per browser · voices depend on installed browser/system voices · an interaction is required after reload</small>
  {c.history.length>0&&<details className="trade-alert-history"><summary>Recent trade notifications ({c.history.length})</summary>{c.history.map(e=><div key={e.id}><span className={e.side==='Buy'?'green':'red'}>{e.side==='Buy'?'BUY':'SHORT'} {e.verb}</span><SymbolLink symbol={e.symbol}>{e.symbol}</SymbolLink><span>{amount(e.qty)} @ {amount(e.price)}</span><DateTime ts={e.time}/></div>)}</details>}
 </fieldset>;
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
