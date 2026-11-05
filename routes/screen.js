/**
 * routes/screen.js — 全园/班级数据大屏（体测 + 手环健康动态）
 * v4 (2026-09-08)：平台浅色风；重点关注按展示班级过滤；生长趋势时间正序；
 *                  雷达图当前系列标注批次日期；新增最近上报滚动数据。
 */
const { asyncHandler, requireRole, requirePermission } = require('../lib/helpers');
const { dbQuery, getSettings } = require('../lib/db');
const { recentClassRecords } = require('../lib/band-recent');
const { createBandCache } = require('../lib/band-cache');
const cachedTotals = createBandCache(300000, 32);
const { buildFitnessSummaries, buildRadarChartData } = require('../lib/fitness-analytics');
const { buildDisplayMap } = require('../lib/name-masking');
const { SOUTH_GW_ZONES } = require('../lib/positioning');

// 南操场网关 → 展示分区名（顺序与 SOUTH_GW_ZONES 一致：西/中/东，避免两处硬编码漂移）
const HEATMAP_ZONE_LABEL = { '1区(西)': '西区', '2区(中)': '中区', '3区(东)': '东区' };
const HEATMAP_ZONES = Object.keys(SOUTH_GW_ZONES).map((gw) => ({
  gw: String(gw).toLowerCase(),
  zone: HEATMAP_ZONE_LABEL[SOUTH_GW_ZONES[gw]] || SOUTH_GW_ZONES[gw]
}));

let _sdCache = { at: 0, map: new Map() };
async function loadStudentDisplayMap() {
  if (_sdCache.map.size && Date.now() - _sdCache.at < 60000) return _sdCache.map;
  const rows = await dbQuery(`SELECT ch.name, c.name AS class_name FROM children ch LEFT JOIN classes c ON c.id = ch.class_id WHERE ch.enabled = 1`);
  _sdCache = { at: Date.now(), map: buildDisplayMap(rows) };
  return _sdCache.map;
}
function maskChildName(displayMap, className, name) {
  const nm = String(name == null ? '' : name).replace(/[\s\u00a0]/g, '');
  if (!nm) return name;
  const hit = displayMap.get(String(className || '') + '\u0001' + nm);
  return hit === undefined ? (nm.length > 1 ? nm.slice(0, -1) + '*' : nm) : hit;
}

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

// 心率区间定义（与前端 pill/系列颜色一一对应）：热身 / 燃脂增肌 / 有氧强化 / 极限
const HR_ZONES = [
  { key: 'warmup', label: '热身 <100', min: 0, max: 99 },
  { key: 'burn', label: '燃增 100-139', min: 100, max: 139 },
  { key: 'aerobic', label: '有氧强化 140-169', min: 140, max: 169 },
  { key: 'extreme', label: '极限 ≥170', min: 170, max: Infinity }
];

/**
 * 把 intensityAgg（桶×区间 的手环计数行）整理成 { zones, times, series }
 * 行形如 { t, hr, bands }，hr 是该桶内该手环的最高心率（用于判定所属区间）。
 */
function buildIntensityData(rows) {
  const times = [];
  const buckets = new Map(); // t -> { warmup: n, burn: n, ... }
  for (const r of rows || []) {
    const t = r.t || '';
    if (!t) continue;
    let bucket = buckets.get(t);
    if (!bucket) {
      bucket = { warmup: 0, burn: 0, aerobic: 0, extreme: 0 };
      buckets.set(t, bucket);
      times.push(t);
    }
    const hr = Number(r.hr);
    const zone = HR_ZONES.find((z) => hr >= z.min && hr <= z.max);
    if (zone) bucket[zone.key] += Number(r.bands) || 0;
  }
  const totals = HR_ZONES.reduce((acc, z) => {
    acc[z.key] = times.reduce((s, t) => s + (buckets.get(t)[z.key] || 0), 0);
    return acc;
  }, {});
  return {
    zones: HR_ZONES.map((z) => ({ key: z.key, label: z.label })),
    times,
    series: HR_ZONES.map((z) => ({ key: z.key, label: z.label, data: times.map((t) => buckets.get(t)[z.key] || 0) })),
    // 当前即时汇总（最新桶）
    latest: times.length ? Object.assign({ t: times[times.length - 1] }, buckets.get(times[times.length - 1])) : null,
    total: totals
  };
}

