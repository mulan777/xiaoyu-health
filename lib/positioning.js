/**
 * 南操场三分区定位算法（正式版）
 * ============================================
 * 输入：band_records 三台南操场网关的 (gw_addr, bp_time, rssi) 记录
 * 输出：按手环的分区时间线（每段：起止时间、分区、置信度）
 *
 * 算法管线：
 *   1. 30 秒桶聚合：每桶内每网关 RSSI 取平均（滤单条噪声）
 *   2. 桶级区域判定：三网关平均 RSSI 最强者胜出；
 *      若最强者 < EDGE_DBM(-75) 视为覆盖边缘，低置信
 *   3. 迟滞切换：新区域需连续 HYS_CONFIRM(2) 个有效桶才正式切换，
 *      边缘低置信桶不参与切换确认（滤边界抖动）
 *   4. 短段合并：持续 < MIN_STAY_SEC(90s) 的片段并入前后较长段
 *   5. 覆盖外判定：超过 OFFLINE_SEC(180s) 无样本记为「离开覆盖」
 *
 * 网关布局（2026-09-25 杰哥标定：南操场长边三等分）
 *   c0656f554509 = 1区(西)   c8fe97a0102f = 2区(中)   c78a168bef18 = 3区(东)
 */

const SOUTH_GW_ZONES = {
  'c0656f554509': '1区(西)',
  'c8fe97a0102f': '2区(中)',
  'c78a168bef18': '3区(东)',
};

const ZONE_ORDER = ['1区(西)', '2区(中)', '3区(东)'];

const BUCKET_SEC = 30;        // 聚合桶宽
const EDGE_DBM = -75;         // 最强信号低于此 = 覆盖边缘
const HYS_CONFIRM = 2;        // 新区域需连续 N 个有效桶
const MIN_STAY_SEC = 90;      // 片段最短持续，短于此并入邻段
const OFFLINE_SEC = 180;      // 无样本超过此值 = 离开覆盖

function toDate(dt) {
  if (dt instanceof Date) return new Date(dt.getTime());
  return new Date(String(dt).replace(' ', 'T'));
}

function bucketKey(dt) {
  const d = toDate(dt);
  d.setSeconds(Math.floor(d.getSeconds() / BUCKET_SEC) * BUCKET_SEC, 0);
  return d;
}

