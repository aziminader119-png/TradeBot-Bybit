import React from 'react';
// Adapted from NADERAZIMI/nexora-frontend SpotProChart.tsx: Futures datafeed and isolated local chart preferences.
import { useEffect, useRef, useState } from 'react';
import { Chart, darkTheme, lightTheme, ichimoku, supertrend, envelope, emaRibbon, twap, smc, stochastic, obv, mfi, williamsR, roc, cvd } from '../../vendor/mg-chart/index.js';
import type { Timeframe, Indicator } from '../../vendor/mg-chart/index.js';
type SpotPair={symbol:string};
import {FuturesDatafeed as BybitMGDatafeed} from './futuresStream.ts';
import type { BookState } from './futuresStream.ts';
import DepthChart from './DepthChart';
import ChartAlerts,{CHART_TO_ALERT_TF,ALERT_TO_CHART_TF} from './ChartAlerts';
import {sharedIndicator} from './sharedIndicators.ts';
import {INDICATORS,PRICE_SOURCES,type IndicatorKey} from '../../shared/indicators.ts';
import {blankRule,type RuleDraft,historyUrl} from '../alerts/AlertCenter.tsx';
import type {AlertEvent} from '../../shared/alertRules.ts';
import './FuturesChart.css';
import type {OrderLine} from '../../vendor/mg-chart/core/renderer/order-lines';
import {syncPositionLines} from './positionLines.ts';

const intervals: Timeframe[] = ['1m','3m','5m','15m','30m','1H','2H','4H','6H','12H','1D','1W','1M'];
const defaultPinned:Timeframe[]=['1m','5m','15m','30m','1H','4H','1D','1W','1M'];
const timeframeKey='tradebot:futures:mg-chart:active-timeframe';
const loadTimeframe=():Timeframe=>{try{const value=localStorage.getItem(timeframeKey);return intervals.includes(value as Timeframe)?value as Timeframe:'5m'}catch{return '5m'}};
const sortTimes=(values:Timeframe[])=>[...values].sort((a,b)=>intervals.indexOf(a)-intervals.indexOf(b));
const chartFont='"Inter",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif';
const nxTheme=(light:boolean)=>({... (light?lightTheme:darkTheme),bg:getComputedStyle(document.documentElement).getPropertyValue('--nx-chart-bg').trim()||getComputedStyle(document.documentElement).getPropertyValue('--nx-surface').trim()||(light?'#FFFFFF':'#101014'),fontFamily:chartFont});
const pinnedKey='tradebot:futures:mg-chart:pinned-timeframes';
const pinnedLayoutVersionKey='tradebot:futures:mg-chart:pinned-layout-version';
const loadPinned=():Timeframe[]=>{
 try{
  // One-time migration: existing 8-slot layouts must display the new ten standard shortcuts.
  if(localStorage.getItem(pinnedLayoutVersionKey)!=='10'){
   localStorage.setItem(pinnedKey,JSON.stringify(defaultPinned));
   localStorage.setItem(pinnedLayoutVersionKey,'10');
   return defaultPinned;
  }
  const raw:unknown=JSON.parse(localStorage.getItem(pinnedKey)||'null');
  if(!Array.isArray(raw)||!raw.length)return defaultPinned;
  const valid=raw.filter((v:unknown,i:number)=>typeof v==='string'&&intervals.includes(v as Timeframe)&&raw.indexOf(v)===i) as Timeframe[];
  return valid.length?sortTimes(valid.slice(0,10)):defaultPinned;
 }catch{return defaultPinned}
};
// EMA, SMA, RSI, MACD, Bollinger, ADX, ATR, Parabolic SAR, Volume and VWAP use the SHARED math (identical to the server
// alert evaluator); the remaining studies are the chart engine's own and are display only (no alerts).
type IndicatorEntry={key:string;label:string;shared?:IndicatorKey;make:(params?:Record<string,number|string>)=>Indicator};
const vendorEntry=(key:string,label:string,indicator:Indicator):IndicatorEntry=>({key,label,make:()=>indicator});
const sharedEntry=(key:IndicatorKey):IndicatorEntry=>({key,label:INDICATORS[key].label,shared:key,make:(params)=>{try{return sharedIndicator(key,params||{})}catch{return sharedIndicator(key,{})}}});
const indicatorList: IndicatorEntry[] = [
 sharedEntry('SMA'),sharedEntry('EMA'),sharedEntry('BB'),sharedEntry('VWAP'),sharedEntry('SAR'),sharedEntry('RSI'),sharedEntry('MACD'),sharedEntry('ATR'),sharedEntry('ADX'),sharedEntry('VOL'),
 vendorEntry('ICH','Ichimoku Cloud',ichimoku),vendorEntry('ST','Supertrend',supertrend),vendorEntry('ENV','Envelope',envelope),
 vendorEntry('RIBBON','EMA Ribbon',emaRibbon),vendorEntry('TWAP','TWAP',twap),vendorEntry('SMC','Smart Money Concepts',smc),
 vendorEntry('STOCH','Stochastic',stochastic),vendorEntry('OBV','On Balance Volume',obv),vendorEntry('MFI','Money Flow Index',mfi),
 vendorEntry('WR','Williams %R',williamsR),vendorEntry('ROC','Rate of Change',roc),vendorEntry('CVD','Cumulative Volume Delta (OHLCV estimate)',cvd)
];

