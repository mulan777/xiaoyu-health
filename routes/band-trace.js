/**
 * routes/band-trace.js — 南操场三分区活动轨迹（2026-09-25）
 * 数据：band_records 三台南操场网关 RSSI → lib/positioning 分区算法 → 页面/JSON
 * 布局标定：c0656f554509=1区(西) c8fe97a0102f=2区(中) c78a168bef18=3区(东)，长边三等分
 */
const { asyncHandler, requireRole, requirePermission, hasPermission } = require('../lib/helpers');
const { dbQuery, getStudentDisplayMap, maskDisplayName } = require('../lib/db');
const { computeTrace, staySummary, SOUTH_GW_ZONES } = require('../lib/positioning');

const SOUTH_GWS = Object.keys(SOUTH_GW_ZONES);
const gwPlaceholders = SOUTH_GWS.map(() => '?').join(',');

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function loadTrace(date, bandMac) {
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
  // 孩子信息（展示名脱敏：末字星/同班撞车中间星）
  const [info] = await dbQuery(
    `SELECT m.band_mac, ch.id AS child_id, ch.name AS child_name, c.name AS class_name
     FROM band_mapping m LEFT JOIN children ch ON ch.id = m.child_id LEFT JOIN classes c ON c.id = ch.class_id
     WHERE m.band_mac = ? LIMIT 1`, [bandMac]);
  if (info && info.child_name) {
    const displayMap = await getStudentDisplayMap();
    info.display_name = maskDisplayName(displayMap, info.class_name, info.child_name);
  }
  return { date, band_mac: bandMac, info: info || null, trace, stayMin, sample_count: rows.length };
}

module.exports = function mountBandTraceRoutes(app) {
  const adminOnly = requireRole('admin');

  async function pageData(date) {
    // 绑定了孩子的手环下拉（按班级排序）
    const bands = await dbQuery(
      `SELECT m.band_mac, ch.id AS child_id, ch.name AS child_name, c.name AS class_name, c.id AS class_id
       FROM band_mapping m
       JOIN children ch ON ch.id = m.child_id
       LEFT JOIN classes c ON c.id = ch.class_id
       WHERE ch.name IS NOT NULL
       ORDER BY CASE c.grade_level WHEN 'small' THEN 1 WHEN 'middle' THEN 2 WHEN 'large' THEN 3 ELSE 99 END, c.name, ch.name`);
    return bands;
  }

  // ========== 轨迹页面 ==========
  app.get('/admin/bands/trace', adminOnly, requirePermission('data.bands.view'), asyncHandler(async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : todayStr();
    const bands = await pageData(date);
    // 下拉展示名脱敏（末字星/同班撞车中间星）
    const displayMap = await getStudentDisplayMap();
    bands.forEach(function (b) {
      b.display_name = maskDisplayName(displayMap, b.class_name, b.child_name);
    });
    let data = null;
    const bandMac = String(req.query.band_mac || '').toLowerCase().replace(/[\s:\-_.·：]/g, '');
    if (bandMac) {
      try { data = await loadTrace(date, bandMac); } catch (e) { data = { error: e.message }; }
    }
    res.render('admin-band-trace', {
      bands, data, queryDate: date, selectedBand: bandMac,
      zoneMeta: SOUTH_GW_ZONES,
      currentUser: req.session.user,
      hasPerm: (p) => hasPermission(req.session.user, p),
      isReadonly: !!req.session.user.isReadonly,
    });
  }));

  // ========== 轨迹 JSON API（轻量轮询/刷新用，实时直读库） ==========
  app.get('/admin/bands/trace/api', adminOnly, requirePermission('data.bands.view'), asyncHandler(async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : todayStr();
    const bandMac = String(req.query.band_mac || '').toLowerCase().replace(/[\s:\-_.·：]/g, '');
    if (!bandMac) return res.status(400).json({ ok: false, error: '缺少 band_mac' });
    try {
      const data = await loadTrace(date, bandMac);
      res.json({ ok: true, data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }));
};