module.exports = function mountScreenRoutes(app) {
  // 旧路径 301 → 统一目录（2026-09-10，收藏/投屏链接不失效）
  app.get('/screen', (req, res) => res.redirect(301, '/admin/screen'));
  app.get('/screen/api/overview', (req, res) => res.redirect(301, '/admin/screen/api/overview'));

  // ========== 大屏页面 ==========
  app.get('/admin/screen', requireRole('admin'), requirePermission('data.bands.view'), asyncHandler(async (req, res) => {
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
  /**
   * 大屏聚合数据（2026-09-20 抽取复用）：
   *   scope/classId   体测数据范围（all=全园 / class=指定班）
   *   bandClassId     手环数据过滤（0=全部手环，>0=仅该班手环——教师端大屏用）
   * 返回 res.json 同构的数据对象。
   */
  // ========== 大屏 overview 结果缓存（2026-10-09 CPU 100% 事故修复）==========
  // 22万行/日聚合单次1~6秒 + 前端5s轮询多屏并发 → MySQL 打满。同参数请求5秒内共用一份结果。
  const _overviewCache = new Map();
  const OVERVIEW_CACHE_MS = 60000;
  async function buildScreenOverviewCached(scope, classId, rangeMode, bandClassId) {
    rangeMode = ['today', 'yesterday', 'week'].includes(String(rangeMode)) ? String(rangeMode) : 'today';
    const key = [scope, classId, rangeMode, bandClassId].join('|');
    const hit = _overviewCache.get(key);
    const now = Date.now();
    if (hit && now - hit.ts < OVERVIEW_CACHE_MS) return hit.data;
    // single-flight：同key正在计算时直接复用同一个Promise，杜绝N个页面同时各算一套打满MySQL
    if (hit && hit.p) return hit.p;
    const promise = buildScreenOverview(scope, classId, rangeMode, bandClassId)
      .then((data) => { _overviewCache.set(key, { ts: Date.now(), data }); return data; })
      .catch((err) => { _overviewCache.delete(key); throw err; });
    _overviewCache.set(key, { ts: now, p: promise });
    if (_overviewCache.size > 64) {
      const oldest = [..._overviewCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest && !oldest[1].p) _overviewCache.delete(oldest[0]);
    }
    return promise;
  }

  async function buildScreenOverview(scope, classId, rangeMode, bandClassId) {
    // 2026-10-09 改版：数据只看每天 09:00-11:00 运动窗（band-bridge 落库侧同步只留该窗口）
    // rangeMode: today(默认) / yesterday / week
    const mode = ['today', 'yesterday', 'week'].includes(String(rangeMode)) ? String(rangeMode) : 'today';
    // 曲线分桶：today/yesterday=2小时窗按5分钟桶(24点)，week=7天按每天一个桶
    let timeWindowSql, bucketSec, timeFmt;
    if (mode === 'week') {
      // 近一周：每天 09:00-11:00 的数据，按天分桶
      timeWindowSql = "r.bp_time >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) + INTERVAL 9 HOUR AND r.bp_time < CURDATE() + INTERVAL 11 HOUR AND TIME(r.bp_time) >= '09:00:00' AND TIME(r.bp_time) < '11:00:00'";
      bucketSec = 86400;
      timeFmt = "'%m-%d'";
    } else {
      // 今天 / 昨天：单日 09:00-11:00 两小时窗，5 分钟桶
      const dayExpr = mode === 'yesterday' ? 'DATE_SUB(CURDATE(), INTERVAL 1 DAY)' : 'CURDATE()';
      timeWindowSql = "r.bp_time >= " + dayExpr + " + INTERVAL 9 HOUR AND r.bp_time < " + dayExpr + " + INTERVAL 11 HOUR";
      bucketSec = 300;
      timeFmt = "'%H:%i'";
    }
    // Group calendar days directly: Unix-day buckets can split a local date.
    const bucketExpr = mode === 'week' ? 'DATE(r.bp_time)' : `FLOOR(UNIX_TIMESTAMP(r.bp_time) / ${bucketSec})`;
    const bucketLabel = mode === 'week' ? `DATE_FORMAT(r.bp_time, ${timeFmt})` : `DATE_FORMAT(FROM_UNIXTIME(${bucketSec} * ${bucketExpr}), ${timeFmt})`;
    // 手环卡片（bandOverview）取数窗口：today/yesterday=当日9-11点起，week=近7天每天9-11
    const ovWinStart = mode === 'week'
      ? 'DATE_SUB(CURDATE(), INTERVAL 6 DAY) + INTERVAL 9 HOUR'
      : (mode === 'yesterday' ? 'DATE_SUB(CURDATE(), INTERVAL 1 DAY) + INTERVAL 9 HOUR' : 'CURDATE() + INTERVAL 9 HOUR');
    const bandScopeSql = bandClassId
      ? 'AND r.band_mac IN (SELECT m2.band_mac FROM band_mapping m2 JOIN children ch2 ON ch2.id = m2.child_id WHERE ch2.class_id = ' + Number(bandClassId) + ')'
      : '';
    const [records, bandBuckets, intensityAgg, bandOverview, attentionAll, recentBands, totals, settings] = await Promise.all([
      loadScopedFitnessRecords(scope, classId),
      // 聚合曲线: 按区间分桶, 全部手环平均值
      dbQuery(
        `SELECT DATE_FORMAT(MIN(r.bp_time), ${timeFmt}) AS t,
                AVG(CASE WHEN r.heart_rate > 0 THEN r.heart_rate END) AS avg_hr,
                AVG(CASE WHEN r.spo2 > 0 THEN r.spo2 END) AS avg_spo2,
                AVG(CASE WHEN r.body_temp > 0 THEN r.body_temp END) AS avg_tp
           FROM band_records r
          WHERE ${timeWindowSql} AND NOT EXISTS (SELECT 1 FROM band_teacher_mapping t WHERE t.band_mac=r.band_mac)
            ${bandClassId ? 'AND r.band_mac IN (SELECT m2.band_mac FROM band_mapping m2 JOIN children ch2 ON ch2.id = m2.child_id WHERE ch2.class_id = ' + Number(bandClassId) + ')' : ''}
          GROUP BY ${bucketExpr}
          ORDER BY t ASC`),
      // 运动强度画像（2026-09-27）：同一分桶下按心率区间统计「手环数」（不是条数，避免高频上报的手环刷屏）
      dbQuery(
        `SELECT t, MAX(hr) AS hr, COUNT(DISTINCT band_mac) AS bands FROM (
            SELECT ${bucketLabel} AS t,
                   ${bucketExpr} AS bk,
                   r.band_mac,
                   MAX(r.heart_rate) AS hr
              FROM band_records r
             WHERE ${timeWindowSql} AND NOT EXISTS (SELECT 1 FROM band_teacher_mapping t WHERE t.band_mac=r.band_mac)
               AND r.heart_rate > 0
               ${bandScopeSql}
             GROUP BY bk, t, r.band_mac
          ) x
          GROUP BY t, bk, CASE
              WHEN hr >= 170 THEN 'extreme'
              WHEN hr >= 140 THEN 'aerobic'
              WHEN hr >= 100 THEN 'burn'
              ELSE 'warmup' END
          ORDER BY t ASC`),
      dbQuery(
        `SELECT r.band_mac, g.last_time, g.total_records,
                r.heart_rate, r.body_temp, r.systolic, r.diastolic,
                r.spo2, r.steps, r.battery, r.sos
           FROM (SELECT r.band_mac, MAX(r.id) AS max_id, MAX(r.bp_time) AS last_time, COUNT(*) AS total_records
                   FROM band_records r
                  WHERE ${timeWindowSql} AND NOT EXISTS (SELECT 1 FROM band_teacher_mapping t WHERE t.band_mac=r.band_mac) ${bandScopeSql}
                  GROUP BY r.band_mac) g
           JOIN band_records r ON r.id = g.max_id
          ORDER BY g.last_time DESC`),
      // 重点关注管理（预约管理 - 重点关注管理的人）
      dbQuery(
        `SELECT ch.id, ch.name, ch.class_id, c.name AS class_name,
                ch.attention_reason, ch.attention_tags, ch.attention_vest_type,
                ch.attention_start_date, ch.attention_end_date
           FROM children ch
           LEFT JOIN classes c ON c.id = ch.class_id
          WHERE ch.enabled = 1 AND ch.needs_attention = 1
            ${bandClassId ? 'AND ch.class_id = ' + Number(bandClassId) : ''}
          ORDER BY c.name, ch.name`),
      // 最近上报（滚动列表）
      bandClassId
        ? recentClassRecords(Number(bandClassId), 10, timeWindowSql)
        : dbQuery(`
          SELECT r.id, r.band_mac, r.bp_time, r.heart_rate, r.body_temp, r.spo2, r.systolic, r.diastolic, r.sos,
                  m.child_id, ch.name AS child_name
             FROM band_records r
             LEFT JOIN band_mapping m ON m.band_mac = r.band_mac
             LEFT JOIN children ch ON ch.id = m.child_id
            WHERE ${timeWindowSql} AND NOT EXISTS (SELECT 1 FROM band_teacher_mapping t WHERE t.band_mac=r.band_mac)
            ORDER BY r.bp_time DESC
            LIMIT 10`),
      cachedTotals(String(bandClassId || 0), () => bandClassId ? dbQuery(`SELECT
        (SELECT COUNT(*) FROM children WHERE enabled = 1 AND class_id = ?) AS children,
        (SELECT COUNT(*) FROM fitness_records fr JOIN children ch ON ch.id = fr.child_id WHERE ch.class_id = ?) AS fitnessRecords,
        COUNT(*) AS bandRecords, COALESCE(SUM(b.sos = 1), 0) AS sosCount
        FROM band_records b JOIN band_mapping m ON m.band_mac = b.band_mac
        JOIN children ch ON ch.id = m.child_id WHERE ch.class_id = ?`, [bandClassId, bandClassId, bandClassId]) : dbQuery(`SELECT
        (SELECT COUNT(*) FROM children WHERE enabled = 1) AS children,
        (SELECT COUNT(*) FROM fitness_records) AS fitnessRecords,
        COUNT(*) AS bandRecords, COALESCE(SUM(sos = 1), 0) AS sosCount FROM band_records b WHERE NOT EXISTS (SELECT 1 FROM band_teacher_mapping t WHERE t.band_mac=b.band_mac)`)),
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
    // 2026-10-09：数据只录 9-11 点运动窗，实时在线判定仅在当前处于窗口内才有意义；
    // 窗口外（11点后/昨天/周视图）一律显示离线，避免「永远离线」误解。
    const nowTs = Date.now();
    const bjNow = new Date(nowTs + 8 * 3600 * 1000);
    const bjMin = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes();
    const inSportWindow = bjMin >= 9 * 60 && bjMin < 11 * 60;
    const bands = bandOverview.map((r) => {
      const raw = r.last_time instanceof Date
        ? r.last_time.getTime()
        : (r.last_time ? new Date(String(r.last_time).replace(' ', 'T')).getTime() : 0);
      const lastTime = Number.isFinite(raw) ? raw : 0;
      // 服务器/MySQL 均为北京时间(CST)，last_time 解析即本地时间，直接用 UNIX 差值
      const online = mode === 'today' && inSportWindow && lastTime ? (nowTs - lastTime) < 6 * 60 * 1000 : false;
      return {
        ...r,
        last_time: fmtDateTime(r.last_time),
        online,
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
      sampleCount: Math.max(hrVals.length, spVals.length, tpVals.length),
      sampleCounts: { hr: hrVals.length, sp: spVals.length, tp: tpVals.length, bp: Math.min(sysVals.length, diaVals.length) }
    };

    const mappingRows = await dbQuery(
      `SELECT m.band_mac, m.child_id, ch.name AS child_name, c.name AS class_name, c.id AS class_id
         FROM band_mapping m
         LEFT JOIN children ch ON ch.id = m.child_id
         LEFT JOIN classes c ON c.id = ch.class_id
        WHERE NOT EXISTS (SELECT 1 FROM band_teacher_mapping t WHERE t.band_mac=m.band_mac) ${bandClassId ? 'AND ch.class_id = ?' : ''}`, bandClassId ? [bandClassId] : []);
  { const dm = await loadStudentDisplayMap(); for (const _r of (Array.isArray(mappingRows) ? mappingRows : [])) {
      if (_r.name && !_r.display_name) _r.display_name = maskChildName(dm, _r.class_name, _r.name);
      if (_r.child_name && !_r.child_display) _r.child_display = maskChildName(dm, _r.class_name, _r.child_name);
      // API 出口直接脱敏原字段（前端已改用 display 字段，这里兜底所有出口）
      if (_r.name) _r.name = _r.display_name || _r.name;
      if (_r.child_name) _r.child_name = _r.child_display || _r.child_name;
  } }
    const infoByMac = new Map(mappingRows.map((m) => [String(m.band_mac).toLowerCase(), m]));
    // A watch without a report remains visible as "no report", never as a zero reading.
    const detailByMac = new Map(bands.map((b) => [String(b.band_mac).toLowerCase(), b]));
    for (const m of mappingRows) {
      const mac = String(m.band_mac).toLowerCase();
      if (!detailByMac.has(mac)) detailByMac.set(mac, { band_mac: mac });
    }
    const bandDetails = [...detailByMac.values()].map((b) => {
      const m = infoByMac.get(String(b.band_mac).toLowerCase()) || {};
      const value = (key) => b[key] == null ? null : Number(b[key]);
      return {
        band_mac: String(b.band_mac).toLowerCase(),
        child_name: m.child_name || '', class_name: m.class_name || '', class_id: Number(m.class_id) || 0,
        hr: value('heart_rate'), sp: value('spo2'), tp: value('body_temp'),
        systolic: value('systolic'), diastolic: value('diastolic'), steps: value('steps'),
        last_time: b.last_time || '', online: !!b.online, has_record: !!b.last_time,
        included: { hr: inRange(b.heart_rate, 30, 250), sp: inRange(b.spo2, 50, 100),
          tp: inRange(b.body_temp, 35, 40), bp: inRange(b.systolic, 40, 250) && inRange(b.diastolic, 25, 160),
          steps: Number.isFinite(Number(b.steps)) && Number(b.steps) > 0 }
      };
    });
    const mappedMacs = new Set(mappingRows.map((m) => String(m.band_mac).toLowerCase()));
    const stepVals = bands.map((b) => Number(b.steps)).filter((v) => Number.isFinite(v) && v > 0);
    const bandSummary = {
      total: bands.length,
      online: bands.filter((b) => b.online).length,
      offline: bands.filter((b) => !b.online).length,
      mappedMacs: mappedMacs.size,
      childrenOnlineBounded: bands.filter((b) => b.online && mappedMacs.has(String(b.band_mac).toLowerCase())).length,
      sos: bands.filter((b) => Number(b.sos) > 0).length,
      stepBands: stepVals.length,
      totalSteps: stepVals.length ? stepVals.reduce((a, b) => a + b, 0) : null,
      avgSteps: stepVals.length ? Math.round(stepVals.reduce((a, b) => a + b, 0) / stepVals.length) : null
    };

    // ---------- 手环：聚合健康 ----------
    // 大屏「重点预警事件」改读持久化事件表 band_alerts（2026-09-16 杰哥要求: 记录不消失）
    // 显示: 今日全部事件（含已恢复），active 在前按最后触发时间倒序
    const alertRows = await dbQuery(
      `SELECT a.id, a.band_mac, a.kind, a.child_name, a.class_name, a.peak_value,
              a.first_time, a.last_time, a.trigger_count, a.status, a.resolved_at,
              TIMESTAMPDIFF(SECOND, a.first_time, a.last_time) AS dur_sec,
              TIMESTAMPDIFF(SECOND, a.first_time, NOW()) AS dur_now_sec
         FROM band_alerts a
        WHERE NOT EXISTS (SELECT 1 FROM band_teacher_mapping t WHERE t.band_mac=a.band_mac) AND a.last_time >= ${mode === 'week' ? 'DATE_SUB(CURDATE(), INTERVAL 6 DAY)' : (mode === 'yesterday' ? 'DATE_SUB(CURDATE(), INTERVAL 1 DAY)' : 'CURDATE()')}
          AND a.last_time < ${mode === 'yesterday' ? 'CURDATE()' : 'CURDATE() + INTERVAL 1 DAY'}
          ${bandClassId ? 'AND a.class_name = (SELECT name FROM classes WHERE id = ' + Number(bandClassId) + ')' : ''}
        ORDER BY (a.status = 'active') DESC, a.last_time DESC
        `, []
    );
  { const dm = await loadStudentDisplayMap(); for (const _r of (Array.isArray(alertRows) ? alertRows : [])) {
      if (_r.child_name && !_r.child_display) _r.child_display = maskChildName(dm, _r.class_name, _r.child_name);
      if (_r.child_name) _r.child_name = _r.child_display;
  } }
    const bandAlerts = alertRows.map((a) => ({
      id: a.id,
      band_mac: a.band_mac,
      kind: a.kind,
      child_name: a.child_name || '',
      class_name: a.class_name || '',
      heart_rate: a.peak_value != null ? Number(a.peak_value) : null,
      first_time: fmtDateTime(a.first_time),
      last_time: fmtDateTime(a.last_time),
      dur_sec: Number(a.dur_sec) || 0,
      dur_now_sec: Number(a.dur_now_sec) || 0,
      trigger_count: Number(a.trigger_count) || 1,
      status: a.status,
      resolved_at: a.resolved_at ? fmtDateTime(a.resolved_at) : null
    }));

    { const dm = await loadStudentDisplayMap(); for (const _r of (recentBands || [])) { if (_r.child_name) _r.child_display = maskChildName(dm, _r.class_name, _r.child_name); } }
    const recentBandsList = (recentBands || []).map((r) => ({
      band_mac: r.band_mac,
      t: fmtDateTime(r.bp_time),
      hr: Number(r.heart_rate) || null,
      tp: Number(r.body_temp) || null,
      sp: Number(r.spo2) || null,
      bp: (Number(r.systolic) > 0 && Number(r.diastolic) > 0) ? `${r.systolic}/${r.diastolic}` : null,
      sos: Number(r.sos) || 0,
      child_name: r.child_display || r.child_name || ''
    }));

    // ---------- 重点关注（按展示班级过滤，避免超屏） ----------
    const VEST = { green: { label: '绿背心', color: '#16a34a' }, yellow: { label: '黄背心', color: '#d97706' }, red: { label: '红背心', color: '#dc2626' } };
    { const dm = await loadStudentDisplayMap(); for (const _r of (attentionAll || [])) { if (_r.name) _r.display_name = maskChildName(dm, _r.class_name, _r.name); } }
    const attentionAllList = (attentionAll || []).map((r) => ({
      id: r.id,
      name: r.display_name || r.name,
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

    return {
      ok: true,
      scope,
      rangeMode: mode,
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
      bandDetails,
      bandAlerts,
      recentBands: recentBandsList,
      curveData: (bandBuckets || []).map((r) => ({
        t: r.t || '',
        avgHr: r.avg_hr != null ? Number(r.avg_hr).toFixed(0) : null,
        avgSpo2: r.avg_spo2 != null ? Number(r.avg_spo2).toFixed(0) : null,
        avgTp: r.avg_tp != null ? Number(r.avg_tp).toFixed(1) : null
      })),
      // 运动强度实时画像：4 区间手环数堆叠（前端堆叠面积图）
      // 注意不能按桶内行数算——同一手环一分钟可能上报多条，会把「人数」放大成「条数」
      intensityData: buildIntensityData(intensityAgg),
      attentionChildren,
      attentionTotal,
      totals: Array.isArray(totals) ? (totals[0] || {}) : totals
    };
  }

  // 管理端路由（2026-10-09 改版：rangeMode=today/yesterday/week，数据窗口=每天09:00-11:00）
  app.get('/admin/screen/api/overview', requireRole('admin'), requirePermission('data.bands.view'), asyncHandler(async (req, res) => {
    const scope = req.query.scope === 'class' ? 'class' : 'all';
    const classId = scope === 'class' ? (Number(req.query.classId) || 0) : 0;
    const data = await buildScreenOverviewCached(scope, classId, req.query.rangeMode, classId);
    res.json(Object.assign({ ok: true }, data));
  }));

  const cachedAlerts = createBandCache(30000, 128);
  async function buildScreenAlerts(classId, query) {
    const mode = ['today', 'yesterday', 'week', 'all'].includes(String(query.rangeMode)) ? String(query.rangeMode) : 'today';
    const mac = String(query.bandMac || '').toLowerCase();
    if (mac && !/^[0-9a-f]{12}$/.test(mac)) return { ok: false, error: '手表编号格式错误' };
    const metric = query.metric === 'hr' ? 'hr' : 'all';
    const status = ['active', 'resolved'].includes(query.status) ? query.status : 'all';
    const page = Math.min(100000, Math.max(1, Math.floor(Number(query.page) || 1)));
    return cachedAlerts([classId, mode, mac, metric, status, page].join('|'), async () => {
      const where = ['NOT EXISTS (SELECT 1 FROM band_teacher_mapping t WHERE t.band_mac=a.band_mac)'], params = [];
      if (classId) { where.push('a.class_name = (SELECT name FROM classes WHERE id = ?)'); params.push(classId); }
      if (mode !== 'all') {
        where.push(`a.last_time >= ${mode === 'week' ? 'DATE_SUB(CURDATE(), INTERVAL 6 DAY)' : mode === 'yesterday' ? 'DATE_SUB(CURDATE(), INTERVAL 1 DAY)' : 'CURDATE()'}`);
        where.push(`a.last_time < ${mode === 'yesterday' ? 'CURDATE()' : 'CURDATE() + INTERVAL 1 DAY'}`);
      }
      if (mac) { where.push('a.band_mac = ?'); params.push(mac); }
      if (metric === 'hr') where.push("a.kind IN ('hr_high', 'hr_low')");
      if (status !== 'all') { where.push('a.status = ?'); params.push(status); }
      const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const counts = await dbQuery(`SELECT COUNT(*) AS total, COALESCE(SUM(a.status = 'active'), 0) AS active FROM band_alerts a ${clause}`, params);
      const total = Number(counts[0].total) || 0;
      const actualPage = Math.min(page, Math.max(1, Math.ceil(total / 50)));
      const rows = await dbQuery(`SELECT a.id, a.band_mac, a.kind, a.child_name, a.class_name, a.peak_value,
        a.first_time, a.last_time, a.status, a.trigger_count, a.resolved_at
        FROM band_alerts a ${clause} ORDER BY (a.status = 'active') DESC, a.last_time DESC, a.id DESC
        LIMIT 50 OFFSET ${50 * (actualPage - 1)}`, params);
      const dm = await loadStudentDisplayMap();
      return { ok: true, total, active: Number(counts[0].active) || 0, page: actualPage, pageSize: 50, rangeMode: mode,
        alerts: rows.map(a => ({ ...a, child_name: maskChildName(dm, a.class_name, a.child_name) || '',
          peak_value: a.peak_value == null ? null : Number(a.peak_value), first_time: fmtDateTime(a.first_time),
          last_time: fmtDateTime(a.last_time), resolved_at: a.resolved_at ? fmtDateTime(a.resolved_at) : '' })) };
    });
  }
  app.get('/admin/screen/api/alerts', requireRole('admin'), requirePermission('data.bands.view'), asyncHandler(async (req, res) => {
    const classId = req.query.scope === 'class' ? Math.max(0, Math.floor(Number(req.query.classId) || 0)) : 0;
    if (req.query.scope === 'class' && !classId) return res.status(400).json({ ok: false, error: '请选择班级' });
    const data = await buildScreenAlerts(classId, req.query);
    res.status(data.ok ? 200 : 400).json(data);
  }));

  // ========== 南操场实时热力图（30s 轮询） ==========
  /**
   * 近 3 分钟 band_records 按南操场网关分组 → 三分区实时人数 / 平均 RSSI / 在场幼儿（脱敏）
   * 人数口径：DISTINCT band_mac（一台手环算一人），0 人分区前端显示「无人活动」。
   */
  app.get('/admin/screen/api/heatmap', requireLogin, asyncHandler(async (req, res) => {
    const gws = HEATMAP_ZONES.map((z) => z.gw);
    const placeholders = gws.map(() => '?').join(',');
    // 每网关每手环一行：平均 RSSI 滤单条噪声（与 lib/positioning 的桶聚合同思路）
    const rows = await dbQuery(
      `SELECT LOWER(r.gw_addr) AS gw,
              r.band_mac,
              AVG(r.rssi) AS avg_rssi,
              MAX(r.bp_time) AS last_time
         FROM band_records r
        WHERE NOT EXISTS (SELECT 1 FROM band_teacher_mapping t WHERE t.band_mac=r.band_mac) AND r.bp_time >= DATE_SUB(NOW(), INTERVAL 3 MINUTE)
          AND r.rssi IS NOT NULL
          AND LOWER(r.gw_addr) IN (${placeholders})
        GROUP BY LOWER(r.gw_addr), r.band_mac
        ORDER BY avg_rssi DESC`,
      gws);

    // 手环 → 幼儿（姓名/班级），出口前统一脱敏
    const macs = [...new Set((rows || []).map((r) => String(r.band_mac).toLowerCase()))];
    const mappingByMac = new Map();
    if (macs.length) {
      const mappingRows = await dbQuery(
        `SELECT LOWER(m.band_mac) AS band_mac, ch.name AS child_name, c.name AS class_name
           FROM band_mapping m
           JOIN children ch ON ch.id = m.child_id
           LEFT JOIN classes c ON c.id = ch.class_id
          WHERE LOWER(m.band_mac) IN (${macs.map(() => '?').join(',')})`,
        macs);
      const dm = await loadStudentDisplayMap();
      for (const m of mappingRows || []) {
        mappingByMac.set(String(m.band_mac).toLowerCase(), {
          name: maskChildName(dm, m.class_name, m.child_name),
          class_name: m.class_name || ''
        });
      }
    }

    const byGw = new Map();
    for (const r of rows || []) {
      const gw = String(r.gw).toLowerCase();
      if (!byGw.has(gw)) byGw.set(gw, []);
      byGw.get(gw).push(r);
    }

    const round1 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(1)));
    const zones = HEATMAP_ZONES.map((z) => {
      const list = byGw.get(z.gw) || [];
      const rssis = list.map((r) => round1(r.avg_rssi)).filter((v) => v != null);
      const bands = list.slice(0, 8).map((r) => {
        const info = mappingByMac.get(String(r.band_mac).toLowerCase());
        return info ? info.name : '';
      }).filter(Boolean);
      return {
        zone: z.zone,
        gw: z.gw,
        count: list.length,
        avgRssi: rssis.length ? round1(rssis.reduce((s, v) => s + v, 0) / rssis.length) : null,
        bands
      };
    });

    res.json({ ok: true, zones, updatedAt: fmtDateTime(new Date()) });
  }));

  return { buildScreenOverview, buildScreenOverviewCached, buildIntensityData, buildScreenAlerts };
};