const drawingGroups: {label:string;tools:[string,string][]}[] = [
 {label:'Lines',tools:[['trend-line','Trend Line'],['ray','Ray'],['extended-line','Extended Line'],['horizontal-line','Horizontal Line'],['horizontal-ray','Horizontal Ray'],['vertical-line','Vertical Line'],['cross-line','Cross Line'],['info-line','Info Line'],['polyline','Polyline'],['trend-angle','Trend Angle']]},
 {label:'Channels',tools:[['parallel-channel','Parallel Channel'],['regression-channel','Regression Channel'],['pitchfork','Pitchfork'],['schiff-pitchfork','Schiff Pitchfork'],['modified-schiff-pitchfork','Modified Schiff Pitchfork'],['inside-pitchfork','Inside Pitchfork'],['disjoint-channel','Disjoint Channel']]},
 {label:'Fibonacci',tools:[['fib-retracement','Retracement'],['fib-extension','Extension'],['fib-channel','Channel'],['fib-timezone','Time Zone'],['fib-speed-fan','Speed Fan'],['fib-circles','Circles'],['fib-spiral','Spiral'],['fib-arcs','Arcs'],['fib-wedge','Wedge'],['trend-fib-extension','Trend Extension'],['trend-fib-time','Trend Time']]},
 {label:'Gann & Cycles',tools:[['gann-box','Gann Box'],['gann-fan','Gann Fan'],['gann-square','Gann Square'],['gann-square-fixed','Fixed Gann Square'],['cyclic-lines','Cyclic Lines'],['time-cycles','Time Cycles'],['sine-line','Sine Line']]},
 {label:'Patterns',tools:[['xabcd-pattern','XABCD'],['abcd-pattern','ABCD'],['head-shoulders','Head & Shoulders'],['three-drives','Three Drives'],['cypher-pattern','Cypher'],['elliott-impulse','Elliott Impulse'],['elliott-correction','Elliott Correction'],['elliott-triangle','Elliott Triangle'],['elliott-double-combo','Elliott Double Combo'],['elliott-triple-combo','Elliott Triple Combo'],['triangle','Triangle'],['flat-top-bottom','Flat Top/Bottom'],['bars-pattern','Bars Pattern']]},
 {label:'Shapes & Text',tools:[['rectangle','Rectangle'],['ellipse','Ellipse'],['arc','Arc'],['arrow','Arrow'],['brush','Brush'],['text','Text'],['text-annotation','Text Annotation'],['note','Note'],['callout','Callout'],['flag-marker','Flag']]},
 {label:'Trading & Measure',tools:[['long-short','Long/Short Position'],['price-range','Price Range'],['date-range','Date Range'],['date-price-range','Date + Price Range'],['forecast','Forecast'],['fixed-range-vp','Fixed Range Volume Profile'],['anchored-vwap','Anchored VWAP']]}
];
// Supported chart styles: Standard Candlestick and Heikin Ashi only.
type ChartStyle='candlestick'|'heikin_ashi';
const chartStyles:{id:ChartStyle;label:string}[]=[{id:'candlestick',label:'Candles'},{id:'heikin_ashi',label:'Heikin Ashi'}];
function StyleIcon({kind}:{kind:ChartStyle}){switch(kind){case 'candlestick':return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round"><path d="M6 2v20M12 2v20M18 2v20"/><rect x="3.5" y="7" width="5" height="8" rx=".5"/><rect x="9.5" y="4" width="5" height="11" rx=".5"/><rect x="15.5" y="10" width="5" height="7" rx=".5"/></svg>;case 'heikin_ashi':return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round"><path d="M6 2v20M12 2v20M18 2v20"/><rect x="3.5" y="7" width="5" height="8" rx=".5"/><rect x="9.5" y="4" width="5" height="11" rx=".5"/><rect x="15.5" y="10" width="5" height="7" rx=".5"/></svg>;default:return null}}
const readStored=(key:string)=>{try{return JSON.parse(localStorage.getItem(key)||'null') as {drawings?:object[];indicators?:string[];volumeProfile?:boolean}|null}catch{return null}};
type MultiLayout=1|2|3|4|5;
const multiLayoutKey='tradebot:futures:mg-chart:multi-layout';
function CompanionChart({symbol,timeframe,index,lines}:{symbol:string;timeframe:Timeframe;index:number;lines:OrderLine[]}){
 const current=useRef<Chart|null>(null),latest=useRef(lines);latest.current=lines;
 useEffect(()=>{if(current.current)syncPositionLines(current.current,lines);},[lines]);
 const mount=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const node=mount.current;if(!node)return;
  let instance:Chart|null=null;const feed=new BybitMGDatafeed(symbol);
  try{instance=new Chart({container:node,symbol,timeframe,datafeed:feed,theme:nxTheme(document.documentElement.dataset.nxTheme==='light'),chartType:'candlestick',renderer:'webgl',features:{volume:true},trading:{showPlusButton:false,showContextMenu:false,draggableOrderLines:false}})}
  catch(e){console.warn('[TradeBot Futures] Companion chart failed',e)}
  current.current=instance;if(instance)syncPositionLines(instance,latest.current);
  return()=>{current.current=null;instance?.destroy();feed.destroy()};
 },[symbol,timeframe]);
 return <div className="nx-multi-cell"><div className="nx-multi-label">{symbol} · {timeframe} · {index+1}</div><div ref={mount} className="nx-multi-chart-mount"/></div>;
}
/** Indicator settings: shared indicators show their real parameters (period, source, colour, thickness, thresholds);
 *  "Create alert" opens the alert builder with the same indicator and parameters (identical server-side math). */
