// 企业微信工作台无感登录（2026-09-09）
// 流程: 企微工作台打开 /wxoauth → 自动带 code → 换 userid → 匹配平台账号(先 wx_userid 后按姓名) → 直接建会话
// 未匹配/重名 → /login?wxbind=1 → 账号密码登录一次完成绑定，之后永久无感
const express = require('express');
const crypto = require('crypto');
const { dbQuery, getUserPermissions } = require('../lib/db');
const { asyncHandler } = require('../lib/helpers');

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

const USER_SELECT =
  'SELECT u.id, u.username, u.role, u.name, u.birth_date, u.class_id, u.enabled, c.name AS class_name ' +
  'FROM users u LEFT JOIN classes c ON c.id = u.class_id ';

async function loginAsUser(req, res, user) {
  const roleInfo = await getUserPermissions(user.role);
  req.session.user = {
    id: user.id, username: user.username, role: user.role, name: user.name,
    birthDate: user.birth_date, classId: user.class_id, className: user.class_name || '',
    permissions: roleInfo.permissions, isReadonly: roleInfo.isReadonly,
    roleDisplayName: roleInfo.roleDisplayName
  };
  // 诊断日志: 定位「点卡片→登录→回跳目标丢失」问题
  console.log('[wx-login]', JSON.stringify({
    user: user && user.username, role: user && user.role,
    next: req.session.loginNext, path: req.originalUrl, hasCookie: !!req.headers.cookie
  }));
  // 登录前想去的页面（requireRole 未登录时记录）→ 登录后跳回；仅限站内路径防开放重定向
  const next = req.session.loginNext;
  delete req.session.loginNext;
  if (next && typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !/^\/\//.test(next) && !/https?:\/\//i.test(next)) {
    return res.redirect(next);
  }
  res.redirect(user.role === 'user' ? '/user' : '/admin');
}

module.exports = function mountWxRoutes(app) {
  const router = express.Router();

  // 企微 OAuth 无感登录入口
  router.get('/wxoauth', asyncHandler(async (req, res) => {
    if (req.session.user) return res.redirect(req.session.user.role === 'user' ? '/user' : '/admin');
    if (!WX_CORPID || !WX_SECRET) {
      return res.status(500).send('企业微信未配置（.env 缺 WX_CORPID/WX_SECRET）');
    }

    const { code, state } = req.query;

    // 无 code → 跳企微授权（企微内 snsapi_base 静默，外部浏览器打开也会走）
    if (!code) {
      const st = crypto.randomBytes(12).toString('hex');
      req.session.wxOauthState = st;
      const redirectUri = `${req.protocol}://${req.get('host')}/wxoauth`;
      const url = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(WX_CORPID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_base&state=${st}#wechat_redirect`;
      return res.redirect(url);
    }

    // state 防 CSRF
    const st = req.session.wxOauthState;
    req.session.wxOauthState = null;
    if (!st || st !== String(state || '')) return res.status(400).send('state 校验失败，请重新打开');

    // code 换 userid
    const token = await getWxAccessToken();
    const info = await wxApiGet(`/cgi-bin/auth/getuserinfo?access_token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`);
    if (info.errcode) {
      return res.status(401).render('login', { error: '企微登录失败：' + (info.errmsg || ('err_' + info.errcode)), wxbind: '', wxname: '', wxdup: '' });
    }
    const wxUserid = info.userid || '';
    if (!wxUserid) {
      return res.status(401).render('login', { error: '未获取到企业成员信息，请在企业微信客户端中打开', wxbind: '', wxname: '', wxdup: '' });
    }

    // 1) 已绑定 userid → 直接登录
    const bound = await dbQuery(USER_SELECT + 'WHERE u.wx_userid = ? LIMIT 1', [wxUserid]);
    if (bound.length) return loginAsUser(req, res, bound[0]);

    // 2) 按姓名匹配平台账号
    const detail = await wxApiGet(`/cgi-bin/user/get?access_token=${encodeURIComponent(token)}&userid=${encodeURIComponent(wxUserid)}`);
    if (detail.errcode === 0 && detail.name) {
      const candidates = await dbQuery(USER_SELECT + 'WHERE u.username = ? AND u.enabled = 1', [detail.name]);
      if (candidates.length === 1) {
        await dbQuery('UPDATE users SET wx_userid = ? WHERE id = ?', [wxUserid, candidates[0].id]);
        return loginAsUser(req, res, candidates[0]);
      }
      req.session.wxPendingUserid = wxUserid;
      req.session.wxPendingName = detail.name;
      const dup = candidates.length > 1 ? '&dup=1' : '';
      return res.redirect('/login?wxbind=1&name=' + encodeURIComponent(detail.name) + dup);
    }

    // 3) 姓名读不到（应用无通讯录权限等）→ 绑定模式兜底
    req.session.wxPendingUserid = wxUserid;
    req.session.wxPendingName = detail.name || '';
    return res.redirect('/login?wxbind=1');
  }));

  // 连通性自检（不回显 secret）
  router.get('/wxoauth-test', asyncHandler(async (req, res) => {
    try {
      const token = await getWxAccessToken();
      res.json({ ok: true, corpid: WX_CORPID, agentId: WX_AGENT_ID, tokenOk: token.length > 0 });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }));

  app.use(router);
};