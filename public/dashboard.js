(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(1);
  const labels = {high:'High flood watch', elevated:'Elevated watch',watch:'Rain watch',lower:'Lower rainfall signal'};
  const colors = {high:'#b94b45',elevated:'#c57a36',watch:'#ab913b',lower:'#71958a'};
  const rank = {high:0,elevated:1,watch:2,lower:3};
  const key = a => a.state + '|' + a.district;
  const name = a => a.district + ', ' + a.state;
  let areas=[], selected=null, current=null, pageSize=12, nationalTimer, monitorTimer, controller, sequence=0, userPoint;
  let notificationEnabled=false;
  try { notificationEnabled=sessionStorage.getItem('fw-notify')==='yes'; } catch {}
  const seen=new Set();
  let reservoirTimer;
  function priorityModel(data, now=Date.now()){
    const epoch=Date.parse(data.generatedAt);
    const fresh=data.status==='ready'&&Number.isFinite(epoch)&&epoch<=now+60000&&now-epoch<=(data.cacheSeconds||21600)*1000+300000&&!data.error;
    const candidates=(data.results||[]).filter(a=>['high','elevated'].includes(a.level)||(Number(a.maxRainChance)>=70&&Number(a.maxDailyMm)>0))
      .sort((a,b)=>rank[a.level]-rank[b.level]||b.maxRainChance-a.maxRainChance||b.maxDailyMm-a.maxDailyMm);
    return {fresh,candidates};
  }
  function renderPriority(data){
    const {fresh,candidates}=priorityModel(data);
    const urgent=candidates.filter(a=>['high','elevated'].includes(a.level));
    $('priorityPanel').className='priority-panel'+(!fresh?' unavailable':urgent.length?' urgent':'');
    $('priorityTime').textContent=data.generatedAt?'Forecast check · '+time(data.generatedAt):'National forecast scan in progress';
    if(!fresh){
      $('priorityTitle').textContent=data.status==='refreshing'?'Scanning districts · '+(data.completed||0)+' / '+(data.total||0):'National rain-watch status unavailable';
      $('prioritySummary').textContent=data.status==='refreshing'?'The automatic national scan is still running. Alerts will be ranked once this snapshot completes.':'A fresh, complete forecast snapshot could not be confirmed. Previous map readings may be stale; this is not an all-clear.';
      $('priorityCards').innerHTML='';return;
    }
    $('priorityTitle').textContent=urgent.length?urgent.length+' districts have elevated flood-watch signals':candidates.length?candidates.length+' districts have a high chance of rain':'No high-rain signals in the returned forecast';
    $('prioritySummary').textContent='Next 3 days · automatically ranked across '+(data.results||[]).length+' covered districts. Rain percentages are rain probabilities, not flood probabilities. '+(data.failed?data.failed+' district lookups are unavailable. ':'')+'National data refreshes every '+Math.round((data.cacheSeconds||21600)/3600)+' hours; selected districts are checked every 5 minutes.';
    $('priorityCards').innerHTML=candidates.slice(0,6).map(a=>'<button class="priority-card '+esc(a.level)+'" data-priority="'+esc(key(a))+'"><span class="rain-number">'+esc(a.maxRainChance)+'%</span><b>'+esc(a.district)+'</b><small>'+esc(a.state)+'</small><small>'+fmt(a.maxDailyMm)+' mm on the wettest day</small><div class="signal">'+esc(['high','elevated'].includes(a.level)?labels[a.level]+' · possible flooding; review conditions':'Rain likely · check local flood conditions')+' ↗</div></button>').join('');
    if(candidates.length){
      const summaryKey='national-rain|'+candidates.slice(0,6).map(a=>key(a)+'|'+a.level+'|'+a.forecastDays?.[0]?.date).join(';');
      if(!seen.has(summaryKey)){
        seen.add(summaryKey);toast((urgent.length?'Flood-watch screening is elevated':'High rain probability')+' in '+(urgent.length?urgent:candidates).slice(0,3).map(a=>a.district).join(', ')+'. See the automatic watch at the top.');
      }
    }
    for(const a of urgent){
      const id='national|'+key(a)+'|'+a.level+'|'+a.forecastDays?.[0]?.date;
      if(seen.has(id))continue;seen.add(id);
      if(notificationEnabled&&'Notification'in window&&Notification.permission==='granted'){
        try{new Notification('FloodWatch · national screening watch',{body:name(a)+' · '+labels[a.level]+'. Forecast '+fmt(a.maxDailyMm)+' mm/day. Follow local official guidance.',tag:id});}catch{}
      }
    }
    while(seen.size>300)seen.delete(seen.values().next().value);
  }
  let map=null, points=[];
  if(window.L){
    map=L.map('map',{scrollWheelZoom:false}).setView([23.1,80.2],4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
  } else $('map').innerHTML='<p class="empty-text">Map tiles could not load. District monitoring and the watchlist are still available.</p>';
  $('date').innerHTML='<b>'+new Date().toLocaleDateString('en-IN',{weekday:'long'})+'</b>'+new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'});
  function message(text){$('message').textContent=text;}
  function toast(text){$('toast').textContent=text;$('toast').hidden=false;setTimeout(()=>$('toast').hidden=true,10000);}
  function time(iso){return iso?new Date(iso).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' IST':'Unknown';}
  function activeAlerts(item){return (item.weatherAlerts||[]).filter(a=>!Number.isFinite(Date.parse(a.expires))||Date.parse(a.expires)>Date.now());}
  function stale(data){const epoch=data?.result?.current?.updatedEpoch;return !epoch || Date.now()-epoch*1000>90*60000 || Date.now()-Date.parse(data.fetchedAt)>10*60000;}
  async function read(url,signal){const response=await fetch(url,{cache:'no-store',signal});const data=await response.json();if(!response.ok)throw new Error(data.error||'The weather service is unavailable.');return data;}
  function renderMap(){
    if(!map)return;
    points.forEach(p=>map.removeLayer(p));points=[];
    const filter=$('mapFilter').value;
    for(const area of areas){
      if(filter==='watch'&&area.level==='lower'||filter==='high'&&!['high','elevated'].includes(area.level))continue;
      if(!Number.isFinite(Number(area.lat))||!Number.isFinite(Number(area.lon)))continue;
      const isSelected=selected&&key(selected)===key(area);
      const marker=L.circleMarker([area.lat,area.lon],{radius:isSelected?10:area.level==='lower'?4:6,color:isSelected?'#173e43':'#fff',weight:isSelected?3:1,fillColor:colors[area.level]||colors.lower,fillOpacity:.9}).addTo(map);
      const popup=document.createElement('div');
      popup.innerHTML='<b>'+esc(name(area))+'</b><br>'+esc(labels[area.level])+'<br>'+fmt(area.maxDailyMm)+' mm/day · '+esc(area.maxRainChance)+'% rain chance';
      const button=document.createElement('button');button.textContent='Monitor this district';button.onclick=()=>selectArea(area);popup.appendChild(button);
      marker.bindPopup(popup);points.push(marker);
    }
  }
  function renderRows(){
    const sorted=[...areas].sort((a,b)=>rank[a.level]-rank[b.level]||b.maxDailyMm-a.maxDailyMm);
    $('watchCount').textContent=areas.filter(a=>a.level!=='lower').length+' watch areas / '+areas.length+' mapped';
    $('watchRows').innerHTML=sorted.slice(0,pageSize).map(a=>'<tr><td><b>'+esc(a.district)+'</b><small>'+esc(a.state)+'</small></td><td><span class="pill '+esc(a.level)+'">'+esc(labels[a.level])+'</span></td><td>'+fmt(a.maxDailyMm)+' mm</td><td>'+esc(a.maxRainChance)+'%</td><td><button data-area="'+esc(key(a))+'">Monitor ↗</button></td></tr>').join('');
    $('moreAreas').hidden=pageSize>=areas.length;
  }
  function populateSmsAreas(){
    const select=$('smsArea');if(!select)return;
    const previous=select.value;
    const sorted=[...areas].sort((a,b)=>a.state.localeCompare(b.state)||a.district.localeCompare(b.district));
    select.innerHTML='<option value="">Choose a district</option>'+sorted.map(a=>'<option value="'+esc(key(a))+'">'+esc(a.district+', '+a.state)+'</option>').join('');
    if(sorted.some(a=>key(a)===previous))select.value=previous;
  }
  async function national(){
    clearTimeout(nationalTimer);
    try{
      const data=await read('/api/risk');
      renderPriority(data);
      if(data.results?.length){
        areas=data.results;
        populateSmsAreas();
        if(current?.result){const i=areas.findIndex(a=>key(a)===key(current.result));if(i>=0)areas[i]=current.result;}
        $('areas').innerHTML=areas.map(a=>'<option value="'+esc(name(a))+'"></option>').join('');
        renderMap();renderRows();
      }
      $('nationalStamp').textContent=data.status==='refreshing'?'Updating '+data.completed+'/'+data.total+' districts':'National snapshot · '+time(data.generatedAt);
      $('nationalSource').textContent=data.status==='refreshing'?'Updating':areas.length+' districts';
      if(!selected){
        $('connection').textContent='Choose a district';
        if(data.status==='ready')message('Choose a district, click a map marker, or use your location to start monitoring.');
        let saved;try{saved=JSON.parse(localStorage.getItem('fw-area')||'null');}catch{}
        const restore=saved&&areas.find(a=>key(a)===key(saved));if(restore)selectArea(restore);
      }
      if(data.status==='unconfigured'||data.status==='error')throw new Error(data.error);
      nationalTimer=setTimeout(national,data.status==='refreshing'?5000:300000);
    }catch(error){
      renderPriority({status:'error',error:error.message});
      $('nationalStamp').textContent='National feed unavailable · previous data may be stale';
      $('nationalSource').textContent='Unavailable';
      if(!areas.length)$('watchRows').innerHTML='<tr><td colspan="5">Forecast feed unavailable. Retrying in one minute.</td></tr>';
      message(error.message);nationalTimer=setTimeout(national,60000);
    }
  }
  function clearLocal(){
    for(const id of ['rainChance','rainMm','temperature'])$(id).textContent='—';
    $('condition').textContent='Requesting current weather…';
    $('hourly').innerHTML='<p class="empty-text">Loading hourly forecast…</p>';$('daily').innerHTML='';
    $('localAlerts').innerHTML='<h3>Checking your district…</h3><p>Requesting weather conditions, forecast rainfall and provider alerts.</p>';
    $('localBadge').textContent='Checking';$('localBadge').className='pill';
  }
  function selectArea(area){
    selected=area;current=null;clearLocal();sequence++;controller?.abort();clearTimeout(monitorTimer);
    try{localStorage.setItem('fw-area',JSON.stringify({district:area.district,state:area.state}));}catch{}
    $('areaInput').value=name(area);$('areaName').textContent=area.district;$('areaState').textContent=area.state;
    if(map){map.setView([area.lat,area.lon],7);renderMap();}
    monitor();
  }
  function notify(item,data){
    if(stale(data))return;
    const notices=activeAlerts(item).map(a=>({id:key(item)+'|'+a.headline+'|'+a.effective+'|'+a.expires,title:a.event||'Weather alert',body:name(item)+': '+a.headline}));
    if(['high','elevated'].includes(item.level))notices.push({id:key(item)+'|'+item.level+'|'+item.forecastDays?.[0]?.date,title:labels[item.level],body:name(item)+': forecast up to '+fmt(item.maxDailyMm)+' mm/day. Screening estimate; follow local authority guidance.'});
    for(const notice of notices){
      if(seen.has(notice.id))continue;
      seen.add(notice.id);if(seen.size>200)seen.delete(seen.values().next().value);
      toast(notice.body);
      if(notificationEnabled&&'Notification'in window&&Notification.permission==='granted'){
        try{const n=new Notification('FloodWatch · '+notice.title,{body:notice.body,tag:notice.id});n.onclick=()=>{window.focus();location.hash='alerts';n.close();};}catch{}
      }
    }
  }
  function renderLocal(data){
    const a=data.result, old=stale(data), alerts=activeAlerts(a), weather=a.current;
    $('rainChance').textContent=a.maxRainChance==null?'—':a.maxRainChance+'%';
    $('rainMm').textContent=fmt(a.maxDailyMm)+' mm';
    $('temperature').textContent=weather?.temperatureC==null?'—':fmt(weather.temperatureC)+'°C';
    $('condition').textContent=weather?.condition||'Current conditions unavailable';
    $('checked').textContent='API fetched · '+time(data.fetchedAt);
    $('observed').textContent='Provider observation · '+time(weather?.updatedEpoch?weather.updatedEpoch*1000:null);
    $('nextCheck').textContent='Checks every 5 minutes while open · last request '+time(data.fetchedAt);
    $('localBadge').className='pill '+(old?'':a.level);
    $('localBadge').textContent=old?'Data needs updating':labels[a.level];
    $('connection').textContent=old?'Observation stale':'Monitoring active';$('connection').className='connection'+(old?' bad':'');
    $('weatherSource').textContent=old?'Stale / incomplete':'Connected';
    let markup=old?'<div class="provider-alert"><strong>Current observations are stale or missing</strong><p>Fresh weather conditions could not be confirmed. Automatic notifications are paused for this data.</p></div>':'';
    markup+=alerts.map(alert=>'<div class="provider-alert"><strong>'+esc(alert.headline)+'</strong><p>'+esc(alert.severity)+' · '+esc(alert.event)+'</p><p>'+esc(alert.areas||name(a))+'</p><p>'+esc(alert.instruction||alert.description)+'</p><small>Effective '+esc(alert.effective||'not supplied')+' · expires '+esc(alert.expires||'not supplied')+'</small></div>').join('');
    markup+='<h3>'+esc(labels[a.level])+'</h3><p>'+(a.level==='lower'?'The forecast does not meet the current rainfall screening thresholds. This does not rule out flooding.':'The rainfall forecast and historical flood exposure trigger a '+esc(labels[a.level].toLowerCase())+' for this district.')+'</p><ul>'+(a.reasons||[]).map(r=>'<li>'+esc(r)+'</li>').join('')+'</ul><p>'+(a.alertFeedAvailable?(alerts.length?alerts.length+' active provider weather alert(s).':'No unexpired provider alerts returned for this forecast location. Coverage varies by region.'):'Provider alert coverage could not be confirmed.')+'</p>';
    $('localAlerts').innerHTML=markup;
    const hours=(a.hourly||[]).filter(h=>h.epoch*1000>=Date.now()).slice(0,24), max=Math.max(1,...hours.map(h=>Number(h.precipitationMm)||0));
    $('hourly').innerHTML=hours.length?hours.map((h,i)=>'<div class="hour" title="'+esc(h.time)+' · '+fmt(h.precipitationMm)+' mm · '+esc(h.chanceOfRain)+'% rain"><div class="bar" style="height:'+Math.max(2,(Number(h.precipitationMm)||0)/max*105)+'px"></div><small>'+(i%3===0?esc(h.time.slice(-5,-3)):'·')+'</small></div>').join(''):'<p class="empty-text">Hourly forecast unavailable.</p>';
    $('daily').innerHTML=(a.forecastDays||[]).map(d=>'<div class="day">'+esc(d.date)+'<b>'+fmt(d.totalPrecipMm)+' mm</b>'+esc(d.chanceOfRain)+'% rain chance</div>').join('');
    notify(a,data);
  }
  async function monitor(){
    if(!selected)return;
    const token=++sequence;controller?.abort();controller=new AbortController();clearTimeout(monitorTimer);
    $('refresh').disabled=true;
    const activeController=controller;
    const timeout=setTimeout(()=>activeController.abort(),20000);
    try{
      const data=await read('/api/monitor?'+new URLSearchParams({district:selected.district,state:selected.state}),controller.signal);
      if(token!==sequence)return;
      current=data;renderLocal(data);
      const i=areas.findIndex(a=>key(a)===key(data.result));if(i>=0)areas[i]=data.result;
      renderMap();renderRows();
      message('Monitoring '+name(selected)+'. Provider location: '+data.result.locationName+', '+data.result.providerRegion+'. WeatherAPI conditions and forecasts; no local river sensor feed.');
    }catch(error){
      if(token!==sequence)return;
      current=null;$('connection').textContent='Monitoring interrupted';$('connection').className='connection bad';$('localBadge').textContent='Data unavailable';$('weatherSource').textContent='Unavailable';
      $('localAlerts').innerHTML='<h3>Monitoring interrupted</h3><p>'+esc(error.name==='AbortError'?'The weather request timed out.':error.message)+'</p><p>Previous readings may be stale. Notifications are paused. We will retry automatically.</p>';
      $('checked').textContent='Latest API request failed';message('Unable to refresh '+name(selected)+'. Try Refresh or wait for the next automatic check.');
    }finally{
      clearTimeout(timeout);if(token===sequence){$('refresh').disabled=false;monitorTimer=setTimeout(monitor,current?300000:60000);}
    }
  }
  $('areaForm').onsubmit=e=>{e.preventDefault();const q=$('areaInput').value.trim().toLowerCase();const exact=areas.find(a=>name(a).toLowerCase()===q);const matches=areas.filter(a=>name(a).toLowerCase().includes(q));if(exact)selectArea(exact);else if(matches.length===1)selectArea(matches[0]);else message(matches.length?'Several areas match. Choose a full district and state from the suggestions.':'No matching district in the supplied atlas. Try another name.');};
  $('refresh').onclick=()=>selected?monitor():national();
  let smsPhonePending='';
  async function smsRequest(url,payload){
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'SMS request failed.');return result;
  }
  async function smsSetup(){
    try{const response=await fetch('/api/sms/status',{cache:'no-store'});const data=await response.json();
      $('smsSetupStatus').textContent=data.configured?'SMS delivery is ready. Confirm your number before alerts can be sent.':'SMS is not active yet. The site owner must configure Twilio on the backend before codes and alerts can be sent.';
      $('smsSetupStatus').className='sms-status'+(data.configured?' ready':'');
    }catch{$('smsSetupStatus').textContent='Could not check SMS setup. The service may be unavailable.';}
  }
  $('smsSubscribeForm').onsubmit=async e=>{
    e.preventDefault();const button=$('smsSendCode');button.disabled=true;
    const [state,district]=$('smsArea').value.split('|');const phone=$('smsPhone').value.trim();
    try{const result=await smsRequest('/api/sms/subscribe',{phone,district,state,consent:$('smsConsent').checked});
      if(result.verified){$('smsSetupStatus').textContent=result.message;$('smsSetupStatus').className='sms-status ready';return;}
      smsPhonePending=phone;$('smsSubscribeForm').hidden=true;$('smsVerifyForm').hidden=false;$('smsSetupStatus').textContent=result.message;$('smsCode').focus();
    }catch(error){$('smsSetupStatus').textContent=error.message;$('smsSetupStatus').className='sms-status error';}
    finally{button.disabled=false;}
  };
  $('smsVerifyForm').onsubmit=async e=>{
    e.preventDefault();const button=$('smsVerifyForm').querySelector('button');button.disabled=true;
    try{const result=await smsRequest('/api/sms/verify',{phone:smsPhonePending,code:$('smsCode').value.trim()});
      $('smsSetupStatus').textContent=result.message;$('smsSetupStatus').className='sms-status ready';$('smsVerifyForm').hidden=true;$('smsSubscribeForm').hidden=false;$('smsCode').value='';
    }catch(error){$('smsSetupStatus').textContent=error.message;$('smsSetupStatus').className='sms-status error';}
    finally{button.disabled=false;}
  };
  smsSetup();
  $('mapFilter').onchange=renderMap;
  $('moreAreas').onclick=()=>{pageSize+=30;renderRows();};
  $('watchRows').onclick=e=>{const b=e.target.closest('[data-area]');if(b){const a=areas.find(a=>key(a)===b.dataset.area);if(a)selectArea(a);}};
  $('priorityCards').onclick=e=>{const b=e.target.closest('[data-priority]');if(b){const a=areas.find(a=>key(a)===b.dataset.priority);if(a){selectArea(a);$('alerts').scrollIntoView({behavior:document.body.classList.contains('calm-motion')?'auto':'smooth',block:'center'});}}};
  function openReservoirsLink(e){const details=$('reservoirs').closest('details');if(details&&!details.open){e.preventDefault();details.open=true;setTimeout(()=>$('reservoirsFold').scrollIntoView({behavior:document.body.classList.contains('calm-motion')?'auto':'smooth',block:'start'}),80);}}
  $('damTopNotice').onclick=openReservoirsLink;
  document.querySelectorAll('a[href="#reservoirsFold"]').forEach(link=>link.addEventListener('click',openReservoirsLink));
  $('damTopNotice').onclick=e=>{const details=$('reservoirs').closest('details');if(details&&!details.open){e.preventDefault();details.open=true;setTimeout(()=>$('reservoirs').scrollIntoView({behavior:document.body.classList.contains('calm-motion')?'auto':'smooth',block:'start'}),80);}};
  function motionLabel(){$('motionToggle').textContent=document.body.classList.contains('calm-motion')?'Play animation':'Pause animation';$('motionToggle').setAttribute('aria-pressed',String(document.body.classList.contains('calm-motion')));}
  try{if(localStorage.getItem('fw-calm')==='yes')document.body.classList.add('calm-motion');}catch{}
  $('motionToggle').onclick=()=>{document.body.classList.toggle('calm-motion');try{localStorage.setItem('fw-calm',document.body.classList.contains('calm-motion')?'yes':'no');}catch{}motionLabel();};
  motionLabel();
  function notificationLabel(){$('notifications').textContent=notificationEnabled&&'Notification'in window&&Notification.permission==='granted'?'Browser alerts on · turn off':'Enable browser alerts';}
  $('notifications').onclick=async()=>{
    if(!('Notification'in window)){message('This browser does not support desktop notifications. In-page alerts remain available.');return;}
    if(notificationEnabled){notificationEnabled=false;try{sessionStorage.removeItem('fw-notify');}catch{}notificationLabel();return;}
    const permission=await Notification.requestPermission();
    notificationEnabled=permission==='granted';
    try{sessionStorage.setItem('fw-notify',notificationEnabled?'yes':'no');}catch{}
    notificationLabel();
    message(notificationEnabled?'Browser alerts enabled for new selected-district provider alerts and national high/elevated screening watches while this page runs.':'Browser permission was not granted. In-page alerts remain available.');
  };
  $('locate').onclick=()=>{
    if(!navigator.geolocation){message('Location is unavailable. Search for a district instead.');return;}
    if(!areas.length){message('Wait for the district map to finish loading.');return;}
    $('locate').disabled=true;message('Your browser will request location access. Coordinates stay in this browser; only the nearest district name is used for API monitoring.');
    navigator.geolocation.getCurrentPosition(pos=>{
      $('locate').disabled=false;
      const rad=d=>d*Math.PI/180,lat=pos.coords.latitude,lon=pos.coords.longitude;
      const nearest=areas.map(a=>{const v=Math.sin(rad(a.lat-lat)/2)**2+Math.cos(rad(lat))*Math.cos(rad(a.lat))*Math.sin(rad(a.lon-lon)/2)**2;return {a,km:6371*2*Math.asin(Math.sqrt(Math.min(1,v)))}}).sort((a,b)=>a.km-b.km)[0];
      if(!nearest||nearest.km>150){message('No nearby covered forecast point within 150 km. Please choose a district manually.');return;}
      if(map){if(userPoint)map.removeLayer(userPoint);userPoint=L.circleMarker([lat,lon],{radius:6,color:'#266f96'}).addTo(map).bindPopup('Your approximate device location');}
      selectArea(nearest.a);toast('Nearest forecast point: '+name(nearest.a)+' · '+Math.round(nearest.km)+' km away. This is not a district boundary lookup.');
    },()=>{$('locate').disabled=false;message('Location could not be obtained. Use district search or check browser permissions.');},{timeout:12000,maximumAge:60000,enableHighAccuracy:false});
  };
  async function imd(){try{const r=await fetch('/api/live');const d=await r.json();$('imdSource').textContent=d.warnings?.ok?'Warning feed reachable':'Unavailable';$('imdSource').className=d.warnings?.ok?'':'muted';}catch{$('imdSource').textContent='Unavailable';}setTimeout(imd,300000);}
  const damArt='<svg class="dam-cartoon" viewBox="0 0 110 80" aria-hidden="true"><path d="M2 59q12-16 27 0t27 0t27 0t27 0v20H2z" fill="#a8e4da"/><path d="M37 18h37l16 48H22z" fill="#8eabb3" stroke="#243b41" stroke-width="3" stroke-linejoin="round"/><path d="M35 18v-8h42v8M46 29v29m16-29v29" fill="none" stroke="#243b41" stroke-width="3"/><path class="dam-water" d="M5 69q10-9 20 0t20 0t20 0t20 0" fill="none" stroke="#20a69c" stroke-width="4" stroke-linecap="round"/><circle cx="14" cy="18" r="9" fill="#ffbc3d"/></svg>';
  async function reservoirs(){
    clearTimeout(reservoirTimer);$('refreshDams').disabled=true;
    try{
      const data=await read('/api/reservoirs');
      $('damTime').textContent='Operator reading · '+time(data.observedAt)+' / fetched '+time(data.fetchedAt);
      $('damCards').innerHTML=data.reservoirs.map(d=>'<article class="dam-card '+(['review','watch'].includes(d.assessment.status)?'needs-review':'')+'"><div class="dam-card-top">'+damArt+'<div><h3>'+esc(d.name)+' Dam</h3><p>'+esc(d.river)+' river · BBMB</p></div></div><span class="pill '+(d.assessment.status==='review'?'elevated':d.assessment.status==='watch'?'watch':'')+'">'+esc(d.assessment.label)+'</span><div class="dam-values"><div><b>'+fmt(d.levelFt)+'</b><small>Level · feet</small></div><div><b>'+Number(d.inflowCusecs).toLocaleString('en-IN')+'</b><small>Inflow · cusecs</small></div><div><b>'+Number(d.outflowCusecs).toLocaleString('en-IN')+'</b><small>Outflow · cusecs</small></div></div><p class="dam-reference">'+esc(d.referenceNote)+'<br>Distance below FRL: '+fmt(d.headroomToFrlFt)+' ft (negative means above FRL).</p><p>'+esc(d.assessment.reason)+'</p></article>').join('');
      const actionable=data.reservoirs.filter(d=>['review','watch'].includes(d.assessment.status));
      $('damTopNotice').textContent=actionable.length?'Reservoir level watch: '+actionable.map(d=>d.name).join(', ')+' · review the operator’s release advisory ↓':'Reservoir data: '+(data.reservoirs.some(d=>d.assessment.status==='stale')?'older readings; current overflow risk unknown':'no level-review threshold met in the two returned readings')+' ↓';
      $('damStatus').textContent=data.error|| (data.reservoirs.some(d=>d.assessment.status==='stale')?'The operator’s table is older than 36 hours or its date is uncertain. Current overflow/release risk is unknown; no alert is generated from an old reading.': 'Source is within the app’s 36-hour freshness window. '+actionable.length+' reservoirs meet a level-review threshold. Release consequences and dam-failure probability are not assessed.');
      for(const d of actionable){
        const id='dam|'+d.id+'|'+d.assessment.status+'|'+data.observedAt;if(seen.has(id))continue;seen.add(id);
        const body=d.name+' reservoir: '+d.assessment.label+'. Check the operator’s release advisory. This is not a dam-failure prediction.';
        toast(body);
        if(notificationEnabled&&'Notification'in window&&Notification.permission==='granted'){try{new Notification('FloodWatch · reservoir level watch',{body,tag:id});}catch{}}
      }
    }catch(error){
      $('damTopNotice').textContent='Reservoir feed unavailable · current dam conditions unknown ↓';
      $('damTime').textContent='Reservoir source unavailable';
      $('damCards').innerHTML='<p class="empty-text">Current BBMB readings could not be loaded. No dam-risk assessment is available.</p>';
      $('damStatus').textContent='Check the linked operator bulletin for water levels and release instructions.';
    }finally{$('refreshDams').disabled=false;reservoirTimer=setTimeout(reservoirs,1800000);}
  }
  $('refreshDams').onclick=reservoirs;
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&selected&&(!current||Date.now()-Date.parse(current.fetchedAt)>=300000))monitor();});
  setInterval(()=>{if(current&&stale(current)){$('connection').textContent='Observation stale';$('connection').className='connection bad';$('localBadge').textContent='Data needs updating';}},15000);
  notificationLabel();national();imd();reservoirs();
})();