function IndicatorSettings({entry,values,onClose,onApply,onAlert}:{entry:IndicatorEntry;values?:Record<string,number|string>;onClose:()=>void;onApply:(v:Record<string,number|string>)=>void;onAlert?:(v:Record<string,number|string>)=>void}){
 const spec=entry.shared?INDICATORS[entry.shared]:null;
 const fields=spec?spec.params:Object.entries(values||{period:entry.key==='EMA'?50:14}).map(([name,v])=>({name,label:name,kind:'number' as const,default:v}));
 const read=(form:HTMLFormElement)=>{const fd=new FormData(form),out:Record<string,number|string>={};for(const f of fields){const v=fd.get(f.name);if(v===null)continue;out[f.name]=f.kind==='source'||f.kind==='color'?String(v):Number(v)}return out};
 return <section className="nexora-mg-popover mg-settings-popover"><header><strong>{entry.label} Settings</strong><button onClick={onClose}>×</button></header><form onSubmit={e=>{e.preventDefault();onApply(read(e.currentTarget))}}>
  {fields.map(f=><label key={f.name}>{f.label}{f.kind==='source'?<select name={f.name} defaultValue={String(values?.[f.name]??f.default)}>{PRICE_SOURCES.map(s=><option key={s}>{s}</option>)}</select>:f.kind==='color'?<input name={f.name} type="color" defaultValue={String(values?.[f.name]??f.default)}/>:<input name={f.name} type="number" step={(f as any).step??'any'} min={(f as any).min} max={(f as any).max} defaultValue={String(values?.[f.name]??f.default)} required/>}</label>)}
  <button type="submit">Apply</button>{onAlert&&<button type="button" data-testid="indicator-create-alert" onClick={e=>onAlert(read(e.currentTarget.form!))}>Create alert</button>}
 </form></section>;
}
export default function FuturesChart({pair,frame,livePrice,book,positionLines=[]}:{pair:SpotPair;frame:string;livePrice:number|null;book:BookState;positionLines?:OrderLine[]}){
 const latestLines=useRef(positionLines);latestLines.current=positionLines;
 const [multiLayout,setMultiLayout]=useState<MultiLayout>(()=>{
  try{const n=Number(localStorage.getItem(multiLayoutKey));return n>=1&&n<=5?n as MultiLayout:1}catch{return 1}
 });
 const [multiMenu,setMultiMenu]=useState(false);
 const [chartViewTab,setChartViewTab]=useState<'Standard'|'TradingView'|'Depth'>('TradingView');
 const [syncInterval,setSyncInterval]=useState(true);
 const changeMulti=(count:MultiLayout)=>{setMultiLayout(count);setMultiMenu(false);try{localStorage.setItem(multiLayoutKey,String(count))}catch{}};
 const holder=useRef<HTMLDivElement>(null);
 const chart=useRef<Chart|null>(null);
 const instanceIds=useRef<Map<string,string>>(new Map());
 const [error,setError]=useState<string|null>(null);
 const [indicatorMenu,setIndicatorMenu]=useState(false);
 const [chartTypeMenu,setChartTypeMenu]=useState(false);
 const [chartPopupLeft,setChartPopupLeft]=useState(8);
 const [drawMenu,setDrawMenu]=useState(false);
 const [drawingGroup,setDrawingGroup]=useState<string|null>(null);
 const [railSearch,setRailSearch]=useState('');
 const [activeTools,setActiveTools]=useState<string|null>(null);
 const [chosen,setChosen]=useState<string[]>(['SMA']);
 // indicators kept in the list (with their settings) but not drawn; persisted per symbol
 const [hidden,setHidden]=useState<string[]>([]);const hiddenRef=useRef<Set<string>>(new Set());
 const [alertDraft,setAlertDraft]=useState<RuleDraft|null>(null);
 const [vp,setVp]=useState(false);
 const [kind,setKind]=useState<ChartStyle>('candlestick');

 const [drawSearch,setDrawSearch]=useState('');
 const [indSearch,setIndSearch]=useState('');
 const [objectsOpen,setObjectsOpen]=useState(false);
 const [alertsOpen,setAlertsOpen]=useState(false);
 const [compareOpen,setCompareOpen]=useState(false);
 const [compareSymbol,setCompareSymbol]=useState('');
 const [compared,setCompared]=useState<string[]>([]);
 const [settingsOpen,setSettingsOpen]=useState<string|null>(null);
 const [params,setParams]=useState<Record<string,Record<string,number|string>>>({});
 const [favorites,setFavorites]=useState<string[]>([]);
 const [magnet,setMagnet]=useState(false);
 const [stayDrawing,setStayDrawing]=useState(false);
 const [drawVersion,setDrawVersion]=useState(0);
 const root=useRef<HTMLDivElement>(null);
 const [allDrawingsLocked,setAllDrawingsLocked]=useState(false);
 const [allDrawingsHidden,setAllDrawingsHidden]=useState(false);
 const [drawingColor,setDrawingColor]=useState('#3D6BFF');
 const [drawingWidth,setDrawingWidth]=useState(2);
 const [selectedDrawing,setSelectedDrawing]=useState<string|null>(null);
 const [priceScale,setPriceScale]=useState<'linear'|'logarithmic'|'percentage'>('linear');
 const [localFrame,setLocalFrame]=useState<Timeframe>(loadTimeframe);
 const [pinned,setPinned]=useState<Timeframe[]>(loadPinned);
 const [timeframeMenu,setTimeframeMenu]=useState(false);
 const [editPinned,setEditPinned]=useState(false);
 useEffect(()=>{
  if(!timeframeMenu)return;
  const onPointerDown=(event:PointerEvent)=>{
   const target=event.target;
   if(!(target instanceof Node))return;
   const panel=root.current?.querySelector('.mg-timeframe-menu');
   const arrow=root.current?.querySelector('.mg-timeframe-arrow');
   if(!panel?.contains(target)&&!arrow?.contains(target))setTimeframeMenu(false);
  };
  const onContextMenu=()=>setTimeframeMenu(false);
  const onKeyDown=(event:KeyboardEvent)=>{if(event.key==='Escape')setTimeframeMenu(false)};
  document.addEventListener('pointerdown',onPointerDown,true);
  document.addEventListener('contextmenu',onContextMenu,true);
  document.addEventListener('keydown',onKeyDown);
  return ()=>{document.removeEventListener('pointerdown',onPointerDown,true);document.removeEventListener('contextmenu',onContextMenu,true);document.removeEventListener('keydown',onKeyDown)};
 },[timeframeMenu]);
 useEffect(()=>{
  const anyOpen=timeframeMenu||chartTypeMenu||indicatorMenu||drawMenu||drawingGroup!==null||settingsOpen!==null||objectsOpen||alertsOpen||compareOpen;
  if(!anyOpen)return;
  const dismiss=()=>{setTimeframeMenu(false);setChartTypeMenu(false);setIndicatorMenu(false);setDrawMenu(false);setDrawingGroup(null);setSettingsOpen(null);setObjectsOpen(false);setAlertsOpen(false);setCompareOpen(false)};
  const outside=(event:PointerEvent)=>{const target=event.target;if(!(target instanceof Node))return;const host=root.current;if(!host)return;
   const insideMenu=Array.from(host.querySelectorAll('.mg-timeframe-menu,.nexora-mg-popover,.nexora-mg-objects,.mg-rail-flyout,.nx-alert-panel')).some(el=>el.contains(target));
   const trigger=Array.from(host.querySelectorAll('.mg-timeframe-arrow,.mg-compact-icon,.nexora-mg-toolbar button,.nexora-mg-rail button')).some(el=>el.contains(target));
   if(!insideMenu&&!trigger)dismiss();
  };
  const rightClick=()=>dismiss();
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')dismiss()};
  document.addEventListener('pointerdown',outside,true);document.addEventListener('contextmenu',rightClick,true);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('contextmenu',rightClick,true);document.removeEventListener('keydown',escape)};
 },[timeframeMenu,chartTypeMenu,indicatorMenu,drawMenu,settingsOpen,objectsOpen,alertsOpen,compareOpen,drawingGroup]);
 const vpRef=useRef(false);
 const paramRef=useRef<Record<string,Record<string,number|string>>>({});
 const key='tradebot:futures:mg-chart:'+pair.symbol;
 const save=()=>{const c=chart.current;if(!c)return;try{localStorage.setItem(key,JSON.stringify({drawings:c.getDrawings(),indicators:[...instanceIds.current.keys()],volumeProfile:vpRef.current,params:paramRef.current,hiddenIndicators:[...hiddenRef.current]}))}catch{/* Private browsing or full storage */}};
 useEffect(()=>{
  const node=holder.current;if(!node)return;
  let disposed=false;
  setError(null);
  const saved=readStored(key);
  const savedHidden=((saved as any)?.hiddenIndicators||[]).filter((k:string)=>indicatorList.some(i=>i.key===k));hiddenRef.current=new Set(savedHidden);setHidden(savedHidden);
  if(saved?.indicators)setChosen([...saved.indicators.filter(k=>indicatorList.some(i=>i.key===k)),...savedHidden]);

  setVp(Boolean(saved?.volumeProfile));vpRef.current=Boolean(saved?.volumeProfile);
  const extra=saved as typeof saved & {params?:Record<string,Record<string,number|string>>;favorites?:string[]};
  paramRef.current=extra?.params||{};setParams(paramRef.current);
  try{setFavorites(JSON.parse(localStorage.getItem('tradebot:futures:mg-favorites')||'[]'))}catch{setFavorites([])}
  const feed=new BybitMGDatafeed(pair.symbol);
  const next=new Chart({container:node,symbol:pair.symbol,timeframe:localFrame,datafeed:feed,theme:nxTheme(document.documentElement.dataset.nxTheme==='light'),chartType:kind,renderer:'webgl',features:{volume:true},trading:{showPlusButton:false,showContextMenu:false,draggableOrderLines:false}});
  if(disposed){next.destroy();return}
  chart.current=next;syncPositionLines(next,latestLines.current);
  // Alert annotations are non-interactive dashed MG order-line overlays.
  // Keep them distinct from trading orders and normal drawings.
  instanceIds.current.clear();
  const items=(saved?.indicators||['SMA']).filter(k=>indicatorList.some(i=>i.key===k));
  for(const k of items){const entry=indicatorList.find(i=>i.key===k);if(entry){try{instanceIds.current.set(k,next.addIndicator(entry.make(paramRef.current[k]),paramRef.current[k] as any))}catch(e){console.warn('[TradeBot Futures] Indicator failed:',k,e)}}}
  if(saved?.volumeProfile)next.setVolumeProfile(true);
  if(saved?.drawings?.length){try{next.loadDrawings(saved.drawings)}catch(e){console.warn('[TradeBot Futures] Drawing restore failed',e)}}
  const persist=()=>{try{localStorage.setItem(key,JSON.stringify({drawings:next.getDrawings(),indicators:[...instanceIds.current.keys()],volumeProfile:vpRef.current,params:paramRef.current,hiddenIndicators:[...hiddenRef.current]}))}catch{/* storage inaccessible */}};
  let persistTimer:number|undefined;
  const persistSoon=()=>{window.clearTimeout(persistTimer);persistTimer=window.setTimeout(()=>{if(!disposed)persist()},300)};
  for(const event of ['drawingAdded','drawingRemoved','drawingModified','drawingSelected'] as const)next.on(event,()=>{setDrawVersion(v=>v+1);if(event!=='drawingSelected')persistSoon()});
  // the chart engine emits no event when a drawing is moved or one of its points is edited: save after each drag
  node.addEventListener('pointerup',persistSoon,true);
  window.addEventListener('pagehide',persist);
  const updateChartTheme=()=>!disposed&&next.setTheme(nxTheme(document.documentElement.dataset.nxTheme==='light'));
  const observer=new MutationObserver(updateChartTheme);
  window.addEventListener('tradebot:futures:design-change',updateChartTheme);
  observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-nx-theme','style']});
  return ()=>{disposed=true;window.clearTimeout(persistTimer);node.removeEventListener('pointerup',persistSoon,true);window.removeEventListener('pagehide',persist);observer.disconnect();window.removeEventListener('tradebot:futures:design-change',updateChartTheme);persist();next.destroy();feed.destroy();if(chart.current===next)chart.current=null;instanceIds.current.clear()};
 },[pair.symbol,frame]);
 useEffect(()=>{if(chart.current)syncPositionLines(chart.current,positionLines);},[positionLines]);
 // Opened from an alert (?alert=<event id>): switch to the alert's timeframe and mark the triggering candle and price.
 const [alertEvent,setAlertEvent]=useState<AlertEvent|null>(null);
 useEffect(()=>{let id:string|null=null;try{id=new URLSearchParams(window.location.search).get('alert')}catch{}if(!id)return;let gone=false;
  fetch(historyUrl(pair.symbol)).then(r=>r.json()).then((d:{events?:AlertEvent[]})=>{const e=d.events?.find(x=>x.id===id);if(!e||gone)return;setAlertEvent(e);const tf=ALERT_TO_CHART_TF[e.timeframe] as Timeframe|undefined;if(tf&&tf!==localFrame&&intervals.includes(tf))changeTimeframe(tf);}).catch(()=>{});
  return()=>{gone=true};},[pair.symbol]);
 useEffect(()=>{const c=chart.current;if(!c||!alertEvent)return;const bull=/above|bull|up|oversold/.test(alertEvent.condition);
  try{c.setBarMarkers([{time:alertEvent.candleTime,label:'⚑ '+alertEvent.indicator+' '+alertEvent.conditionLabel,color:bull?'#26A69A':'#EF5350',position:bull?'below':'above'}]);c.setPriceMarkers([{price:alertEvent.price,label:'Alert '+alertEvent.price,color:'#EAA343'}])}catch(e){console.warn('[TradeBot Futures] alert marker failed',e)}
 },[alertEvent,frame,localFrame]);
 const setChartStyle=(type:ChartStyle)=>{
  try{
   setKind(type);
   chart.current?.setChartType(type);
   setChartTypeMenu(false);
  }catch(e){setError(String(e))}
 };
 const toggleIndicator=(k:string)=>{const c=chart.current,entry=indicatorList.find(i=>i.key===k);if(!c||!entry)return;try{const ids=instanceIds.current;if(hiddenRef.current.has(k)){hiddenRef.current.delete(k);setHidden([...hiddenRef.current]);setChosen([...ids.keys()]);save();return;}if(ids.has(k)){c.removeIndicator(ids.get(k)!);ids.delete(k);setChosen([...ids.keys(),...hiddenRef.current]);save();return;}else ids.set(k,c.addIndicator(entry.make(paramRef.current[k]),paramRef.current[k] as any));hiddenRef.current.delete(k);setHidden([...hiddenRef.current]);setChosen([...ids.keys(),...hiddenRef.current]);save();}catch(e){setError('Indicator could not be added: '+String(e))}};
 /** show / hide an added indicator without losing it or its settings */
 const toggleVisible=(k:string)=>{const c=chart.current,entry=indicatorList.find(i=>i.key===k);if(!c||!entry)return;try{const ids=instanceIds.current;if(ids.has(k)){c.removeIndicator(ids.get(k)!);ids.delete(k);hiddenRef.current.add(k)}else if(hiddenRef.current.has(k)){ids.set(k,c.addIndicator(entry.make(paramRef.current[k]),paramRef.current[k] as any));hiddenRef.current.delete(k)}setHidden([...hiddenRef.current]);setChosen([...ids.keys(),...hiddenRef.current]);save()}catch(e){setError(String(e))}};
 const chooseTool=(name:string|null)=>{try{chart.current?.setDrawingTool(name);setActiveTools(name);setDrawMenu(false);setDrawingGroup(null)}catch(e){setError('Drawing tool failed: '+String(e))}};
 const toggleVP=()=>{const n=!vp;chart.current?.setVolumeProfile(n);vpRef.current=n;setVp(n)};
 const toggleFavorite=(k:string)=>setFavorites(v=>{const next=v.includes(k)?v.filter(x=>x!==k):[...v,k];try{localStorage.setItem('tradebot:futures:mg-favorites',JSON.stringify(next))}catch{}return next});
 const applyParams=(k:string,values:Record<string,number|string>)=>{const entry=indicatorList.find(i=>i.key===k),c=chart.current;if(!entry||!c)return;try{paramRef.current={...paramRef.current,[k]:values};setParams(paramRef.current);const id=instanceIds.current.get(k);if(id)c.removeIndicator(id);hiddenRef.current.delete(k);setHidden([...hiddenRef.current]);instanceIds.current.set(k,c.addIndicator(entry.make(values),values as any));setChosen([...instanceIds.current.keys(),...hiddenRef.current]);setSettingsOpen(null);save()}catch(e){setError(String(e))}};
 const items=(()=>{void drawVersion;try{return chart.current?.getDrawingInstances()||[]}catch{return []}})() as Array<{id:string;toolName:string;visible:boolean;locked:boolean}>;
 const drawingAction=(id:string,action:string)=>{const c=chart.current;if(!c)return;try{if(action==='remove')c.removeDrawing(id);else if(action==='visible')c.toggleDrawingVisible(id);else if(action==='lock')c.toggleDrawingLock(id);else if(action==='front')c.bringDrawingToFront(id);else if(action==='back')c.sendDrawingToBack(id);setDrawVersion(v=>v+1);save()}catch(e){setError(String(e))}};
 const addCompare=async()=>{const symbol=compareSymbol.trim().toUpperCase();if(!/^[A-Z0-9]{2,32}$/.test(symbol)||symbol===pair.symbol){setError('Enter another valid market symbol');return}try{await chart.current?.addCompare(symbol);setCompared(v=>v.includes(symbol)?v:[...v,symbol]);setCompareSymbol('')}catch(e){setError('Symbol comparison failed: '+String(e))}};
 const removeCompare=(symbol:string)=>{chart.current?.removeCompare(symbol);setCompared(v=>v.filter(x=>x!==symbol))};
 const toggleMagnet=()=>{const next=!magnet;chart.current?.setMagnetMode(next);setMagnet(next)};
 const toggleAllLock=()=>{const next=!allDrawingsLocked;if(next)chart.current?.lockAllDrawings();else chart.current?.unlockAllDrawings();setAllDrawingsLocked(next);setDrawVersion(v=>v+1);save()};
 const toggleAllHidden=()=>{const next=!allDrawingsHidden;if(next)chart.current?.hideAllDrawings();else chart.current?.showAllDrawings();setAllDrawingsHidden(next);setDrawVersion(v=>v+1);save()};
 const changeDrawingAppearance=(field:'color'|'lineWidth',value:string|number)=>{if(!selectedDrawing)return;try{chart.current?.updateDrawing(selectedDrawing,{[field]:value});setDrawVersion(v=>v+1);save()}catch(e){setError(String(e))}};
 const toggleFullscreen=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await root.current?.requestFullscreen()}catch(e){setError(String(e))}};
 const changeTimeframe=(timeframe:Timeframe)=>{try{chart.current?.setTimeframe(timeframe).catch(e=>setError('Timeframe switch failed: '+String(e)));setLocalFrame(timeframe);try{localStorage.setItem(timeframeKey,timeframe)}catch{}setTimeframeMenu(false)}catch(e){setError('Timeframe switch failed: '+String(e))}};
 const togglePinned=(timeframe:Timeframe)=>setPinned(current=>{const updated=current.includes(timeframe)?(current.length>1?current.filter(t=>t!==timeframe):current):(current.length<10?[...current,timeframe]:current);const sorted=sortTimes(updated);try{localStorage.setItem(pinnedKey,JSON.stringify(sorted))}catch{}return sorted});
 const toggleStayDrawing=()=>{const next=!stayDrawing;chart.current?.setStayInDrawingMode(next);setStayDrawing(next)};
 return <div ref={root} className="nexora-mg-chart">
   <div className="nexora-mg-toolbar">
    <div className="mg-intervals">{pinned.map(t=><button key={t} className={t===localFrame?'selected':''} type="button" title={'Switch to '+t} onClick={()=>changeTimeframe(t)}>{t}</button>)}<button className={timeframeMenu?'selected mg-timeframe-arrow':'mg-timeframe-arrow'} aria-label="Choose timeframes" aria-expanded={timeframeMenu} type="button" onClick={()=>{setTimeframeMenu(v=>!v);setChartTypeMenu(false);setIndicatorMenu(false)}}>▾</button></div>
    <button type="button" className={chartTypeMenu?'selected mg-compact-icon':'mg-compact-icon'} aria-label="Chart styles" title="Chart styles" aria-expanded={chartTypeMenu} onClick={e=>{const chartRoot=root.current;if(chartRoot){const trigger=(e.currentTarget as HTMLElement).getBoundingClientRect();const base=chartRoot.getBoundingClientRect();setChartPopupLeft(Math.max(4,Math.min(trigger.left-base.left,base.width-165)))}setChartTypeMenu(v=>!v);setTimeframeMenu(false);setIndicatorMenu(false);setDrawMenu(false)}}><svg viewBox="0 0 24 24" aria-hidden="true" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M6 3v18M6 7h0M12 2v20M18 4v17"/><rect x="3.5" y="8" width="5" height="8" rx=".8"/><rect x="9.5" y="5" width="5" height="11" rx=".8"/><rect x="15.5" y="10" width="5" height="7" rx=".8"/></svg></button>
    <button type="button" className={indicatorMenu?'selected mg-compact-icon':'mg-compact-icon'} aria-label="Indicators" title="Indicators" aria-expanded={indicatorMenu} onClick={()=>{setIndicatorMenu(v=>!v);setChartTypeMenu(false);setTimeframeMenu(false);setDrawMenu(false)}}><svg viewBox="0 0 24 24" aria-hidden="true" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 18h18M5 15l4-5 4 3 6-8"/><path d="M16 5h3v3"/></svg></button>
    

    <button type="button" className={alertsOpen?'selected':''} onClick={()=>setAlertsOpen(v=>!v)}>Alerts</button>
    <button type="button" className={compareOpen?'selected':''} onClick={()=>setCompareOpen(v=>!v)}>Compare</button>
    <div className="mg-toolbar-spacer"/>

    <div className="nx-chart-view-tabs" role="tablist" aria-label="Chart view modes">{(['Standard','TradingView','Depth'] as const).map(view=><button key={view} type="button" role="tab" aria-selected={chartViewTab===view} className={chartViewTab===view?'active':''} onClick={()=>setChartViewTab(view)}>{view}</button>)}</div>
    <button type="button" className={'nx-chart-volume-profile'+(vp?' selected':'')} aria-pressed={vp} onClick={toggleVP}>Volume Profile</button>
    <button type="button" className="nx-chart-multi-trigger" aria-label="Chart layout" aria-expanded={multiMenu} title="Chart layout" onClick={()=>setMultiMenu(v=>!v)}><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="4" width="16" height="16" rx="3"/></svg></button>
    <button type="button" className="nx-chart-screenshot" aria-label="Take chart screenshot" title="Screenshot" onClick={()=>chart.current?.exportPNG('TradeBot Futures-'+pair.symbol+'.png')}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.4"/></svg></button>
    <button type="button" className="nx-chart-fullscreen" aria-label="Toggle chart fullscreen" title="Fullscreen chart" onClick={toggleFullscreen}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 3H3v6M3 3l7 7M15 21h6v-6m0 6-7-7"/></svg></button>
    {chartTypeMenu&&<section className="nexora-mg-popover mg-chart-type-popover" style={{left:chartPopupLeft}} role="menu" aria-label="Chart styles"><div className="mg-chart-style-list">{chartStyles.map(item=><button type="button" role="menuitemradio" aria-checked={kind===item.id} key={item.id} className={kind===item.id?'selected':''} onClick={()=>setChartStyle(item.id)}><span className="mg-style-icon" aria-hidden="true"><StyleIcon kind={item.id}/></span><span>{item.label}</span></button>)}</div></section>}
       </div>
    {multiMenu&&<div className="nx-multi-layout-menu" role="dialog" aria-label="Multi chart layout">
      <div className="nx-multi-layout-title">Chart layout</div>
      <div className="nx-multi-layout-choices">
       {[1,2,3,4,5].map(n=><button type="button" className={'nx-multi-option'+(multiLayout===n?' active':'')} key={n} aria-label={n+' chart layout'} aria-pressed={multiLayout===n} onClick={()=>changeMulti(n as MultiLayout)}><span className="nx-multi-index">{n}</span><span className={'nx-mini-layout nx-mini-layout-'+n}>{Array.from({length:n},(_,i)=><i key={i}/>)}</span></button>)}
      </div>
      <div className="nx-multi-layout-title nx-multi-divider">Sync chart settings</div>
      <div className="nx-multi-toggle"><span>Symbol</span><button type="button" className="nx-sync-switch is-on" role="switch" aria-checked={true} aria-label="Sync symbol" title="All charts follow the selected market" disabled><i/></button></div>
      <div className="nx-multi-toggle"><span>Interval</span><button type="button" className={'nx-sync-switch'+(syncInterval?' is-on':'')} role="switch" aria-checked={syncInterval} aria-label="Sync interval" onClick={()=>setSyncInterval(v=>!v)}><i/></button></div>
      <div className="nx-multi-toggle"><span>Crosshair</span><button type="button" className="nx-sync-switch" role="switch" aria-checked={false} aria-label="Sync crosshair" title="Not supported by the chart engine yet" disabled><i/></button></div>
      <div className="nx-multi-toggle"><span>Time</span><button type="button" className="nx-sync-switch" role="switch" aria-checked={false} aria-label="Sync time" title="Not supported by the chart engine yet" disabled><i/></button></div>
      <div className="nx-multi-toggle"><span>Date Range</span><button type="button" className="nx-sync-switch" role="switch" aria-checked={false} aria-label="Sync date range" title="Not supported by the chart engine yet" disabled><i/></button></div>
     </div>}
   <div className="nexora-mg-stage">
    {timeframeMenu&&<section className="mg-timeframe-menu" role="dialog" aria-label="Timeframe selection"><header><strong>Pinned ({pinned.length}/10)</strong><button className="mg-pin-edit" type="button" onClick={()=>setEditPinned(v=>!v)}>{editPinned?'Done':'Edit'}</button></header><div className="mg-timeframe-grid">{pinned.map(t=><button type="button" key={t} className={t===localFrame?'selected':''} onClick={()=>editPinned?togglePinned(t):changeTimeframe(t)}>{t}{editPinned?' ×':''}</button>)}</div><header><strong>Available</strong><span>{pinned.length>=10?'Maximum 10 pinned':''}</span></header><div className="mg-timeframe-grid">{intervals.filter(t=>!pinned.includes(t)).map(t=><button type="button" key={t} onClick={()=>editPinned?togglePinned(t):changeTimeframe(t)} disabled={editPinned&&pinned.length>=10}>{t}{editPinned?' +':''}</button>)}</div>{editPinned&&<p className="mg-pin-hint">Choose up to 10 shortcuts. Your selection is saved automatically.</p>}</section>}
    <aside className="nexora-mg-rail" aria-label="Drawing toolbar">
 <button type="button" className={!activeTools?'selected':''} title="Crosshair / Cursor" aria-label="Cursor" onClick={()=>chooseTool(null)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2v20M2 12h20"/></svg></button>
 <button type="button" title="Trend Line" aria-label="Trend Line" className={activeTools==='trend-line'?'selected':''} onClick={()=>chooseTool('trend-line')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 20L20 4"/><circle cx="4" cy="20" r="2"/><circle cx="20" cy="4" r="2"/></svg></button>
 <button type="button" title="Lines" aria-label="Lines" onClick={()=>setDrawingGroup('Lines')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 5h20M2 12h20M2 19h20"/><circle cx="8" cy="5" r="2"/><circle cx="16" cy="12" r="2"/></svg></button>
 <button type="button" title="Patterns" aria-label="Patterns" onClick={()=>setDrawingGroup('Patterns')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 19 8 5l6 10 7-10M3 19l11-4 7 4"/><circle cx="8" cy="5" r="2"/><circle cx="14" cy="15" r="2"/></svg></button>
 <button type="button" title="Fibonacci" aria-label="Fibonacci" onClick={()=>setDrawingGroup('Fibonacci')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 5h20M2 10h20M2 15h20M2 20h20"/><circle cx="7" cy="10" r="2"/><circle cx="17" cy="15" r="2"/></svg></button>
 <button type="button" title="Brush and Shapes" aria-label="Brush and Shapes" onClick={()=>setDrawingGroup('Shapes & Text')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 19c6 2 7-5 11-11l5-5 2 2-5 5C10 14 11 21 3 19Z"/></svg></button>
 <button type="button" title="Text" aria-label="Text" className={activeTools==='text'?'selected':''} onClick={()=>chooseTool('text')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 5h18M12 5v15M7 20h10"/></svg></button>
 <button type="button" title="Ruler / Measure price and time" aria-label="Ruler" className={activeTools==='date-price-range'?'selected':''} onClick={()=>chooseTool('date-price-range')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><g transform="rotate(-45 12 12)"><rect x="3" y="8" width="18" height="8" rx="1"/><path d="M6 8v4M9 8v3M12 8v4M15 8v3M18 8v4"/></g></svg></button>
 <button type="button" title="Long / Short and Measurement" aria-label="Trading and measuring tools" onClick={()=>setDrawingGroup('Trading & Measure')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 5h14v14H5zM5 12h14M12 5v14"/></svg></button>
 <button type="button" title="All Drawing Tools" aria-label="All Drawing Tools" className={drawingGroup==='All tools'?'selected':''} onClick={()=>{setRailSearch('');setDrawingGroup(v=>v==='All tools'?null:'All tools')}}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="7" cy="18" r="2"/></svg></button>
 <button type="button" title="Keep drawing tool active" aria-label="Keep Tool" aria-pressed={stayDrawing} className={stayDrawing?'selected':''} onClick={toggleStayDrawing}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M5 18l9-9 4 4-9 9H5v-4ZM13 10l2-2 4 4-2 2M15 5l4-2 2 4-3 2"/></svg></button>
 <button type="button" title="Drawing objects manager" aria-label="Objects" aria-expanded={objectsOpen} className={objectsOpen?'selected':''} onClick={()=>setObjectsOpen(v=>!v)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="4" y="5" width="11" height="11" rx="1"/><path d="M9 9h11v11H9z"/></svg></button>
 <button type="button" title="Magnet" aria-label="Toggle Magnet" className={magnet?'selected':''} onClick={toggleMagnet}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 12V7a7 7 0 0 1 14 0v5h-5V7a2 2 0 0 0-4 0v5z"/></svg></button>
 <button type="button" title="Lock All Drawings" aria-label="Lock All Drawings" onClick={toggleAllLock}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></button>
 <button type="button" title="Show / Hide Drawings" aria-label="Show or Hide Drawings" onClick={toggleAllHidden}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button>
 <div className="mg-rail-spacer"/>
 <button type="button" className="mg-rail-trash" title="Delete all drawings" aria-label="Delete all drawings" onClick={()=>{if(window.confirm('Delete all drawings for '+pair.symbol+'?')){chart.current?.clearDrawings();save()}}}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></svg></button>
 </aside>
    <div className="nx-depth-layer" style={{display:chartViewTab==='Depth'?'block':'none'}}><DepthChart book={book} symbol={pair.symbol}/></div>
    <div className={'nx-multi-chart-area nx-multi-layout-'+multiLayout} style={{display:chartViewTab==='Depth'?'none':undefined}}>
     <div className="nexora-mg-render nx-multi-primary" ref={holder}/>
     {Array.from({length:multiLayout-1},(_,i)=><CompanionChart key={i} lines={positionLines} symbol={pair.symbol} timeframe={syncInterval?localFrame:'1H'} index={i+1}/>)}
    </div>
    {drawMenu&&<section className="nexora-mg-popover mg-draw-popover" role="dialog" aria-label="Drawing Tools"><header><strong>Drawing Tools</strong><button type="button" aria-label="Close drawing tools" onClick={()=>setDrawMenu(false)}>×</button></header><input aria-label="Search drawing tools" value={drawSearch} placeholder="Search drawing tools..." onChange={e=>setDrawSearch(e.target.value)}/><div className="nexora-mg-options"><button type="button" onClick={()=>chooseTool(null)}>Cursor / Cancel tool</button>{drawingGroups.map(g=><div key={g.label}><h4>{g.label}</h4>{g.tools.filter(([,label])=>label.toLowerCase().includes(drawSearch.toLowerCase())).map(([id,label])=><button type="button" key={id} className={activeTools===id?'selected':''} onClick={()=>chooseTool(id)}>{label}</button>)}</div>)}</div></section>}
    <ChartAlerts symbol={pair.symbol} livePrice={livePrice} open={alertsOpen} onClose={()=>setAlertsOpen(false)} draft={alertDraft} frame={localFrame}/>
    {compareOpen&&<section className="nexora-mg-objects"><header><strong>Compare Markets</strong><button onClick={()=>setCompareOpen(false)}>×</button></header><div className="mg-sidebar-form"><input aria-label="Compare market symbol" placeholder="ETHUSDT" value={compareSymbol} onChange={e=>setCompareSymbol(e.target.value)}/><button onClick={addCompare}>Compare</button></div><div className="nexora-mg-options">{compared.map(symbol=><div key={symbol} className="mg-object-row"><span>{symbol}</span><button onClick={()=>removeCompare(symbol)}>Remove</button></div>)}</div></section>}
    {objectsOpen&&<section className="nexora-mg-objects"><header><strong>Objects ({items.length})</strong><button onClick={()=>setObjectsOpen(false)}>×</button></header>{selectedDrawing&&<div className="mg-sidebar-form mg-drawing-style"><label>Color <input type="color" value={drawingColor} onChange={e=>{setDrawingColor(e.target.value);changeDrawingAppearance('color',e.target.value)}}/></label><label>Width <input type="number" min="1" max="12" value={drawingWidth} onChange={e=>{const n=Number(e.target.value);setDrawingWidth(n);changeDrawingAppearance('lineWidth',n)}}/></label></div>}<div className="nexora-mg-options">{items.length===0?<p>No drawings yet</p>:items.map((d,index)=><div className="mg-object-row" key={d.id||index}><button className={selectedDrawing===d.id?'selected':''} title="Select drawing" onClick={()=>setSelectedDrawing(d.id)}>{d.toolName||'Drawing'} #{index+1}</button><div><button title="Show/hide" onClick={()=>drawingAction(d.id,'visible')}>◉</button><button title="Lock/unlock" onClick={()=>drawingAction(d.id,'lock')}>♧</button><button title="Bring forward" onClick={()=>drawingAction(d.id,'front')}>↑</button><button title="Send backward" onClick={()=>drawingAction(d.id,'back')}>↓</button><button title="Delete" onClick={()=>drawingAction(d.id,'remove')}>×</button></div></div>)}</div></section>}
    {error&&<div className="nexora-mg-error" role="alert">{error}<button onClick={()=>setError(null)}>Dismiss</button></div>}
    {indicatorMenu&&<section className="nexora-mg-popover mg-indicator-popover"><header><strong>Indicators</strong><button onClick={()=>setIndicatorMenu(false)}>×</button></header><input value={indSearch} placeholder="Search indicators..." onChange={e=>setIndSearch(e.target.value)}/><div className="nexora-mg-options">{indicatorList.filter(i=>i.label.toLowerCase().includes(indSearch.toLowerCase())||i.key.toLowerCase().includes(indSearch.toLowerCase())).sort((a,b)=>Number(favorites.includes(b.key))-Number(favorites.includes(a.key))).map(i=><div className="mg-indicator-row" key={i.key}><button title="Favorite" onClick={()=>toggleFavorite(i.key)}>{favorites.includes(i.key)?'★':'☆'}</button><button className={chosen.includes(i.key)?'selected':''} onClick={()=>toggleIndicator(i.key)} title={chosen.includes(i.key)?'Remove from chart':'Add to chart'}><span>{i.label}</span><span>{chosen.includes(i.key)?'✓':'+'}</span></button>{chosen.includes(i.key)&&<button title={hidden.includes(i.key)?'Show':'Hide'} aria-label={(hidden.includes(i.key)?'Show ':'Hide ')+i.label} data-indicator-visible={hidden.includes(i.key)?'0':'1'} onClick={()=>toggleVisible(i.key)}>{hidden.includes(i.key)?'◌':'👁'}</button>}<button title="Settings" onClick={()=>setSettingsOpen(i.key)}>⚙</button></div>)}</div></section>}
    {settingsOpen&&<IndicatorSettings entry={indicatorList.find(i=>i.key===settingsOpen)!} values={params[settingsOpen]} onClose={()=>setSettingsOpen(null)} onApply={v=>applyParams(settingsOpen,v)} onAlert={indicatorList.find(i=>i.key===settingsOpen)?.shared?(v=>{const k=indicatorList.find(i=>i.key===settingsOpen)!.shared!;setAlertDraft({...blankRule(pair.symbol,false,k,v),timeframe:(CHART_TO_ALERT_TF[localFrame]||'60') as any});setAlertsOpen(true);setSettingsOpen(null)}):undefined}/>}
    {drawingGroup&&<section className="mg-rail-flyout" role="menu" aria-label={drawingGroup}><header><strong>{drawingGroup}</strong><button type="button" aria-label="Close drawing menu" onClick={()=>setDrawingGroup(null)}>×</button></header><input className="mg-rail-search" aria-label="Search drawing tools" placeholder="Search tools..." value={railSearch} onChange={e=>setRailSearch(e.target.value)}/><div className="mg-rail-flyout-items">{(drawingGroup==='All tools'?drawingGroups:drawingGroups.filter(g=>g.label===drawingGroup)).map(g=><div key={g.label}><h4>{g.label}</h4>{g.tools.filter(([,label])=>label.toLowerCase().includes(railSearch.toLowerCase())).map(([id,label])=><button type="button" role="menuitem" className={activeTools===id?'selected':''} key={id} onClick={()=>chooseTool(id)}>{label}</button>)}</div>)}</div><div className="mg-rail-actions"><button type="button" onClick={()=>{chart.current?.lockAllDrawings();setDrawingGroup(null)}}>Lock all</button><button type="button" onClick={()=>{chart.current?.hideAllDrawings();setDrawingGroup(null)}}>Hide all</button><button type="button" onClick={()=>{if(window.confirm('Clear all drawings?')){chart.current?.clearDrawings();save()}setDrawingGroup(null)}}>Clear</button></div></section>}
   </div>
 </div>
}


