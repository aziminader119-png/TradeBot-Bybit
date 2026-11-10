export function updateStatus(hasState:boolean,wsConnected:boolean,lastUpdated:number,now:number) {
  if(!hasState)return {stale:true,label:'Connecting…',tone:'pending'};
  if(!lastUpdated||now-lastUpdated>20000)return {stale:true,label:'Data stale',tone:'bad'};
  return {stale:false,label:wsConnected?'Live updates':'Polling updates',tone:wsConnected?'good':'pending'};
}
