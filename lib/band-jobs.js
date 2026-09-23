// 小鱼健康 · 手环业务定时任务（2026-09-10 新增, 2026-09-10 改版: 时间/开关后台可配）
// 1) 心率超标报警：每 60s 扫最近 3 分钟 band_records, 心率 > 阈值（site_settings.bandHrAlert, 默认180）
//    同一记录去重 + 同一手环 5 分钟内静默；推送孩子班级老师(role=user 已绑企微)，无则 admin
// 2) 每日健康日报：每天到点（site_settings.bandDailyTime, 默认 10:30）且当天未推过 → 汇总推送 admin+health_teacher
// 开关: bandHrEnabled / bandDailyEnabled ('1'/'0')
const { dbQuery } = require('./db');
const { ensurePushLogsTable, sendAppMessage, logPush } = require('./wx-push');
const { buildDisplayMap } = require('./name-masking');

// ========== 幼儿姓名展示脱敏（2026-09-17）==========
let _maskDisplayCache = { at: 0, map: new Map() };
async function loadMaskDisplayMap() {
  if (_maskDisplayCache.map.size && Date.now() - _maskDisplayCache.at < 60000) return _maskDisplayCache.map;
  try {
    const rows = await dbQuery(`SELECT ch.name, c.name AS class_name FROM children ch LEFT JOIN classes c ON c.id = ch.class_id WHERE ch.enabled = 1`);
    _maskDisplayCache = { at: Date.now(), map: buildDisplayMap(rows) };
  } catch (e) { /* 查询失败退回默认规则 */ }
  return _maskDisplayCache.map;
}
function maskWho(displayMap, className, childName) {
  const nm = String(childName == null ? '' : childName).replace(/[\\s\\u00a0]/g, '');
  if (!nm) return childName;
  const hit = displayMap.get(String(className || '') + '\\u0001' + nm);
  return hit === undefined ? (nm.length > 1 ? nm.slice(0, -1) + '*' : nm) : hit;
}

const TICK_MS = 60 * 1000;        // 心跳周期（报警扫描 + 日报检查）
const HR_ALERT_WINDOW_MIN = 3;    // 报警扫描窗口
const HR_ALERT_DEFAULT = 160;     // 默认心率阈值（2026-09-16 杰哥定: 超过160推送）
const HR_SILENCE_MIN = 5;         // 同一手环静默期
const EVENT_HR_HIGH = 140;        // 大屏「偏高」显示口径（事件表记录线）
const EVENT_HR_LOW = 60;          // 大屏「偏低」显示口径
const RESOLVE_AFTER_MIN = 10;     // 预警事件超过 N 分钟无新触发 → 标记已恢复
const CLEAN_HOUR = 3;             // 数据清理时刻（每天 03:00 上海时区）
const CLEAN_RETAIN_DAYS = 7;      // band_records 只保留最近 7 天（site_settings.bandRetainDays 可改）
const HR_ALERT_URL = 'https://www.jiangxiyey.cn/alert';   // 心率警报卡片跳转 -> 警报面板(专注模式, 面板key=alert 无s)
const DAILY_REPORT_URL = 'https://www.jiangxiyey.cn/report'; // 日报卡片跳转 -> 日报面板(专注模式)
const TZ = 'Asia/Shanghai';

function zp(n) { return String(n).padStart(2, '0'); }

// 上海时区当前 HH:MM 与 YYYY-MM-DD
function shNowParts(now) {
  const d = new Date(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hm: `${get('hour')}:${get('minute')}` };
}

async function getSetting(key, def) {
  try {
    const rows = await dbQuery('SELECT setting_value FROM site_settings WHERE setting_key = ?', [key]);
    return rows.length ? rows[0].setting_value : def;
  } catch (e) {
    return def;
  }
}

function fmtTime(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return `${dt.getFullYear()}-${zp(dt.getMonth() + 1)}-${zp(dt.getDate())} ${zp(dt.getHours())}:${zp(dt.getMinutes())}`;
}

