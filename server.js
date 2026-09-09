/**
 * server.js — 精简入口
 *
 * 所有业务逻辑已拆分到：
 *   lib/helpers.js       — 工具函数
 *   lib/db.js             — 数据库初始化 + 数据访问
 *   lib/excel.js          — Excel 模板/导入/导出
 *   lib/fitness-scoring.js — 体测评分引擎
 *   routes/admin.js       — 管理后台路由
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const https = require('https');
const bcrypt = require('bcryptjs');
const { createClient } = require('redis');
const { RedisStore } = require('connect-redis');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: '登录尝试过于频繁，请15分钟后再试',
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false, xForwardedForHeader: false }
});
const { requestLogger, audit, errorLog, ensureLogDir, buildAuditChanges, buildAuditSnapshot } = require('./lib/logger');

const { gradeLabel, calculateAge, asyncHandler, normalizeText, normalizeFlexibleDate, calculateMonthAge, requireRole, expandPermissions, chinaNowText, toNullableInt, pickValue } = require('./lib/helpers');
const { initDatabase, getSettings, getHomeFeatures, getQuickLinks, buildUserDashboard, dbQuery, paginateItems, normalizePageNumber, getUserPermissions } = require('./lib/db');
const { computeFitnessResult } = require('./lib/fitness-scoring');
const { buildFitnessSummaries, buildRadarChartData } = require('./lib/fitness-analytics');
const { parseWorkbookRows, sendWorkbook, buildFitnessTemplateWorkbook } = require('./lib/excel');
const mountAdminRoutes = require('./routes/admin');
const mountVenueRoutes = require('./routes/venue');
const mountUserRoutes = require('./routes/user');
const mountBandRoutes = require('./routes/bands');
const mountScreenRoutes = require('./routes/screen');

const app = express();
const ALLOWED_MIMETYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-m4v',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/pdf'
]);
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.mp4', '.webm', '.ogg', '.mov', '.m4v',
  '.xlsx', '.xls', '.pdf'
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const extension = (path.extname(file.originalname || '') || '').toLowerCase();
    if (ALLOWED_MIMETYPES.has(file.mimetype) || ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
      cb(null, true);
    } else {
      cb(new Error('不允许上传该类型的文件: ' + file.originalname));
    }
  }
});

const PORT = Number(process.env.PORT || 3070);
const APP_START_TIME = Date.now();
const WEATHER_CITY = '无锡';
const WEATHER_CACHE_MS = 30 * 60 * 1000;
let weatherCareCache = { expiresAt: 0, data: null };

function getWeatherCareFallback() {
  return {
    city: WEATHER_CITY,
    summary: '今天也辛苦啦，记得课间喝口水。',
    detail: '天气信息暂时获取不到，户外活动前可以再看一眼窗外和场地情况。',
    temperature: '',
    rainHint: '出门前留意天气变化',
    source: 'fallback'
  };
}

function fetchJson(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'xiaoyu-health/2.0' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`weather status ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('weather timeout')));
    req.on('error', reject);
  });
}

function buildWeatherCare(data) {
  const current = data && data.current_condition && data.current_condition[0] ? data.current_condition[0] : {};
  const today = data && data.weather && data.weather[0] ? data.weather[0] : {};
  const temp = current.temp_C || '';
  const minTemp = today.mintempC || '';
  const maxTemp = today.maxtempC || '';
  const hourly = Array.isArray(today.hourly) ? today.hourly : [];
  const maxRainChance = hourly.reduce((max, item) => Math.max(max, Number(item.chanceofrain || 0)), 0);
  const desc = current.weatherDesc && current.weatherDesc[0] ? current.weatherDesc[0].value : '';
  const willRain = maxRainChance >= 50 || /雨|rain|shower/i.test(desc);
  const temperature = minTemp && maxTemp ? `${minTemp}–${maxTemp}℃` : (temp ? `${temp}℃` : '温度暂无');
  const summary = willRain
    ? `早上好，今天无锡约 ${temperature}，可能有雨，户外体能活动建议准备室内备选方案。`
    : `早上好，今天无锡约 ${temperature}，天气整体适合活动，记得提醒孩子们及时补水。`;
  return {
    city: WEATHER_CITY,
    summary,
    detail: desc ? `当前天气：${desc}。` : '愿今天也是轻松顺利的一天。',
    temperature,
    rainHint: willRain ? `降雨概率约 ${maxRainChance}%` : `降雨概率约 ${maxRainChance}%`,
    source: 'wttr.in'
  };
}

async function getWeatherCare() {
  if (weatherCareCache.data && weatherCareCache.expiresAt > Date.now()) return weatherCareCache.data;
  try {
    const url = 'https://wttr.in/' + encodeURIComponent(WEATHER_CITY) + '?format=j1&lang=zh-cn';
    const data = buildWeatherCare(await fetchJson(url));
    weatherCareCache = { expiresAt: Date.now() + WEATHER_CACHE_MS, data };
    return data;
  } catch (error) {
    const fallback = getWeatherCareFallback();
    weatherCareCache = { expiresAt: Date.now() + 5 * 60 * 1000, data: fallback };
    return fallback;
  }
}

function normalizeFitnessSortField(value) {
  const allowed = new Set(['test_date', 'child_name', 'height_score', 'bmi_score', 'grip_score', 'jump_score', 'sit_score', 'djump_score', 'obstacle_score', 'balance_score', 'total_score']);
  const v = String(value || '').trim();
  return allowed.has(v) ? v : 'test_date';
}

function normalizeSortOrder(value) {
  return String(value || '').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
}

function normalizeDateInput(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function normalizeFitnessRecordMode(value) {
  return String(value || '').trim() === 'history' ? 'history' : 'latest';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeCell(value) {
  return escapeHtml(value === null || value === undefined || value === '' ? '-' : value);
}

function formatDateOnly(value) {
  // 本地时区日期提取：mysql2 返回的 Date 是本地时刻（服务器 TZ=+8），
  // 用 toISOString 会按 UTC 截取导致日期错位 -1 天（2026-05-25 显示成 05-24）。
  // 改用本地时区组件拼接，保证 数据库日期 == 页面显示日期。
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function normalizeChildGender(value) {
  const text = normalizeText(value);
  if (text === '男') return '男';
  if (text === '女') return '女';
  return '';
}

function wantsJsonResponse(req) {
  const requestedWith = normalizeText(req.get('X-Requested-With')).toLowerCase();
  const accept = normalizeText(req.get('Accept')).toLowerCase();
  return requestedWith === 'fetch' || accept.includes('application/json');
}

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) { console.error('SESSION_SECRET 未配置, 拒绝启动'); process.exit(1); }
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let redisClient;

async function initRedis() {
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error:', err.message));
  await redisClient.connect();
}

// 2026-09-08 安全加固(P1-8.7)：按 userId 踢掉其全部 Redis 会话（connect-redis 前缀 kgp:sess:）
// 用于：禁用用户 / 重置密码 / 角色或班级变更 / 批量操作后，让目标用户旧 session 立即失效
async function kickUserSessions(userId) {
  if (!redisClient || !userId) return;
  try {
    const sessionKeys = await redisClient.keys('kgp:sess:*');
    for (const key of sessionKeys) {
      try {
        const raw = await redisClient.get(key);
        if (!raw) continue;
        const data = JSON.parse(raw);
        if (data && data.user && Number(data.user.id) === Number(userId)) {
          await redisClient.del(key);
        }
      } catch (e) { /* 单个 session 解析失败忽略 */ }
    }
  } catch (e) {
    console.error('kickUserSessions error:', e.message);
  }
}

