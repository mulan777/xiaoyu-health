// 小鱼健康 · 手环业务定时任务（2026-09-10 新增, 2026-09-10 改版: 时间/开关后台可配）
// 1) 心率超标报警：每 60s 扫最近 3 分钟 band_records, 心率 > 阈值（site_settings.bandHrAlert, 默认180）
//    同一记录去重 + 同一手环 5 分钟内静默；推送孩子班级老师(role=user 已绑企微)，无则 admin
// 2) 每日健康日报：每天到点（site_settings.bandDailyTime, 默认 10:30）且当天未推过 → 汇总推送 admin+health_teacher
// 开关: bandHrEnabled / bandDailyEnabled ('1'/'0')
const { dbQuery } = require('./db');
const { ensurePushLogsTable, sendAppMessage, logPush } = require('./wx-push');

const TICK_MS = 60 * 1000;        // 心跳周期（报警扫描 + 日报检查）
const HR_ALERT_WINDOW_MIN = 3;    // 报警扫描窗口
const HR_ALERT_DEFAULT = 180;     // 默认心率阈值
const HR_SILENCE_MIN = 5;         // 同一手环静默期
const HR_ALERT_URL = 'https://www.jiangxiyey.cn/admin?panel=alert&focus=1';   // 心率警报卡片跳转 -> 警报面板(专注模式, 面板key=alert 无s)
const DAILY_REPORT_URL = 'https://www.jiangxiyey.cn/admin?panel=report&focus=1'; // 日报卡片跳转 -> 日报面板(专注模式)
const TZ = 'Asia/Shanghai';

function zp(n) { return String(n).padStart(2, '0'); }

// 上海时区当前 HH:MM 与 YYYY-MM-DD
function shNowParts(now) {
  const d = new Date(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
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

// ---------- 心率超标报警 ----------
async function hrAlertOnce() {
  const enabled = await getSetting('bandHrEnabled', '1');
  if (enabled !== '1') return { disabled: true };
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

    let targets = [];
    if (r.class_id) {
      targets = await dbQuery(
        'SELECT wx_userid FROM users WHERE role="user" AND class_id=? AND wx_userid IS NOT NULL AND wx_userid<>""',
        [r.class_id]
      );
    }
    if (!targets.length) {
      targets = await dbQuery('SELECT wx_userid FROM users WHERE role="admin" AND wx_userid IS NOT NULL AND wx_userid<>""');
    }
    if (!targets.length) {
      await logPush({ push_type: 'hr_alert', ref_id: String(r.id), mac: r.band_mac, tousers: '', title: '心率预警', content: '无人可推送（无已绑企微的教师/管理员）', errcode: -2, errmsg: 'no_targets' });
      continue;
    }
    const tousers = targets.map((t) => t.wx_userid).join(',');
    const who = r.child_name ? `${r.class_name || ''} · ${r.child_name}` : `手环 ${r.band_mac}（未绑定孩子）`;
    const title = `🚨 心率预警：${who}`.slice(0, 64);
    const desc = `当前心率 ${r.heart_rate} 次/分（阈值 ${threshold}）\n数据时间：${fmtTime(r.bp_time)}\n请老师尽快查看孩子状况，必要时联系保健老师。`;
    // 卡片链接带本条记录ID, 点开直达该条警报详情
    const alertUrl = `${HR_ALERT_URL}&id=${r.id}`;
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

// ---------- 每日健康日报 ----------
async function buildDailyReport() {
  const row = await dbQuery(
    `SELECT COUNT(*) AS recs,
            COUNT(DISTINCT band_mac) AS macs,
            ROUND(AVG(CASE WHEN heart_rate > 0 THEN heart_rate END)) AS avg_hr,
            MAX(heart_rate) AS max_hr,
            SUM(heart_rate > 170) AS hr_high,
            SUM(body_temp > 37.3) AS fever_events,
            SUM(sos = 1) AS sos_count,
            ROUND(AVG(CASE WHEN steps > 0 THEN steps END)) AS avg_steps
     FROM band_records WHERE bp_time >= CURDATE()`,
    []
  );
  const s = row[0] || {};
  const recs = Number(s.recs) || 0;

  const byClass = await dbQuery(
    `SELECT c.name AS class_name, COUNT(*) AS recs, COUNT(DISTINCT b.band_mac) AS macs,
            ROUND(AVG(CASE WHEN b.heart_rate > 0 THEN b.heart_rate END)) AS avg_hr,
            MAX(b.heart_rate) AS max_hr, SUM(b.heart_rate > 170) AS hr_high,
            SUM(b.body_temp > 37.3) AS fever_events, SUM(b.sos = 1) AS sos_count
     FROM band_records b
     JOIN band_mapping m ON m.band_mac = b.band_mac
     JOIN children ch ON ch.id = m.child_id
     JOIN classes c ON c.id = ch.class_id
     WHERE b.bp_time >= CURDATE()
     GROUP BY c.id, c.name ORDER BY c.id`,
    []
  );
  const boundMacs = byClass.reduce((a, x) => a + Number(x.macs || 0), 0);
  const { date } = shNowParts(new Date());
  const d = new Date(date + 'T00:00:00+08:00');
  let lines = [`📊 小鱼健康日报 · ${d.getMonth() + 1}月${d.getDate()}日`, ''];
  if (recs === 0) {
    lines.push('今日暂无手环上报数据。');
  } else {
    lines.push(`今日上报 ${recs} 条 · 手环 ${s.macs} 只`);
    lines.push(`平均心率 ${s.avg_hr || '-'} · 最高 ${s.max_hr || '-'}`);
    lines.push(`心率>170 共 ${s.hr_high || 0} 次 · 体温>37.3℃ 共 ${s.fever_events || 0} 次`);
    lines.push(`SOS 报警 ${s.sos_count || 0} 次 · 平均步数 ${s.avg_steps || '-'}`);
    if (byClass.length) {
      lines.push('');
      lines.push('【已绑定班级明细】');
      for (const x of byClass) {
        lines.push(`${x.class_name}：${x.recs}条 · avg${x.avg_hr || '-'} · max${x.max_hr || '-'} · 高心率${x.hr_high || 0} · 体温高${x.fever_events || 0} · SOS${x.sos_count || 0}`);
      }
    }
    if (boundMacs < Number(s.macs || 0)) {
      lines.push('');
      lines.push(`提示：还有 ${(s.macs || 0) - boundMacs} 只手环未绑定孩子，绑定后日报可精确到班级。`);
    }
  }
  return { recs, text: lines.join('\n'), byClass, total: s };
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
    const targets = await dbQuery('SELECT wx_userid FROM users WHERE role IN ("admin","health_teacher") AND wx_userid IS NOT NULL AND wx_userid<>""');
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

// ---------- 调度（单 tick: 报警扫描 + 日报检查） ----------
let tickTimer = null;

async function tickOnce() {
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
}

async function initBandJobs() {
  await ensurePushLogsTable();
  tickTimer = setInterval(() => { tickOnce(); }, TICK_MS);
  console.log(`[band-jobs] 手环定时任务已启动（每 ${TICK_MS / 1000}s tick: 心率报警/日报检查）`);
  return true;
}

module.exports = { initBandJobs, hrAlertOnce, dailyReportOnce, buildDailyReport };