// ---------- 传感器死值过滤（2026-09-22 杰哥定）----------
// 背景：手环静置/刚佩戴时心率传感器会输出恒定假值（9-22 周歆甜 170 卡 103 分钟、王子安 169 卡死）。
// 判定：最近 DEAD_WINDOW_MIN 分钟内该手环非零心率「取值唯一」且样本数 >= DEAD_MIN_SAMPLES（约4分钟无任何波动）→ 视为传感器死值。
// 用途：hrAlertOnce 不推送、syncAlertEvents 不入事件表；SOS 在事件表侧单独豁免（本函数不含 SOS 逻辑）。
const DEAD_WINDOW_MIN = 10;
const DEAD_MIN_SAMPLES = 8;
async function isDeadHeartRate(bandMac) {
  try {
    const distinct = await dbQuery(
      `SELECT DISTINCT heart_rate FROM band_records
        WHERE band_mac = ? AND bp_time >= NOW() - INTERVAL ${DEAD_WINDOW_MIN} MINUTE
          AND heart_rate > 0 LIMIT 2`,
      [bandMac]
    );
    if (distinct.length >= 2) return false; // 有波动 → 真实数据
    const cnt = await dbQuery(
      `SELECT COUNT(*) AS c FROM band_records
        WHERE band_mac = ? AND bp_time >= NOW() - INTERVAL ${DEAD_WINDOW_MIN} MINUTE AND heart_rate > 0`,
      [bandMac]
    );
    return Number((cnt[0] && cnt[0].c) || 0) >= DEAD_MIN_SAMPLES; // 恒定值且样本足够 → 死值
  } catch (e) { return false; } // 查询异常放行，不影响原有告警
}

// ---------- 运动时间窗（2026-09-22 杰哥定：手环仅运动时段佩戴，上海时间默认 09:30-10:30，site_settings.bandSportStart/End 可改）----------
// 窗口外手环都是静置假心率：不推送、不入事件表（SOS 永远豁免）。
async function inSportWindow() {
  try {
    const start = await getSetting('bandSportStart', '09:30');
    const end = await getSetting('bandSportEnd', '10:30');
    const hm = shNowParts(Date.now()).hm;
    if (start <= end) return hm >= start && hm < end;
    return hm >= start || hm < end; // 跨午夜窗口
  } catch (e) { return true; } // 配置异常放行
}

