(function(){
  'use strict';
  var app=document.querySelector('.ef-app');if(!app)return;
  var form=document.getElementById('ef-record-form'),search=document.getElementById('ef-search');
  var selection=document.getElementById('ef-selection-form');
  var dirtyForms=new Set(),submitting=false,allowLeave=false;
  var fieldNames=['activity','movement','coverage','ground','equipment','training','interest','participation','complexion','sweat','breathing','coordination','attention','spirit','diet','sleep','intensity'];
  function markDirty(f){dirtyForms.add(f);}
  function updateFilled(){if(!form)return;['activity','observe','talk'].forEach(function(key){var panel=document.getElementById('ef-panel-'+key),badge=app.querySelector('[data-filled="'+key+'"]');if(!panel||!badge)return;var count=0;panel.querySelectorAll('[data-group]').forEach(function(g){if(g.querySelector('input:checked'))count++;});var talk=panel.querySelector('[name=communication]');if(talk&&talk.value.trim())count++;badge.textContent=count?count+'项':'';});}
  function setTab(key,remember){if(!form)return;var tab=app.querySelector('[data-form-tab="'+key+'"]');if(!tab)return;app.querySelectorAll('[data-form-tab]').forEach(function(b){b.setAttribute('aria-selected',String(b===tab));});app.querySelectorAll('.ef-form-panel').forEach(function(p){p.hidden=p.id!=='ef-panel-'+key;});if(remember)try{sessionStorage.setItem('ef-form-tab',key);}catch(_){};}
  app.addEventListener('click',function(e){
    var open=e.target.closest('[data-open-dialog]');if(open){var dialog=document.getElementById(open.dataset.openDialog);if(dialog)dialog.showModal();}
    var close=e.target.closest('[data-close-dialog]');if(close)close.closest('dialog').close();
    var tab=e.target.closest('[data-form-tab]');if(tab)setTab(tab.dataset.formTab,true);
    var clear=e.target.closest('[data-clear-group]');if(clear&&form){var group=clear.closest('[data-group]');group.querySelectorAll('input').forEach(function(input){input.checked=false;});markDirty(form);updateFilled();}
  });
  app.querySelectorAll('dialog').forEach(function(dialog){dialog.addEventListener('click',function(e){if(e.target===dialog){var r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});});
  function updateSelection(){if(!selection)return;var n=selection.querySelectorAll('input[name=childIds]:checked').length;document.getElementById('ef-selection-count').textContent='已选择 '+n+' 人';}
  if(search)search.addEventListener('input',function(){var value=search.value.trim();app.querySelectorAll('.ef-child-option').forEach(function(el){el.hidden=el.dataset.name.indexOf(value)<0;});});
  [form,selection].filter(Boolean).forEach(function(f){
    f.addEventListener('input',function(e){if(e.target.type==='search')return;markDirty(f);updateFilled();});
    f.addEventListener('change',function(e){if(e.target.type==='search')return;markDirty(f);updateFilled();if(f===selection)updateSelection();});
    f.addEventListener('submit',function(e){
      if(submitting){e.preventDefault();return;}
      if(!f.checkValidity())return;
      if(Array.from(dirtyForms).some(function(other){return other!==f;})&&!window.confirm('另有未保存的修改，本次只保存当前表单。确定继续吗？')){e.preventDefault();return;}
      if(f===form&&form.elements.start.value>=form.elements.end.value){e.preventDefault();form.elements.end.setCustomValidity('结束时间须晚于开始时间');form.elements.end.reportValidity();return;}
      submitting=true;dirtyForms.delete(f);allowLeave=true;
      // Preserve the clicked submitter's name/value before disabling buttons.
      if(e.submitter&&e.submitter.name){var input=document.createElement('input');input.type='hidden';input.name=e.submitter.name;input.value=e.submitter.value;f.appendChild(input);}
      f.querySelectorAll('button[type=submit]').forEach(function(b){b.disabled=true;});
      if(e.submitter)e.submitter.textContent='正在保存…';
    });
  });
  document.addEventListener('click',function(e){var a=e.target.closest('a[href]');if(!a||a.target==='_blank'||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;if(dirtyForms.size){if(!window.confirm('当前有未保存的修改，确定离开吗？')){e.preventDefault();return;}allowLeave=true;}});
  window.addEventListener('beforeunload',function(e){if(dirtyForms.size&&!submitting&&!allowLeave){e.preventDefault();e.returnValue='';}});
  window.addEventListener('pageshow',function(e){if(e.persisted){submitting=false;allowLeave=false;[form,selection].filter(Boolean).forEach(function(f){f.querySelectorAll('button[type=submit]').forEach(function(b){b.disabled=false;if(b.name==='action')b.textContent=b.value==='next'?'保存并下一位 →':'保存记录';else b.textContent='保存本周名单';});});}});
  var weekInput=document.getElementById('ef-week-input');if(weekInput)weekInput.addEventListener('change',function(){if(!weekInput.value||!weekInput.checkValidity())return;if(dirtyForms.size&&!confirm('当前有未保存的修改，确定切换周次吗？'))return;allowLeave=true;document.getElementById('ef-week-form').requestSubmit();});
  if(!form)return;
  var activeTab='observe';try{var remembered=sessionStorage.getItem('ef-form-tab');if(['activity','observe','talk'].indexOf(remembered)>=0)activeTab=remembered;}catch(_){}setTab(activeTab,false);updateFilled();
  var button=document.getElementById('ef-refresh'),box=document.getElementById('ef-metrics'),pending=0;
  function value(n){return form.elements[n].value;}
  function show(title,detail){box.replaceChildren();var strong=document.createElement('strong');strong.textContent=title;box.append(strong);if(detail){var span=document.createElement('span');span.textContent=detail;box.append(span);}}
  async function query(){
    var request=++pending,date=value('date'),start=value('start'),end=value('end');form.elements.end.setCustomValidity('');
    if(!date||!start||!end){button.disabled=false;show('请填写活动日期和起止时间','保存时自动带入时段平均心率');return;}
    if(start>=end){button.disabled=false;show('结束时间须晚于开始时间');return;}
    button.disabled=true;show('正在查询心率…');
    try{var params=new URLSearchParams({classId:value('classId'),week:value('week'),childId:value('childId'),date:date,start:start,end:end});var res=await fetch(form.dataset.base+'/metrics?'+params,{headers:{Accept:'application/json'}});if(!res.ok)throw new Error('请刷新页面或稍后重试');var result=await res.json();if(request!==pending)return;var m=result.metrics;if(m.avg==null)show(m.reason||'暂无心率数据','缺失数据不记为 0，保存时会再次查询');else show(m.avg+' 次/分','时段平均 · 最低 '+m.min+' / 最高 '+m.max+' · '+m.sample_count+' 次采样');var cb=document.getElementById('ef-refresh-save');if(cb){cb.checked=true;markDirty(form);}}
    catch(err){if(request===pending)show('暂时无法查询心率',err.message);}finally{if(request===pending)button.disabled=false;}
  }
  button.addEventListener('click',query);['date','start','end'].forEach(function(key){form.elements[key].addEventListener('change',query);});form.elements.end.addEventListener('input',function(){form.elements.end.setCustomValidity('');});
})();
