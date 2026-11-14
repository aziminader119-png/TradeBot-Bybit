import type {BotStateSummary} from '../../types/trading.ts';
import type {OrderLine} from '../../vendor/mg-chart/core/renderer/order-lines';
export type ExchangeChartPosition={side:'Buy'|'Sell';size:number;entryPrice:number;unrealizedPnl:number|null;takeProfit:number|null;stopLoss:number|null};
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>0;
export function positionLines(symbol:string,state:BotStateSummary|null,exchange:ExchangeChartPosition[]|null,mark?:number):OrderLine[]{
 if(!state?.settings?.isApiKeyConfigured||!state.connection?.positionsSyncedAt)return [];
 const local=state.positions.filter(p=>p.symbol===symbol&&!p.paper&&!p.missingOnExchangeSince&&p.size>0);
 const positions=exchange??local.map(p=>({side:p.side,size:p.size,entryPrice:p.entryPrice,unrealizedPnl:p.unrealizedPnl,takeProfit:null,stopLoss:null}));
 const lines:OrderLine[]=[];
 for(const p of positions){if(!positive(p.size)||!positive(p.entryPrice))continue;
  const name=p.side==='Buy'?'BUY':'SHORT',side=p.side==='Buy'?'buy':'sell',color=p.side==='Buy'?'#39AA77':'#ED4F5D',id='position:'+symbol+':'+p.side;
  const matching=local.find(x=>x.side===p.side&&Math.abs(x.entryPrice-p.entryPrice)<=Math.max(1e-10,p.entryPrice*1e-8)&&Math.abs(x.size-p.size)<=Math.max(1e-10,p.size*1e-8));
  const pnl=positive(mark)?(mark-p.entryPrice)*p.size*(p.side==='Buy'?1:-1):matching?.unrealizedPnl??p.unrealizedPnl;
  lines.push({id,price:p.entryPrice,type:'entry',side,color,label:name+' · Qty '+p.size,pnl:typeof pnl==='number'&&Number.isFinite(pnl)?pnl:undefined});
  if(positive(p.takeProfit))lines.push({id:id+':exchange-tp',price:p.takeProfit,type:'tp',side,color:'#39AA77',label:name+' TP · Bybit · '+p.takeProfit});
  if(positive(p.stopLoss))lines.push({id:id+':exchange-sl',price:p.stopLoss,type:'sl',side,color:'#ED4F5D',label:name+' SL · Bybit · '+p.stopLoss});
  // A missing native protection still gets a draggable DRAFT guide. This is NOT
  // an order: only the authenticated confirmation dialog can write to Bybit.
  // Never draw drafts from locally cached positions or bot-managed cycles.
  if(exchange!==null && matching?.owner!=='bot'){
   const anchor=positive(mark)?mark:p.entryPrice;
   const direction=p.side==='Buy'?1:-1;
   if(!positive(p.takeProfit)){
    const draft=anchor*(1+direction*0.02);
    if(positive(draft))lines.push({id:id+':draft-tp',price:draft,type:'tp',side,color:'#39AA77',label:name+' SET TP · drag to choose · NOT SAVED'});
   }
   if(!positive(p.stopLoss)){
    const draft=anchor*(1-direction*0.02);
    if(positive(draft))lines.push({id:id+':draft-sl',price:draft,type:'sl',side,color:'#ED4F5D',label:name+' SET SL · drag to choose · NOT SAVED'});
   }
  }
  const cycle=state.strategyCycles?.[symbol],cfg=state.strategies?.[symbol],leg=cycle?.sides?.[p.side],settings=p.side==='Buy'?cfg?.buy:cfg?.sell;
  if(matching?.owner==='bot'&&cycle?.cycleId===matching.cycleId&&cycle.status!=='CLOSED'&&leg?.tpEnabled&&positive(leg.avgEntryPrice)&&positive(settings?.tpPct)){
   const tp=leg.avgEntryPrice*(1+(p.side==='Buy'?1:-1)*settings.tpPct/100);
   if(positive(tp))lines.push({id:id+':bot-tp',price:tp,type:'tp',side,color:'#39AA77',label:name+' TP · BOT · '+tp});
  }
 }
 return lines;
}
/** Only replace our own overlays; drawings and local price alerts remain independent. */
export function syncPositionLines(chart:{getOrderLines:()=>OrderLine[];addOrderLine:(l:OrderLine)=>void;removeOrderLine:(id:string)=>void},lines:OrderLine[]){const ids=new Set(lines.map(l=>l.id));for(const l of chart.getOrderLines())if(l.id.startsWith('position:')&&!ids.has(l.id))chart.removeOrderLine(l.id);for(const l of lines)chart.addOrderLine(l);}