// ---------- 心率超标报警 ----------
async function hrAlertOnce() {
  const enabled = await getSetting('bandHrEnabled', '1');
  if (enabled !== '1') return { disabled: true };
  // 运动时间窗外一律不推送（手环静置假心率，2026-09-22 杰哥定 09:30-10:30 运动时段）
  if (!(await inSportWindow())) return { outside_sport_window: true };
  const threshold = Number(await getSetting('bandHrAlert', HR_ALERT_DEFAULT)) || HR_ALERT_DEFAULT;
  const rows = await dbQuery(
    `SELECT b.id, b.band_mac, b.heart_rate, b.bp_time,
            m.child_id, ch.name AS child_name, ch.class_id, c.name AS class_name
     FROM band_records b
     LEFT JOIN band_mapping m ON m.band_mac = b.band_mac
     LEFT JOIN children ch ON ch.id = m.child_id
     LEFT JOIN classes c ON c.id = ch.class_id
     WHERE b.bp_time >= NOW() - INTERVAL ${HR_ALERT_WINDOW_MIN} MINUTE
       AND b.heart_rate > ?
     ORDER BY b.bp_time DESC LIMIT 50`,
    [threshold]
  );
  let pushed = 0;
  for (const r of rows) {
    const dup = await dbQuery('SELECT id FROM push_logs WHERE push_type="hr_alert" AND ref_id=? LIMIT 1', [String(r.id)]);
    if (dup.length) continue;
    const recent = await dbQuery(
      'SELECT id FROM push_logs WHERE push_type="hr_alert" AND mac=? AND created_at >= NOW() - INTERVAL ? MINUTE LIMIT 1',
      [r.band_mac, HR_SILENCE_MIN]
    );
    if (recent.length) continue;
    // 传感器死值不推送（2026-09-22：静置假心率 170/169 连刷导致误报）
    if (await isDeadHeartRate(r.band_mac)) continue;

    // 推送三方: 对应班级老师 + 管理员 + 保健老师（不再回退，全部一起推）
    const targets = await dbQuery(
      `SELECT wx_userid FROM users
        WHERE wx_userid IS NOT NULL AND wx_userid <> ''
          AND ((role = 'user' AND class_id = ?) OR role = 'admin' OR role = 'health_teacher')
        GROUP BY wx_userid`,
      [r.class_id || null]
    );
    if (!targets.length) {
      await logPush({ push_type: 'hr_alert', ref_id: String(r.id), mac: r.band_mac, tousers: '', title: '心率预警', content: '无人可推送（无已绑企微的教师/管理员/保健老师）', errcode: -2, errmsg: 'no_targets' });
      continue;
    }
    const tousers = targets.map((t) => t.wx_userid).join(',');
    const _dm = await loadMaskDisplayMap();
    const who = r.child_name ? `${r.class_name || ''} · ${maskWho(_dm, r.class_name, r.child_name)}` : `手环 ${r.band_mac}（未绑定孩子）`;
    const title = `🚨 心率预警：${who}`.slice(0, 64);
    const desc = `当前心率 ${r.heart_rate} 次/分（阈值 ${threshold}）\n数据时间：${fmtTime(r.bp_time)}\n请老师尽快查看孩子状况，必要时联系保健老师。`;
    // 卡片链接带本条记录ID, 点开直达该条警报详情
    const alertUrl = `${HR_ALERT_URL}?id=${r.id}`;
    try {
      const res = await sendAppMessage({ touser: tousers, msgtype: 'textcard', title, desc, url: alertUrl });
      await logPush({ push_type: 'hr_alert', ref_id: String(r.id), mac: r.band_mac, tousers, title, content: desc, errcode: res && res.errcode, errmsg: res && res.errmsg });
      pushed += 1;
    } catch (e) {
      await logPush({ push_type: 'hr_alert', ref_id: String(r.id), mac: r.band_mac, tousers, title, content: desc, errcode: -1, errmsg: String(e && e.message || e).slice(0, 200) });
    }
  }
  return { scanned: rows.length, pushed };
}

