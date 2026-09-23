/**
 * band-command — YT9 手环下行命令服务
 * HTTP API → MQTT SrvData(经网关BLE连接手环写特征) → GwData 回执解析 → band_commands 落库
 * 附带：心率阈值监听（≥阈值触发震动，带冷却）；管理端静态页面。
 *
 * 链路配方（2026-09-22 真机验收通过）：
 *  1. conn_addr_request（不带 send_infos）→ 等 sta_device_state=ready
 *  2. conn_send_data 发帧（devices+devices_num 键），type=request
 *  3. 回执走 GwData 的 sta_device_data（raw），帧回执 = a0+Command+Key(+状态)
 */
const mqtt = require('mqtt');
const mysql = require('mysql2/promise');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://127.0.0.1:7628';
const MQTT_USER = process.env.MQTT_USER || 'user';
const MQTT_PASS = process.env.MQTT_PASS || '521ZiJi123';
const PORT = Number(process.env.BAND_COMMAND_PORT || 3079);
const MYSQL = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'kindergarten_app',
  password: process.env.MYSQL_PASSWORD || '521ZiJi.',
  database: process.env.MYSQL_DATABASE || 'kindergarten_platform',
  connectionLimit: 5, waitForConnections: true, queueLimit: 0,
};

// 网关蓝牙出口：mac -> gw_addr（取最近一次广播该手环、RSSI 最强的网关）
const gwByMac = new Map();        // mac -> { gw_addr, rssi, ts }
const pendingConn = new Map();    // mac -> { msgId, gw_addr, timer, resolve, cmdId }
const pendingSend = new Map();    // mac -> { msgId, timer, resolve }
const ackWaiters = new Map();     // mac -> [{ pattern(hexPrefix), resolve, timer }]
const vibrateTimers = new Map();  // mac -> timer（找手环自动关闭）
const hrCooldown = new Map();     // mac -> ts（阈值震动冷却）
let msgIdSeq = Math.floor(Date.now() / 1000) % 1000000000;
const stats = { startedAt: new Date().toISOString(), published: 0, acks: 0, thresholdTriggers: 0, errors: 0 };

const pool = mysql.createPool(MYSQL);

