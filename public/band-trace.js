(() => {
  'use strict';
  const config = JSON.parse(document.getElementById('tracePayload').textContent);
  const $ = id => document.getElementById(id);
  const zones = config.zones;
  let data = config.data, segments = [], first = 0, last = 0, current = 0, timer = null, lastTick = 0, loading = false, liveTimer = null;
  const timestamp = value => new Date(value.replace(' ', 'T')).getTime();
  const zoneIndex = zone => zones.indexOf(zone);
  const minutes = s => Math.max(0, (timestamp(s.end) - timestamp(s.start)) / 60000 + .5);
  const clock = t => new Date(t).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',hour12:false});
  function pause() { clearInterval(timer); timer = null; $('btnPlay').textContent = '▶ 播放'; $('btnPlay').setAttribute('aria-label','播放活动回放'); }
  function render(time) {
    if (!segments.length) return;
    current = Math.max(first, Math.min(last, time));
    const segment = segments.find(s => current >= timestamp(s.start) && current < timestamp(s.end) + 30000);
    const index = segment ? zoneIndex(segment.zone) : -1;
    zones.forEach((z,i) => $('traceZone' + i).classList.toggle('active', i === index));
    $('traceMarker').hidden = index < 0;
    if (index >= 0) $('traceMarker').style.left = ((index + .5) / zones.length * 100) + '%';
    $('nowTime').textContent = clock(current);
    $('seekBar').value = String(Math.round((current-first)/Math.max(1,last-first)*1000));
    $('traceCurrent').textContent = clock(current) + ' · ' + (index >= 0 ? segment.zone : '覆盖外 / 信号中断') + (segment && segment.low_confidence ? ' · 信号较弱' : '');
  }
  function mount(next) {
    pause(); data = next;
    segments = data && data.trace ? data.trace.segments || [] : [];
    const covered = segments.filter(s => zoneIndex(s.zone) >= 0);
    $('traceMapEmpty').hidden = covered.length > 0;
    $('btnPlay').disabled = covered.length === 0; $('seekBar').disabled = covered.length === 0;
    $('traceDuration').replaceChildren(document.createTextNode(String(Math.round(covered.reduce((n,s)=>n+minutes(s),0)))));
    const unit = document.createElement('em');unit.textContent='分钟';$('traceDuration').append(unit);
    $('traceVisited').firstChild.textContent = String(new Set(covered.map(s=>s.zone)).size);
    $('traceSamples').firstChild.textContent = String(data ? data.sample_count || 0 : 0);
    const stay = zones.map(z=>covered.filter(s=>s.zone===z).reduce((n,s)=>n+minutes(s),0));
    $('traceStay').replaceChildren();
    stay.forEach((value,i) => {
      const row=document.createElement('div');row.className='trace-stay-row';const label=document.createElement('div');const name=document.createElement('span');name.textContent=zones[i];const count=document.createElement('strong');count.textContent=Math.round(value)+' 分钟';label.append(name,count);
      const track=document.createElement('div');track.className='trace-stay-track';const fill=document.createElement('div');fill.className='trace-stay-fill trace-color-'+i;fill.style.width=(value/Math.max(1,...stay)*100)+'%';track.append(fill);row.append(label,track);$('traceStay').append(row);
    });
    $('traceTimelineCount').textContent=segments.length+' 个时段';$('traceTimeline').replaceChildren();$('traceRibbon').replaceChildren();
    if (!covered.length) { $('traceCurrent').textContent='暂无活动记录，可切换日期或查看最近一次活动';$('traceMarker').hidden=true;zones.forEach((z,i)=>$('traceZone'+i).classList.remove('active'));$('nowTime').textContent='--:--'; }
    if (!segments.length) {const tip=document.createElement('div');tip.className='trace-timeline-empty';tip.textContent='该日期暂无活动时段。定位采集时段为工作日 9:00–11:00。';$('traceTimeline').append(tip);return;}
    first=timestamp(segments[0].start);last=timestamp(segments[segments.length-1].end)+29999;
    segments.forEach(s=>{
      const title=clock(timestamp(s.start))+'–'+clock(timestamp(s.end))+' · '+s.zone;
      const color='trace-color-'+(zoneIndex(s.zone)<0?'gap':zoneIndex(s.zone));
      const chip=document.createElement('button');chip.type='button';chip.className=color;chip.title=title;chip.setAttribute('aria-label',title);chip.style.width=(minutes(s)*60000/(last-first)*100)+'%';chip.addEventListener('click',()=>{pause();render(timestamp(s.start));});$('traceRibbon').append(chip);
      const button=document.createElement('button');button.type='button';const strong=document.createElement('strong');strong.textContent=title;const span=document.createElement('span');span.textContent=Math.round(minutes(s))+' 分钟'+(s.low_confidence?' · 信号较弱':'');button.append(strong,span);button.addEventListener('click',()=>{pause();render(timestamp(s.start));});$('traceTimeline').append(button);
    });
    if (covered.length) render(timestamp(covered[covered.length-1].end));
  }
  function stopLive() { clearInterval(liveTimer);liveTimer=null;$('btnLive').textContent=config.isHistorical?'刷新记录':'实时跟随';$('btnLive').setAttribute('aria-pressed','false'); }
  $('btnPlay').addEventListener('click',()=>{stopLive();if(timer){pause();return;}if(current>=last-30000)current=first;lastTick=Date.now();$('btnPlay').textContent='Ⅱ 暂停';$('btnPlay').setAttribute('aria-label','暂停活动回放');timer=setInterval(()=>{const now=Date.now();const time=current+(now-lastTick)*Number($('speedSel').value);lastTick=now;render(time);if(time>=last)pause();},150);});
  $('seekBar').addEventListener('input',()=>{stopLive();pause();render(first+Number($('seekBar').value)/1000*(last-first));});
  async function refresh() {
    if(loading||!config.bandMac)return;loading=true;$('btnLive').disabled=true;$('btnLive').textContent='正在刷新…';
    try{const response=await fetch(config.base+'/api?date='+encodeURIComponent(config.date)+'&band_mac='+encodeURIComponent(config.bandMac),{credentials:'same-origin'});if(!response.ok)throw Error('HTTP '+response.status);const result=await response.json();if(!result.ok)throw Error('数据加载失败');mount(result.data);$('btnLive').textContent=liveTimer?'跟随中 · 30秒同步':'已刷新';}
    catch(e){$('btnLive').textContent='重试刷新';$('traceCurrent').textContent='刷新失败，已保留现有记录。请检查网络后重试。';}
    finally{loading=false;$('btnLive').disabled=false;}
  }
  $('btnLive').textContent=config.isHistorical?'刷新记录':'实时跟随';
  $('btnLive').addEventListener('click',()=>{if(config.isHistorical){refresh();return;}if(liveTimer){stopLive();return;}pause();liveTimer=setInterval(()=>{if(!document.hidden)refresh();},30000);$('btnLive').setAttribute('aria-pressed','true');refresh();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
  mount(data);
})();