// ---------- 预警事件持久化表（大屏「重点预警事件」不消失, 2026-09-16 杰哥要求） ----------
async function ensureBandAlertsTable() {
  await dbQuery(`CREATE TABLE IF NOT EXISTS band_alerts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    band_mac VARCHAR(32) NOT NULL,
    kind VARCHAR(16) NOT NULL DEFAULT 'hr_high',
    child_name VARCHAR(64) NOT NULL DEFAULT '',
    class_name VARCHAR(64) NOT NULL DEFAULT '',
    peak_value DECIMAL(6,1) DEFAULT NULL,
    first_time DATETIME NOT NULL,
    last_time DATETIME NOT NULL,
    trigger_count INT NOT NULL DEFAULT 1,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    resolved_at DATETIME DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_mac (band_mac),
    KEY idx_status (status),
    KEY idx_last_time (last_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// 每 tick 扫描最近窗口内的异常记录（心率>140 或 30<=心率<60 或 SOS，0 值无效不算），
// 同一手环同一类型合并且只更新最后时间/峰值/次数；超过 RESOLVE_AFTER_MIN 无新触发 → 标记已恢复（记录保留不删）
async function syncAlertEvents() {
  // 运动时间窗外不入预警事件表（SOS 例外：走独立通道必须始终记录，2026-09-22）
  const sportOn = await inSportWindow();
  const rows = await dbQuery(
    `SELECT b.id, b.band_mac, b.heart_rate, b.bp_time, b.sos,
            m.child_id, ch.name AS child_name, c.name AS class_name
     FROM band_records b
     LEFT JOIN band_mapping m ON m.band_mac = b.band_mac
     LEFT JOIN children ch ON ch.id = m.child_id
     LEFT JOIN classes c ON c.id = ch.class_id
     WHERE b.bp_time >= NOW() - INTERVAL ${HR_ALERT_WINDOW_MIN} MINUTE
       AND ((b.heart_rate > ${EVENT_HR_HIGH}) OR (b.heart_rate >= 30 AND b.heart_rate < ${EVENT_HR_LOW}) OR (b.sos = 1))
     ORDER BY b.bp_time ASC`, []
  );
  let upserted = 0;
  for (const r of rows) {
    const kind = Number(r.sos) > 0 ? 'sos' : (Number(r.heart_rate) > EVENT_HR_HIGH ? 'hr_high' : 'hr_low');
    // SOS 永远记录；其余非运动时段直接跳过（2026-09-22 运动时间窗）
    if (kind !== 'sos' && !sportOn) continue;
    // 传感器死值不入事件表（SOS 除外，永远记录）；2026-09-22
    if (kind !== 'sos' && await isDeadHeartRate(r.band_mac)) continue;
    // 找同一手环同一类型 且 未恢复 的事件（10 分钟窗口内视为同一事件持续段）
    const alive = await dbQuery(
      `SELECT id FROM band_alerts
        WHERE band_mac = ? AND kind = ? AND status = 'active'
          AND last_time >= NOW() - INTERVAL ${RESOLVE_AFTER_MIN} MINUTE
        LIMIT 1`,
      [r.band_mac, kind]
    );
    if (alive.length) {
      await dbQuery(
        `UPDATE band_alerts
            SET last_time = ?, peak_value = CASE WHEN ? > peak_value THEN ? ELSE peak_value END,
                trigger_count = trigger_count + 1,
                child_name = ?, class_name = ?
          WHERE id = ?`,
        [r.bp_time, Number(r.heart_rate), Number(r.heart_rate), r.child_name || '', r.class_name || '', alive[0].id]
      );
    } else {
      await dbQuery(
        `INSERT INTO band_alerts (band_mac, kind, child_name, class_name, peak_value, first_time, last_time, trigger_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [r.band_mac, kind, r.child_name || '', r.class_name || '', Number(r.heart_rate) || null, r.bp_time, r.bp_time]
      );
    }
    upserted += 1;
  }
  // 标已恢复：active 事件最近触发时间超过 10 分钟
  const resolved = await dbQuery(
    `UPDATE band_alerts SET status = 'resolved', resolved_at = NOW()
      WHERE status = 'active' AND last_time < NOW() - INTERVAL ${RESOLVE_AFTER_MIN} MINUTE`, []
  );
  return { scanned: rows.length, upserted, resolved: resolved.affectedRows };
}

