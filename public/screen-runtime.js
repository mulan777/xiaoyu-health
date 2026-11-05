(function () {
  'use strict';

  // Native scrolling owns vertical gestures. Refresh visible content after motion ends.
  window.createScreenInteraction = function () {
    var pending = new Map(), lastMotion = 0, touching = false, timer = null;
    function mark() { lastMotion = Date.now(); }
    function busy() { return document.hidden || touching || Date.now() - lastMotion < 220; }
    function schedule() {
      if (timer !== null || document.hidden || !pending.size) return;
      timer = setTimeout(flush, busy() ? 240 : 0);
    }
    function flush() {
      timer = null;
      if (busy()) { schedule(); return; }
      var tasks = Array.from(pending.values()); pending.clear();
      tasks.forEach(function (task) { task(); });
      schedule();
    }
    window.addEventListener('scroll', mark, { passive: true, capture: true });
    window.addEventListener('wheel', mark, { passive: true });
    window.addEventListener('touchstart', function () { touching = true; mark(); }, { passive: true });
    window.addEventListener('touchmove', mark, { passive: true });
    function endTouch(event) { touching = !!(event.touches && event.touches.length); mark(); schedule(); }
    window.addEventListener('touchend', endTouch, { passive: true });
    window.addEventListener('touchcancel', endTouch, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearTimeout(timer); timer = null; }
      else schedule();
    });
    return { defer: function (key, task) { pending.set(key, task); schedule(); } };
  };

  window.createScreenCharts = function (interaction) {
    var charts = {}, observers = {}, signatures = {}, resizeHooks = {};
    function resize(id) {
      interaction.defer('resize:' + id, function () {
        var c = charts[id], el = document.getElementById(id);
        if (!c || c.isDisposed() || !el || !el.clientWidth || !el.clientHeight) return;
        var width = el.clientWidth, height = el.clientHeight;
        // WeChat toolbar height changes also emit resize; unchanged charts need no work.
        if (c.getWidth() === width && c.getHeight() === height) return;
        c.resize({ width: width, height: height, silent: true });
        if (resizeHooks[id]) resizeHooks[id]();
      });
    }
    function init(id) {
      if (!window.echarts) return null;
      var el = document.getElementById(id);
      if (!el || !el.clientWidth || !el.clientHeight) return null;
      if (!charts[id] || charts[id].isDisposed()) {
        charts[id] = echarts.init(el); delete signatures[id];
        if (window.ResizeObserver && !observers[id]) {
          observers[id] = new ResizeObserver(function () { resize(id); });
          observers[id].observe(el);
        }
      }
      return charts[id];
    }
    function readable(value) {
      if (!value || typeof value !== 'object') return;
      Object.keys(value).forEach(function (key) {
        if (key === 'fontSize' && typeof value[key] === 'number') value[key] = Math.max(12, value[key]);
        else readable(value[key]);
      });
    }
    function set(id, opt) {
      readable(opt); opt.animation = false;
      opt.textStyle = Object.assign({ fontSize: 13 }, opt.textStyle || {});
      if (window.innerWidth <= 768) {
        if (opt.tooltip) opt.tooltip.triggerOn = 'click';
        if (opt.legend && opt.grid && Array.isArray(opt.series) && opt.series.length > 2) {
          opt.grid.top = Math.max(Number(opt.grid.top) || 0, 56);
        }
      }
      var signature = JSON.stringify(opt, function (key, value) { return typeof value === 'function' ? String(value) : value; });
      interaction.defer('chart:' + id, function () {
        var c = init(id); if (!c || signatures[id] === signature) return;
        c.setOption(opt, { notMerge: true, lazyUpdate: true, silent: true });
        signatures[id] = signature;
      });
    }
    function resizeAll() { Object.keys(charts).forEach(resize); }
    window.addEventListener('resize', resizeAll, { passive: true });
    return { charts: charts, init: init, set: set, onResize: function (id, hook) { resizeHooks[id] = hook; } };
  };
})();
