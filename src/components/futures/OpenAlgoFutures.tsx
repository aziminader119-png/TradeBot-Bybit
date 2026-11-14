import React,{useEffect,useRef,useState} from 'react';
import {darkTheme,registerInterval} from 'openalgo-charts';
import type {PriceLineOptions} from 'openalgo-charts';
import 'openalgo-charts/indicators';
import 'openalgo-charts/transform';
import {createWidget} from 'openalgo-charts/widget';
import type {Widget} from 'openalgo-charts/widget';
import {BybitOpenAlgoFeed} from './BybitOpenAlgoFeed.ts';
import type {OrderLine} from '../../vendor/mg-chart/core/renderer/order-lines';
import './OpenAlgoFutures.css';

// Only chart rendering changes. All execution remains in TradeBot's protected dialogs.
const intervals=['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','D','W','M'];
registerInterval({code:'M',bucketing:{mode:'calendar',unit:'month',timezone:'UTC'}});
const theme={...darkTheme,background:'#101216',grid:'#20252e',axisText:'#9da7b4',
 axisLine:'#303641',paneSeparator:'#292e37',crosshair:'#63768b',
 upColor:'#0bba74',downColor:'#ff4761',wickUpColor:'#0bba74',wickDownColor:'#ff4761',
 lineColor:'#1463ff',lastPriceUp:'#0bba74',lastPriceDown:'#ff4761',
 buy:'#0bba74',sell:'#ff4761',profit:'#0bba74',loss:'#ff4761'};
const storageKey='tradebot:openalgo:timeframe';
const initialFrame=()=>{try{const value=localStorage.getItem(storageKey)||'5m';return intervals.includes(value)?value:'5m'}catch{return '5m'}};
type ChartLine=ReturnType<Widget['chart']['addPriceLine']>;
type WidgetOverlay=Widget&{chart:Widget['chart']&{addPriceLine:(opt:PriceLineOptions)=>ChartLine;removePrimitive:(item:ChartLine)=>void}};

export default function OpenAlgoFutures({symbol,positionLines=[]}:{symbol:string;positionLines?:OrderLine[]}) {
 const container=useRef<HTMLDivElement>(null);
 const widget=useRef<WidgetOverlay|null>(null);
 const overlays=useRef<ChartLine[]>([]);
 const feed=useRef<BybitOpenAlgoFeed|null>(null);
 const [failure,setFailure]=useState('');
 useEffect(()=>{
   const el=container.current;if(!el)return;
   let instance:WidgetOverlay|null=null;
   const datafeed=new BybitOpenAlgoFeed(symbol);
   feed.current=datafeed;setFailure('');
   try{
     instance=createWidget(el,{
       feed:datafeed,symbol,exchange:'BYBIT',interval:initialFrame(),
       intervals,chartType:'candlestick',theme,persist:'tradebot-v19-'+symbol,
       topbar:true,rail:true,statusline:true,indicators:true,
       // No OrderFeed, no on-chart execution, no drag-to-trade.
     }) as WidgetOverlay;
     widget.current=instance;
     instance.on('interval',()=>{try{localStorage.setItem(storageKey,instance?.interval()||'5m')}catch{}});
     window.dispatchEvent(new CustomEvent('ft-chart-ok',{detail:{symbol}}));
   }catch(e:any){
     setFailure(e?.message||'OpenAlgo chart could not start');
     window.dispatchEvent(new CustomEvent('ft-chart-error',{detail:{symbol,message:e?.message||'Chart initialization failed'}}));
   }
   return()=>{
     for(const line of overlays.current){try{instance?.chart.removePrimitive(line)}catch{}}
     overlays.current=[];widget.current=null;feed.current=null;
     instance?.destroy();datafeed.destroy();
   };
 },[symbol]);
 useEffect(()=>{
   const chart=widget.current?.chart;
   if(!chart)return;
   for(const old of overlays.current){try{chart.removePrimitive(old)}catch{}}
   overlays.current=[];
   for(const line of positionLines){
     if(!(line.price>0&&Number.isFinite(line.price)))continue;
     try{
       const options:PriceLineOptions={id:line.id,price:line.price,color:line.color||'#1463ff',
         lineWidth:1,dashed:line.type!=='entry',badge:line.side==='buy'?'BUY':'SHORT',
         leftLabel:line.label||'',closeButton:false};
       overlays.current.push(chart.addPriceLine(options));
     }catch{}
   }
 },[positionLines,symbol]);
 return <div className="tb-openalgo-wrap" data-testid="openalgo-futures-chart">
   <div ref={container} className="tb-openalgo-mount"/>
   {failure&&<div className="tb-openalgo-error" role="alert">{failure}</div>}
 </div>;
}