// ---------- 每日健康日报 ----------
// 口径：平均心率/平均血氧/平均步数(每手环当日最大累计值均值)/平均体温 + 体征预警次数（高心率>阈值 · 高温· SOS）
async function buildDailyReport() {
  const hrThreshold = Number(await getSetting('bandHrAlert', String(HR_ALERT_DEFAULT))) || HR_ALERT_DEFAULT;
  const row = await dbQuery(
    `SELECT COUNT(*) AS recs,
            COUNT(DISTINCT band_mac) AS macs,
            ROUND(AVG(CASE WHEN heart_rate > 0 THEN heart_rate END)) AS avg_hr,
            ROUND(AVG(CASE WHEN spo2 > 0 THEN spo2 END)) AS avg_spo2,
            ROUND(SUM(heart_rate > ?) +
                  SUM(body_temp > 37.3) +
                  SUM(sos = 1)) AS alert_count,
            SUM(heart_rate > ?) AS hr_high,
            SUM(body_temp > 37.3) AS fever_events,
            SUM(sos = 1) AS sos_count
     FROM band_records WHERE bp_time >= CURDATE()`,
    [hrThreshold, hrThreshold]
  );
  const s = row[0] || {};
  const recs = Number(s.recs) || 0;

  // 平均体温与平均步数：体温取全天记录中有效范围(35-42℃)均值；步数为每只手环当日最大累计步数的均值（累计值不能直接 AVG 所有行）
  const tpRow = await dbQuery(
    `SELECT ROUND(AVG(CASE WHEN body_temp BETWEEN 35 AND 42 THEN body_temp END), 1) AS avg_tp
     FROM band_records WHERE bp_time >= CURDATE()`,
    []
  );
  const stepsRow = await dbQuery(
    `SELECT ROUND(AVG(d.max_steps)) AS avg_steps FROM (
        SELECT MAX(steps) AS max_steps FROM band_records
        WHERE bp_time >= CURDATE() AND steps > 0 GROUP BY band_mac
     ) d`,
    []
  );
  const avgTp = tpRow[0] && tpRow[0].avg_tp != null ? Number(tpRow[0].avg_tp) : null;
  const avgSteps = stepsRow[0] && stepsRow[0].avg_steps != null ? Number(stepsRow[0].avg_steps) : null;
  const hrHigh = Number(s.hr_high) || 0;
  const fever = Number(s.fever_events) || 0;
  const sos = Number(s.sos_count) || 0;
  const alertCount = Number(s.alert_count) || 0;
  // 预警事件起数与持续时长（band_alerts 持久化事件表口径：只统计需推送的 hr_high，SOS/心率偏低不推——2026-09-16 杰哥定: 偏低多为手表松动假信号）
  const alertEv = await dbQuery(
    `SELECT COUNT(*) AS events,
            ROUND(SUM(TIMESTAMPDIFF(SECOND, first_time, last_time)) / 60) AS total_min,
            ROUND(MAX(TIMESTAMPDIFF(SECOND, first_time, last_time)) / 60) AS max_min
       FROM band_alerts
      WHERE last_time >= CURDATE() AND kind = 'hr_high'`, []
  );
  const ev = alertEv[0] || {};
  const events = Number(ev.events) || 0;
  const totalMin = Math.max(0, Math.round(Number(ev.total_min) || 0));
  const maxMin = Math.max(0, Math.round(Number(ev.max_min) || 0));
  // 今日预警事件明细 TOP（只列心率偏高，写清孩子/班级/峰值/持续分钟）
  const detailRows = await dbQuery(
    `SELECT band_mac, child_name, class_name, kind, peak_value,
            TIMESTAMPDIFF(MINUTE, first_time, last_time) AS dur_min
       FROM band_alerts
      WHERE last_time >= CURDATE() AND kind = 'hr_high'
      ORDER BY dur_min DESC, last_time DESC
      LIMIT 5`, []
  );
  const _dm = await loadMaskDisplayMap();
  const detailLines = detailRows.map((e, i) => {
    const who = e.child_name ? `${e.class_name || ''}·${maskWho(_dm, e.class_name, e.child_name)}` : `手环${String(e.band_mac).slice(-4)}`;
    return `${i + 1}.${who} 心率偏高${e.peak_value != null ? e.peak_value : '--'} 持续${Math.max(0, Math.round(Number(e.dur_min) || 0))}分钟`;
  });
  const { date } = shNowParts(new Date());
  const d = new Date(date + 'T00:00:00+08:00');
  const lines = [`📊 小鱼健康日报 · ${d.getMonth() + 1}月${d.getDate()}日`, ''];
  if (recs === 0) {
    lines.push('今日暂无手环上报数据。');
  } else {
    lines.push(`统计手环 ${s.macs || 0} 只`);
    lines.push(`平均心率 ${s.avg_hr != null ? s.avg_hr : '-'} 次/分`);
    lines.push(`平均血氧 ${s.avg_spo2 != null ? s.avg_spo2 : '-'} %`);
    lines.push(`平均步数 ${avgSteps != null ? avgSteps : '-'} 步`);
    lines.push(`平均体温 ${avgTp != null ? avgTp : '-'} ℃`);
    lines.push(`体征预警 ${alertCount} 次（高心率${hrHigh} · 高温${fever} · SOS${sos}）`);
    if (events > 0) {
      lines.push(`预警事件 ${events} 起 · 累计持续 ${totalMin} 分钟 · 最长单起 ${maxMin} 分钟`);
    }
    if (detailLines.length) {
      lines.push('重点预警明细：');
      lines.push(...detailLines);
    }
  }
  return { recs, text: lines.join('\n'), total: { macs: s.macs, avgHr: s.avg_hr, avgSpo2: s.avg_spo2, avgTp, avgSteps, alertCount, events, totalMin, maxMin } };
}

