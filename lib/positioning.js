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
  // Numeric keys merge all samples in the same 30s bucket; Date object
  // keys compare by identity and previously created one bucket per record.
  const buckets = new Map();
  for (const r of rows) {
    const gw = String(r.gw_addr || '').toLowerCase();
    const value = Number(r.rssi);
    const ms = toDate(r.bp_time).getTime();
    if (r.rssi == null || !Number.isFinite(value) || !Number.isFinite(ms) || !SOUTH_GW_ZONES[gw]) continue;
    const key = Math.floor(ms / (BUCKET_SEC * 1000)) * BUCKET_SEC * 1000;
    if (!buckets.has(key)) buckets.set(key, new Map());
    const bucket = buckets.get(key);
    const agg = bucket.get(gw) || { sum: 0, count: 0 };
    agg.sum += value; agg.count++;
    bucket.set(gw, agg);
  }
  const judged = [...buckets.keys()].sort((a, b) => a - b).map(ms => {
    const entries = [...buckets.get(ms)].map(([gw, a]) => [gw, a.sum / a.count]);
    // Deterministic tie break, independent of SQL row order.
    entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [gw, value] = entries[0];
    return { t: new Date(ms), zone: SOUTH_GW_ZONES[gw], avg_rssi: Math.round(value), edge: value < EDGE_DBM };
  });

  const runs = [];
  let run = [], current = null, pending = null, previous = null;
  for (const j of judged) {
    if (previous && (j.t - previous.t) / 1000 > OFFLINE_SEC) {
      runs.push(run); run = []; current = null; pending = null;
    }
    previous = j;
    if (!current) {
      current = j;
      run.push({ start: j.t, end: j.t, zone: j.zone, avg_rssi: j.avg_rssi, confidence: j.edge ? 'low' : 'high' });
      continue;
    }
    const last = run[run.length - 1];
    if (j.zone === current.zone) {
      pending = null; last.end = j.t; last.avg_rssi = j.avg_rssi;
      continue;
    }
    if (j.edge) { pending = null; last.end = j.t; continue; }
    if (!pending || pending.zone !== j.zone) pending = { zone: j.zone, count: 1, first: j };
    else pending.count++;
    if (pending.count >= HYS_CONFIRM) {
      current = j;
      last.end = new Date(Math.max(last.start.getTime(), pending.first.t.getTime() - BUCKET_SEC * 1000));
      run.push({ start: pending.first.t, end: j.t, zone: j.zone, avg_rssi: j.avg_rssi, confidence: 'high' });
      pending = null;
    } else last.end = j.t;
  }
  if (run.length) runs.push(run);

  // Merge short noise segments inside continuous coverage only.
  const duration = s => (s.end - s.start) / 1000 + BUCKET_SEC;
  for (const segments of runs) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments.length <= 1 || duration(segments[i]) >= MIN_STAY_SEC) continue;
      const seg = segments[i], prev = segments[i - 1], next = segments[i + 1];
      const target = prev && next ? (duration(prev) >= duration(next) ? prev : next) : prev || next;
      if (seg.start < target.start) target.start = seg.start;
      if (seg.end > target.end) target.end = seg.end;
      segments.splice(i, 1);
    }
    for (let i = segments.length - 1; i > 0; i--) {
      if (segments[i].zone === segments[i - 1].zone) {
        segments[i - 1].end = segments[i].end;
        segments.splice(i, 1);
      }
    }
  }
  const out = [];
  let lastEnd = null;
  for (const segments of runs) {
    if (lastEnd) out.push({ start: fmt(new Date(lastEnd.getTime() + BUCKET_SEC * 1000)),
      end: fmt(new Date(segments[0].start.getTime() - BUCKET_SEC * 1000)),
      zone: '覆盖外', confidence: 'none', avg_rssi: null });
    for (const seg of segments) out.push({ start: fmt(seg.start), end: fmt(seg.end),
      zone: seg.zone, confidence: seg.confidence, avg_rssi: seg.avg_rssi });
    lastEnd = segments[segments.length - 1].end;
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
