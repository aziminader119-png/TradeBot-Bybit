import React from 'react';
import {useMemo,useRef,useState} from 'react';
import type {BookState} from './futuresStream.ts';
import './DepthChart.css';

type Point={price:number;volume:number;x:number;y:number;side:'bid'|'ask'};
const W=1000,H=440,L=22,R=66,T=22,B=42;
function fmt(v:number){return new Intl.NumberFormat('en-US',{notation:v>=1e6?'compact':'standard',maximumFractionDigits:v>=1e6?2:2}).format(v)}
function priceFmt(v:number){return new Intl.NumberFormat('en-US',{maximumFractionDigits:v>=100?2:6}).format(v)}
export default function DepthChart({book,symbol}:{book:BookState;symbol:string}){
 const svg=useRef<SVGSVGElement>(null);
 const [hover,setHover]=useState<Point|null>(null);
 const model=useMemo(()=>{
  if(!book.synchronized||!book.bids.length||!book.asks.length)return null;
  const bids=[...book.bids].filter(l=>l.price>0&&l.amount>0).sort((a,b)=>a.price-b.price);
  const asks=[...book.asks].filter(l=>l.price>0&&l.amount>0).sort((a,b)=>a.price-b.price);
  if(!bids.length||!asks.length)return null;
  const bestBid=bids[bids.length-1].price,bestAsk=asks[0].price;
  if(bestBid>=bestAsk)return null;
  const lo=bids[0].price,hi=asks[asks.length-1].price;
  if(hi<=lo)return null;
  let running=0;
  const bidVolumes=bids.map(l=>l.amount);
  const bp=bids.map((l,i)=>{running=bidVolumes.slice(i).reduce((a,b)=>a+b,0);return {price:l.price,volume:running}});
  running=0;
  const ap=asks.map(l=>{running+=l.amount;return {price:l.price,volume:running}});
  const max=Math.max(...bp.map(p=>p.volume),...ap.map(p=>p.volume),1)*1.08;
  const toX=(price:number)=>L+(price-lo)/(hi-lo)*(W-L-R);
  const toY=(amount:number)=>H-B-(amount/max)*(H-T-B);
  const bidsXY:Point[]=bp.map(p=>({...p,x:toX(p.price),y:toY(p.volume),side:'bid'}));
  const asksXY:Point[]=ap.map(p=>({...p,x:toX(p.price),y:toY(p.volume),side:'ask'}));
  return {bidsXY,asksXY,lo,hi,max,bestBid,bestAsk,toX,toY};
 },[book]);
 const onMove=(event:React.MouseEvent<SVGSVGElement>)=>{
  if(!model||!svg.current)return;
  const rect=svg.current.getBoundingClientRect();
  const x=(event.clientX-rect.left)/rect.width*W;
  const points=[...model.bidsXY,...model.asksXY];
  let candidate=points[0];
  for(const p of points)if(Math.abs(p.x-x)<Math.abs(candidate.x-x))candidate=p;
  setHover(candidate);
 };
 const line=(points:Point[])=>points.map((p,i)=>(i?'L':'M')+p.x.toFixed(1)+' '+p.y.toFixed(1)).join(' ');
 const fill=(points:Point[])=>line(points)+' L'+points[points.length-1].x+' '+(H-B)+' L'+points[0].x+' '+(H-B)+' Z';
 return <div className="nx-depth-chart">
  {!model?<div className="nx-depth-wait">{book.connected?'Waiting for synchronized order book…':'Connecting to live Bybit market depth…'}{book.error&&<small>{book.error}</small>}</div>:
  <>
   <svg ref={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={()=>setHover(null)} role="img" aria-label={`Live ${symbol} market depth, green cumulative bids and red cumulative asks`}>
    <defs><linearGradient id="nx-depth-bids" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#16B89A" stopOpacity=".26"/><stop offset="1" stopColor="#16B89A" stopOpacity=".08"/></linearGradient><linearGradient id="nx-depth-asks" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#F05A70" stopOpacity=".23"/><stop offset="1" stopColor="#F05A70" stopOpacity=".07"/></linearGradient></defs>
    {Array.from({length:6},(_,i)=>{const y=T+i*(H-T-B)/5;return <g key={i}><line x1={L} x2={W-R} y1={y} y2={y} stroke="#343943" strokeOpacity=".45"/><text x={W-R+9} y={y+4} className="nx-depth-axis">{fmt(model.max*(1-i/5))}</text></g>})}
    {Array.from({length:9},(_,i)=>{const x=L+i*(W-L-R)/8;return <g key={i}><line x1={x} x2={x} y1={T} y2={H-B} stroke="#343943" strokeOpacity=".26"/><text x={x} y={H-18} textAnchor="middle" className="nx-depth-axis">{priceFmt(model.lo+(model.hi-model.lo)*i/8)}</text></g>})}
    <path d={fill(model.bidsXY)} fill="url(#nx-depth-bids)"/><path d={fill(model.asksXY)} fill="url(#nx-depth-asks)"/>
    <path d={line(model.bidsXY)} fill="none" stroke="#16B89A" strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>
    <path d={line(model.asksXY)} fill="none" stroke="#F05A70" strokeWidth="1.7" vectorEffect="non-scaling-stroke"/>
    {hover&&<g><line x1={hover.x} x2={hover.x} y1={T} y2={H-B} stroke="#B8C1D0" strokeDasharray="3 3" vectorEffect="non-scaling-stroke"/><circle cx={hover.x} cy={hover.y} r="4" fill={hover.side==='bid'?'#16B89A':'#F05A70'}/></g>}
   </svg>
   {hover&&<div className="nx-depth-tooltip" style={{left:`${Math.max(12,Math.min(79,hover.x/W*100))}%`,top:`${Math.max(10,Math.min(78,hover.y/H*100))}%`}}><strong>{hover.side==='bid'?'Buy depth':'Sell depth'}</strong><div>Price <b>{priceFmt(hover.price)}</b></div><div>Amount <b>{fmt(hover.volume)} {symbol.replace(/USDT$|USDC$|BTC$|ETH$/,'')}</b></div><div>Range <b>{((hover.price/(hover.side==='bid'?model.bestBid:model.bestAsk)-1)*100).toFixed(2)}%</b></div></div>}
   <span className="nx-depth-live">{book.connected?'● Live':'○ Reconnecting'}</span>
  </>}
 </div>;
}

