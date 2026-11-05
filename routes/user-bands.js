/**
 * routes/user-bands.js — 教师端手环健康监测 + 班级大屏（2026-09-20）
 * 面向 role=user 且本班已启用手环展示(bandEnabledClasses)的教师：
 *   /user/bands                本班手环实时概览（复用 admin-bands 视图，teacherView=true 隐藏配置/绑定管理）
 *   /user/bands/api/recent     本班最近上报
 *   /user/bands/api/records    本班单手环曲线（MAC 归属校验）
 *   /user/screen               本班数据大屏（screen-teacher 视图，锁定本班）
 *   /user/screen/api/overview  本班大屏聚合（复用 screen.js buildScreenOverview，bandClassId=本班）
 */
const { normalizeText, asyncHandler, requireRole } = require('../lib/helpers');
const { dbQuery, getSettings } = require('../lib/db');
const { recentClassRecords } = require('../lib/band-recent');
const { requireBandTeacher } = require('../lib/band-access');
const { createBandCache } = require('../lib/band-cache');
const cachedOverview = createBandCache(30000, 32);

function normalizeBandMac(input) {
  return String(normalizeText(input) || '').toLowerCase().replace(/[\s:\-_.·：]/g, '');
}

module.exports = function mountUserBandRoutes(app, screenHelpers) {
  const teacherOnly = requireRole('user');
  const buildScreenOverview = screenHelpers.buildScreenOverview;
  const buildScreenOverviewCached = screenHelpers.buildScreenOverviewCached;

  // ========== 教师端手环页 ==========
  app.get('/user/bands', teacherOnly, asyncHandler(async (req, res) => {
    const scopeInfo = await requireBandTeacher(req, res);
    if (!scopeInfo) return;
    const { classId, myClass } = scopeInfo;
    /* 20260926 修复：下方 gwNames/res.render 引用了 settings，但此作用域原本没有——
       教师端 /user/bands 因此 500（settings is not defined）。这里取一次。 */
    const settings = scopeInfo.settings;

    const [mappings, bandOverview, latestRecords] = await Promise.all([
      dbQuery(`SELECT m.id, m.band_mac, m.remark, m.child_id, ch.name AS child_name
               FROM band_mapping m LEFT JOIN children ch ON ch.id = m.child_id
               WHERE ch.class_id = ?`, [classId]),
      cachedOverview(String(classId), () => dbQuery(`SELECT r.band_mac, r.heart_rate, r.body_temp, r.systolic, r.diastolic,
                      r.spo2, r.steps, r.battery, r.sos, g.last_time, g.total_records
               FROM (SELECT b.band_mac, MAX(b.id) AS max_id, MAX(b.bp_time) AS last_time, COUNT(*) AS total_records
                     FROM band_records b
                     JOIN band_mapping m ON m.band_mac = b.band_mac
                     JOIN children ch ON ch.id = m.child_id AND ch.class_id = ?
                     GROUP BY b.band_mac) g
               JOIN band_records r ON r.id = g.max_id
               ORDER BY g.last_time DESC`, [classId])),
      recentClassRecords(classId, 30),
    ]);

    const nowTs = Date.now();
    const bandList = bandOverview.map((r) => {
      const mp = mappings.find((x) => x.band_mac === r.band_mac);
      const rawLast = r.last_time instanceof Date
        ? r.last_time.getTime()
        : (r.last_time ? new Date(String(r.last_time).replace(' ', 'T')).getTime() : 0);
      const lastTime = Number.isFinite(rawLast) ? rawLast : 0;
      return {
        ...r,
        child_name: mp ? mp.child_name : '',
        class_name: myClass.name,
        online: Number.isFinite(nowTs - lastTime) && (nowTs - lastTime) < 6 * 60 * 1000,
        minutes_ago: lastTime ? Math.max(0, Math.round((nowTs - lastTime) / 60000)) : null,
      };
    });

    let gwNames = {};
    try { gwNames = JSON.parse(settings.bandGatewayNames || '{}') || {}; } catch (e) { gwNames = {}; }
    latestRecords.forEach((r) => { r.gw_name = gwNames[r.gw_addr] || ''; });

    res.render('admin-bands', {
      settings: { bandEnabledClasses: JSON.stringify([classId]), bandGatewayNames: settings.bandGatewayNames || '[]' },
      classes: [myClass],
      enabledClassIds: [classId],
      mappings,
      children: [],
      bandList,
      latestRecords,
      focusMode: false,
      teacherView: true,
      message: '',
      query: {},
      today: (function(){ const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })(),
      currentUser: req.session.user,
      hasPerm: () => false,
      isReadonly: !!req.session.user.isReadonly,
    });
  }));

  // ========== 教师端：最近上报（本班） ==========
  app.get('/user/bands/api/recent', teacherOnly, asyncHandler(async (req, res) => {
    const scopeInfo = await requireBandTeacher(req, res);
    if (!scopeInfo) return;
    const rows = await recentClassRecords(scopeInfo.classId, 30);
    res.json({ ok: true, count: rows.length, records: rows });
  }));

  // ========== 教师端：单手环曲线（仅本班手环） ==========
  app.get('/user/bands/api/records', teacherOnly, asyncHandler(async (req, res) => {
    const scopeInfo = await requireBandTeacher(req, res);
    if (!scopeInfo) return;
    const mac = normalizeBandMac(req.query.mac);
    if (!/^[0-9a-f]{12}$/.test(mac)) return res.json({ ok: false, message: 'MAC 参数错误' });
    const own = await dbQuery(
      `SELECT 1 FROM band_mapping m JOIN children ch ON ch.id = m.child_id
       WHERE m.band_mac = ? AND ch.class_id = ? LIMIT 1`, [mac, scopeInfo.classId]);
    if (!own.length) return res.json({ ok: false, message: '无权查看该手环' });
    const hours = Math.min(Math.max(Number(req.query.hours || 6), 1), 72);
    const since = new Date(Date.now() + 8 * 3600 * 1000 - hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const rows = await dbQuery(
      `SELECT bp_time, heart_rate, body_temp, systolic, diastolic, spo2, steps, battery
       FROM band_records WHERE band_mac = ? AND bp_time >= ? ORDER BY id ASC`, [mac, since]);
    res.json({ ok: true, mac, hours, count: rows.length, records: rows });
  }));

  // ========== 教师端大屏页（锁定本班） ==========
  app.get('/user/screen', teacherOnly, asyncHandler(async (req, res) => {
    const scopeInfo = await requireBandTeacher(req, res);
    if (!scopeInfo) return;
    res.render('screen-teacher', {
      classes: [scopeInfo.myClass],
      displayClasses: [scopeInfo.myClass],
      teacherView: true,
      teacherClassId: scopeInfo.classId,
      teacherClassName: scopeInfo.myClass.name,
      currentUser: req.session.user,
      today: (function(){ const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()
    });
  }));

  // ========== 教师端大屏聚合 API（固定本班；手环数据也按本班过滤） ==========
  app.get('/user/screen/api/overview', teacherOnly, asyncHandler(async (req, res) => {
    const scopeInfo = await requireBandTeacher(req, res);
    if (!scopeInfo) return;
    const data = await buildScreenOverviewCached('class', scopeInfo.classId, req.query.rangeMode, scopeInfo.classId);
    // 教师端只暴露本班
    res.json(Object.assign({}, data, { ok: true, teacherLocked: true,
      displayClasses: [{ id: scopeInfo.classId, name: scopeInfo.myClass.name }] }));
  }));
  app.get('/user/screen/api/alerts', teacherOnly, asyncHandler(async (req, res) => {
    const scopeInfo = await requireBandTeacher(req, res);
    if (!scopeInfo) return;
    const data = await screenHelpers.buildScreenAlerts(scopeInfo.classId, req.query);
    res.status(data.ok ? 200 : 400).json(data);
  }));
};