async function getSettings() {
  const [rows] = await pool.query('SELECT * FROM band_command_settings WHERE id=1');
  return rows[0] || { vibrate_seconds: 3, hr_interval: 1, hr_threshold: 160, hr_cooldown_seconds: 300, hr_watch_enabled: 1 };
}
async function loadChildByMac(mac) {
  const [rows] = await pool.query(
    `SELECT m.child_id, COALESCE(ch.name, '') AS child_name
     FROM band_mapping m LEFT JOIN children ch ON ch.id = m.child_id WHERE m.band_mac = ? LIMIT 1`, [mac]);
  return rows[0] || null;
}
async function updateCommand(id, fields) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k}=?`); vals.push(v); }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE band_commands SET ${sets.join(',')} WHERE id=?`, vals);
}
async function insertCommand(rec) {
  const [r] = await pool.query(
    `INSERT INTO band_commands (band_mac, child_id, child_name, gw_addr, cmd_type, cmd_desc, payload, trigger_source, status)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [rec.band_mac, rec.child_id || null, rec.child_name || null, rec.gw_addr || null,
     rec.cmd_type, rec.cmd_desc || null, rec.payload || null, rec.trigger_source || 'manual', 'pending']);
  return r.insertId;
}

/* ---------- YT9 帧组包：帧 = 代号0xA0 + Command + Key + payload ---------- */
function frame(...bytes) { return Buffer.from([0xA0, ...bytes]); }
const FIND_BAND_ON  = () => frame(0x05, 0x03, 0x01);           // 找手环(震动)开
const FIND_BAND_OFF = () => frame(0x05, 0x03, 0x00);           // 找手环(震动)关
const HR_INTERVAL   = (code) => frame(0x02, 0x0A, 0x00, 0x00, 0x00, 0x00, code, 0x00, 0x00); // 5.3 其他功能: 心率自动检测开+间隔
const HR_SWITCH     = (on) => frame(0x05, 0x01, on ? 0x01 : 0x00);           // 8.1 心率开关

/* ---------- MQTT：SrvData 下发 + GwData 回执 ---------- */
const client = mqtt.connect(MQTT_URL, {
  username: MQTT_USER, password: MQTT_PASS,
  clientId: 'band-command-' + Math.random().toString(16).slice(2, 8),
  reconnectPeriod: 3000, connectTimeout: 10000, keepalive: 30,
});
function publish(obj) {
  stats.published++;
  client.publish('SrvData', JSON.stringify(obj));
}

// 连接手环（两步走第一步）：等 ready
function connBand(mac, gwAddr, keepTime, timeoutMs) {
  return new Promise((resolve) => {
    const msgId = ++msgIdSeq;
    pendingConn.set(mac, { msgId, gw_addr: gwAddr, resolve, timer: null });
    publish({
      pkt_type: 'command', gw_addr: gwAddr, data: {
        msgId, cmd: 'conn_addr_request',
        devices_num: 1, devices: [{ addr: mac }],
        notify_chars_num: 1, notify_chars: [{ handle: 18, cccd: 19 }],
        keep_time: keepTime,
        le_upd_req: '00', conn_params: { reject: true },
      }
    });
    const entry = pendingConn.get(mac);
    entry.timer = setTimeout(() => {
      if (pendingConn.get(mac) === entry) { pendingConn.delete(mac); resolve({ ok: false, error: '连接超时：手环未就绪' }); }
    }, timeoutMs);
  });
}
// 写数据（两步走第二步）
function sendFrames(mac, gwAddr, buffers, keepTime) {
  return new Promise((resolve) => {
    const msgId = ++msgIdSeq;
    const entry = { msgId, timer: null, resolve: null };
    pendingSend.set(mac, entry);
    publish({
      pkt_type: 'command', gw_addr: gwAddr, data: {
        msgId, cmd: 'conn_send_data',
        devices_num: 1, devices: [{ addr: mac }],
        send_num: buffers.length,
        send_infos: buffers.map(b => ({ handle: 16, type: 'request', raw: b.toString('hex') })),
      }
    });
    entry.timer = setTimeout(() => {
      if (pendingSend.get(mac) === entry) { pendingSend.delete(mac); resolve({ ok: false, error: '写入无响应：网关未确认' }); }
    }, 8000);
    entry.resolve = (v) => { clearTimeout(entry.timer); resolve(v); };
    // 写入后留 keepTime 供回执与后续帧
    setTimeout(() => { if (pendingSend.get(mac) === entry) pendingSend.delete(mac); }, keepTime * 1000);
  });
}

/* ---------- 高层命令 ---------- */
async function cmdVibrate(mac, seconds, triggerSource, cmdDesc) {
  seconds = Math.max(1, Math.min(60, seconds | 0));
  const gw = pickGw(mac);
  if (!gw) { const id = await insertCommand({ band_mac: mac, cmd_type: 'vibrate', cmd_desc: cmdDesc, trigger_source: triggerSource, payload: `${seconds}s` }); await updateCommand(id, { status: 'failed', error_msg: '手环不在任何网关覆盖内(120秒无广播)' }); return { ok: false, error: '手环不在网关覆盖范围', cmdId: id }; }
  const child = await loadChildByMac(mac);
  const keepTime = seconds + 8;
  const id = await insertCommand({ band_mac: mac, child_id: child?.child_id, child_name: child?.child_name, gw_addr: gw.gw_addr, cmd_type: 'vibrate', cmd_desc: cmdDesc || `找手环震动${seconds}秒`, trigger_source: triggerSource, payload: `${seconds}s` });
  const conn = await connBand(mac, gw.gw_addr, keepTime, 15000);
  if (!conn.ok) { await updateCommand(id, { status: 'failed', error_msg: conn.error, sent_at: new Date() }); return { ok: false, error: conn.error, cmdId: id }; }
  updateCommand(id, { status: 'sent', sent_at: new Date() }).catch(() => {});
  const wr = await sendFrames(mac, gw.gw_addr, [FIND_BAND_ON()], keepTime);
  if (!wr.ok) { await updateCommand(id, { status: 'failed', error_msg: wr.error }); return { ok: false, error: wr.error, cmdId: id }; }
  // 等 a0050301 回执（最多 6 秒）
  const acked = await waitAck(mac, 'a0050301', 6000);
  if (acked) {
    await updateCommand(id, { status: 'acked', ack_raw: 'a0050301', ack_at: new Date() });
    // 到时自动发关
    const t = setTimeout(async () => {
      vibrateTimers.delete(mac);
      try { await sendFrames(mac, gw.gw_addr, [FIND_BAND_OFF()], keepTime); await waitAck(mac, 'a0050300', 5000); } catch (e) {}
    }, seconds * 1000);
    vibrateTimers.set(mac, t);
    return { ok: true, cmdId: id, detail: `震动${seconds}秒已触发` };
  }
  // 开命令写入成功但无 ACK：result 只代表空口已发，按 sent 处理不报失败
  return { ok: true, cmdId: id, detail: '指令已发出，手环信号弱未回执', acked: false };
}

async function cmdHrInterval(mac, intervalCode) {
  const labels = { 1: '15分钟', 2: '30分钟', 3: '60分钟' };
  const gw = pickGw(mac);
  const id = await insertCommand({ band_mac: mac, cmd_type: 'heart_rate_interval', cmd_desc: `心率自动检测间隔=${labels[intervalCode] || intervalCode}`, trigger_source: 'manual', payload: `code=${intervalCode}`, gw_addr: gw?.gw_addr });
  if (!gw) { await updateCommand(id, { status: 'failed', error_msg: '手环不在网关覆盖范围' }); return { ok: false, error: '手环不在线', cmdId: id }; }
  const keepTime = 10;
  const conn = await connBand(mac, gw.gw_addr, keepTime, 15000);
  if (!conn.ok) { await updateCommand(id, { status: 'failed', error_msg: conn.error, sent_at: new Date() }); return { ok: false, error: conn.error, cmdId: id }; }
  updateCommand(id, { status: 'sent', sent_at: new Date() }).catch(() => {});
  const wr = await sendFrames(mac, gw.gw_addr, [HR_INTERVAL(intervalCode)], keepTime);
  if (!wr.ok) { await updateCommand(id, { status: 'failed', error_msg: wr.error }); return { ok: false, error: wr.error, cmdId: id }; }
  const acked = await waitAck(mac, 'a0020a01', 6000); // 5.3 设置成功回执 a0 02 0A 01
  await updateCommand(id, acked ? { status: 'acked', ack_raw: 'a0020a01', ack_at: new Date() } : { status: 'sent', error_msg: '已写入未ACK' });
  return { ok: true, cmdId: id, acked };
}

async function cmdHrSwitch(mac, on) {
  const gw = pickGw(mac);
  const id = await insertCommand({ band_mac: mac, cmd_type: 'heart_rate_switch', cmd_desc: on ? '打开心率自动检测' : '关闭心率自动检测', trigger_source: 'manual', payload: on ? 'on' : 'off', gw_addr: gw?.gw_addr });
  if (!gw) { await updateCommand(id, { status: 'failed', error_msg: '手环不在网关覆盖范围' }); return { ok: false, error: '手环不在线', cmdId: id }; }
  const conn = await connBand(mac, gw.gw_addr, 10, 15000);
  if (!conn.ok) { await updateCommand(id, { status: 'failed', error_msg: conn.error, sent_at: new Date() }); return { ok: false, error: conn.error, cmdId: id }; }
  updateCommand(id, { status: 'sent', sent_at: new Date() }).catch(() => {});
  const wr = await sendFrames(mac, gw.gw_addr, [HR_SWITCH(on)], 10);
  if (!wr.ok) { await updateCommand(id, { status: 'failed', error_msg: wr.error }); return { ok: false, error: wr.error, cmdId: id }; }
  const acked = await waitAck(mac, 'a0050101', 6000);
  await updateCommand(id, acked ? { status: 'acked', ack_raw: 'a0050101', ack_at: new Date() } : { status: 'sent', error_msg: '已写入未ACK' });
  return { ok: true, cmdId: id, acked };
}

/* ---------- 回执等待 ---------- */
function waitAck(mac, hexPrefix, timeoutMs) {
  return new Promise((resolve) => {
    const w = { pattern: hexPrefix.toLowerCase(), resolve, timer: setTimeout(() => {
      const arr = ackWaiters.get(mac) || [];
      const i = arr.indexOf(w); if (i >= 0) arr.splice(i, 1);
      resolve(false);
    }, timeoutMs) };
    if (!ackWaiters.has(mac)) ackWaiters.set(mac, []);
    ackWaiters.get(mac).push(w);
  });
}

/* ---------- 网关选择：最近 120 秒广播里 RSSI 最强的网关 ---------- */
function pickGw(mac) {
  const e = gwByMac.get(mac);
  if (!e || Date.now() - e.ts > 120 * 1000) return null;
  return e;
}

/* ---------- GwData 解析 ---------- */
function handleGwData(msg) {
  const gw = msg.gw_addr || '';
  const pkt = msg.pkt_type;
  const d = msg.data || {};
  // 扫描报告：更新 网关覆盖表
  const infos = (d.dev_infos && Array.isArray(d.dev_infos)) ? d.dev_infos : [];
  for (const dev of infos) {
    const mac = String(dev.addr || '').toLowerCase();
    if (!mac) continue;
    const prev = gwByMac.get(mac);
    if (!prev || prev.rssi < (dev.rssi || -999)) gwByMac.set(mac, { gw_addr: gw, rssi: dev.rssi, ts: Date.now() });
    else prev.ts = Date.now();
  }
  // 心率阈值监听
  checkThreshold(infos);

  // response 包（GwData 上的 pkt_type=response）：conn_addr_request / conn_send_data 的 result
  // 注意：网关不回显请求 msgId（自维护递增），只能按 resp 类型+当前 pending 匹配
  if (pkt === 'response' && d.resp) {
    if (d.resp === 'conn_addr_request') {
      for (const [mac, p] of pendingConn.entries()) {
        if (d.result !== true) { clearTimeout(p.timer); pendingConn.delete(mac); p.resolve({ ok: false, error: `网关拒绝连接(reason=${d.reason})` }); }
        break; // result:true 时继续等 ready
      }
    } else if (d.resp === 'conn_send_data') {
      for (const [mac, entry] of pendingSend.entries()) {
        clearTimeout(entry.timer);
        pendingSend.delete(mac);
        entry.resolve && entry.resolve(d.result === true ? { ok: true } : { ok: false, error: `网关写入失败(reason=${d.reason})` });
        break;
      }
    }
  }

  // state 包：连接状态 + 手环回执数据
  if (pkt === 'state' && d.state) {
    const mac = String(d.device_addr || d.addr || '').toLowerCase();
    if (d.state === 'sta_device_state' && d.device_state === 'ready') {
      const p = pendingConn.get(mac);
      if (p) { clearTimeout(p.timer); pendingConn.delete(mac); p.resolve({ ok: true }); }
    }
    if (d.state === 'sta_device_data') {
      const raws = [];
      if (d.raw) raws.push(String(d.raw).toLowerCase());
      if (d.recv_infos && d.recv_infos.raw) raws.push(String(d.recv_infos.raw).toLowerCase());
      if (Array.isArray(d.recv_infos)) for (const x of d.recv_infos) if (x && x.raw) raws.push(String(x.raw).toLowerCase());
      if (Array.isArray(d.datas)) for (const x of d.datas) if (x && x.raw) raws.push(String(x.raw).toLowerCase());
      for (const raw of raws) {
        stats.acks++;
        const arr = ackWaiters.get(mac) || [];
        for (let i = arr.length - 1; i >= 0; i--) {
          const w = arr[i];
          if (raw.startsWith(w.pattern)) { clearTimeout(w.timer); arr.splice(i, 1); w.resolve(raw); }
        }
      }
    }
  }
}

/* ---------- 心率阈值监听 ---------- */
function parseHr(advRaw) {
  if (!advRaw) return null;
  let b; try { b = Buffer.from(advRaw, 'hex'); } catch (e) { return null; }
  const i = b.indexOf(Buffer.from([0x16, 0xff]));
  if (i < 0 || b.length < i + 2 + 21) return null;
  const hr = b[i + 2 + 9];
  return (hr > 30 && hr < 220) ? hr : null;
}
async function checkThreshold(infos) {
  let s;
  try { s = await getSettings(); } catch (e) { return; }
  if (!s.hr_watch_enabled) return;
  const now = Date.now();
  for (const dev of infos) {
    const mac = String(dev.addr || '').toLowerCase();
    const hr = parseHr(dev.adv_raw);
    if (!hr || hr < s.hr_threshold) continue;
    const last = hrCooldown.get(mac) || 0;
    if (now - last < s.hr_cooldown_seconds * 1000) continue;
    hrCooldown.set(mac, now);
    stats.thresholdTriggers++;
    console.log(`[threshold] ${mac} 心率=${hr} >= ${s.hr_threshold}，触发震动`);
    cmdVibrate(mac, s.vibrate_seconds, 'threshold', `心率${hr}≥阈值${s.hr_threshold}自动震动`).catch(e => { stats.errors++; console.error('[threshold]', e.message); });
  }
}

client.on('connect', () => {
  console.log('[band-command] MQTT 已连接');
  client.subscribe('GwData', { qos: 0 }, (err) => { if (err) console.error('[subscribe GwData]', err.message); else console.log('[band-command] 已订阅 GwData'); });
});
client.on('message', (_topic, payload) => {
  try { handleGwData(JSON.parse(payload.toString())); } catch (e) { stats.errors++; console.error('[gwdata-err]', e.message, e.stack && e.stack.split('\n')[1]); }
});
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message));
client.on('error', (e) => console.error('[mqtt]', e.message));

/* ---------- HTTP API + 管理端 ---------- */
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function body(req) { return new Promise((resolve, reject) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } }); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/health') return json(res, 200, { ok: true, service: 'band-command', uptime_s: Math.round(process.uptime()), ...stats, gwKnown: gwByMac.size });
    if (p === '/api/settings') {
      if (req.method === 'GET') return json(res, 200, await getSettings());
      if (req.method === 'POST') {
        const b = await body(req);
        const s = await getSettings();
        const next = {
          vibrate_seconds: Math.max(1, Math.min(60, Number(b.vibrate_seconds ?? s.vibrate_seconds) | 0)),
          hr_interval: [1, 2, 3].includes(Number(b.hr_interval)) ? Number(b.hr_interval) : s.hr_interval,
          hr_threshold: Math.max(80, Math.min(220, Number(b.hr_threshold ?? s.hr_threshold) | 0)),
          hr_cooldown_seconds: Math.max(30, Math.min(3600, Number(b.hr_cooldown_seconds ?? s.hr_cooldown_seconds) | 0)),
          hr_watch_enabled: b.hr_watch_enabled === undefined ? s.hr_watch_enabled : (b.hr_watch_enabled ? 1 : 0),
        };
        await pool.query(`UPDATE band_command_settings SET vibrate_seconds=?, hr_interval=?, hr_threshold=?, hr_cooldown_seconds=?, hr_watch_enabled=? WHERE id=1`,
          [next.vibrate_seconds, next.hr_interval, next.hr_threshold, next.hr_cooldown_seconds, next.hr_watch_enabled]);
        return json(res, 200, { ok: true, settings: next });
      }
    }
    if (p === '/api/vibrate' && req.method === 'POST') {
      const b = await body(req);
      const mac = String(b.band_mac || '').toLowerCase().replace(/[^a-f0-9]/g, '');
      if (!mac) return json(res, 400, { ok: false, error: 'band_mac 必填' });
      const s = await getSettings();
      const r = await cmdVibrate(mac, Number(b.seconds || s.vibrate_seconds), 'manual', b.desc || null);
      return json(res, r.ok ? 200 : 500, r);
    }
    if (p === '/api/heart-rate/interval' && req.method === 'POST') {
      const b = await body(req);
      const mac = String(b.band_mac || '').toLowerCase().replace(/[^a-f0-9]/g, '');
      const code = Number(b.code || 1);
      if (!mac || ![1, 2, 3].includes(code)) return json(res, 400, { ok: false, error: 'band_mac 与 code(1/2/3) 必填' });
      const r = await cmdHrInterval(mac, code);
      return json(res, r.ok ? 200 : 500, r);
    }
    if (p === '/api/heart-rate/switch' && req.method === 'POST') {
      const b = await body(req);
      const mac = String(b.band_mac || '').toLowerCase().replace(/[^a-f0-9]/g, '');
      if (!mac) return json(res, 400, { ok: false, error: 'band_mac 必填' });
      const r = await cmdHrSwitch(mac, !!b.on);
      return json(res, r.ok ? 200 : 500, r);
    }
    if (p === '/api/bands' && req.method === 'GET') {
      // 在线手环列表（120 秒内见过广播的）+ 绑定孩子 + 最新心率
      const cutoff = new Date(Date.now() - 120 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      const [rows] = await pool.query(
        `SELECT r.band_mac, r.heart_rate, r.rssi, r.battery, r.bp_time, m.child_id, ch.name AS child_name, c.name AS class_name
         FROM band_records r
         LEFT JOIN band_mapping m ON m.band_mac = r.band_mac
         LEFT JOIN children ch ON ch.id = m.child_id
         LEFT JOIN classes c ON c.id = ch.class_id
         WHERE r.created_at >= ? AND r.id IN (
           SELECT MAX(id) FROM band_records WHERE created_at >= ? GROUP BY band_mac)`, [cutoff, cutoff]);
      return json(res, 200, { bands: rows.filter(r => gwByMac.has(r.band_mac)) });
    }
    if (p === '/api/commands' && req.method === 'GET') {
      const page = Math.max(1, Number(url.searchParams.get('page') || 1) | 0);
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 10) | 0));
      const status = url.searchParams.get('status');
      const mac = url.searchParams.get('band_mac');
      const where = [], params = [];
      if (status) { where.push('status=?'); params.push(status); }
      if (mac) { where.push('band_mac=?'); params.push(mac); }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM band_commands ${whereSql}`, params);
      const [rows] = await pool.query(
        `SELECT * FROM band_commands ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
        [...params, limit, (page - 1) * limit]);
      return json(res, 200, { commands: rows, total, page, limit });
    }
    if (p === '/' || p === '/admin') {
      const html = fs.readFileSync(path.join(__dirname, 'admin.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    stats.errors++;
    return json(res, 500, { ok: false, error: e.message });
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`[band-command] listening: ${PORT}`));