function createSessionMiddleware() {
  return session({
    store: new RedisStore({ client: redisClient, prefix: 'kgp:sess:' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000 * 60 * 60 * 8 }
  });
}


async function syncStoredFitnessScores() {
  const records = await dbQuery(`
    SELECT fr.id, fr.test_date, fr.height_cm, fr.weight_kg, fr.grip_kg, fr.long_jump_cm,
           fr.sit_reach_cm, fr.double_jump_sec, fr.obstacle_run_sec, fr.balance_beam_sec,
           ch.gender, ch.birth_date
      FROM fitness_records fr
      JOIN children ch ON ch.id = fr.child_id
  `);

  for (const record of records) {
    const monthAge = calculateMonthAge(record.birth_date, record.test_date);
    const result = computeFitnessResult({
      heightCm: record.height_cm == null ? null : Number(record.height_cm),
      weightKg: record.weight_kg == null ? null : Number(record.weight_kg),
      gripKg: record.grip_kg == null ? null : Number(record.grip_kg),
      longJumpCm: record.long_jump_cm == null ? null : Number(record.long_jump_cm),
      sitReachCm: record.sit_reach_cm == null ? null : Number(record.sit_reach_cm),
      doubleJumpSec: record.double_jump_sec == null ? null : Number(record.double_jump_sec),
      obstacleRunSec: record.obstacle_run_sec == null ? null : Number(record.obstacle_run_sec),
      balanceBeamSec: record.balance_beam_sec == null ? null : Number(record.balance_beam_sec)
    }, record.gender, monthAge);

    await dbQuery(`
      UPDATE fitness_records
         SET bmi = ?, height_score = ?, bmi_score = ?, grip_score = ?, jump_score = ?, sit_score = ?,
             djump_score = ?, obstacle_score = ?, balance_score = ?, total_score = ?, rating = ?
       WHERE id = ?
    `, [
      result.bmi,
      result.scores.height,
      result.scores.bmi,
      result.scores.grip,
      result.scores.longJump,
      result.scores.sitReach,
      result.scores.doubleJump,
      result.scores.obstacleRun,
      result.scores.balanceBeam,
      result.totalScore,
      result.rating,
      record.id
    ]);
  }
}

async function bootstrap() {
  await initDatabase({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'kindergarten_app',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'kindergarten_platform',
    adminUsername: process.env.DEFAULT_ADMIN_USERNAME || 'admin',
    adminPassword: process.env.DEFAULT_ADMIN_PASSWORD || '521ZiJi.',
    adminName: process.env.DEFAULT_ADMIN_NAME || '系统管理员',
    userUsername: process.env.DEFAULT_USER_USERNAME || 'teacher',
    userPassword: process.env.DEFAULT_USER_PASSWORD || 'teacher123456',
    userName: process.env.DEFAULT_USER_NAME || '示例教师'
  });

  if (process.env.SYNC_FITNESS_SCORES === '1') {
    console.log('Syncing stored fitness scores...');
    await syncStoredFitnessScores();
  }
  await initRedis();
  ensureLogDir();

  // ========== Express 配置 ==========
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use('/static/uploads', express.static(path.join(__dirname, 'public', 'uploads'), {
    maxAge: '365d',
    etag: true,
    lastModified: true,
    immutable: true,
    setHeaders(res, filePath) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable, stale-while-revalidate=86400');
      // 防御: 即使有历史残留svg, 也强制下载不当页面渲染(防svg内嵌script的XSS)
      if (filePath && filePath.toLowerCase().endsWith('.svg')) {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment');
      }
    }
  }));

  app.use('/static', express.static(path.join(__dirname, 'public'), {
    maxAge: '1d',
    etag: true,
    lastModified: true
  }));
  app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'favicon.ico')));
  app.get('/apple-touch-icon.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apple-touch-icon.png')));
  app.get('/apple-touch-icon-precomposed.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apple-touch-icon.png')));
  app.get('/apple-touch-icon-120x120.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apple-touch-icon-120x120.png')));
  app.get('/apple-touch-icon-120x120-precomposed.png', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apple-touch-icon-120x120.png')));
  app.use((req, res, next) => {
    if (!req.path.startsWith('/static')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(createSessionMiddleware());
  // Flash message — merges session flash + URL query, templates use res.locals.message
  app.use((req, res, next) => {
    const flash = req.session._flashMessage || '';
    const query = req.query.message || '';
    res.locals.message = flash || query || '';
    delete req.session._flashMessage;
    req.setFlash = (msg) => { req.session._flashMessage = msg; };
    next();
  });
  app.use(requestLogger());

  app.get('/app-version', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.json({ version: APP_START_TIME });
  });

  // 全局 locals
  app.use(asyncHandler(async (req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    res.locals.cssVersion = APP_START_TIME;
    res.locals.currentPath = req.path || '/';
    res.locals.settings = await getSettings();
    res.locals.gradeLabel = gradeLabel;
    res.locals.calculateAge = calculateAge;
    res.locals.formatDateOnly = formatDateOnly;
    // RBAC 权限辅助函数
    res.locals.hasPerm = function(perm) {
      const u = req.session.user;
      if (!u || !u.permissions) return false;
      const expanded = expandPermissions(u.permissions);
      return expanded.includes(perm);
    };
    res.locals.isReadonly = !!(req.session.user && req.session.user.isReadonly);
    next();
  }));

  // ========== 公共路由 ==========
  app.get('/', asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const features = await getHomeFeatures();
    const quickLinks = await getQuickLinks();
    res.render('index', { settings, content: { features, quickLinks } });
  }));

  app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect(req.session.user.role === 'user' ? '/user' : '/admin');
    res.render('login', { error: '' });
  });

  app.post('/login', loginLimiter, asyncHandler(async (req, res) => {
    const username = normalizeText(req.body.username);
    const password = String(req.body.password || '');
    const rows = await dbQuery(
      `SELECT u.id, u.username, u.password_hash, u.role, u.name, u.birth_date, u.class_id, u.enabled, c.name AS class_name
       FROM users u LEFT JOIN classes c ON c.id = u.class_id WHERE u.username = ? LIMIT 1`,
      [username]
    );
    const user = rows[0];
    if (!user || !user.enabled || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).render('login', { error: '用户名或密码错误' });
    }
    // 加载角色权限
    const roleInfo = await getUserPermissions(user.role);
    req.session.user = {
      id: user.id, username: user.username, role: user.role, name: user.name, birthDate: user.birth_date,
      classId: user.class_id, className: user.class_name || '',
      permissions: roleInfo.permissions,
      isReadonly: roleInfo.isReadonly,
      roleDisplayName: roleInfo.roleDisplayName
    };
    // 非 user 角色都跳转到 admin 面板
    res.redirect(user.role === 'user' ? '/user' : '/admin');
  }));


  // ========== 修改密码（所有登录用户可用） ==========
  app.post('/change-password', asyncHandler(async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const oldPassword = String(req.body.oldPassword || '');
    const newPassword = String(req.body.newPassword || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!oldPassword || !newPassword) {
      const dest = req.session.user.role === 'user' ? '/user' : '/admin';
      return res.redirect(dest + '?message=' + encodeURIComponent('请填写完整的密码信息'));
    }
    if (newPassword.length < 6) {
      const dest = req.session.user.role === 'user' ? '/user' : '/admin';
      return res.redirect(dest + '?message=' + encodeURIComponent('新密码至少需要6个字符'));
    }
    if (newPassword !== confirmPassword) {
      const dest = req.session.user.role === 'user' ? '/user' : '/admin';
      return res.redirect(dest + '?message=' + encodeURIComponent('两次输入的新密码不一致'));
    }

    const rows = await dbQuery('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [req.session.user.id]);
    if (!rows.length || !bcrypt.compareSync(oldPassword, rows[0].password_hash)) {
      const dest = req.session.user.role === 'user' ? '/user' : '/admin';
      return res.redirect(dest + '?message=' + encodeURIComponent('原密码错误'));
    }

    await dbQuery('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(newPassword, 10), req.session.user.id]);
    audit('password_changed', { actor: req.session.user, ip: req.ip });

    // 2026-09-08 安全加固(P1-8.7)：改密后重建会话，强制重新登录，旧 session 立即作废
    req.session.regenerate(function () {
      res.redirect('/login?message=' + encodeURIComponent('密码修改成功，请重新登录'));
    });
    return;
  }));

  app.get('/logout', (req, res) => {
    req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/login'); });
  });

  // ========== 教师端 ==========

  // AJAX 分页：返回体测记录 HTML 片段
  // 教师体测录入

  // 幼儿个人纵向对比数据
  // 教师体测模板下载
  // 教师体测导入
  // 教师体测导出

  // ========== 管理后台路由（拆分） ==========
  mountAdminRoutes(app, upload, { kickUserSessions });

  // ========== 场地预约路由 ==========
  mountVenueRoutes(app, upload);

  // ========== 手环健康监测路由 ==========
  mountBandRoutes(app, upload);

  // ========== 数据大屏路由 ==========
  mountScreenRoutes(app);

  // 教师端 /user 路由(从server.js抽取, 依赖注入)
  const userRouteCtx = {
    asyncHandler, requireRole, normalizeText, toNullableInt, normalizeFlexibleDate,
    normalizeDateInput, normalizeChildGender, normalizeFitnessSortField, normalizeSortOrder,
    normalizeFitnessRecordMode, escapeHtml, safeCell, formatDateOnly, wantsJsonResponse,
    dbQuery, getSettings, audit, buildAuditChanges, buildAuditSnapshot, APP_START_TIME,
    buildUserDashboard, getWeatherCare, normalizePageNumber, paginateItems, chinaNowText
  };
  mountUserRoutes(app, upload, userRouteCtx);

  // ========== 健康检查 ==========
  app.get('/health', asyncHandler(async (req, res) => {
    const [dbRows, redisStatus] = await Promise.all([dbQuery('SELECT NOW() AS now_time'), redisClient.ping()]);
    res.json({ ok: true, app: 'kindergarten-fitness-platform', mysql: dbRows[0]?.now_time || null, redis: redisStatus, time: new Date().toISOString() });
  }));

  // ========== 错误处理 ==========
  app.use((req, res) => {
    if (!res.locals.settings) res.locals.settings = { siteName: '小鱼健康平台', subtitle: '' };
    if (!res.locals.currentUser) res.locals.currentUser = req.session && req.session.user ? req.session.user : null;
    if (!res.locals.cssVersion) res.locals.cssVersion = APP_START_TIME;
    res.status(404).render('error', { message: '页面不存在' });
  });
  app.use((error, req, res, next) => {
    console.error('Application error:', error);
    const errId = 'ERR-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    errorLog(error, req, errId);
    if (res.headersSent) return next(error);
    // 确保 error.ejs 的 header 能渲染（locals 中间件可能未跑完）
    if (!res.locals.settings) res.locals.settings = { siteName: '小鱼健康平台', subtitle: '' };
    if (!res.locals.currentUser) res.locals.currentUser = req.session && req.session.user ? req.session.user : null;
    if (!res.locals.cssVersion) res.locals.cssVersion = APP_START_TIME;
    res.status(500).render('error', { message: '服务暂时不可用，请稍后再试', errorId: errId });
  });

  app.listen(PORT, '0.0.0.0', () => { console.log(`Server listening on http://0.0.0.0:${PORT}`); });
}

bootstrap().catch((err) => { console.error('Bootstrap failed:', err); process.exit(1); });
