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

async function getWxAccessToken() {
  if (!WX_CORPID || !WX_SECRET) throw new Error('WX_NOT_CONFIGURED');
  const now = Date.now();
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

/**
 * 发送企业微信应用消息
 * @param {object} opts
 * @param {string} opts.touser 企微 userid，多个用逗号分隔（不能超过1000人）
 * @param {string} [opts.msgtype] 'text' | 'textcard'，默认 text
 * @param {string} [opts.content] text 消息正文
 * @param {string} [opts.title] textcard 标题（128字节内）
 * @param {string} [opts.desc] textcard 描述（512字节内，\n 换行）
 * @param {string} [opts.url] textcard 跳转链接
 * @returns {Promise<object>} 企微返回 {errcode, errmsg, invaliduser}
 */
async function sendAppMessage({ touser, msgtype = 'text', content, title, desc, url }) {
  if (!touser) throw new Error('touser 为空');
  const token = await getWxAccessToken();
  // 企微 message/send 多接收者用 | 分隔（逗号会被解析成一个无效 userid → 81013）
  const userList = String(touser).split(/[,|]/).map((s) => s.trim()).filter(Boolean).join('|');
  if (!userList) throw new Error('touser 解析后为空');
  const body = {
    touser: userList,
    msgtype,
    agentid: Number(WX_AGENT_ID),
    safe: 0,
  };
  if (msgtype === 'text') {
    body.text = { content: String(content || '').slice(0, 2048) };
  } else if (msgtype === 'textcard') {
    body.textcard = {
      title: String(title || '').slice(0, 128),
      description: String(desc || '').slice(0, 512),
      url: url || 'https://www.jiangxiyey.cn',
      btntxt: '查看详情',
    };
  } else {
    throw new Error('不支持的 msgtype: ' + msgtype);
  }
  return wxApiPost(`/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, body);
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