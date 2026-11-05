/**
 * routes/band-trace.js — 南操场三分区活动轨迹（2026-09-25）
 * 数据：band_records 三台南操场网关 RSSI → lib/positioning 分区算法 → 页面/JSON
 * 布局标定：c0656f554509=1区(西) c8fe97a0102f=2区(中) c78a168bef18=3区(东)，长边三等分
 */
const { asyncHandler, requireRole, requirePermission, hasPermission } = require('../lib/helpers');
const { dbQuery, getStudentDisplayMap, maskDisplayName } = require('../lib/db');
const { computeTrace, staySummary, SOUTH_GW_ZONES } = require('../lib/positioning');
const { requireBandTeacher } = require('../lib/band-access');
const { createBandCache } = require('../lib/band-cache');
const cachedTrace = createBandCache(30000);
const cachedLatest = createBandCache(60000, 32);

const SOUTH_GWS = Object.keys(SOUTH_GW_ZONES);
const gwPlaceholders = SOUTH_GWS.map(() => '?').join(',');

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function loadTrace(date, bandMac) {
  const computed = await cachedTrace(date + '|' + bandMac, async () => {
    const rows = await dbQuery(
    `SELECT band_mac, gw_addr, bp_time, rssi FROM band_records
     WHERE band_mac = ? AND bp_time >= ? AND bp_time < ? + INTERVAL 1 DAY
       AND gw_addr IN (${gwPlaceholders}) AND rssi IS NOT NULL
     ORDER BY bp_time ASC`, [bandMac, date + ' 00:00:00', date, ...SOUTH_GWS]);
  const trace = computeTrace(rows);
  const stay = staySummary(trace);
  // 停留转分钟
  const stayMin = {};
  for (const [z, sec] of Object.entries(stay)) stayMin[z] = Math.round(sec / 60);
    return { trace, stayMin, sample_count: rows.length };
  });
  // Resolve child information on every request so binding changes take effect.
  const [info] = await dbQuery(
    `SELECT m.band_mac, ch.id AS child_id, ch.name AS child_name, c.name AS class_name
     FROM band_mapping m LEFT JOIN children ch ON ch.id = m.child_id LEFT JOIN classes c ON c.id = ch.class_id
     WHERE m.band_mac = ? LIMIT 1`, [bandMac]);
  if (info && info.child_name) {
    const displayMap = await getStudentDisplayMap();
    info.display_name = maskDisplayName(displayMap, info.class_name, info.child_name);
  }
  return { date, band_mac: bandMac, info: info || null, ...computed };
}

function requestParams(req, res) {
  const date = req.query.date == null || req.query.date === '' ? todayStr() : String(req.query.date);
  const d = new Date(date + 'T00:00:00Z');
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date;
  const bandMac = String(req.query.band_mac || '').toLowerCase().replace(/[\s:\-_.·：]/g, '');
  if (!validDate || (bandMac && !/^[0-9a-f]{12}$/.test(bandMac))) {
    res.status(400).json({ ok: false, error: '日期或手环参数错误' });
    return null;
  }
  return { date, bandMac };
}

