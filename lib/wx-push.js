// 企业微信应用消息推送模块（2026-09-10 新增）
// 复用 wx.js 相同 gettoken 逻辑，独立成模块供业务定时任务调用
// 能力: sendAppMessage 支持 text / textcard，推送记录落 push_logs 表
const { dbQuery } = require('./db');

const WX_CORPID = String(process.env.WX_CORPID || '').trim();
const WX_SECRET = String(process.env.WX_SECRET || '').trim();
const WX_AGENT_ID = String(process.env.WX_AGENT_ID || '').trim();
const WX_API = 'https://qyapi.weixin.qq.com';

let wxTokenCache = { token: '', expiresAt: 0 };
let wxTokenFetching = null;

async function wxApiGet(path) {
  const res = await fetch(WX_API + path, { signal: AbortSignal.timeout(8000) });
  return res.json();
}

async function wxApiPost(path, body) {
  const res = await fetch(WX_API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return res.json();
}

async function getWxAccessToken(forceRefresh) {
  if (!WX_CORPID || !WX_SECRET) throw new Error('WX_NOT_CONFIGURED');
  const now = Date.now();
  if (forceRefresh) wxTokenCache = { token: '', expiresAt: 0 }; // 40014/42001 时强制刷新
  if (wxTokenCache.token && now < wxTokenCache.expiresAt) return wxTokenCache.token;
  if (wxTokenFetching) return wxTokenFetching;
  wxTokenFetching = (async () => {
    const data = await wxApiGet(`/cgi-bin/gettoken?corpid=${encodeURIComponent(WX_CORPID)}&corpsecret=${encodeURIComponent(WX_SECRET)}`);
    if (data.errcode) throw new Error(`WX_GETTOKEN_${data.errcode}:${data.errmsg}`);
    wxTokenCache = { token: data.access_token, expiresAt: now + (Number(data.expires_in || 7200) - 300) * 1000 };
    return data.access_token;
  })().finally(() => { wxTokenFetching = null; });
  return wxTokenFetching;
}

// 按 UTF-8 字节数截断（企微 title=128字节 / description=512字节 按字节算，中文 3 字节/字）
function truncBytes(s, maxBytes) {
  const str = String(s == null ? '' : s);
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  let out = ''; let used = 0;
  for (const ch of str) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (used + b > maxBytes) break;
    out += ch; used += b;
  }
  return out;
}

// 单条消息发送（text 最多 1000 人 / record 最多 100 人，调用方负责分批），带 1 次重试（2026-09-27）
async function sendOne(msgtype, userList, payload, agentid) {
  const build = (t) => ({ touser: userList, msgtype, agentid, safe: 0, ...payload(t) });
  let token = await getWxAccessToken();
  try {
    let r = await wxApiPost(`/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, build(token));
    // token 失效 → 强制刷新后重试 1 次
    if (r && (r.errcode === 40014 || r.errcode === 42001)) {
      token = await getWxAccessToken(true);
      r = await wxApiPost(`/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, build(token));
    }
    return r || { errcode: -1, errmsg: 'empty_response' };
  } catch (e) {
    // 网络异常 → 重试 1 次
    try {
      token = await getWxAccessToken(true);
      return await wxApiPost(`/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, build(token)) || { errcode: -1, errmsg: 'empty_response' };
    } catch (e2) {
      return { errcode: -1, errmsg: `network:${(e2 && e2.message) || e2}` };
    }
  }
}

/**
 * 发送企业微信应用消息（自动分批：text 每批≤1000人，textcard 每批≤100人）
 * @param {object} opts
 * @param {string} opts.touser 企微 userid，多个用逗号/竖线分隔
 * @param {string} [opts.msgtype] 'text' | 'textcard'，默认 text
 * @param {string} [opts.content] text 消息正文
 * @param {string} [opts.title] textcard 标题（128字节内）
 * @param {string} [opts.desc] textcard 描述（512字节内，\n 换行）
 * @param {string} [opts.url] textcard 跳转链接
 * @returns {Promise<object>} 企微返回 {errcode, errmsg, invaliduser}；任一批失败即取首个失败结果
 */
async function sendAppMessage({ touser, msgtype = 'text', content, title, desc, url }) {
  if (!touser) throw new Error('touser 为空');
  // 企微 message/send 多接收者用 | 分隔（逗号会被解析成一个无效 userid → 81013）
  const users = String(touser).split(/[,|]/).map((s) => s.trim()).filter(Boolean);
  if (!users.length) throw new Error('touser 解析后为空');
  const agentid = Number(WX_AGENT_ID);
  let textBytes; let card;
  if (msgtype === 'text') {
    textBytes = truncBytes(String(content || ''), 2048); // 企微按字节限制
  } else if (msgtype === 'textcard') {
    card = { title: truncBytes(String(title || ''), 128), description: truncBytes(String(desc || ''), 512), url: url || 'https://www.jiangxiyey.cn', btntxt: '查看详情' };
  } else {
    throw new Error('不支持的 msgtype: ' + msgtype);
  }
  // 单批上限：textcard 企微限 100 人，text 限 1000 人（2026-09-27，原实现无分批会整体失败）
  const batchSize = msgtype === 'textcard' ? 100 : 1000;
  const payload = () => (msgtype === 'text' ? { text: { content: textBytes } } : { textcard: card });
  let firstErr = null; let invalid = [];
  for (let i = 0; i < users.length; i += batchSize) {
    const chunk = users.slice(i, i + batchSize).join('|');
    const r = await sendOne(msgtype, chunk, payload, agentid);
    if (r && r.invaliduser) invalid = invalid.concat(String(r.invaliduser).split('|').filter(Boolean));
    if (!r || r.errcode !== 0) { if (!firstErr) firstErr = r || { errcode: -1, errmsg: 'empty_response' }; }
  }
  if (firstErr) return { ...firstErr, invaliduser: invalid.join('|') };
  return { errcode: 0, errmsg: 'ok', invaliduser: invalid.join('|') };
}

// push_logs 表（幂等建表）
async function ensurePushLogsTable() {
  await dbQuery(`CREATE TABLE IF NOT EXISTS push_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    push_type VARCHAR(32) NOT NULL,
    ref_id VARCHAR(64) NOT NULL DEFAULT '',
    mac VARCHAR(32) NOT NULL DEFAULT '',
    tousers VARCHAR(255) NOT NULL DEFAULT '',
    title VARCHAR(255) NOT NULL DEFAULT '',
    content TEXT,
    wx_errcode INT NOT NULL DEFAULT -1,
    wx_errmsg VARCHAR(255) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_type_ref (push_type, ref_id),
    KEY idx_mac_time (mac, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  return true;
}

async function logPush({ push_type, ref_id, mac, tousers, title, content, errcode, errmsg }) {
  await dbQuery(
    'INSERT INTO push_logs (push_type, ref_id, mac, tousers, title, content, wx_errcode, wx_errmsg) VALUES (?,?,?,?,?,?,?,?)',
    [push_type, String(ref_id || ''), String(mac || ''), String(tousers || ''), String(title || ''), String(content || ''), Number.isFinite(errcode) ? errcode : -1, String(errmsg || '')]
  );
}

module.exports = { getWxAccessToken, sendAppMessage, ensurePushLogsTable, logPush, WX_AGENT_ID };