/**
 * 每日日报推送
 * @param {object} [opts] { force: true } 手动强制推送（后台「立即推送」按钮，不检查时间/开关/重复）
 */
let dailyLock = null; // 并发防抖：同一时刻只允许一次推送（防按钮双提交/双请求）
async function dailyReportOnce(opts = {}) {
  if (dailyLock) return { skipped: true, reason: 'in_flight' };
  dailyLock = (async () => {
    const force = !!opts.force;
    const today = shNowParts(new Date()).date;
    if (!force) {
      const enabled = await getSetting('bandDailyEnabled', '1');
      if (enabled !== '1') return { skipped: true, reason: 'disabled' };
      const time = String(await getSetting('bandDailyTime', '10:30') || '10:30').trim();
      const nowHm = shNowParts(new Date()).hm;
      if (nowHm < time) return { skipped: true, reason: 'not_yet', time, nowHm };
      const dup = await dbQuery('SELECT id FROM push_logs WHERE push_type="daily_report" AND ref_id=? LIMIT 1', [today]);
      if (dup.length) return { skipped: true, reason: 'already_pushed' };
    }

    const report = await buildDailyReport();
    if (!report.recs) {
      if (!force) await logPush({ push_type: 'daily_report', ref_id: today, mac: '', tousers: '', title: '今日健康日报', content: '今日无手环数据，跳过推送', errcode: -2, errmsg: 'no_data' });
      return { skipped: true, reason: 'no_data' };
    }
    // 日报接收人: 管理员 + 保健老师 + 手环覆盖班级的绑定教师（2026-09-17 杰哥定，如中4班=蒋瑶/蒋慧慧）
    const enabledClsRaw = String(await getSetting('bandEnabledClasses', '[]') || '[]').trim();
    let enabledClsIds = [];
    try { enabledClsIds = JSON.parse(enabledClsRaw).map(Number).filter(Number.isFinite); } catch (e) { enabledClsIds = []; }
    const clsPh = enabledClsIds.length ? enabledClsIds.map(() => '?').join(',') : 'NULL';
    const targets = await dbQuery(
      `SELECT wx_userid FROM users
        WHERE enabled = 1 AND wx_userid IS NOT NULL AND wx_userid <> ''
          AND (role IN ('admin','health_teacher') OR (role = 'user' AND class_id IN (${clsPh})))
        GROUP BY wx_userid`,
      enabledClsIds
    );
    if (!targets.length) {
      if (!force) await logPush({ push_type: 'daily_report', ref_id: today, mac: '', tousers: '', title: '今日健康日报', content: report.text, errcode: -2, errmsg: 'no_targets' });
      return { skipped: true, reason: 'no_targets' };
    }
    const tousers = targets.map((t) => t.wx_userid).join(',');
    const d = new Date(today + 'T00:00:00+08:00');
    const title = `📊 今日健康日报（${d.getMonth() + 1}月${d.getDate()}日）`.slice(0, 128);
    const res = await sendAppMessage({ touser: tousers, msgtype: 'textcard', title, desc: report.text.slice(0, 500), url: DAILY_REPORT_URL });
    await logPush({ push_type: 'daily_report', ref_id: today, mac: '', tousers, title, content: report.text, errcode: res && res.errcode, errmsg: res && res.errmsg });
    return { skipped: false, errcode: res && res.errcode, errmsg: res && res.errmsg, tousers: String(tousers).split(/[,|]/).filter(Boolean).length };
  })().finally(() => { dailyLock = null; });
  return dailyLock;
}

