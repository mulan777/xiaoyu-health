/**
 * routes/class-api.js — 班级只读查询 API（2026-10-05）
 *
 * 供班级侧系统调用，查询「本班」孩子的数据。设计红线：
 *   - 全部 GET-only（避开 CSRF 中间件；POST 会被 CSRF 拦截）
 *   - 鉴权：请求头 X-API-Key，比对 class_api_keys.key_hash(sha256)
 *   - 绝不信任请求里的 class_id —— scope 一律由 key 绑定行派生
 *   - 姓名一律脱敏（复用 lib/name-masking.js buildDisplayMap），绝不回全名
 *   - 绝不输出 guardian_phone / guardian_name / notes / attention_* 等隐私字段
 *   - 所有 SQL 强制 WHERE ch.class_id = ?；手环历史走 idx_band_time(band_mac,bp_time) 区间
 *   - per-key 限流 + 审计表 class_api_logs
 *
 * 挂载：server.js 中 const mountClassApiRoutes = require('./routes/class-api');
 *       mountClassApiRoutes(app);
 */
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { asyncHandler, normalizeText } = require('../lib/helpers');
const { dbQuery } = require('../lib/db');
const { buildDisplayMap } = require('../lib/name-masking');

// 心率区间（与 routes/screen.js 保持一致口径：热身/燃增/有氧强化/极限）
const HR_ZONES = [
  { key: 'warmup', label: '热身 <100', min: 0, max: 99 },
  { key: 'burn', label: '燃增 100-139', min: 100, max: 139 },
  { key: 'aerobic', label: '有氧强化 140-169', min: 140, max: 169 },
  { key: 'extreme', label: '极限 ≥170', min: 170, max: Infinity }
];

const OK = (res, data) => res.json({ code: 0, data });
const FAIL = (res, status, msg) => res.status(status).json({ code: 1, msg });

function pad2(n) { return String(n).padStart(2, '0'); }

// 以服务器本地时区（Asia/Shanghai）产出 YYYY-MM-DD / YYYY-MM-DD HH:MM:SS
function localDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function localDateTime(d) {
  return localDate(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function todayStr() { return localDate(new Date()); }

// 严格校验 YYYY-MM-DD（且必须是真实日期，如 2026-02-31 拒绝）
function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(String(s) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return false;
  return localDate(d) === String(s);
}
// 返回 { ok, value } —— 空值给出 def（可为 ''，表示「不限」），非法返回 ok:false
function pickDate(raw, def) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: true, value: def == null ? todayStr() : def };
  return isValidDate(s) ? { ok: true, value: s } : { ok: false };
}
// 可选日期边界：空 -> null（不限）；给值则必须是合法日期
function pickDateOpt(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: true, value: null };
  return isValidDate(s) ? { ok: true, value: s } : { ok: false };
}
// 给定日期当日的 [00:00:00, 次日00:00:00) 区间
function dayBounds(dateStr) {
  const start = dateStr + ' 00:00:00';
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return { start, end: localDate(d) + ' 00:00:00' };
}

const num = (v) => (v == null || v === '' ? null : Number(v));
const round1 = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(1)));
const toLocalDateTime = (v) => {
  if (!v) return null;
  if (v instanceof Date) return localDateTime(v);
  return String(v).replace('T', ' ').slice(0, 19);
};
const intOr = (v, def) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : def; };

// 手环 steps 是「当日累计」计数器（每 30s 上报同一累计值，零点归零），
// 因此当日步数 = 当日 MAX(steps)，绝不能 SUM（会放大约 3000 倍）。
const stepsExpr = (alias) => `MAX(${alias}.steps)`;
// 健康指标有效区间（与 screen.js 口径一致，滤掉 0 值与噪声）
const HR_MIN = 31, HR_MAX = 249;      // 有效心率
const TP_MIN = 35, TP_MAX = 42;       // 有效体温（与 lib/band-jobs.js 口径一致，滤传感器离腕低温）