function fmt(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 核心入口：单手环轨迹计算
 * @param {Array<{gw_addr,bp_time,rssi}>} rows 该手环的南操场网关记录（时间乱序可）
 * @returns {{segments: Array<{start,end,zone,confidence,avg_rssi}>, buckets: number}}
 */
function computeTrace(rows) {
  // 1. 桶聚合
  const buckets = new Map(); // Date -> {gw: [rssi...]}
  for (const r of rows) {
    if (r.rssi == null || !SOUTH_GW_ZONES[r.gw_addr]) continue;
    const k = bucketKey(r.bp_time);
    if (!buckets.has(k)) buckets.set(k, {});
    const b = buckets.get(k);
    (b[r.gw_addr] = b[r.gw_addr] || []).push(Number(r.rssi));
  }
  const times = [...buckets.keys()].sort((a, b) => a - b);

  // 2. 桶级判定
  const judged = times.map(t => {
    const b = buckets.get(t);
    const avg = {};
    for (const [gw, arr] of Object.entries(b)) avg[gw] = arr.reduce((s, v) => s + v, 0) / arr.length;
    const entries = Object.entries(avg);
    if (!entries.length) return null;
    let best = entries[0];
    for (const e of entries) if (e[1] > best[1]) best = e;
    return {
      t,
      zone: SOUTH_GW_ZONES[best[0]],
      gw: best[0],
      avg_rssi: Math.round(best[1]),
      edge: best[1] < EDGE_DBM, // 覆盖边缘 = 低置信
    };
  }).filter(Boolean);

  // 3. 迟滞切换
  const segs = [];
  let cur = null;        // 当前正式区域
  let pending = null;    // 候选 {zone, count}
  for (const j of judged) {
    if (!cur) {
      cur = j; pending = null;
      segs.push({ start: j.t, end: j.t, zone: j.zone, gw: j.gw, avg_rssi: j.avg_rssi, confidence: j.edge ? 'low' : 'high' });
      continue;
    }
    const last = segs[segs.length - 1];
    if (j.zone === cur.zone) { pending = null; last.end = j.t; last.avg_rssi = j.avg_rssi; continue; }
    // 候选区域：必须非边缘才计确认数
    if (!j.edge) {
      if (!pending || pending.zone !== j.zone) pending = { zone: j.zone, gw: j.gw, count: 1, last: j };
      else pending.count++;
      if (pending.count >= HYS_CONFIRM) {
        cur = pending.last;
        segs.push({ start: cur.t, end: cur.t, zone: cur.zone, gw: cur.gw, avg_rssi: cur.avg_rssi, confidence: 'high' });
        pending = null;
      }
    }
    // 边缘桶：不确认、不切换，只在同区域时延长时间
    else if (j.zone === cur.zone) { last.end = j.t; }
  }

  // 4. 短段合并：将 <MIN_STAY_SEC 的片段并入时间上相邻的较长段
  const merged = [];
  for (const s of segs) {
    const dur = (s.end - s.start) / 1000 + BUCKET_SEC;
    merged.push({ ...s, _dur: dur });
  }
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged.length <= 1) break;
    const s = merged[i];
    if (s._dur >= MIN_STAY_SEC) continue;
    const prev = merged[i - 1], next = merged[i + 1];
    // 并入相邻同区段或较长邻段（保持 Date 类型）
    if (prev && next) {
      const target = prev._dur >= next._dur ? prev : next;
      if (s.start < target.start) target.start = s.start;
      if (s.end > target.end) target.end = s.end;
      merged.splice(i, 1);
    } else if (prev) { if (s.end > prev.end) prev.end = s.end; merged.splice(i, 1); }
    else if (next) { if (s.start < next.start) next.start = s.start; merged.splice(i, 1); }
  }

  // 5. 覆盖外间隙插入「离开覆盖」段
  const out = [];
  for (let i = 0; i < merged.length; i++) {
    const s = merged[i];
    if (out.length) {
      const gapSec = (s.start - out[out.length - 1].end) / 1000;
      if (gapSec > OFFLINE_SEC) {
        out.push({ start: fmt(new Date(out[out.length - 1].end.getTime() + BUCKET_SEC * 1000)),
                   end: fmt(new Date(s.start.getTime() - BUCKET_SEC * 1000)),
                   zone: '覆盖外', confidence: 'none', avg_rssi: null });
      }
    }
    out.push({ start: fmt(s.start), end: fmt(s.end), zone: s.zone, confidence: s.confidence, avg_rssi: s.avg_rssi });
  }
  return { segments: out, buckets: judged.length };
}

/** 批量：多手环轨迹。rows 需含 band_mac */
function computeTraces(rows) {
  const byband = new Map();
  for (const r of rows) {
    (byband.get(r.band_mac) || byband.set(r.band_mac, []).get(r.band_mac)).push(r);
  }
  const result = {};
  for (const [mac, list] of byband) result[mac] = computeTrace(list);
  return result;
}

/** 分区停留统计（秒） */
function staySummary(trace) {
  const sum = {};
  for (const s of trace.segments) {
    if (s.zone === '覆盖外') continue;
    sum[s.zone] = (sum[s.zone] || 0) + (new Date(s.end.replace(' ', 'T')) - new Date(s.start.replace(' ', 'T'))) / 1000 + BUCKET_SEC;
  }
  return sum;
}

module.exports = { SOUTH_GW_ZONES, ZONE_ORDER, computeTrace, computeTraces, staySummary };
