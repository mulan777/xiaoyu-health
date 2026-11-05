(function () {
  'use strict';
  var metrics = {
    hr: { title:'心率明细', label:'心率', unit:'bpm', color:'#e11d48', average:'avgHr' },
    sp: { title:'血氧明细', label:'血氧', unit:'%', color:'#0284c7', average:'avgSpo2' },
    tp: { title:'体温明细', label:'体温', unit:'℃', color:'#d97706', average:'avgTp' },
    bp: { title:'血压明细', label:'血压', unit:'mmHg', color:'#7c3aed', average:'avgBp' },
    steps: { title:'步数明细', label:'步数', unit:'步', color:'#059669' },
    alert: { title:'体征预警明细', label:'各项体征', unit:'', color:'#dc2626' }
  };
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function macLabel(mac) { return String(mac || '').toUpperCase().match(/.{1,2}/g)?.join(':') || '--'; }
  function period(mode) { return mode === 'yesterday' ? '昨天' : mode === 'week' ? '近一周' : '今天'; }
  function td(label, content) { return '<td data-label="' + esc(label) + '"><div>' + content + '</div></td>'; }
  function empty(message) { return '<tr><td class="sd-empty" colspan="6">' + esc(message) + '</td></tr>'; }
  window.createScreenDetails = function (options) {
    var el = function(id) { return document.getElementById(id); };
    var dialog = el('screenDetails'), data = null, dataKey = '', metric = 'hr', tab = 'measurements';
    var bandMac = '', alertPage = 1, totalPages = 1, requestId = 0, request = null;
    var focusBefore = null, oldOverflow = '';
    function key(state) { return [state.scope, state.classId || 0, state.rangeMode].join('|'); }
    function cancel() { requestId++; if (request) request.abort(); request = null; }
    function sameScope() { return data && dataKey === key(options.getState()); }
    function renderHeader() {
      var state = options.getState();
      el('sdTitle').textContent = metrics[metric].title;
      var chip = document.querySelector('.scope-chip.active');
      var name = sameScope() ? data.scopeLabel : chip ? chip.textContent : state.scope === 'class' ? '本班' : '全园';
      el('sdScope').textContent = name + ' · ' + period(state.rangeMode) + ' · 测量窗口 09:00–11:00';
      dialog.style.setProperty('--sd-accent', metrics[metric].color);
      el('sdAlertsTab').textContent = metric === 'hr' ? '心率预警记录' : '体征预警记录';
      el('sdValueHeading').textContent = metrics[metric].label;
      Array.from(el('sdReadingFilter').options).forEach(function(option) { option.hidden = metric === 'alert' && (option.value === 'valid' || option.value === 'missing'); });
      el('sdUpdated').textContent = sameScope() ? '同步时间：' + data.updatedAt : '';
    }
    function warningMap() {
      var map = new Map();
      (data.bandAlerts || []).forEach(function(a) {
        if (metric === 'hr' && a.kind !== 'hr_high' && a.kind !== 'hr_low') return;
        var mac = String(a.band_mac).toLowerCase(), count = map.get(mac) || { active:0, resolved:0 };
        count[a.status === 'active' ? 'active' : 'resolved']++;
        map.set(mac, count);
      });
      return map;
    }
    function valueOf(row, type) {
      if (type === 'bp') return row.systolic > 0 && row.diastolic > 0 ? row.systolic + '/' + row.diastolic : null;
      var value = row[type];
      return value != null && value >= (type === 'steps' ? 0 : 1) && row.has_record ? value : null;
    }
    function reading(row) {
      if (metric === 'alert') {
        return ['hr','tp','sp','bp','steps'].map(function(type) {
          var value = valueOf(row, type), config = metrics[type];
          return '<small>' + config.label + ' ' + (value == null ? '--' : esc(value) + ' ' + config.unit) + '</small>';
        }).join('');
      }
      var value = valueOf(row, metric);
      return '<span class="sd-value">' + (value == null ? '--' : esc(value)) + ' <span class="sd-unit">' + (value == null ? '' : metrics[metric].unit) + '</span></span>'
        + '<small>' + (!row.has_record ? '所选时段未上报' : row.included[metric] ? '计入大屏均值' : '未计入大屏均值') + '</small>';
    }
    function renderMeasurements() {
      renderHeader();
      if (!sameScope()) { el('sdRows').innerHTML = empty('正在等待所选班级的数据，请稍后…'); el('sdSummary').textContent = ''; return; }
      var warnings = warningMap(), list = data.bandDetails || [];
      var filter = el('sdReadingFilter').value, query = el('sdSearch').value.trim().toLowerCase();
      var included = list.filter(function(r) { return r.included[metric]; }).length;
      var rows = list.filter(function(r) {
        var w = warnings.get(r.band_mac) || {active:0,resolved:0};
        var text = [r.child_name,r.class_name,r.band_mac,macLabel(r.band_mac)].join(' ').toLowerCase();
        if (query && text.indexOf(query) < 0 && r.band_mac.indexOf(query.replace(/[:\s-]/g,'')) < 0) return false;
        return filter === 'valid' ? !!r.included[metric] : filter === 'missing' ? !r.included[metric] : filter === 'alerts' ? w.active + w.resolved > 0 : true;
      }).sort(function(a,b) { return (a.class_name || '').localeCompare(b.class_name || '', 'zh-CN') || a.band_mac.localeCompare(b.band_mac); });
      var average = metric === 'steps' ? data.bandSummary.avgSteps : (data.avgHealth || {})[metrics[metric].average];
      el('sdSummary').textContent = '显示 ' + rows.length + ' / ' + list.length + ' 只手表'
        + (metric === 'alert' ? '' : ' · ' + included + ' 只计入均值 · 大屏均值 ' + (average == null ? '--' : average + ' ' + metrics[metric].unit));
      el('sdRows').innerHTML = rows.length ? rows.map(function(r) {
        var w = warnings.get(r.band_mac) || {active:0,resolved:0};
        var badge = (w.active ? '<span class="sd-badge active">进行中 ' + w.active + ' 起</span>' : '')
          + (w.resolved ? '<span class="sd-badge resolved">已恢复 ' + w.resolved + ' 起</span>' : '');
        return '<tr>' + td('班级 / 幼儿', '<strong>' + esc(r.class_name || '未绑定班级') + '</strong><small>' + esc(r.child_name || '未绑定幼儿') + '</small>')
          + td('手表编号 / MAC','<span class="sd-mac">' + esc(macLabel(r.band_mac)) + '</span>')
          + td(metrics[metric].label, reading(r))
          + td('上报时间',esc(r.last_time || '所选时段未上报') + '<small>' + (r.has_record ? r.online ? '当前在线' : '所选时段的记录' : '等待上报') + '</small>')
          + td('本时段体征预警',badge || '<small>本时段无记录</small>')
          + td('操作','<button type="button" class="sd-link" data-band-mac="' + esc(r.band_mac) + '">查看全部历史预警 ›</button>') + '</tr>';
      }).join('') : empty('没有符合条件的手表');
    }
    function showTab(next) {
      cancel(); tab = next;
      el('sdMeasurements').hidden = tab !== 'measurements'; el('sdAlerts').hidden = tab !== 'alerts';
      ['Measurements','Alerts'].forEach(function(name) {
        var active = name.toLowerCase() === tab;
        el('sd' + name + 'Tab').setAttribute('aria-selected', String(active));
      });
      if (tab === 'measurements') renderMeasurements(); else loadAlerts();
    }
    function loadAlerts() {
      cancel(); var id = requestId;
      request = new AbortController();
      var state = options.getState(), range = el('sdAlertRange').value === 'all' ? 'all' : state.rangeMode;
      renderHeader(); el('sdClearBand').hidden = !bandMac;
      el('sdPrev').disabled = true; el('sdNext').disabled = true; el('sdPage').textContent = '';
      el('sdAlertSummary').textContent = '正在加载预警记录…'; el('sdAlertRows').innerHTML = empty('加载中…');
      var params = new URLSearchParams({ scope:state.scope, classId:String(state.classId || 0), rangeMode:range,
        metric:metric === 'hr' ? 'hr' : 'all', status:el('sdAlertStatus').value, page:String(alertPage) });
      if (bandMac) params.set('bandMac', bandMac);
      fetch(options.apiBase + '/alerts?' + params, { credentials:'same-origin', headers:{'X-Requested-With':'fetch'}, signal:request.signal })
        .then(function(r) { if (!r.ok) throw new Error('无法读取预警记录，请刷新重试'); return r.json(); })
        .then(function(result) {
          if (id !== requestId || !dialog.open) return;
          if (!result || !result.ok) throw new Error(result.error || '无法读取预警记录');
          alertPage = result.page; totalPages = Math.max(1,Math.ceil(result.total / result.pageSize));
          el('sdAlertSummary').textContent = (bandMac ? '手表 ' + macLabel(bandMac) + ' · ' : '')
            + (range === 'all' ? '全部历史' : period(range)) + '共 ' + result.total + ' 起预警 · 进行中 ' + result.active + ' 起 · 已恢复 ' + (result.total - result.active) + ' 起';
          el('sdPage').textContent = alertPage + ' / ' + totalPages + ' 页';
          el('sdPrev').disabled = alertPage <= 1; el('sdNext').disabled = alertPage >= totalPages;
          el('sdAlertRows').innerHTML = result.alerts.length ? result.alerts.map(function(a) {
            var active = a.status === 'active', kind = a.kind === 'hr_high' ? '心率偏高' : a.kind === 'hr_low' ? '心率偏低' : a.kind === 'sos' ? 'SOS 紧急' : a.kind;
            return '<tr>' + td('班级 / 幼儿','<strong>' + esc(a.class_name || '未绑定班级') + '</strong><small>' + esc(a.child_name || '未绑定幼儿') + '</small>')
              + td('手表编号 / MAC','<span class="sd-mac">' + esc(macLabel(a.band_mac)) + '</span>')
              + td('预警类型 / 数值',esc(kind) + (a.kind.indexOf('hr_') === 0 ? '<small>峰值 ' + esc(a.peak_value ?? '--') + ' bpm</small>' : ''))
              + td('首次 / 最近触发',esc(a.first_time) + '<small>最近 ' + esc(a.last_time) + '</small>')
              + td('状态 / 恢复时间','<span class="sd-badge ' + (active ? 'active' : 'resolved') + '">' + (active ? '进行中' : '已恢复') + '</span><small>' + esc(active ? '尚未恢复' : a.resolved_at || '已恢复') + '</small>')
              + td('触发次数',esc(a.trigger_count) + ' 次') + '</tr>';
          }).join('') : empty('当前条件下暂无预警记录');
        }).catch(function(error) {
          if (error.name === 'AbortError' || id !== requestId) return;
          el('sdAlertSummary').textContent = error.message || '加载失败，请刷新重试';
          el('sdAlertRows').innerHTML = empty('预警记录未加载成功，请点击“刷新记录”');
        });
    }
    function open(type, card) {
      metric = type; bandMac = ''; alertPage = 1;
      el('sdSearch').value = ''; el('sdReadingFilter').value = 'all';
      el('sdAlertRange').value = 'selected'; el('sdAlertStatus').value = 'all';
      focusBefore = card; oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
      dialog.showModal(); renderHeader(); showTab(metric === 'alert' ? 'alerts' : 'measurements'); el('sdClose').focus();
    }
    document.querySelectorAll('.metric-card[data-metric]').forEach(function(card) {
      var type = card.getAttribute('data-metric');
      card.setAttribute('role','button'); card.setAttribute('tabindex','0'); card.setAttribute('aria-haspopup','dialog');
      card.setAttribute('aria-controls','screenDetails'); card.setAttribute('aria-label','展开' + metrics[type].title);
      var hint = document.createElement('div'); hint.className = 'sd-card-hint'; hint.textContent = '点击查看明细 ›'; card.appendChild(hint);
      card.addEventListener('click',function() { open(type,card); });
      card.addEventListener('keydown',function(event) { if(event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(type,card); } });
    });
    el('sdClose').addEventListener('click', function() { dialog.close(); });
    dialog.addEventListener('close',function() { cancel(); document.body.style.overflow = oldOverflow; if(focusBefore) focusBefore.focus({preventScroll:true}); });
    dialog.addEventListener('click',function(event) { if(event.target !== dialog) return; var box = dialog.getBoundingClientRect(); if(event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); });
    el('sdMeasurementsTab').addEventListener('click', function() { showTab('measurements'); });
    el('sdAlertsTab').addEventListener('click',function() { showTab('alerts'); });
    el('sdSearch').addEventListener('input',renderMeasurements); el('sdReadingFilter').addEventListener('change',renderMeasurements);
    el('sdRows').addEventListener('click',function(event) {
      var button = event.target.closest('[data-band-mac]'); if(!button) return;
      bandMac = button.getAttribute('data-band-mac'); alertPage = 1; el('sdAlertRange').value = 'all'; showTab('alerts');
    });
    ['sdAlertRange','sdAlertStatus'].forEach(function(id) { el(id).addEventListener('change',function() { alertPage = 1; loadAlerts(); }); });
    el('sdClearBand').addEventListener('click',function() { bandMac = ''; alertPage = 1; loadAlerts(); });
    el('sdRetry').addEventListener('click',loadAlerts);
    el('sdPrev').addEventListener('click',function() { if(alertPage > 1) { alertPage--; loadAlerts(); } });
    el('sdNext').addEventListener('click',function() { if(alertPage < totalPages) { alertPage++; loadAlerts(); } });
    return { update:function(next) { data = next; dataKey = key(options.getState()); if(dialog.open) { if(tab === 'measurements') renderMeasurements(); else loadAlerts(); } } };
  };
})();