module.exports = function mountClassApiRoutes(app) {
  const scope = '/api/class/v1';

  // ---------- per-key 限流（审计写在业务处理里，故先执行鉴权） ----------
  // 用 key 文本派生限流桶，避免同一出口 IP 的多个班互相挤占额度
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const k = apiKeyOf(req);
      return k ? 'k:' + crypto.createHash('sha256').update(k).digest('hex').slice(0, 24) : 'ip:' + (req.ip || '');
    },
    handler: (req, res) => FAIL(res, 429, '请求过于频繁，请稍后再试')
  });

  function apiKeyOf(req) {
    const h = req.get('X-API-Key');
    if (h && String(h).trim()) return String(h).trim();
    // 备用：Authorization: Bearer xxx
    const auth = req.get('Authorization');
    if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
    return '';
  }

  // ---------- 鉴权：X-API-Key -> 绑定班级 ----------
  async function authenticate(req, res, next) {
    const raw = apiKeyOf(req);
    if (!raw) return FAIL(res, 401, '缺少 X-API-Key');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    let rows;
    try {
      rows = await dbQuery(
        'SELECT id, class_id, label, enabled FROM class_api_keys WHERE key_hash = ? LIMIT 1', [hash]);
    } catch (e) {
      console.error('[class-api] key lookup failed:', e.message);
      return FAIL(res, 500, '服务暂时不可用');
    }
    if (!rows.length) return FAIL(res, 401, 'API Key 无效');
    if (!Number(rows[0].enabled)) return FAIL(res, 403, 'API Key 已停用');
    const key = rows[0];
    if (!key.class_id) return FAIL(res, 403, 'API Key 未绑定班级');
    req.apiKey = { id: key.id, classId: Number(key.class_id), label: key.label || '' };
    // 轻量记录最近使用（失败不影响主流程）
    dbQuery('UPDATE class_api_keys SET last_used_at = NOW() WHERE id = ?', [key.id]).catch(() => {});
    next();
  }

  // ---------- 审计：请求收尾写 class_api_logs ----------
  function audit(req, res, next) {
    const started = Date.now();
    res.on('finish', () => {
      const params = { ...(req.query || {}) };
      delete params.key; delete params.api_key; delete params.apikey;
      const endpoint = String(req.path || '').replace(scope + '/', '').replace(/^\//, '').slice(0, 64);
      const paramsStr = JSON.stringify(params).slice(0, 500);
      const key = req.apiKey || {};
      dbQuery(
        `INSERT INTO class_api_logs (key_id, class_id, endpoint, params, ip, status, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [key.id || null, key.classId || null, endpoint, paramsStr,
          String(req.ip || '').slice(0, 64), res.statusCode, Date.now() - started]
      ).catch((e) => console.error('[class-api] audit insert failed:', e.message));
    });
    next();
  }

  // ---------- 班级展示名映射（脱敏用，60s 缓存） ----------
  let _nameCache = { at: 0, map: new Map() };
  async function loadDisplayMap() {
    if (_nameCache.map.size && Date.now() - _nameCache.at < 60000) return _nameCache.map;
    const rows = await dbQuery(
      'SELECT ch.name, c.name AS class_name FROM children ch LEFT JOIN classes c ON c.id = ch.class_id WHERE ch.enabled = 1');
    _nameCache = { at: Date.now(), map: buildDisplayMap(rows) };
    return _nameCache.map;
  }
  function maskName(dm, className, name) {
    const nm = String(name == null ? '' : name).replace(/[\s ]/g, '');
    if (!nm) return '';
    const hit = dm.get(String(className || '') + '\u0001' + nm);
    return hit === undefined ? (nm.length > 1 ? nm.slice(0, -1) + '*' : '*') : hit;
  }

  async function classInfo(classId) {
    const rows = await dbQuery('SELECT id, name, grade_level FROM classes WHERE id = ? LIMIT 1', [classId]);
    return rows[0] || null;
  }

  // 本班「绑定手环 -> 孩子」映射（child_id -> {child_name, class_name, band_mac}）
  async function bandMapForClass(classId) {
    return dbQuery(
      `SELECT m.band_mac, m.child_id, ch.name AS child_name, c.name AS class_name
         FROM band_mapping m
         JOIN children ch ON ch.id = m.child_id
         LEFT JOIN classes c ON c.id = ch.class_id
        WHERE ch.class_id = ?`, [classId]);
  }

  // ======================================================================
  // 1) summary — 本班当日汇总
  // ======================================================================
  app.get(scope + '/summary', apiLimiter, asyncHandler(authenticate), audit, asyncHandler(async (req, res) => {
    const cls = await classInfo(req.apiKey.classId);
    if (!cls) return FAIL(res, 500, '班级信息缺失');
    const date = pickDate(req.query.date, todayStr());
    if (!date.ok) return FAIL(res, 400, 'date 参数格式错误，应为 YYYY-MM-DD');
    const day = date.value;
    const { start, end } = dayBounds(day);

    const [childrenRows, maps] = await Promise.all([
      dbQuery('SELECT id FROM children WHERE class_id = ? AND enabled = 1', [req.apiKey.classId]),
      bandMapForClass(req.apiKey.classId)
    ]);
    const childCount = childrenRows.length;
    const macs = maps.map((m) => m.band_mac);
    const boundBands = new Set(macs.map((m) => String(m).toLowerCase())).size;

    let agg = null, activeMinutes = 0;
    if (macs.length) {
      const ph = macs.map(() => '?').join(',');
      const [rows, arows] = await Promise.all([
        dbQuery(
        `SELECT band_mac,
                ${stepsExpr('band_records')} AS steps,
                AVG(CASE WHEN heart_rate BETWEEN ${HR_MIN} AND ${HR_MAX} THEN heart_rate END) AS avg_hr,
                AVG(CASE WHEN spo2 > 0 THEN spo2 END) AS avg_spo2,
                AVG(CASE WHEN body_temp BETWEEN ${TP_MIN} AND ${TP_MAX} THEN body_temp END) AS avg_tp,
                MAX(heart_rate) AS max_hr,
                MAX(bp_time) AS last_time,
                COUNT(*) AS ticks,
                SUM(CASE WHEN heart_rate BETWEEN ${HR_MIN} AND ${HR_MAX} OR spo2 > 0 OR steps > 0 THEN 1 ELSE 0 END) AS valid_ticks
           FROM band_records
          WHERE bp_time >= ? AND bp_time < ? AND band_mac IN (${ph})
          GROUP BY band_mac`,
        [start, end, ...macs]),
        // 运动时长：steps 是「当日累计」计数器，只有它相对上一条增加才算真有步数位移。
        // 用窗口函数 LAG 求相邻差，统计「步数增加」的上报条数 * 30s。
        dbQuery(
        `SELECT SUM(act) AS active_ticks FROM (
           SELECT band_mac, SUM(delta > 0) AS act FROM (
             SELECT r.band_mac, r.steps - COALESCE(LAG(r.steps) OVER (PARTITION BY r.band_mac ORDER BY r.bp_time), r.steps) AS delta
               FROM band_records r
              WHERE r.bp_time >= ? AND r.bp_time < ? AND r.band_mac IN (${ph})
           ) t GROUP BY band_mac
         ) u`,
        [start, end, ...macs])
      ]);
      agg = rows;
      const at = Number(arows[0] && arows[0].active_ticks) || 0;
      activeMinutes = Math.round((at * 30) / 60);
    }

    // 「有数据」= 当日至少有一条有效读数（心率/血氧/步数任一），避免仅体温噪声的手环计入
    const withData = (agg || []).filter((r) => Number(r.valid_ticks) > 0).length;
    const totalSteps = agg ? agg.reduce((s, r) => s + (Number(r.steps) || 0), 0) : 0;
    const hrVals = (agg || []).map((r) => num(r.avg_hr)).filter((v) => v != null);
    const spVals = (agg || []).map((r) => num(r.avg_spo2)).filter((v) => v != null);
    const tpVals = (agg || []).map((r) => num(r.avg_tp)).filter((v) => v != null);
    const avgOf = (arr) => (arr.length ? Number((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1)) : null);

    OK(res, {
      class: { id: cls.id, name: cls.name, grade_level: cls.grade_level },
      date: day,
      children_total: childCount,
      band_bound: boundBands,
      children_with_data: withData,
      children_no_data: Math.max(0, childCount - withData),
      total_steps: totalSteps,
      avg_heart_rate: avgOf(hrVals),
      avg_spo2: avgOf(spVals),
      avg_body_temp: avgOf(tpVals),
      max_heart_rate: agg && agg.length ? (Math.max(...agg.map((r) => Number(r.max_hr) || 0)) || null) : null,
      active_minutes: activeMinutes,
      steps_note: 'steps 为手环当日累计计数，total_steps=各班内手环当日 MAX(steps) 之和',
      active_note: '运动时长=本班各手环当日步数计数「增加」的上报条数×30s（steps 为累计计数器，仅增量代表真实步数）',
      empty: withData === 0,
      empty_note: withData === 0 ? '当日暂无手环上报数据（可能放假/断网/未佩戴）' : null
    });
  }));

  // ======================================================================
  // 2) children — 脱敏名单 + 当日手环 + 最新体测
  // ======================================================================
  app.get(scope + '/children', apiLimiter, asyncHandler(authenticate), audit, asyncHandler(async (req, res) => {
    const cls = await classInfo(req.apiKey.classId);
    if (!cls) return FAIL(res, 500, '班级信息缺失');
    const date = pickDate(req.query.date, todayStr());
    if (!date.ok) return FAIL(res, 400, 'date 参数格式错误，应为 YYYY-MM-DD');
    const day = date.value;
    const { start, end } = dayBounds(day);
    const dm = await loadDisplayMap();

    const children = await dbQuery(
      `SELECT ch.id, ch.name, ch.gender, ch.birth_date
         FROM children ch
        WHERE ch.class_id = ? AND ch.enabled = 1
        ORDER BY ch.id ASC`, [req.apiKey.classId]);

    const maps = await bandMapForClass(req.apiKey.classId);
    const mapByChild = new Map(maps.filter((m) => m.child_id).map((m) => [Number(m.child_id), m]));

    // 当日每手环聚合
    const macs = maps.map((m) => m.band_mac);
    const aggByMac = new Map();
    if (macs.length) {
      const ph = macs.map(() => '?').join(',');
      const rows = await dbQuery(
        `SELECT band_mac, ${stepsExpr('band_records')} AS steps,
                AVG(CASE WHEN heart_rate BETWEEN ${HR_MIN} AND ${HR_MAX} THEN heart_rate END) AS avg_hr,
                MAX(heart_rate) AS max_hr,
                AVG(CASE WHEN spo2 > 0 THEN spo2 END) AS avg_spo2,
                AVG(CASE WHEN body_temp BETWEEN ${TP_MIN} AND ${TP_MAX} THEN body_temp END) AS avg_tp,
                SUBSTRING_INDEX(GROUP_CONCAT(battery ORDER BY bp_time DESC), ',', 1) AS battery,
                MAX(bp_time) AS last_time, COUNT(*) AS ticks
           FROM band_records
          WHERE bp_time >= ? AND bp_time < ? AND band_mac IN (${ph})
          GROUP BY band_mac`,
        [start, end, ...macs]);
      for (const r of rows) aggByMac.set(String(r.band_mac).toLowerCase(), r);
    }

    // 最新体测（本班孩子，按 child 取最新日期）
    const fitness = await dbQuery(
      `SELECT fr.child_id, fr.test_date, fr.height_cm, fr.weight_kg, fr.bmi, fr.rating, fr.total_score
         FROM fitness_records fr
         JOIN (SELECT fr2.child_id, MAX(fr2.test_date) AS md
                 FROM fitness_records fr2
                 JOIN children ch2 ON ch2.id = fr2.child_id
                WHERE ch2.class_id = ?
                GROUP BY fr2.child_id) t
           ON t.child_id = fr.child_id AND t.md = fr.test_date`,
      [req.apiKey.classId]);
    const fitByChild = new Map(fitness.map((f) => [Number(f.child_id), f]));

    const list = children.map((ch) => {
      const mp = mapByChild.get(Number(ch.id));
      const mac = mp ? String(mp.band_mac).toLowerCase() : '';
      const a = mac ? aggByMac.get(mac) : null;
      const fit = fitByChild.get(Number(ch.id));
      return {
        child_id: ch.id,
        name: maskName(dm, cls.name, ch.name),
        gender: ch.gender,
        band_mac: mp ? mp.band_mac : null,
        band: a ? {
          steps: Number(a.steps) || 0,
          avg_heart_rate: round1(a.avg_hr),
          max_heart_rate: num(a.max_hr),
          avg_spo2: round1(a.avg_spo2),
          avg_body_temp: round1(a.avg_tp),
          battery: a.battery == null || a.battery === '' ? null : Number(a.battery),
          last_report_at: toLocalDateTime(a.last_time),
          records: Number(a.ticks) || 0
        } : null,
        latest_fitness: fit ? {
          test_date: toLocalDateTime(fit.test_date),
          height_cm: num(fit.height_cm),
          weight_kg: num(fit.weight_kg),
          bmi: num(fit.bmi),
          rating: fit.rating,
          total_score: num(fit.total_score)
        } : null
      };
    });

    OK(res, { class: { id: cls.id, name: cls.name }, date: day, count: list.length, children: list });
  }));

  // ======================================================================
  // 3) child/:id — 单孩详情（限本班）
  // ======================================================================
  app.get(scope + '/child/:id', apiLimiter, asyncHandler(authenticate), audit, asyncHandler(async (req, res) => {
    const classId = req.apiKey.classId;
    const cls = await classInfo(classId);
    if (!cls) return FAIL(res, 500, '班级信息缺失');
    const childId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(childId)) return FAIL(res, 400, 'child id 非法');

    // 越权检查：孩子必须属于本班
    const chRows = await dbQuery(
      'SELECT id, name, gender, birth_date FROM children WHERE id = ? AND class_id = ? AND enabled = 1 LIMIT 1',
      [childId, classId]);
    if (!chRows.length) return FAIL(res, 403, '无权查看该幼儿（不属于本班或不存在）');
    const child = chRows[0];
    const dm = await loadDisplayMap();

    const date = pickDate(req.query.date, todayStr());
    if (!date.ok) return FAIL(res, 400, 'date 参数格式错误，应为 YYYY-MM-DD');
    const from = pickDateOpt(req.query.from);
    const to = pickDateOpt(req.query.to);
    if (!from.ok || !to.ok) return FAIL(res, 400, 'from/to 参数格式错误，应为 YYYY-MM-DD');

    // 默认窗口：有 from/to 用其范围；否则用 date 单日。from/to 至少一个时另一端缺省补 date。
    const lo = from.value || to.value || date.value;
    const hi = to.value || from.value || date.value;
    const range = { from: lo, to: hi };
    // 跨度上限 31 天，防止超长区间全表扫（走 idx_band_time 区间仍需限幅）
    const days = Math.round((new Date(hi + 'T00:00:00') - new Date(lo + 'T00:00:00')) / 86400000) + 1;
    if (days > 31) return FAIL(res, 400, '查询跨度不能超过 31 天');
    const { start } = dayBounds(lo);
    const { end } = dayBounds(hi);

    const maps = await dbQuery('SELECT band_mac FROM band_mapping WHERE child_id = ? LIMIT 1', [childId]);
    const mac = maps.length ? maps[0].band_mac : null;

    // 手环：按日聚合（走 idx_band_time 的 (band_mac,bp_time) 区间）；单日范围时附带按时段聚合
    let daily = [], segments = [];
    if (mac) {
      daily = await dbQuery(
        `SELECT DATE(bp_time) AS d, ${stepsExpr('band_records')} AS steps,
                AVG(CASE WHEN heart_rate BETWEEN ${HR_MIN} AND ${HR_MAX} THEN heart_rate END) AS avg_hr,
                MAX(heart_rate) AS max_hr,
                AVG(CASE WHEN spo2 > 0 THEN spo2 END) AS avg_spo2,
                AVG(CASE WHEN body_temp BETWEEN ${TP_MIN} AND ${TP_MAX} THEN body_temp END) AS avg_tp,
                COUNT(*) AS ticks, MAX(bp_time) AS last_time
           FROM band_records
          WHERE band_mac = ? AND bp_time >= ? AND bp_time < ?
          GROUP BY DATE(bp_time) ORDER BY d ASC`, [mac, start, end]);
      // 按时段（默认 30 分钟一桶，5-240 可调）——仅单日窗口时输出，避免多日桶混淆
      if (lo === hi) {
        const bucketMin = Math.min(240, Math.max(5, intOr(req.query.bucketMin, 30)));
        const fmt = bucketMin >= 60 ? '%m-%d %H:00' : '%H:%i';
        // 子查询先算桶号 bk，再按 (bk,t) 聚合，规避 only_full_group_by 对表达式列的报错
        segments = await dbQuery(
          `SELECT t, ${stepsExpr('x')} AS steps,
                  AVG(CASE WHEN hr BETWEEN ${HR_MIN} AND ${HR_MAX} THEN hr END) AS avg_hr,
                  AVG(CASE WHEN spo2 > 0 THEN spo2 END) AS avg_spo2,
                  AVG(CASE WHEN tp BETWEEN ${TP_MIN} AND ${TP_MAX} THEN tp END) AS avg_tp,
                  COUNT(*) AS ticks
             FROM (
               SELECT FLOOR(UNIX_TIMESTAMP(bp_time) / (${bucketMin} * 60)) AS bk,
                      DATE_FORMAT(FROM_UNIXTIME(${bucketMin} * 60 * FLOOR(UNIX_TIMESTAMP(bp_time) / (${bucketMin} * 60))), '${fmt}') AS t,
                      steps, heart_rate AS hr, spo2, body_temp AS tp
                 FROM band_records
                WHERE band_mac = ? AND bp_time >= ? AND bp_time < ?
             ) x
            GROUP BY bk, t ORDER BY bk ASC`, [mac, start, end]);
      }
    }

    // 体测历史全批次
    const fitness = await dbQuery(
      `SELECT test_date, height_cm, weight_kg, bmi, grip_kg, long_jump_cm, sit_reach_cm,
              double_jump_sec, obstacle_run_sec, balance_beam_sec, total_score, rating
         FROM fitness_records WHERE child_id = ? ORDER BY test_date ASC`, [childId]);

    OK(res, {
      child: { id: child.id, name: maskName(dm, cls.name, child.name), gender: child.gender, class_id: cls.id, class_name: cls.name },
      band_mac: mac,
      date: date.value,
      range,
      bucket_minutes: mac && lo === hi ? Math.min(240, Math.max(5, intOr(req.query.bucketMin, 30))) : null,
      band_daily: daily.map((r) => ({
        date: toLocalDateTime(r.d),
        steps: Number(r.steps) || 0,
        avg_heart_rate: round1(r.avg_hr),
        max_heart_rate: num(r.max_hr),
        avg_spo2: round1(r.avg_spo2),
        avg_body_temp: round1(r.avg_tp),
        records: Number(r.ticks) || 0,
        last_report_at: toLocalDateTime(r.last_time)
      })),
      band_segments: segments.map((r) => ({
        t: r.t, steps: Number(r.steps) || 0, avg_heart_rate: round1(r.avg_hr),
        avg_spo2: round1(r.avg_spo2), avg_body_temp: round1(r.avg_tp), records: Number(r.ticks) || 0
      })),
      fitness_history: fitness.map((f) => ({
        test_date: toLocalDateTime(f.test_date),
        height_cm: num(f.height_cm), weight_kg: num(f.weight_kg), bmi: num(f.bmi),
        grip_kg: num(f.grip_kg), long_jump_cm: num(f.long_jump_cm), sit_reach_cm: num(f.sit_reach_cm),
        double_jump_sec: num(f.double_jump_sec), obstacle_run_sec: num(f.obstacle_run_sec), balance_beam_sec: num(f.balance_beam_sec),
        total_score: num(f.total_score), rating: f.rating
      }))
    });
  }));

  // ======================================================================
  // 4) fitness — 本班体测记录列表（按批次/日期）
  // ======================================================================
  app.get(scope + '/fitness', apiLimiter, asyncHandler(authenticate), audit, asyncHandler(async (req, res) => {
    const classId = req.apiKey.classId;
    const cls = await classInfo(classId);
    if (!cls) return FAIL(res, 500, '班级信息缺失');
    const from = pickDateOpt(req.query.from);
    const to = pickDateOpt(req.query.to);
    if (!from.ok || !to.ok) return FAIL(res, 400, 'from/to 参数格式错误，应为 YYYY-MM-DD');
    const limit = Math.min(500, Math.max(1, intOr(req.query.limit, 200)));
    const dm = await loadDisplayMap();

    const where = ['ch.class_id = ?'];
    const params = [classId];
    if (from.value) { where.push('fr.test_date >= ?'); params.push(from.value); }
    if (to.value) { where.push('fr.test_date <= ?'); params.push(to.value); }

    const rows = await dbQuery(
      `SELECT fr.id, fr.child_id, fr.test_date, fr.height_cm, fr.weight_kg, fr.bmi,
              fr.grip_kg, fr.long_jump_cm, fr.sit_reach_cm, fr.double_jump_sec,
              fr.obstacle_run_sec, fr.balance_beam_sec, fr.total_score, fr.rating,
              ch.name AS child_name, ch.gender
         FROM fitness_records fr
         JOIN children ch ON ch.id = fr.child_id
        WHERE ${where.join(' AND ')}
        ORDER BY fr.test_date DESC, ch.id ASC
        LIMIT ${limit}`, params);

    // 批次汇总
    const batches = {};
    for (const r of rows) {
      const d = toLocalDateTime(r.test_date);
      if (!batches[d]) batches[d] = { date: d, count: 0 };
      batches[d].count += 1;
    }

    OK(res, {
      class: { id: cls.id, name: cls.name },
      from: from.value || null, to: to.value || null,
      count: rows.length, limit,
      batches: Object.values(batches).sort((a, b) => (a.date < b.date ? 1 : -1)),
      records: rows.map((r) => ({
        id: r.id, child_id: r.child_id, name: maskName(dm, cls.name, r.child_name), gender: r.gender,
        test_date: toLocalDateTime(r.test_date),
        height_cm: num(r.height_cm), weight_kg: num(r.weight_kg), bmi: num(r.bmi),
        grip_kg: num(r.grip_kg), long_jump_cm: num(r.long_jump_cm), sit_reach_cm: num(r.sit_reach_cm),
        double_jump_sec: num(r.double_jump_sec), obstacle_run_sec: num(r.obstacle_run_sec), balance_beam_sec: num(r.balance_beam_sec),
        total_score: num(r.total_score), rating: r.rating
      }))
    });
  }));

  // ======================================================================
  // 5) health — 手环按日聚合健康指标（含心率区间分布）
  // ======================================================================
  app.get(scope + '/health', apiLimiter, asyncHandler(authenticate), audit, asyncHandler(async (req, res) => {
    const classId = req.apiKey.classId;
    const cls = await classInfo(classId);
    if (!cls) return FAIL(res, 500, '班级信息缺失');
    const date = pickDate(req.query.date, todayStr());
    if (!date.ok) return FAIL(res, 400, 'date 参数格式错误，应为 YYYY-MM-DD');
    const day = date.value;
    const { start, end } = dayBounds(day);

    const maps = await bandMapForClass(classId);
    const macs = maps.map((m) => m.band_mac);
    if (!macs.length) {
      return OK(res, {
        class: { id: cls.id, name: cls.name }, date: day,
        bands: 0, avg: null, hr_zones: [], empty: true, empty_note: '本班暂无绑定手环'
      });
    }
    const ph = macs.map(() => '?').join(',');

    // 按手环按日聚合（含区间分布）
    const rows = await dbQuery(
      `SELECT band_mac,
              ${stepsExpr('band_records')} AS steps,
              AVG(CASE WHEN heart_rate BETWEEN ${HR_MIN} AND ${HR_MAX} THEN heart_rate END) AS avg_hr,
              MAX(heart_rate) AS max_hr,
              AVG(CASE WHEN spo2 > 0 THEN spo2 END) AS avg_spo2,
              AVG(CASE WHEN body_temp BETWEEN ${TP_MIN} AND ${TP_MAX} THEN body_temp END) AS avg_tp,
              MAX(CASE WHEN body_temp BETWEEN ${TP_MIN} AND ${TP_MAX} THEN body_temp END) AS max_tp,
              SUBSTRING_INDEX(GROUP_CONCAT(battery ORDER BY bp_time DESC), ',', 1) AS battery,
              MAX(bp_time) AS last_time,
              COUNT(*) AS ticks
         FROM band_records
        WHERE bp_time >= ? AND bp_time < ? AND band_mac IN (${ph})
        GROUP BY band_mac`, [start, end, ...macs]);

    const avgOf = (arr) => (arr.length ? Number((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1)) : null);
    const hrVals = rows.map((r) => num(r.avg_hr)).filter((v) => v != null);
    const spVals = rows.map((r) => num(r.avg_spo2)).filter((v) => v != null);
    const tpVals = rows.map((r) => num(r.avg_tp)).filter((v) => v != null);
    // 心率区间分布：以「每个孩子当日平均心率」落在哪个区间来计数（区间人数，非上报条数）
    const zoneCounts = HR_ZONES.reduce((acc, z) => { acc[z.key] = 0; return acc; }, {});
    for (const v of hrVals) {
      const z = HR_ZONES.find((zz) => v >= zz.min && v <= zz.max);
      if (z) zoneCounts[z.key] += 1;
    }

    OK(res, {
      class: { id: cls.id, name: cls.name }, date: day,
      bands: rows.length,
      avg: {
        heart_rate: avgOf(hrVals), spo2: avgOf(spVals), body_temp: avgOf(tpVals),
        total_steps: rows.reduce((s, r) => s + (Number(r.steps) || 0), 0),
        max_body_temp: tpVals.length ? round1(Math.max(...tpVals)) : null
      },
      hr_zones: HR_ZONES.map((z) => ({ key: z.key, label: z.label, children: zoneCounts[z.key] || 0 })),
      bands_detail: rows.map((r) => ({
        band_mac: r.band_mac,
        steps: Number(r.steps) || 0,
        avg_heart_rate: round1(r.avg_hr), max_heart_rate: num(r.max_hr),
        avg_spo2: round1(r.avg_spo2), avg_body_temp: round1(r.avg_tp),
        battery: r.battery == null || r.battery === '' ? null : Number(r.battery),
        last_report_at: toLocalDateTime(r.last_time), records: Number(r.ticks) || 0
      })),
      empty: rows.length === 0,
      empty_note: rows.length === 0 ? '当日暂无手环上报数据（可能放假/断网/未佩戴）' : null
    });
  }));

  return { scope };
};