/**
 * routes/screen.js — 全园/班级数据大屏（体测 + 手环健康动态）
 * v4 (2026-09-08)：平台浅色风；重点关注按展示班级过滤；生长趋势时间正序；
 *                  雷达图当前系列标注批次日期；新增最近上报滚动数据。
 */
const { asyncHandler } = require('../lib/helpers');
const { dbQuery, getSettings } = require('../lib/db');
const { buildFitnessSummaries, buildRadarChartData } = require('../lib/fitness-analytics');

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login');
}

function dateOnly(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fmtDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function mean(items, key) {
  const vs = items.map((i) => i[key]).filter((v) => v != null && v !== '');
  if (!vs.length) return null;
  return Number((vs.reduce((s, v) => s + Number(v), 0) / vs.length).toFixed(1));
}

async function loadScopedFitnessRecords(scope, classId) {
  if (scope === 'class') {
    return dbQuery(
      `SELECT fr.*, ch.name AS child_name, ch.gender, c.name AS class_name, c.grade_level
         FROM fitness_records fr
         JOIN children ch ON ch.id = fr.child_id
         LEFT JOIN classes c ON c.id = ch.class_id
        WHERE ch.class_id = ?
        ORDER BY fr.test_date ASC, fr.id ASC`,
      [classId]);
  }
  return dbQuery(
    `SELECT fr.*, ch.name AS child_name, ch.gender, c.name AS class_name, c.grade_level
       FROM fitness_records fr
       JOIN children ch ON ch.id = fr.child_id
       LEFT JOIN classes c ON c.id = ch.class_id
      ORDER BY fr.test_date ASC, fr.id ASC`);
}

function latestBatchRecords(items) {
  const list = Array.isArray(items) ? items : [];
  const latestDay = list.length ? dateOnly(list[list.length - 1].test_date) : '';
  return latestDay ? { day: latestDay, records: list.filter((item) => dateOnly(item.test_date) === latestDay) } : { day: '', records: [] };
}

function prevBatchRecords(items, latestDay) {
  const list = Array.isArray(items) ? items : [];
  const days = [];
  for (const item of list) {
    const day = dateOnly(item.test_date);
    if (day && day !== latestDay && !days.includes(day)) days.push(day);
  }
  if (!days.length) return { day: '', records: [] };
  days.sort((a, b) => (a < b ? 1 : -1));
  const day = days[0];
  return { day, records: list.filter((item) => dateOnly(item.test_date) === day) };
}

module.exports = function mountScreenRoutes(app) {
  // ========== 大屏页面 ==========
  app.get('/screen', requireLogin, asyncHandler(async (req, res) => {
    const [classes, settings] = await Promise.all([
      dbQuery(
        `SELECT id, name, grade_level
           FROM classes
          ORDER BY CASE grade_level WHEN 'small' THEN 1 WHEN 'middle' THEN 2 WHEN 'large' THEN 3 ELSE 99 END, id ASC`),
      getSettings()
    ]);
    let displayClassIds = [];
    try { displayClassIds = JSON.parse(settings.bandEnabledClasses || '[]'); } catch (e) { displayClassIds = []; }
    if (!Array.isArray(displayClassIds)) displayClassIds = [];
    const displayClasses = (classes || []).filter((c) => displayClassIds.map(Number).includes(Number(c.id)));

    res.render('screen', {
      classes,
      displayClasses,
      currentUser: req.session.user,
      today: dateOnly(new Date())
    });
  }));

  // ========== 聚合数据 API（前端 30s 轮询） ==========
  app.get('/screen/api/overview', requireLogin, asyncHandler(async (req, res) => {
    const scope = req.query.scope === 'class' ? 'class' : 'all';
    const classId = scope === 'class' ? (Number(req.query.classId) || 0) : 0;
    const [records, bandBuckets, bandOverview, attentionAll, recentBands, totals, settings] = await Promise.all([
      loadScopedFitnessRecords(scope, classId),
      // 聚合曲线：最近 120 分钟按 5 分钟分桶，全部手环平均值
      dbQuery(
        `SELECT DATE_FORMAT(MIN(r.bp_time), '%H:%i') AS t,
                AVG(CASE WHEN r.heart_rate > 0 THEN r.heart_rate END) AS avg_hr,
                AVG(CASE WHEN r.spo2 > 0 THEN r.spo2 END) AS avg_spo2,
                AVG(CASE WHEN r.body_temp > 0 THEN r.body_temp END) AS avg_tp
           FROM band_records r
          WHERE r.bp_time >= DATE_SUB(NOW(), INTERVAL 120 MINUTE)
          GROUP BY FLOOR(UNIX_TIMESTAMP(r.bp_time) / 300)
          ORDER BY t ASC`),
      dbQuery(
        `SELECT b.band_mac,
                MAX(b.bp_time) AS last_time,
                COUNT(*) AS total_records,
                (SELECT heart_rate FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS heart_rate,
                (SELECT body_temp  FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS body_temp,
                (SELECT systolic   FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS systolic,
                (SELECT diastolic  FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS diastolic,
                (SELECT spo2       FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS spo2,
                (SELECT steps      FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS steps,
                (SELECT battery    FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS battery,
                (SELECT sos        FROM band_records b2 WHERE b2.band_mac = b.band_mac ORDER BY b2.id DESC LIMIT 1) AS sos
           FROM band_records b
          GROUP BY b.band_mac
          ORDER BY last_time DESC`),
      // 重点关注管理（预约管理 - 重点关注管理的人）
      dbQuery(
        `SELECT ch.id, ch.name, ch.class_id, c.name AS class_name,
                ch.attention_reason, ch.attention_tags, ch.attention_vest_type,
                ch.attention_start_date, ch.attention_end_date
           FROM children ch
           LEFT JOIN classes c ON c.id = ch.class_id
          WHERE ch.enabled = 1 AND ch.needs_attention = 1
          ORDER BY c.name, ch.name`),
      // 最近上报（滚动列表）
      dbQuery(
        `SELECT r.id, r.band_mac, r.bp_time, r.heart_rate, r.body_temp, r.spo2, r.systolic, r.diastolic, r.sos,
                m.child_id, ch.name AS child_name
           FROM band_records r
           LEFT JOIN band_mapping m ON m.band_mac = r.band_mac
           LEFT JOIN children ch ON ch.id = m.child_id
          ORDER BY r.id DESC
          LIMIT 10`),
      dbQuery(`SELECT
        (SELECT COUNT(*) FROM children WHERE enabled = 1) AS children,
        (SELECT COUNT(*) FROM fitness_records) AS fitnessRecords,
        (SELECT COUNT(*) FROM band_records) AS bandRecords,
        (SELECT COUNT(*) FROM band_records WHERE sos = 1) AS sosCount`),
      getSettings()
    ]);

    // ---------- 展示班级（实时匹配手环页配置） ----------
    let displayClassIds = [];
    try { displayClassIds = JSON.parse(settings.bandEnabledClasses || '[]'); } catch (e) { displayClassIds = []; }
    if (!Array.isArray(displayClassIds)) displayClassIds = [];
    const displayClassIdsNum = displayClassIds.map(Number);
    const allClasses = await dbQuery('SELECT id, name FROM classes');
    const displayClasses = allClasses
      .filter((c) => displayClassIdsNum.includes(Number(c.id)))
      .map((c) => ({ id: Number(c.id), name: c.name }));

    // ---------- 体测 ----------
    const latest = latestBatchRecords(records);
    const prev = prevBatchRecords(records, latest.day);
    const latestSummary = latest.records.length ? buildFitnessSummaries(latest.records) : null;
    const prevSummary = prev.records.length ? buildFitnessSummaries(prev.records) : null;

    let className = '';
    if (scope === 'class') {
      const cls = await dbQuery('SELECT name FROM classes WHERE id = ? LIMIT 1', [classId]);
      className = cls.length ? cls[0].name : '';
    }

    const radarComparisonSeries = prevSummary
      ? [{ key: 'prev-batch', label: prev.day || '上一批次', color: '#7c3aed', dasharray: '5 4', strokeWidth: 2.4, metricHealthSummary: prevSummary.metricHealthSummary }]
      : [];

    const radarChartData = buildRadarChartData(
      latestSummary ? latestSummary.metricHealthSummary : [],
      {
        currentLabel: latest.day ? `${latest.day.slice(5)}·${scope === 'class' ? (className || '本班') : '全园'}` : (scope === 'class' ? (className || '本班') : '全园'),
        currentColor: '#4f46e5',
        currentFillColor: 'rgba(99, 102, 241, 0.14)',
        comparisonSeries: radarComparisonSeries
      }
    );

    // 生长趋势：时间正序（先上一批，再最新批）
    const growthTrend = [];
    if (prev.day) {
      growthTrend.push({
        label: prev.day.slice(5),
        full: prev.day,
        height: mean(prev.records, 'height_cm'),
        weight: mean(prev.records, 'weight_kg'),
        bmi: mean(prev.records, 'bmi')
      });
    }
    if (latest.day) {
      growthTrend.push({
        label: latest.day.slice(5),
        full: latest.day,
        height: mean(latest.records, 'height_cm'),
        weight: mean(latest.records, 'weight_kg'),
        bmi: mean(latest.records, 'bmi')
      });
    }

    // ---------- 手环：聚合健康 ----------
    const nowTs = Date.now();
    const bands = bandOverview.map((r) => {
      const raw = r.last_time instanceof Date
        ? r.last_time.getTime()
        : (r.last_time ? new Date(String(r.last_time).replace(' ', 'T')).getTime() : 0);
      const lastTime = Number.isFinite(raw) ? raw : 0;
      return {
        ...r,
        last_time: fmtDateTime(r.last_time),
        online: lastTime ? (nowTs - lastTime) < 6 * 60 * 1000 : false,
        minutes_ago: lastTime ? Math.max(0, Math.round((nowTs - lastTime) / 60000)) : null
      };
    });

    const inRange = (v, min, max) => Number(v) > min && Number(v) < max;
    const hrVals = bands.map((b) => Number(b.heart_rate)).filter((v) => inRange(v, 30, 250));
    const spVals = bands.map((b) => Number(b.spo2)).filter((v) => inRange(v, 50, 100));
    const tpVals = bands.map((b) => Number(b.body_temp)).filter((v) => inRange(v, 35, 40));
    const sysVals = bands.map((b) => Number(b.systolic)).filter((v) => inRange(v, 40, 250));
    const diaVals = bands.map((b) => Number(b.diastolic)).filter((v) => inRange(v, 25, 160));
    const avgOf = (arr) => arr.length ? Number((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1)) : null;
    const avgHealth = {
      avgHr: avgOf(hrVals),
      avgSpo2: avgOf(spVals),
      avgTp: avgOf(tpVals),
      avgBp: (sysVals.length && diaVals.length) ? `${avgOf(sysVals)}/${avgOf(diaVals)}` : null,
      sampleCount: Math.max(hrVals.length, spVals.length, tpVals.length)
    };

    const mappingRows = await dbQuery('SELECT band_mac, child_id FROM band_mapping');
    const mappedMacs = new Set(mappingRows.map((m) => String(m.band_mac).toLowerCase()));
    const bandSummary = {
      total: bands.length,
      online: bands.filter((b) => b.online).length,
      offline: bands.filter((b) => !b.online).length,
      mappedMacs: mappedMacs.size,
      childrenOnlineBounded: bands.filter((b) => b.online && mappedMacs.has(String(b.band_mac).toLowerCase())).length,
      sos: bands.filter((b) => Number(b.sos) > 0).length
    };

    const HR_HIGH = 140, HR_LOW = 60;
    const bandAlerts = [];
    for (const b of bands) {
      const hr = Number(b.heart_rate);
      if (inRange(hr, 30, 250) && (hr > HR_HIGH || hr < HR_LOW)) {
        bandAlerts.push({
          band_mac: b.band_mac,
          heart_rate: hr,
          kind: hr > HR_HIGH ? 'high' : 'low',
          last_time: b.last_time,
          sos: 0
        });
      }
      if (Number(b.sos) > 0) {
        bandAlerts.push({ band_mac: b.band_mac, heart_rate: hr || null, kind: 'sos', last_time: b.last_time, sos: 1 });
      }
    }

    const recentBandsList = (recentBands || []).map((r) => ({
      band_mac: r.band_mac,
      t: fmtDateTime(r.bp_time),
      hr: Number(r.heart_rate) || null,
      tp: Number(r.body_temp) || null,
      sp: Number(r.spo2) || null,
      bp: (Number(r.systolic) > 0 && Number(r.diastolic) > 0) ? `${r.systolic}/${r.diastolic}` : null,
      sos: Number(r.sos) || 0,
      child_name: r.child_name || ''
    }));

    // ---------- 重点关注（按展示班级过滤，避免超屏） ----------
    const VEST = { green: { label: '绿背心', color: '#16a34a' }, yellow: { label: '黄背心', color: '#d97706' }, red: { label: '红背心', color: '#dc2626' } };
    const attentionAllList = (attentionAll || []).map((r) => ({
      id: r.id,
      name: r.name,
      class_id: Number(r.class_id) || 0,
      class_name: r.class_name || '',
      reason: r.attention_reason || '',
      tags: r.attention_tags || '',
      vest: VEST[r.attention_vest_type] || null
    }));
    // 体测结果导向的标记（体测不合格/体能不达标/运动能力弱）不放健康关注屏，只留真正健康风险类
    const attnExcludeRe = /体测|体侧|体能|运动能力|不达标/;
    const attnScopeList = attentionAllList.filter((r) => !displayClassIdsNum.length || displayClassIdsNum.includes(r.class_id));
    const attnFiltered = attnScopeList.filter((r) => !attnExcludeRe.test(r.reason || '') && !attnExcludeRe.test(r.tags || ''));
    const attentionChildren = attnFiltered.slice(0, 8);
    const attentionTotal = attnFiltered.length;

    res.json({
      ok: true,
      scope,
      scopeLabel: scope === 'class' ? (className || '本班') : '全园',
      updatedAt: fmtDateTime(new Date()),
      displayClasses,
      latestBatch: { day: latest.day, count: latest.records.length },
      prevBatch: { day: prev.day, count: prev.records.length },
      avgScore: latestSummary ? Number(latestSummary.avgScore || 0) : null,
      prevAvgScore: prevSummary ? Number(prevSummary.avgScore || 0) : null,
      ratingSummary: latestSummary ? latestSummary.ratingSummary : [],
      radarChartData,
      growthTrend,
      avgHealth,
      bandSummary,
      bandAlerts,
      recentBands: recentBandsList,
      curveData: (bandBuckets || []).map((r) => ({
        t: r.t || '',
        avgHr: r.avg_hr != null ? Number(r.avg_hr).toFixed(0) : null,
        avgSpo2: r.avg_spo2 != null ? Number(r.avg_spo2).toFixed(0) : null,
        avgTp: r.avg_tp != null ? Number(r.avg_tp).toFixed(1) : null
      })),
      attentionChildren,
      attentionTotal,
      totals: Array.isArray(totals) ? (totals[0] || {}) : totals
    });
  }));
};