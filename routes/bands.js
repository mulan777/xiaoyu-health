/**
 * routes/bands.js — 手环健康监测（YT9 手环数据展示 / 班级配置 / MAC 绑定）
 */
const { normalizeText, asyncHandler, requireRole, requirePermission, requireWritable, hasPermission } = require('../lib/helpers');
const { dbQuery, getSettings, saveSettings } = require('../lib/db');

module.exports = function mountBandRoutes(app, upload) {
  const adminOnly = requireRole('admin');

  // ========== 手环健康主页面 ==========
  app.get('/admin/bands', adminOnly, requirePermission('data.bands.view'), asyncHandler(async (req, res) => {
    const settings = await getSettings();
    let enabledClassIds = [];
    try { enabledClassIds = JSON.parse(settings.bandEnabledClasses || '[]'); } catch (e) { enabledClassIds = []; }
    if (!Array.isArray(enabledClassIds)) enabledClassIds = [];

    const [classes, mappings, bandOverview, latestRecords] = await Promise.all([
      dbQuery(`SELECT id, name, grade_level, capacity, enabled
               FROM classes
               ORDER BY CASE grade_level WHEN 'small' THEN 1 WHEN 'middle' THEN 2 WHEN 'large' THEN 3 ELSE 99 END, id ASC`),
      dbQuery(`SELECT m.id, m.band_mac, m.remark, m.child_id, ch.name AS child_name, c.name AS class_name, c.id AS class_id
               FROM band_mapping m
               LEFT JOIN children ch ON ch.id = m.child_id
               LEFT JOIN classes c ON c.id = ch.class_id
               ORDER BY m.id DESC`),
      dbQuery(`SELECT b.band_mac,
                     MAX(b.bp_time) AS last_time,
                     COUNT(*) AS total_records,
                     (SELECT heart_rate FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS heart_rate,
                     (SELECT body_temp FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS body_temp,
                     (SELECT systolic FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS systolic,
                     (SELECT diastolic FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS diastolic,
                     (SELECT spo2 FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS spo2,
                     (SELECT steps FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS steps,
                     (SELECT battery FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS battery,
                     (SELECT sos FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS sos
              FROM band_records b
              GROUP BY b.band_mac
              ORDER BY last_time DESC`),
      dbQuery(`SELECT b.id, b.band_mac, b.bp_time, b.heart_rate, b.body_temp, b.systolic, b.diastolic,
                      b.spo2, b.steps, b.battery, b.sos,
                      m.child_id, ch.name AS child_name, c.name AS class_name, c.id AS class_id
               FROM band_records b
               LEFT JOIN band_mapping m ON m.band_mac = b.band_mac
               LEFT JOIN children ch ON ch.id = m.child_id
               LEFT JOIN classes c ON c.id = ch.class_id
               ORDER BY b.id DESC LIMIT 30`),
    ]);

    // 绑定管理下拉只列出「展示班级配置」中启用的班级的孩子
    let children = [];
    if (enabledClassIds.length) {
      const placeholders = enabledClassIds.map(() => '?').join(',');
      children = await dbQuery(
        `SELECT ch.id, ch.name, c.name AS class_name, c.id AS class_id
         FROM children ch LEFT JOIN classes c ON c.id = ch.class_id
         WHERE ch.enabled = 1 AND ch.class_id IN (${placeholders})
         ORDER BY c.name, ch.name`, enabledClassIds);
    }

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
        class_name: mp ? mp.class_name : '',
        online: Number.isFinite(nowTs - lastTime) && (nowTs - lastTime) < 6 * 60 * 1000,
        minutes_ago: lastTime ? Math.max(0, Math.round((nowTs - lastTime) / 60000)) : null,
      };
    });

    res.render('admin-bands', {
      settings,
      classes,
      enabledClassIds,
      mappings,
      children,
      bandList,
      latestRecords,
      message: normalizeText(req.query.message),
      query: req.query || {},
      today: (function(){ const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })(),
      currentUser: req.session.user,
      hasPerm: (p) => hasPermission(req.session.user, p),
      isReadonly: !!req.session.user.isReadonly,
    });
  }));

  // ========== 保存启用班级配置 ==========
  app.post('/admin/bands/config', adminOnly, requirePermission('data.bands.config'), requireWritable(), asyncHandler(async (req, res) => {
    // 兼容单复选框提交（字符串）与多选（数组）
    const raw = Array.isArray(req.body.classIds)
      ? req.body.classIds
      : (req.body.classIds != null ? [req.body.classIds] : []);
    const ids = [...new Set(raw.map(Number).filter((n) => Number.isFinite(n)))];
    await saveSettings({ bandEnabledClasses: JSON.stringify(ids) });
    res.redirect('/admin/bands?message=' + encodeURIComponent('班级配置已保存（' + ids.length + ' 个班级启用）'));
  }));

  // ========== 保存 MAC 绑定 ==========
  app.post('/admin/bands/mapping/save', adminOnly, requirePermission('data.bands.config'), requireWritable(), asyncHandler(async (req, res) => {
    const mac = normalizeText(req.body.bandMac || '').toLowerCase();
    const childId = req.body.childId ? Number(req.body.childId) : null;
    const remark = normalizeText(req.body.remark || '');
    if (!/^[0-9a-f]{12}$/.test(mac)) return res.redirect('/admin/bands?message=' + encodeURIComponent('MAC 格式不正确（应为 12 位十六进制）'));
    await dbQuery(`INSERT INTO band_mapping (band_mac, child_id, remark) VALUES (?, ?, ?)
                   ON DUPLICATE KEY UPDATE child_id = VALUES(child_id), remark = VALUES(remark)`,
      [mac, childId, remark]);
    res.redirect('/admin/bands?message=' + encodeURIComponent('MAC 绑定已保存：' + mac));
  }));

  // ========== 删除 MAC 绑定 ==========
  app.post('/admin/bands/mapping/delete', adminOnly, requirePermission('data.bands.config'), requireWritable(), asyncHandler(async (req, res) => {
    const id = Number(req.body.id || 0);
    if (id) await dbQuery('DELETE FROM band_mapping WHERE id = ?', [id]);
    res.redirect('/admin/bands?message=' + encodeURIComponent('绑定已删除'));
  }));

  // ========== JSON 接口：最近上报记录（记录表 30 秒局部刷新用） ==========
  app.get('/admin/bands/api/recent', adminOnly, requirePermission('data.bands.view'), asyncHandler(async (req, res) => {
    const rows = await dbQuery(
      `SELECT b.id, b.band_mac, b.bp_time, b.heart_rate, b.body_temp, b.systolic, b.diastolic,
              b.spo2, b.steps, b.battery, b.sos,
              m.child_id, ch.name AS child_name, c.name AS class_name, c.id AS class_id
       FROM band_records b
       LEFT JOIN band_mapping m ON m.band_mac = b.band_mac
       LEFT JOIN children ch ON ch.id = m.child_id
       LEFT JOIN classes c ON c.id = ch.class_id
       ORDER BY b.id DESC LIMIT 30`);
    res.json({ ok: true, count: rows.length, records: rows });
  }));

  // ========== JSON 接口：单手环历史记录（曲线数据） ==========
  app.get('/admin/bands/api/records', adminOnly, requirePermission('data.bands.view'), asyncHandler(async (req, res) => {
    const mac = normalizeText(req.query.mac || '').toLowerCase();
    if (!/^[0-9a-f]{12}$/.test(mac)) return res.json({ ok: false, message: 'MAC 参数错误' });
    const hours = Math.min(Math.max(Number(req.query.hours || 6), 1), 72);
    const since = new Date(Date.now() + 8 * 3600 * 1000 - hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const rows = await dbQuery(
      `SELECT bp_time, heart_rate, body_temp, systolic, diastolic, spo2, steps, battery
       FROM band_records WHERE band_mac = ? AND bp_time >= ? ORDER BY id ASC`, [mac, since]);
    res.json({ ok: true, mac, hours, count: rows.length, records: rows });
  }));
};