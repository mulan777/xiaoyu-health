(function(){
  'use strict';
  var search=document.getElementById('ef-search');
  if(search)search.addEventListener('input',function(){document.querySelectorAll('.ef-child-option').forEach(function(el){el.hidden=el.dataset.name.indexOf(search.value.trim())<0;});});
  var form=document.getElementById('ef-record-form'),button=document.getElementById('ef-refresh'),box=document.getElementById('ef-metrics');
  var dirty=false,submitting=false;
  document.querySelectorAll('#ef-record-form,#ef-selection-form').forEach(function(f){
    f.addEventListener('input',function(){dirty=true;});f.addEventListener('change',function(){dirty=true;});
    f.addEventListener('submit',function(e){if(submitting){e.preventDefault();return;}if(!f.checkValidity())return;submitting=true;dirty=false;f.querySelectorAll('button[type="submit"]').forEach(function(b){b.disabled=true;b.textContent='正在保存…';});});
  });
  window.addEventListener('beforeunload',function(e){if(dirty&&!submitting){e.preventDefault();e.returnValue='';}});
  if(!form||!button)return;
  var pending=0;
  function value(n){return form.elements[n].value;}
  function show(title,detail){box.replaceChildren();var strong=document.createElement('strong');strong.textContent=title;box.append(strong);if(detail){var span=document.createElement('span');span.textContent=detail;box.append(span);}}
  async function query(){
    var date=value('date'),start=value('start'),end=value('end');
    if(!date||!start||!end){show('请先填写活动日期和起止时间');return;}
    if(start>=end){show('结束时间须晚于开始时间');return;}
    var request=++pending;button.disabled=true;show('正在查询心率…');
    try{var qs=new URLSearchParams({classId:value('classId'),week:value('week'),childId:value('childId'),date:date,start:start,end:end});var res=await fetch(form.dataset.base+'/metrics?'+qs,{headers:{Accept:'application/json'}});if(!res.ok)throw new Error('查询失败，请刷新页面或稍后重试');var result=await res.json();if(request!==pending)return;var m=result.metrics;if(m.avg==null)show(m.reason||'暂无心率数据','保存时会再次查询，不会用 0 代替缺失数据。');else show(m.avg+' 次/分','活动时段平均 · 最低 '+m.min+' / 最高 '+m.max+' · '+m.sample_count+' 次有效采样');var cb=document.getElementById('ef-refresh-save');if(cb)cb.checked=true;}
    catch(err){if(request===pending)show('暂时无法查询',err.message);}finally{if(request===pending)button.disabled=false;}
  }
  button.addEventListener('click',query);
  ['date','start','end'].forEach(function(key){form.elements[key].addEventListener('change',function(){if(value('date')&&value('start')&&value('end'))query();});});
})();
