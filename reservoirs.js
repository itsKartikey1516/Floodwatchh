export const SOURCE = 'https://bbmb.gov.in/index.htm';
export const REFERENCE = 'https://bbmb.gov.in/data-reservoir.htm';
const dams = [
  { id:'bhakra', name:'Bhakra', river:'Sutlej', fullLevelFt:1680, maximumLevelFt:1690, referenceNote:'Published FRL 1680 ft; MWL 1690 ft.' },
  { id:'pong', name:'Pong', river:'Beas', fullLevelFt:1390, maximumLevelFt:1410, referenceNote:'Published reduced FRL 1390 ft; reduced MWL 1410 ft (design FRL 1400 ft).' },
];
let cached=null, flight=null;
export function assessReservoir(item, observedAt, now=Date.now()) {
  const epoch=Date.parse(observedAt);
  if(!Number.isFinite(epoch)||now-epoch>36*3600000||epoch>now+3600000) return {status:'stale', label:'Older reading · risk unknown', reason:'A current level and operating advisory are needed before assessing reservoir conditions.'};
  if(item.levelFt>=item.maximumLevelFt) return {status:'review',label:'At / above published MWL',reason:'Compare the latest operator warning and downstream release advisory. This reading does not establish structural failure.'};
  if(item.levelFt>=item.fullLevelFt) return {status:'review',label:'At / above full reservoir level',reason:'Check official release advisories. Above-FRL storage does not by itself establish overtopping or dam failure.'};
  if(item.fullLevelFt-item.levelFt<=5) return {status:'watch',label:'Within 5 ft of full level',reason:'App screening threshold: watch the operator’s level and release updates. No downstream flood boundary has been calculated.'};
  return {status:'reported',label:'Below full reservoir level',reason:'Reported level is below FRL. This is not a dam-safety assessment or a downstream all-clear.'};
}
export function parseReservoirPage(html) {
  const text=html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ');
  const section=text.match(/Reservoir Data[\s\S]{0,1500}/i)?.[0];
  const date=section?.match(/AS ON\s+(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/i);
  if(!date)throw new Error('The reservoir publication date could not be confirmed.');
  const observedAt=date[3]+'-'+date[2]+'-'+date[1]+'T'+date[4]+':'+date[5]+':00+05:30';
  if(!Number.isFinite(Date.parse(observedAt)))throw new Error('Invalid reservoir publication date.');
  const reservoirs=dams.map(dam=>{
    const row=section.match(new RegExp(dam.name+'\\s+([\\d,.]+)\\s+([\\d,.]+)\\s+([\\d,.]+)','i'));
    if(!row)throw new Error('The published '+dam.name+' row could not be read.');
    const [levelFt,inflowCusecs,outflowCusecs]=row.slice(1).map(v=>Number(v.replace(/,/g,'')));
    if(![levelFt,inflowCusecs,outflowCusecs].every(Number.isFinite)||levelFt<500||levelFt>2000||inflowCusecs<0||outflowCusecs<0)throw new Error('Reservoir readings failed validation.');
    return {...dam,levelFt,inflowCusecs,outflowCusecs,headroomToFrlFt:Number((dam.fullLevelFt-levelFt).toFixed(2))};
  });
  return {observedAt,reservoirs};
}
function publicResult(value, error=null){
  return {...value,source:SOURCE,reference:REFERENCE,error,refreshSeconds:1800,coverage:'Two BBMB reservoirs only; nationwide dam telemetry is not connected.',reservoirs:value.reservoirs.map(item=>({...item,assessment:error?{status:'unavailable',label:'Feed interrupted · risk unknown',reason:'Last published data retained; check the operator.'}:assessReservoir(item,value.observedAt)}))};
}
export async function getReservoirs(){
  if(cached&&Date.now()-Date.parse(cached.fetchedAt)<1800000)return publicResult(cached);
  if(!flight)flight=(async()=>{
    try{
      const response=await fetch(SOURCE,{signal:AbortSignal.timeout(15000),headers:{Accept:'text/html'}});
      if(!response.ok)throw new Error('BBMB returned HTTP '+response.status);
      cached={...parseReservoirPage(await response.text()),fetchedAt:new Date().toISOString()};
      return publicResult(cached);
    }catch(error){
      if(cached)return publicResult(cached,'The latest BBMB update is unavailable.');
      return {source:SOURCE,reference:REFERENCE,observedAt:null,fetchedAt:null,error:'The BBMB reservoir feed could not be read. No current dam-risk assessment is available.',reservoirs:[],coverage:'Two BBMB reservoirs; no nationwide dam telemetry.',refreshSeconds:1800};
    }
  })().finally(()=>flight=null);
  return flight;
}