module.exports = function mountBandTraceRoutes(app) {
  const adminOnly = requireRole('admin');
  const teacherOnly = requireRole('user');

  async function pageData(classId) {
    // 绑定了孩子的手环下拉（按班级排序）
    const bands = await dbQuery(
      `SELECT m.band_mac, ch.id AS child_id, ch.name AS child_name, c.name AS class_name, c.id AS class_id
       FROM band_mapping m
       JOIN children ch ON ch.id = m.child_id
       LEFT JOIN classes c ON c.id = ch.class_id
       WHERE ch.name IS NOT NULL
       ${classId ? 'AND ch.class_id = ?' : ''}
       ORDER BY CASE c.grade_level WHEN 'small' THEN 1 WHEN 'middle' THEN 2 WHEN 'large' THEN 3 ELSE 99 END, c.name, ch.name`, classId ? [classId] : []);
    return bands;
  }

  async function latestActivity(bands, date) {
    if (!bands.length) return null;
    const macs = [...new Set(bands.map(b => b.band_mac))].sort();
    const key = macs.join(',') + '|' + (date || 'latest');
    return cachedLatest(key, async () => {
      const params = [];
      const parts = macs.map(mac => {
        params.push(mac, ...SOUTH_GWS);
        if (date) params.push(date + ' 00:00:00', date);
        return `(SELECT band_mac, bp_time FROM band_records FORCE INDEX (idx_band_time)
          WHERE band_mac = ? AND gw_addr IN (${gwPlaceholders}) AND rssi IS NOT NULL
            ${date ? 'AND bp_time >= ? AND bp_time < ? + INTERVAL 1 DAY' : ''}
          ORDER BY bp_time DESC LIMIT 1)`;
      });
      const [row] = await dbQuery(`SELECT band_mac, DATE_FORMAT(bp_time, '%Y-%m-%d') AS day
        FROM (${parts.join(' UNION ALL ')}) recent ORDER BY bp_time DESC, band_mac LIMIT 1`, params);
      return row || null;
    });
  }

  // ========== 轨迹页面 ==========
  async function renderPage(req, res, teacherView) {
    const scope = teacherView ? await requireBandTeacher(req, res) : null;
    if (teacherView && !scope) return;
    const params = requestParams(req, res);
    if (!params) return;
    let { date, bandMac } = params;
    const bands = await pageData(scope && scope.classId);
    if (teacherView && bandMac && !bands.some(b => b.band_mac === bandMac)) {
      return res.status(403).render('error', { message: '只能查看本班幼儿的活动轨迹' });
    }
    const explicitDate = !!req.query.date;
    const candidates = bandMac ? bands.filter(b => b.band_mac === bandMac) : bands;
    const latest = await latestActivity(candidates, explicitDate ? date : null);
    let autoLoaded = false;
    if (latest) {
      if (!bandMac) bandMac = latest.band_mac;
      if (!explicitDate) { date = latest.day; autoLoaded = true; }
    } else if (!bandMac && bands.length) bandMac = bands[0].band_mac;
    // 下拉展示名脱敏（末字星/同班撞车中间星）
    const displayMap = await getStudentDisplayMap();
    bands.forEach(function (b) {
      b.display_name = maskDisplayName(displayMap, b.class_name, b.child_name);
    });
    let data = null;
    if (bandMac) {
      try { data = await loadTrace(date, bandMac); } catch (e) { data = { error: e.message }; }
    }
    res.render('admin-band-trace', {
      bands, data, queryDate: date, selectedBand: bandMac,
      zoneMeta: SOUTH_GW_ZONES,
      currentUser: req.session.user,
      hasPerm: (p) => hasPermission(req.session.user, p),
      isReadonly: !!req.session.user.isReadonly,
      teacherView,
      traceBase: teacherView ? '/user/bands/trace' : '/admin/bands/trace',
      teacherClassName: scope ? scope.myClass.name : '',
      autoLoaded,
      isHistorical: date !== todayStr(),
    });
  }
  app.get('/admin/bands/trace', adminOnly, requirePermission('data.bands.view'), asyncHandler((req, res) => renderPage(req, res, false)));
  app.get('/user/bands/trace', teacherOnly, asyncHandler((req, res) => renderPage(req, res, true)));

  // ========== 轨迹 JSON API（轻量轮询/刷新用，实时直读库） ==========
  async function traceApi(req, res, teacherView) {
    const scope = teacherView ? await requireBandTeacher(req, res) : null;
    if (teacherView && !scope) return;
    const params = requestParams(req, res);
    if (!params) return;
    const { date, bandMac } = params;
    if (!bandMac) return res.status(400).json({ ok: false, error: '缺少 band_mac' });
    if (teacherView) {
      const own = await dbQuery(`SELECT 1 FROM band_mapping m JOIN children ch ON ch.id = m.child_id
        WHERE m.band_mac = ? AND ch.class_id = ? LIMIT 1`, [bandMac, scope.classId]);
      if (!own.length) return res.status(403).json({ ok: false, error: '只能查看本班幼儿的活动轨迹' });
    }
    try {
      const data = await loadTrace(date, bandMac);
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
  app.get('/admin/bands/trace/api', adminOnly, requirePermission('data.bands.view'), asyncHandler((req, res) => traceApi(req, res, false)));
  app.get('/user/bands/trace/api', teacherOnly, asyncHandler((req, res) => traceApi(req, res, true)));
};