// ---------- 数据保留清理（band_records 只存最近 7 天, 每天 03:00 执行一次） ----------
let lastCleanDate = null;

async function cleanOldRecords() {
  const now = shNowParts(new Date());
  const nowHour = Number(now.hm.split(':')[0]);
  if (!Number.isFinite(nowHour) || nowHour < CLEAN_HOUR) return { skipped: true, reason: 'not_yet', now: now.hm };
  if (lastCleanDate === now.date) return { skipped: true, reason: 'already' };
  const keepDays = Number(await getSetting('bandRetainDays', String(CLEAN_RETAIN_DAYS))) || CLEAN_RETAIN_DAYS;
  const res = await dbQuery(
    `DELETE FROM band_records WHERE bp_time < NOW() - INTERVAL ${Math.max(1, keepDays)} DAY`,
    []
  );
  lastCleanDate = now.date; // 删除成功后才记已清理，失败下次 tick 重试
  console.log(`[band-jobs] 数据保留清理: 删除 ${res.affectedRows} 条 band_records (保留最近 ${keepDays} 天)`);
  return { deleted: res.affectedRows, keepDays };
}

// ---------- 调度（单 tick: 报警扫描 + 日报检查 + 数据清理） ----------
let tickTimer = null;

async function tickOnce() {
  try {
    const ev = await syncAlertEvents();
    if (ev.scanned) console.log('[band-jobs] 预警事件同步:', JSON.stringify(ev));
  } catch (e) {
    console.error('[band-jobs] 预警事件同步失败:', e);
  }
  try {
    const hr = await hrAlertOnce();
    if (!hr.disabled && hr.scanned) console.log('[band-jobs] 心率扫描:', JSON.stringify(hr));
  } catch (e) {
    console.error('[band-jobs] 心率扫描失败:', e);
  }
  try {
    const dr = await dailyReportOnce();
    if (!dr.skipped) console.log('[band-jobs] 每日健康日报已推送:', JSON.stringify(dr));
    else if (dr.reason && dr.reason !== 'not_yet') console.log('[band-jobs] 每日健康日报跳过:', JSON.stringify(dr));
  } catch (e) {
    console.error('[band-jobs] 每日健康日报失败:', e);
  }
  try {
    const cl = await cleanOldRecords();
    if (!cl.skipped) console.log('[band-jobs] 数据清理:', JSON.stringify(cl));
  } catch (e) {
    console.error('[band-jobs] 数据清理失败:', e);
  }
}

async function initBandJobs() {
  await ensurePushLogsTable();
  try {
    await ensureBandAlertsTable();
    console.log('[band-jobs] 预警事件表 band_alerts 已就绪');
  } catch (e) {
    console.error('[band-jobs] band_alerts 建表失败:', e);
  }
  tickTimer = setInterval(() => { tickOnce(); }, TICK_MS);
  console.log(`[band-jobs] 手环定时任务已启动（每 ${TICK_MS / 1000}s tick: 预警事件/心率报警/日报检查）`);
  return true;
}

module.exports = { initBandJobs, hrAlertOnce, dailyReportOnce, buildDailyReport, cleanOldRecords, syncAlertEvents, ensureBandAlertsTable };