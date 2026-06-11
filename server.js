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

const app = express();
const ALLOWED_MIMETYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-m4v',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/pdf'
]);
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
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

function buildUserFitnessQuery(source = {}) {
  return {
    recordMode: normalizeFitnessRecordMode(source.recordMode),
    batchDate: normalizeDateInput(source.batchDate),
    detailBatchDate: normalizeDateInput(source.detailBatchDate),
    keyword: normalizeText(source.keyword),
    rating: ['优秀', '良好', '合格', '不合格'].includes(normalizeText(source.rating)) ? normalizeText(source.rating) : '',
    dateFrom: normalizeDateInput(source.dateFrom),
    dateTo: normalizeDateInput(source.dateTo),
    sortField: normalizeFitnessSortField(source.sortField),
    sortOrder: normalizeSortOrder(source.sortOrder)
  };
}

function buildUserFitnessQueryString(query = {}, extras = {}) {
  const params = new URLSearchParams();
  const merged = { ...query, ...extras };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null || String(value) === '') continue;
    params.set(key, String(value));
  }
  return params.toString();
}

function pickLatestFitnessRecordsByChild(records) {
  const latestByChild = new Map();
  for (const item of Array.isArray(records) ? records : []) {
    const childId = Number(item.child_id || 0);
    if (!childId) continue;
    const current = latestByChild.get(childId);
    const incomingDate = item.test_date ? new Date(item.test_date).getTime() : 0;
    const currentDate = current && current.test_date ? new Date(current.test_date).getTime() : 0;
    const incomingId = Number(item.id || 0);
    const currentId = current ? Number(current.id || 0) : 0;
    if (!current || incomingDate > currentDate || (incomingDate === currentDate && incomingId > currentId)) {
      latestByChild.set(childId, item);
    }
  }
  return Array.from(latestByChild.values());
}

function formatDateOnly(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : '';
}

function buildUserEntryUrl(message = '', extras = {}) {
  const params = new URLSearchParams();
  params.set('view', 'entry');
  Object.entries(extras || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || String(value) === '') return;
    params.set(key, String(value));
  });
  if (message) params.set('message', message);
  return `/user?${params.toString()}`;
}

function buildUserRecordRedirectState(source = {}) {
  return {
    childPage: normalizePageNumber(source.childPage, 1),
    recordPage: normalizePageNumber(source.recordPage, 1),
    ...buildUserFitnessQuery(source)
  };
}

function buildUserRecordsUrl(message = '', extras = {}) {
  const params = new URLSearchParams();
  params.set('view', 'records');
  Object.entries(extras || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || String(value) === '') return;
    params.set(key, String(value));
  });
  if (message) params.set('message', message);
  return `/user?${params.toString()}`;
}

function normalizeChildGender(value) {
  const text = normalizeText(value);
  if (text === '男') return '男';
  if (text === '女') return '女';
  return '';
}

const USER_FITNESS_METRIC_LABELS = {
  heightCm: '身高(CM)',
  weightKg: '体重(KG)',
  gripKg: '握力(KG)',
  longJumpCm: '立定跳远(CM)',
  sitReachCm: '坐位体前屈(CM)',
  doubleJumpSec: '双脚连续跳(秒)',
  obstacleRunSec: '15米绕障碍跑(秒)',
  balanceBeamSec: '走平衡木(秒)'
};

function wantsJsonResponse(req) {
  const requestedWith = normalizeText(req.get('X-Requested-With')).toLowerCase();
  const accept = normalizeText(req.get('Accept')).toLowerCase();
  return requestedWith === 'fetch' || accept.includes('application/json');
}

function sendUserEntryResponse(req, res, statusCode, message = '', extras = {}, payload = {}) {
  const redirectUrl = buildUserEntryUrl(message, extras);
  if (wantsJsonResponse(req)) {
    return res.status(statusCode).json({
      ok: statusCode < 400,
      message,
      redirectUrl,
      ...payload
    });
  }
  return res.redirect(redirectUrl);
}

function parseFitnessEntryData(source = {}) {
  const parseMetric = (value) => {
    const text = normalizeText(value);
    if (!text) return null;
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : null;
  };

  return {
    heightCm: parseMetric(source.heightCm),
    weightKg: parseMetric(source.weightKg),
    gripKg: parseMetric(source.gripKg),
    longJumpCm: parseMetric(source.longJumpCm),
    sitReachCm: parseMetric(source.sitReachCm),
    doubleJumpSec: parseMetric(source.doubleJumpSec),
    obstacleRunSec: parseMetric(source.obstacleRunSec),
    balanceBeamSec: parseMetric(source.balanceBeamSec)
  };
}

const USER_FITNESS_REQUIRED_LABELS = {
  heightCm: '\u8eab\u9ad8(CM)',
  weightKg: '\u4f53\u91cd(KG)',
  gripKg: '\u63e1\u529b(KG)',
  longJumpCm: '\u7acb\u5b9a\u8df3\u8fdc(CM)',
  sitReachCm: '\u5750\u4f4d\u4f53\u524d\u5c48(CM)',
  doubleJumpSec: '\u53cc\u811a\u8fde\u7eed\u8df3(\u79d2)',
  obstacleRunSec: '15\u7c73\u7ed5\u969c\u788d\u8dd1(\u79d2)',
  balanceBeamSec: '\u8d70\u5e73\u8861\u6728(\u79d2)'
};

const USER_FITNESS_SCORE_FIELD_LABELS = {
  height: '身高',
  bmi: 'BMI',
  grip: '握力',
  longJump: '立定跳远',
  sitReach: '坐位体前屈',
  doubleJump: '双脚连续跳',
  obstacleRun: '15米绕障碍跑',
  balanceBeam: '走平衡木'
};

const FITNESS_AUDIT_FIELD_LABELS = {
  testDate: '测试日期',
  heightCm: '身高(CM)',
  weightKg: '体重(KG)',
  bmi: 'BMI',
  gripKg: '握力(KG)',
  longJumpCm: '立定跳远(CM)',
  sitReachCm: '坐位体前屈(CM)',
  doubleJumpSec: '双脚连续跳(秒)',
  obstacleRunSec: '15米绕障碍跑(秒)',
  balanceBeamSec: '走平衡木(秒)',
  totalScore: '综合得分',
  rating: '评级'
};

function getMissingFitnessFieldLabels(source = {}) {
  return Object.entries(USER_FITNESS_REQUIRED_LABELS)
    .filter(([key]) => {
      const value = source[key];
      return value === null || value === undefined || normalizeText(value) === '';
    })
    .map(([, label]) => label);
}

function getMissingFitnessScoreLabels(result = {}) {
  return Object.entries(result.scores || {})
    .filter(([, value]) => value == null)
    .map(([key]) => USER_FITNESS_SCORE_FIELD_LABELS[key] || key);
}

function buildFitnessAuditState(testDate, data, result) {
  return {
    testDate,
    heightCm: data.heightCm,
    weightKg: data.weightKg,
    bmi: result.bmi,
    gripKg: data.gripKg,
    longJumpCm: data.longJumpCm,
    sitReachCm: data.sitReachCm,
    doubleJumpSec: data.doubleJumpSec,
    obstacleRunSec: data.obstacleRunSec,
    balanceBeamSec: data.balanceBeamSec,
    totalScore: result.totalScore,
    rating: result.rating
  };
}

function normalizeComparableFitnessValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Number(numeric.toFixed(2));
  return normalizeText(value);
}

function fitnessRecordHasChanges(existingRecord, data, result) {
  if (!existingRecord) return true;
  const checks = [
    [existingRecord.height_cm, data.heightCm],
    [existingRecord.weight_kg, data.weightKg],
    [existingRecord.bmi, result.bmi],
    [existingRecord.grip_kg, data.gripKg],
    [existingRecord.long_jump_cm, data.longJumpCm],
    [existingRecord.sit_reach_cm, data.sitReachCm],
    [existingRecord.double_jump_sec, data.doubleJumpSec],
    [existingRecord.obstacle_run_sec, data.obstacleRunSec],
    [existingRecord.balance_beam_sec, data.balanceBeamSec],
    [existingRecord.height_score, result.scores.height],
    [existingRecord.bmi_score, result.scores.bmi],
    [existingRecord.grip_score, result.scores.grip],
    [existingRecord.jump_score, result.scores.longJump],
    [existingRecord.sit_score, result.scores.sitReach],
    [existingRecord.djump_score, result.scores.doubleJump],
    [existingRecord.obstacle_score, result.scores.obstacleRun],
    [existingRecord.balance_score, result.scores.balanceBeam],
    [existingRecord.total_score, result.totalScore],
    [existingRecord.rating, result.rating]
  ];
  return checks.some(([left, right]) => normalizeComparableFitnessValue(left) !== normalizeComparableFitnessValue(right));
}

async function findOrCreateClassChild(classId, childName, options = {}) {
  const gender = normalizeChildGender(options.gender);
  const birthDate = normalizeDateInput(options.birthDate);
  const existingRows = await dbQuery(
    'SELECT id, name, gender, birth_date, class_id, enabled FROM children WHERE class_id = ? AND name = ? ORDER BY enabled DESC, id ASC LIMIT 1',
    [classId, childName]
  );

  if (existingRows.length) {
    const child = existingRows[0];
    const updateSql = [];
    const updateParams = [];
    const profileUpdatedFields = [];
    const reactivated = !Number(child.enabled || 0);
    if (reactivated) {
      updateSql.push('enabled = 1');
      child.enabled = 1;
    }
    if (gender && !normalizeChildGender(child.gender)) {
      updateSql.push('gender = ?');
      updateParams.push(gender);
      child.gender = gender;
      profileUpdatedFields.push('gender');
    }
    if (birthDate && !child.birth_date) {
      updateSql.push('birth_date = ?');
      updateParams.push(birthDate);
      child.birth_date = birthDate;
      profileUpdatedFields.push('birth_date');
    }
    if (updateSql.length) {
      await dbQuery(`UPDATE children SET ${updateSql.join(', ')} WHERE id = ?`, updateParams.concat(child.id));
    }
    return { child, created: false, reactivated, profileUpdatedFields };
  }

  const createdInsertResult = await dbQuery(
    `INSERT INTO children (name, gender, birth_date, class_id, guardian_name, guardian_phone, notes, enabled)
     VALUES (?, ?, ?, ?, '', '', ?, 1)`,
    [childName, gender || '其他', birthDate || null, classId, '教师体测录入时快速创建']
  );
  const createdChildRows = await dbQuery(
    'SELECT id, name, gender, birth_date, class_id, enabled FROM children WHERE id = ? LIMIT 1',
    [createdInsertResult.insertId]
  );
  return {
    child: createdChildRows[0],
    created: true,
    reactivated: false,
    profileUpdatedFields: [gender ? 'gender' : null, birthDate ? 'birth_date' : null].filter(Boolean)
  };

  const insertResult = await dbQuery(
    `INSERT INTO children (name, gender, birth_date, class_id, guardian_name, guardian_phone, notes, enabled)
     VALUES (?, ?, NULL, ?, '', '', ?, 1)`,
    [childName, '其他', classId, '教师体测录入时快捷创建']
  );
  const createdRows = await dbQuery(
    'SELECT id, name, gender, birth_date, class_id, enabled FROM children WHERE id = ? LIMIT 1',
    [insertResult.insertId]
  );
  return { child: createdRows[0], created: true, reactivated: false };
}

async function saveFitnessRecord({ childId, testDate, data, result, userId }) {
  const existingRows = await dbQuery(
    `SELECT id, height_cm, weight_kg, bmi, grip_kg, long_jump_cm, sit_reach_cm,
            double_jump_sec, obstacle_run_sec, balance_beam_sec,
            height_score, bmi_score, grip_score, jump_score, sit_score, djump_score, obstacle_score, balance_score,
            total_score, rating
       FROM fitness_records
      WHERE child_id = ? AND test_date = ?
      ORDER BY id DESC LIMIT 1`,
    [childId, testDate]
  );

  const params = [
    data.heightCm,
    data.weightKg,
    result.bmi,
    data.gripKg,
    data.longJumpCm,
    data.sitReachCm,
    data.doubleJumpSec,
    data.obstacleRunSec,
    data.balanceBeamSec,
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
    userId
  ];

  if (existingRows.length) {
    const changed = fitnessRecordHasChanges(existingRows[0], data, result);
    if (!changed) {
      return { updated: true, changed: false, id: existingRows[0].id, existingRecord: existingRows[0] };
    }
    await dbQuery(`
      UPDATE fitness_records
         SET height_cm = ?, weight_kg = ?, bmi = ?, grip_kg = ?, long_jump_cm = ?, sit_reach_cm = ?,
             double_jump_sec = ?, obstacle_run_sec = ?, balance_beam_sec = ?,
             height_score = ?, bmi_score = ?, grip_score = ?, jump_score = ?, sit_score = ?, djump_score = ?, obstacle_score = ?, balance_score = ?,
             total_score = ?, rating = ?, created_by = ?
       WHERE id = ?`,
      params.concat(existingRows[0].id)
    );
    return { updated: true, changed: true, id: existingRows[0].id, existingRecord: existingRows[0] };
  }

  await dbQuery(`
    INSERT INTO fitness_records
      (child_id, test_date, height_cm, weight_kg, bmi, grip_kg, long_jump_cm, sit_reach_cm,
       double_jump_sec, obstacle_run_sec, balance_beam_sec,
       height_score, bmi_score, grip_score, jump_score, sit_score, djump_score, obstacle_score, balance_score,
       total_score, rating, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      childId,
      testDate,
      ...params
    ]
  );
  const insertedRows = await dbQuery('SELECT id FROM fitness_records WHERE child_id = ? AND test_date = ? ORDER BY id DESC LIMIT 1', [childId, testDate]);
  return { updated: false, changed: true, id: insertedRows[0] ? insertedRows[0].id : null, existingRecord: null };
}
const SESSION_SECRET = process.env.SESSION_SECRET || 'kindergarten-fitness-platform-secret';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let redisClient;

async function initRedis() {
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error:', err.message));
  await redisClient.connect();
}

function createSessionMiddleware() {
  return session({
    store: new RedisStore({ client: redisClient, prefix: 'kgp:sess:' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 }
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
    setHeaders(res) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable, stale-while-revalidate=86400');
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

    const dest = req.session.user.role === 'user' ? '/user' : '/admin';
    res.redirect(dest + '?message=' + encodeURIComponent('密码修改成功'));
  }));

  app.get('/logout', (req, res) => {
    req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/login'); });
  });

  // ========== 教师端 ==========
  app.get('/user', requireRole('user'), asyncHandler(async (req, res) => {
    const dashboard = await buildUserDashboard(req.session.user);
    const classId = req.session.user.classId;
    const childPage = normalizePageNumber(req.query.childPage, 1);
    const recordPage = normalizePageNumber(req.query.recordPage, 1);
    const editId = toNullableInt(req.query.editId);
    const userView = ['records', 'entry', 'attention'].includes(String(req.query.view || '')) ? String(req.query.view) : 'records';
    const allChildren = dashboard.children || [];
    const entryBatchDate = normalizeDateInput(req.query.entryBatchDate);
    const userFitnessFilters = buildUserFitnessQuery(req.query);
    const userSortFieldMap = {
      test_date: 'fr.test_date',
      child_name: 'ch.name',
      height_score: 'fr.height_score',
      bmi_score: 'fr.bmi_score',
      grip_score: 'fr.grip_score',
      jump_score: 'fr.jump_score',
      sit_score: 'fr.sit_score',
      djump_score: 'fr.djump_score',
      obstacle_score: 'fr.obstacle_score',
      balance_score: 'fr.balance_score',
      total_score: 'fr.total_score'
    };
    // 获取本班体测数据
    let fitnessRecords = [];
    let allFitnessRecords = [];
    let latestFitnessRecords = [];
    let fitnessRecordDates = [];
    let avgScore = null;
    let ratingCounts = { '优秀': 0, '良好': 0, '合格': 0, '不合格': 0 };
    let ratingSummary = [];
    let metricNeedTrainingSummary = [];
    if (classId) {
      // 分析/趋势永远使用本班完整历史，再从中取“最新批次”做当前分析；不受下方筛选影响。
      allFitnessRecords = await dbQuery(`
        SELECT fr.*, ch.name AS child_name, ch.gender, ch.birth_date, c.name AS class_name
        FROM fitness_records fr
        JOIN children ch ON ch.id = fr.child_id
        LEFT JOIN classes c ON c.id = ch.class_id
        WHERE ch.class_id = ?
        ORDER BY fr.test_date DESC, fr.id DESC, ch.name`, [classId]);
      const latestBatchDate = allFitnessRecords.length ? formatDateOnly(allFitnessRecords[0].test_date) : '';
      latestFitnessRecords = latestBatchDate
        ? allFitnessRecords.filter((item) => formatDateOnly(item.test_date) === latestBatchDate)
        : [];

      // 明细表使用固定“历史批次”下拉选择；未选择时默认最新批次。
      const displayBatchDate = userFitnessFilters.detailBatchDate || latestBatchDate || '1970-01-01';
      const displayConditions = ['ch.class_id = ?', 'fr.test_date = ?'];
      const displayParams = [classId, displayBatchDate];
      if (userFitnessFilters.keyword) {
        const like = `%${userFitnessFilters.keyword}%`;
        displayConditions.push('(ch.name LIKE ? OR ch.gender LIKE ?)');
        displayParams.push(like, like);
      }
      if (userFitnessFilters.rating) {
        displayConditions.push('fr.rating = ?');
        displayParams.push(userFitnessFilters.rating);
      }
      const orderExpr = userSortFieldMap[userFitnessFilters.sortField] || 'fr.test_date';
      const orderDir = userFitnessFilters.sortOrder === 'asc' ? 'ASC' : 'DESC';
      const displayWhereSql = `WHERE ${displayConditions.join(' AND ')}`;
      fitnessRecords = await dbQuery(`
        SELECT fr.*, ch.name AS child_name, ch.gender, ch.birth_date, c.name AS class_name
        FROM fitness_records fr
        JOIN children ch ON ch.id = fr.child_id
        LEFT JOIN classes c ON c.id = ch.class_id
        ${displayWhereSql}
        ORDER BY ${orderExpr} ${orderDir}, fr.test_date DESC, ch.name`, displayParams);

      const dateRows = await dbQuery(`
        SELECT DATE_FORMAT(fr.test_date, '%Y-%m-%d') AS test_date,
               COUNT(*) AS record_count,
               COUNT(DISTINCT fr.child_id) AS child_count,
               AVG(fr.total_score) AS avg_score
        FROM fitness_records fr
        JOIN children ch ON ch.id = fr.child_id
        WHERE ch.class_id = ?
        GROUP BY fr.test_date
        ORDER BY fr.test_date DESC
        LIMIT 24`, [classId]);
      fitnessRecordDates = dateRows.map((row) => ({
        testDate: row.test_date,
        recordCount: Number(row.record_count || 0),
        childCount: Number(row.child_count || 0),
        avgScore: row.avg_score == null ? null : Number(Number(row.avg_score).toFixed(1))
      }));
      const selectedBatchRecords = userFitnessFilters.batchDate
        ? allFitnessRecords.filter((item) => formatDateOnly(item.test_date) === userFitnessFilters.batchDate)
        : [];

      const summary = buildFitnessSummaries(userFitnessFilters.batchDate ? selectedBatchRecords : latestFitnessRecords, {
        nameLinkBuilder(metricKey, name) {
          const analysisPart = userFitnessFilters.batchDate ? `&batchDate=${encodeURIComponent(userFitnessFilters.batchDate)}` : '';
          const detailPart = userFitnessFilters.detailBatchDate ? `&detailBatchDate=${encodeURIComponent(userFitnessFilters.detailBatchDate)}` : '';
          return `/user?view=records${analysisPart}${detailPart}&keyword=${encodeURIComponent(name)}#fitness-records`;
        }
      });
      avgScore = summary.avgScore;
      ratingCounts = summary.ratingCounts;
      ratingSummary = summary.ratingSummary;
      metricNeedTrainingSummary = summary.metricNeedTrainingSummary;
    }
    const latestBatchDateForCharts = latestFitnessRecords[0] ? formatDateOnly(latestFitnessRecords[0].test_date) : '';
    const allBatchDateListForCharts = Array.from(new Set(allFitnessRecords.map((item) => formatDateOnly(item.test_date)).filter(Boolean)));
    const compareBatchDateForCharts = allBatchDateListForCharts.find((day) => day !== latestBatchDateForCharts) || '';
    const selectedBatchRecordsForCharts = compareBatchDateForCharts
      ? allFitnessRecords.filter((item) => formatDateOnly(item.test_date) === compareBatchDateForCharts)
      : [];
    const metricHealthSummary = buildFitnessSummaries(latestFitnessRecords).metricHealthSummary;
    let radarChartData = buildRadarChartData(metricHealthSummary, {
      currentLabel: (dashboard.assignedClass && dashboard.assignedClass.name) || '本班',
      currentColor: '#0f172a',
      currentFillColor: 'rgba(15, 23, 42, 0.12)'
    });
    if (classId && dashboard.assignedClass && dashboard.assignedClass.grade_level) {
      const gradeRecords = await dbQuery(`
        SELECT fr.*, ch.name AS child_name, ch.gender, ch.birth_date, c.name AS class_name
        FROM fitness_records fr
        JOIN children ch ON ch.id = fr.child_id
        LEFT JOIN classes c ON c.id = ch.class_id
        WHERE c.grade_level = ?
        ORDER BY fr.test_date DESC, c.name, ch.name`, [dashboard.assignedClass.grade_level]);
      radarChartData = buildRadarChartData(metricHealthSummary, {
        currentLabel: dashboard.assignedClass.name || '本班',
        currentColor: '#0f172a',
        currentFillColor: 'rgba(15, 23, 42, 0.12)',
        comparisonSeries: [
        ...(compareBatchDateForCharts && compareBatchDateForCharts !== latestBatchDateForCharts ? [{
          key: 'selected-batch',
          label: compareBatchDateForCharts,
          color: '#7c3aed',
          dasharray: '5 4',
          strokeWidth: 2.4,
          metricHealthSummary: buildFitnessSummaries(selectedBatchRecordsForCharts).metricHealthSummary
        }] : []),
        {
          key: 'grade-average',
          label: '年级组平均',
          color: '#ef4444',
          dasharray: '10 6',
          strokeWidth: 2.4,
          metricHealthSummary: buildFitnessSummaries((() => { const day = gradeRecords[0] ? formatDateOnly(gradeRecords[0].test_date) : ''; return day ? gradeRecords.filter((item) => formatDateOnly(item.test_date) === day) : []; })()).metricHealthSummary
        }]
      });
    }
    const trendMap = new Map();
    for (const item of allFitnessRecords.slice().reverse()) {
      if (!item.test_date) continue;
      const day = new Date(item.test_date).toISOString().slice(0, 10);
      if (!trendMap.has(day)) trendMap.set(day, { label: day, totalScoreSum: 0, totalScoreCount: 0, recordCount: 0 });
      const bucket = trendMap.get(day);
      bucket.recordCount += 1;
      if (item.total_score != null) {
        bucket.totalScoreSum += Number(item.total_score);
        bucket.totalScoreCount += 1;
      }
    }
    const trendSummary = Array.from(trendMap.values()).map((bucket) => ({
      label: bucket.label,
      avgScore: bucket.totalScoreCount ? Number((bucket.totalScoreSum / bucket.totalScoreCount).toFixed(1)) : null,
      recordCount: bucket.recordCount
    })).slice(-8);
    const childPageData = paginateItems(allChildren, childPage, 10);
    const childQuickLookup = {};
    for (const item of fitnessRecords) {
      if (!item.child_name) continue;
      const current = childQuickLookup[item.child_name];
      const incomingDate = item.test_date ? new Date(item.test_date).getTime() : 0;
      const currentDate = current && current.testDate ? new Date(current.testDate).getTime() : 0;
      if (!current || incomingDate >= currentDate) {
        const needTraining = [];
        if (item.grip_score != null && Number(item.grip_score) < 60) needTraining.push('握力');
        if (item.jump_score != null && Number(item.jump_score) < 60) needTraining.push('跳远');
        if (item.sit_score != null && Number(item.sit_score) < 60) needTraining.push('体前屈');
        if (item.djump_score != null && Number(item.djump_score) < 60) needTraining.push('双脚跳');
        if (item.obstacle_score != null && Number(item.obstacle_score) < 60) needTraining.push('障碍跑');
        if (item.balance_score != null && Number(item.balance_score) < 60) needTraining.push('平衡木');
        childQuickLookup[item.child_name] = {
          childId: item.child_id,
          childName: item.child_name,
          className: item.class_name || '-',
          gender: item.gender || '-',
          birthDate: item.birth_date || '',
          testDate: item.test_date ? new Date(item.test_date).toISOString().slice(0, 10) : '',
          totalScore: item.total_score ?? '-',
          rating: item.rating || '-',
          heightCm: item.height_cm ?? '-',
          weightKg: item.weight_kg ?? '-',
          bmi: item.bmi ?? '-',
          gripKg: item.grip_kg ?? '-',
          gripScore: item.grip_score ?? '-',
          longJumpCm: item.long_jump_cm ?? '-',
          jumpScore: item.jump_score ?? '-',
          sitReachCm: item.sit_reach_cm ?? '-',
          sitScore: item.sit_score ?? '-',
          doubleJumpSec: item.double_jump_sec ?? '-',
          djumpScore: item.djump_score ?? '-',
          obstacleRunSec: item.obstacle_run_sec ?? '-',
          obstacleScore: item.obstacle_score ?? '-',
          balanceBeamSec: item.balance_beam_sec ?? '-',
          balanceScore: item.balance_score ?? '-',
          needTraining: needTraining
        };
      }
    }
    const recordPageData = paginateItems(fitnessRecords || [], recordPage, 10);
    let editRecord = null;
    if (classId && editId) {
      const editRows = await dbQuery(`
        SELECT fr.*, ch.name AS child_name, ch.gender, ch.birth_date, c.name AS class_name
        FROM fitness_records fr
        JOIN children ch ON ch.id = fr.child_id
        LEFT JOIN classes c ON c.id = ch.class_id
        WHERE fr.id = ? AND ch.class_id = ?
        LIMIT 1
      `, [editId, classId]);
      editRecord = editRows[0] || null;
    }
    let fitnessBatchDates = [];
    let entryBatchMissingChildren = [];
    let entryBatchRecordedChildren = [];
    if (classId) {
      const batchRows = await dbQuery(`
        SELECT DATE_FORMAT(fr.test_date, '%Y-%m-%d') AS test_date,
               COUNT(DISTINCT fr.child_id) AS recorded_count
        FROM fitness_records fr
        JOIN children ch ON ch.id = fr.child_id
        WHERE ch.class_id = ?
        GROUP BY fr.test_date
        ORDER BY fr.test_date DESC
        LIMIT 24
      `, [classId]);
      fitnessBatchDates = batchRows.map((row) => {
        const recordedCount = Number(row.recorded_count || 0);
        return {
          testDate: row.test_date,
          recordedCount,
          missingCount: Math.max(allChildren.length - recordedCount, 0)
        };
      });

      if (entryBatchDate) {
        const recordedRows = await dbQuery(`
          SELECT fr.child_id,
                 DATE_FORMAT(fr.test_date, '%Y-%m-%d') AS test_date,
                 fr.height_cm,
                 fr.weight_kg,
                 fr.grip_kg,
                 fr.long_jump_cm,
                 fr.sit_reach_cm,
                 fr.double_jump_sec,
                 fr.obstacle_run_sec,
                 fr.balance_beam_sec
          FROM fitness_records fr
          JOIN children ch ON ch.id = fr.child_id
          WHERE ch.class_id = ?
            AND fr.test_date = ?
          ORDER BY fr.child_id ASC, fr.id DESC
        `, [classId, entryBatchDate]);
        const recordedMap = new Map();
        recordedRows.forEach((row) => {
          const childId = Number(row.child_id);
          if (!childId || recordedMap.has(childId)) return;
          recordedMap.set(childId, {
            testDate: row.test_date,
            heightCm: row.height_cm,
            weightKg: row.weight_kg,
            gripKg: row.grip_kg,
            longJumpCm: row.long_jump_cm,
            sitReachCm: row.sit_reach_cm,
            doubleJumpSec: row.double_jump_sec,
            obstacleRunSec: row.obstacle_run_sec,
            balanceBeamSec: row.balance_beam_sec
          });
        });
        const recordedIds = new Set(Array.from(recordedMap.keys()));
        entryBatchMissingChildren = allChildren.filter((child) => !recordedIds.has(Number(child.id)));
        entryBatchRecordedChildren = allChildren
          .filter((child) => recordedIds.has(Number(child.id)))
          .map((child) => ({
            ...child,
            existingFitness: recordedMap.get(Number(child.id)) || null
          }));
      }
    }
    const todayMd = new Date().toISOString().slice(5, 10);
    const teacherBirthday = req.session.user.birthDate && String(req.session.user.birthDate).slice(5, 10) === todayMd;
    const todayBirthdayChildren = (dashboard.children || []).filter((item) => item.birth_date && String(item.birth_date).slice(5, 10) === todayMd);
    res.render('user-dashboard', {
      ...dashboard,
      allChildren,
      children: childPageData.items,
      childPagination: childPageData.pagination,
      fitnessRecords: recordPageData.items,
      childQuickLookup,
      fitnessPagination: recordPageData.pagination,
      allFitnessRecordsCount: fitnessRecords.length,
      latestFitnessRecordsCount: latestFitnessRecords.length,
      totalFitnessRecordsCount: allFitnessRecords.length,
      fitnessRecordDates,
      avgScore, ratingCounts, ratingSummary, metricNeedTrainingSummary, metricHealthSummary, radarChartData, trendSummary,
      teacherBirthday, todayBirthdayChildren,
      userView,
      entryBatchDate,
      entryTestDate: entryBatchDate || chinaNowText().slice(0, 10),
      fitnessBatchDates,
      entryBatchMissingChildren,
      entryBatchRecordedChildren,
      todayText: chinaNowText().slice(0, 10),
      userFitnessFilters,
      userFitnessQueryString: buildUserFitnessQueryString(userFitnessFilters),
      message: normalizeText(req.query.message),
      editError: normalizeText(req.query.error),
      editRecord
    });
  }));

  // 教师体测录入
  app.post('/user/fitness/add', requireRole('user'), asyncHandler(async (req, res) => {
    const classId = Number(req.session.user.classId || 0);
    const rawChildId = normalizeText(req.body.childId);
    const isManualChild = rawChildId === '__manual__';
    const manualChildName = normalizeText(req.body.manualChildName);
    const manualChildGender = normalizeChildGender(req.body.manualChildGender);
    const manualChildBirthDateRaw = normalizeText(req.body.manualChildBirthDate);
    const manualChildBirthDate = normalizeDateInput(req.body.manualChildBirthDate);
    const childId = isManualChild ? null : toNullableInt(rawChildId);
    const batchDate = normalizeDateInput(req.body.entryBatchDate);
    const testDate = normalizeFlexibleDate(req.body.testDate) || batchDate || chinaNowText().slice(0, 10);

    if (!classId) {
      return sendUserEntryResponse(req, res, 400, '当前账号未绑定班级，无法录入体测数据', { entryBatchDate: batchDate }, { changed: false });
    }

    const data = parseFitnessEntryData(req.body);
    const missingLabels = getMissingFitnessFieldLabels(data);
    let targetChild;
    let childCreateInfo = { created: false, reactivated: false, profileUpdatedFields: [] };

    if (isManualChild) {
      if (!manualChildGender) {
        return sendUserEntryResponse(req, res, 400, '手填新增幼儿时必须选择性别，才能计算分数', { entryBatchDate: batchDate }, { changed: false });
      }
      if (!manualChildBirthDateRaw) {
        return sendUserEntryResponse(req, res, 400, '手填新增幼儿时必须填写出生日期，才能计算月龄和分数', { entryBatchDate: batchDate }, { changed: false });
      }
      if (!manualChildBirthDate) {
        return sendUserEntryResponse(req, res, 400, '出生日期格式不正确，请填写 YYYY-MM-DD', { entryBatchDate: batchDate }, { changed: false });
      }
      if (!manualChildName) {
        return sendUserEntryResponse(req, res, 400, '请先填写“其他幼儿”的姓名', { entryBatchDate: batchDate }, { changed: false });
      }
      if (missingLabels.length) {
        return sendUserEntryResponse(req, res, 400, '手填录入失败：缺少填写' + missingLabels.join('、'), { entryBatchDate: batchDate }, {
          changed: false,
          missingFields: missingLabels
        });
      }
      childCreateInfo = await findOrCreateClassChild(classId, manualChildName, {
        gender: manualChildGender,
        birthDate: manualChildBirthDate
      });
      targetChild = childCreateInfo.child;
    } else {
      if (!childId) {
        return sendUserEntryResponse(req, res, 400, '请选择幼儿', { entryBatchDate: batchDate }, { changed: false });
      }
      const childRows = await dbQuery('SELECT id, name, gender, birth_date, class_id FROM children WHERE id = ? LIMIT 1', [childId]);
      if (!childRows.length || Number(childRows[0].class_id || 0) !== classId) {
        return sendUserEntryResponse(req, res, 400, '只能录入本班幼儿的体测数据', { entryBatchDate: batchDate }, { changed: false });
      }
      if (missingLabels.length) {
        return sendUserEntryResponse(req, res, 400, '录入失败：缺少填写' + missingLabels.join('、'), { entryBatchDate: batchDate }, {
          changed: false,
          missingFields: missingLabels
        });
      }
      targetChild = childRows[0];
    }

    const targetGender = normalizeChildGender(targetChild.gender);
    if (!targetGender) {
      return sendUserEntryResponse(req, res, 400, `${targetChild.name} 缺少有效性别，暂时无法计算评分`, { entryBatchDate: batchDate }, { changed: false });
    }
    if (!targetChild.birth_date) {
      return sendUserEntryResponse(req, res, 400, `${targetChild.name} 缺少出生日期，暂时无法计算月龄和评分`, { entryBatchDate: batchDate }, { changed: false });
    }

    const monthAge = calculateMonthAge(targetChild.birth_date, testDate);
    if (monthAge == null) {
      return sendUserEntryResponse(req, res, 400, `${targetChild.name} 的出生日期与测试日期无法计算出有效月龄，请检查日期`, { entryBatchDate: batchDate }, { changed: false });
    }

    const result = computeFitnessResult(data, targetGender, monthAge);
    const missingScoreLabels = getMissingFitnessScoreLabels(result);
    if (missingScoreLabels.length || result.totalScore == null || !result.rating) {
      return sendUserEntryResponse(req, res, 400, `无法计算完整评分，请检查这些项目是否超出评分标准：${(missingScoreLabels.length ? missingScoreLabels : ['综合评分']).join('、')}`, { entryBatchDate: batchDate }, { changed: false });
    }
    const saveResult = await saveFitnessRecord({
      childId: targetChild.id,
      testDate,
      data,
      result,
      userId: req.session.user.id
    });
    const fitnessAuditState = buildFitnessAuditState(testDate, data, result);

    let successMessage = '';
    if (!saveResult.changed) {
      successMessage = targetChild.name + ' 在 ' + testDate + ' 的体测数据没有变化，已保留原记录';
    } else if (saveResult.updated) {
      successMessage = targetChild.name + ' 在 ' + testDate + ' 的体测记录已更新，综合得分 ' + (result.totalScore ?? '-') + '，评级 ' + (result.rating ?? '-');
    } else {
      successMessage = targetChild.name + ' 体测录入成功，综合得分 ' + (result.totalScore ?? '-') + '，评级 ' + (result.rating ?? '-');
    }

    if (childCreateInfo.created) {
      successMessage += '；该幼儿已自动加入当前班级名单';
    } else if (childCreateInfo.reactivated) {
      successMessage += '；该幼儿已重新加入当前班级名单';
    }
    if (!targetChild.birth_date) {
      successMessage += '；该幼儿暂未填写生日，系统已保存原始体测数据，补充生日后即可自动计算完整评分';
    }

    const successNotes = [];
    if (childCreateInfo.created) {
      successNotes.push('该幼儿已自动加入当前班级名单');
    } else if (childCreateInfo.reactivated) {
      successNotes.push('该幼儿已重新启用');
    }
    if (childCreateInfo.profileUpdatedFields && childCreateInfo.profileUpdatedFields.length) {
      const profileFieldLabelMap = { gender: '性别', birth_date: '出生日期' };
      successNotes.push(`已补齐幼儿档案：${childCreateInfo.profileUpdatedFields.map((field) => profileFieldLabelMap[field] || field).join('、')}`);
    }
    successMessage = [
      !saveResult.changed
        ? `${targetChild.name} 在 ${testDate} 的体测数据没有变化，已保留原记录`
        : saveResult.updated
          ? `${targetChild.name} 在 ${testDate} 的体测记录已更新，综合得分 ${result.totalScore ?? '-'}，评级 ${result.rating ?? '-'}`
          : `${targetChild.name} 体测录入成功，综合得分 ${result.totalScore ?? '-'}，评级 ${result.rating ?? '-'}`
    ].concat(successNotes).join('；');

    const shouldRefresh = !!(saveResult.changed || childCreateInfo.created || childCreateInfo.reactivated || (childCreateInfo.profileUpdatedFields && childCreateInfo.profileUpdatedFields.length));

    if (saveResult.updated) {
      const previousAuditState = saveResult.existingRecord ? {
        testDate,
        heightCm: saveResult.existingRecord.height_cm,
        weightKg: saveResult.existingRecord.weight_kg,
        bmi: saveResult.existingRecord.bmi,
        gripKg: saveResult.existingRecord.grip_kg,
        longJumpCm: saveResult.existingRecord.long_jump_cm,
        sitReachCm: saveResult.existingRecord.sit_reach_cm,
        doubleJumpSec: saveResult.existingRecord.double_jump_sec,
        obstacleRunSec: saveResult.existingRecord.obstacle_run_sec,
        balanceBeamSec: saveResult.existingRecord.balance_beam_sec,
        totalScore: saveResult.existingRecord.total_score,
        rating: saveResult.existingRecord.rating
      } : {};
      audit('fitness_record_updated', {
        actor: req.session.user,
        action: '教师录入并覆盖体测记录',
        target: targetChild.name,
        childName: targetChild.name,
        childId: targetChild.id,
        recordId: saveResult.id,
        ip: req.ip,
        changes: buildAuditChanges(previousAuditState, fitnessAuditState, FITNESS_AUDIT_FIELD_LABELS),
        profileUpdates: childCreateInfo.profileUpdatedFields || []
      });
    } else {
      audit('fitness_record_added', {
        actor: req.session.user,
        action: '教师录入体测记录',
        target: targetChild.name,
        childName: targetChild.name,
        childId: targetChild.id,
        recordId: saveResult.id,
        ip: req.ip,
        afterDetails: buildAuditSnapshot(fitnessAuditState, FITNESS_AUDIT_FIELD_LABELS),
        profileUpdates: childCreateInfo.profileUpdatedFields || []
      });
    }

    return sendUserEntryResponse(req, res, 200, successMessage, { entryBatchDate: batchDate }, {
      changed: shouldRefresh,
      updated: !!saveResult.updated,
      createdChild: !!childCreateInfo.created,
      reactivatedChild: !!childCreateInfo.reactivated
    });
  }));

  app.post('/user/fitness/:id/update', requireRole('user'), asyncHandler(async (req, res) => {
    const classId = Number(req.session.user.classId || 0);
    const recordId = toNullableInt(req.params.id);
    const redirectState = buildUserRecordRedirectState(req.body);

    if (!classId) {
      return res.redirect(buildUserRecordsUrl('', {
        ...redirectState,
        error: '当前账号未绑定班级，无法修正体测记录'
      }));
    }
    if (!recordId) {
      return res.redirect(buildUserRecordsUrl('', {
        ...redirectState,
        error: '体测修正失败：记录不存在'
      }));
    }

    const recordRows = await dbQuery(`
      SELECT fr.id, fr.child_id, fr.test_date, fr.height_cm, fr.weight_kg, fr.bmi, fr.grip_kg, fr.long_jump_cm, fr.sit_reach_cm,
             fr.double_jump_sec, fr.obstacle_run_sec, fr.balance_beam_sec, fr.total_score, fr.rating,
             ch.name AS child_name, ch.gender, ch.birth_date, ch.class_id
      FROM fitness_records fr
      JOIN children ch ON ch.id = fr.child_id
      WHERE fr.id = ? AND ch.class_id = ?
      LIMIT 1
    `, [recordId, classId]);

    if (!recordRows.length) {
      return res.redirect(buildUserRecordsUrl('', {
        ...redirectState,
        error: '体测修正失败：只能修改本班幼儿的记录'
      }));
    }

    const record = recordRows[0];
    const testDate = normalizeFlexibleDate(req.body.testDate);
    if (!testDate) {
      return res.redirect(buildUserRecordsUrl('', {
        ...redirectState,
        editId: recordId,
        error: '体测修正失败：测试日期格式不正确，请填写 YYYY-MM-DD'
      }));
    }

    const data = parseFitnessEntryData(req.body);
    const missingLabels = getMissingFitnessFieldLabels(data);
    if (missingLabels.length) {
      return res.redirect(buildUserRecordsUrl('', {
        ...redirectState,
        editId: recordId,
        error: `体测修正失败：缺少 ${missingLabels.join('、')}`
      }));
    }

    const targetGender = normalizeChildGender(record.gender);
    if (!targetGender) {
      return res.redirect(buildUserRecordsUrl('', {
        ...redirectState,
        editId: recordId,
        error: `体测修正失败：幼儿“${record.child_name}”缺少有效性别，无法重新计算评分`
      }));
    }
    if (!record.birth_date) {
      return res.redirect(buildUserRecordsUrl('', {
        ...redirectState,
        editId: recordId,
        error: `体测修正失败：幼儿“${record.child_name}”缺少出生日期，无法重新计算评分`
      }));
    }

    const monthAge = calculateMonthAge(record.birth_date, testDate);
    if (monthAge == null) {
      return res.redirect(buildUserRecordsUrl('', {
        ...redirectState,
        editId: recordId,
        error: `体测修正失败：幼儿“${record.child_name}”的出生日期与测试日期无法计算出有效月龄`
      }));
    }

    const result = computeFitnessResult(data, targetGender, monthAge);
    const missingScoreLabels = getMissingFitnessScoreLabels(result);
    if (missingScoreLabels.length || result.totalScore == null || !result.rating) {
      return res.redirect(buildUserRecordsUrl('', {
        ...redirectState,
        editId: recordId,
        error: `体测修正失败：仍未能算出完整评分，请检查这些项目是否超出评分标准：${(missingScoreLabels.length ? missingScoreLabels : ['综合评分']).join('、')}`
      }));
    }

    await dbQuery(`
      UPDATE fitness_records
         SET test_date = ?,
             height_cm = ?, weight_kg = ?, bmi = ?, grip_kg = ?, long_jump_cm = ?, sit_reach_cm = ?,
             double_jump_sec = ?, obstacle_run_sec = ?, balance_beam_sec = ?,
             height_score = ?, bmi_score = ?, grip_score = ?, jump_score = ?, sit_score = ?, djump_score = ?, obstacle_score = ?, balance_score = ?,
             total_score = ?, rating = ?, created_by = ?
       WHERE id = ?
    `, [
      testDate,
      data.heightCm, data.weightKg, result.bmi, data.gripKg, data.longJumpCm, data.sitReachCm,
      data.doubleJumpSec, data.obstacleRunSec, data.balanceBeamSec,
      result.scores.height, result.scores.bmi, result.scores.grip, result.scores.longJump, result.scores.sitReach,
      result.scores.doubleJump, result.scores.obstacleRun, result.scores.balanceBeam,
      result.totalScore, result.rating, req.session.user.id, recordId
    ]);
    const previousAuditState = {
      testDate: record.test_date ? new Date(record.test_date).toISOString().slice(0, 10) : '',
      heightCm: record.height_cm,
      weightKg: record.weight_kg,
      bmi: record.bmi,
      gripKg: record.grip_kg,
      longJumpCm: record.long_jump_cm,
      sitReachCm: record.sit_reach_cm,
      doubleJumpSec: record.double_jump_sec,
      obstacleRunSec: record.obstacle_run_sec,
      balanceBeamSec: record.balance_beam_sec,
      totalScore: record.total_score,
      rating: record.rating
    };
    const nextAuditState = buildFitnessAuditState(testDate, data, result);

    audit('fitness_record_updated', {
      actor: req.session.user,
      action: '教师修正体测记录',
      target: record.child_name,
      childName: record.child_name,
      childId: record.child_id,
      recordId,
      ip: req.ip,
      changes: buildAuditChanges(previousAuditState, nextAuditState, FITNESS_AUDIT_FIELD_LABELS)
    });

    return res.redirect(buildUserRecordsUrl(`${record.child_name} 的体测记录已修正，综合得分 ${result.totalScore}，评级 ${result.rating}`, redirectState));
  }));


  // 幼儿个人纵向对比数据
  app.get('/user/fitness/compare/:childId', requireRole('user'), asyncHandler(async (req, res) => {
    const classId = req.session.user.classId;
    const childId = Number(req.params.childId);
    if (!classId || !childId) {
      return res.json({ ok: false, message: '参数错误' });
    }
    
    // 验证幼儿属于本班
    const [child] = await dbQuery(
      'SELECT id, name, gender, birth_date FROM children WHERE id = ? AND class_id = ? LIMIT 1',
      [childId, classId]
    );
    if (!child) {
      return res.json({ ok: false, message: '只能查看本班幼儿数据' });
    }
    
    // 获取该幼儿所有体测记录，按日期排序
    const records = await dbQuery(`
      SELECT fr.id, fr.test_date, fr.height_cm, fr.weight_kg, fr.bmi,
             fr.grip_kg, fr.long_jump_cm, fr.sit_reach_cm,
             fr.double_jump_sec, fr.obstacle_run_sec, fr.balance_beam_sec,
             fr.height_score, fr.bmi_score, fr.grip_score, fr.jump_score,
             fr.sit_score, fr.djump_score, fr.obstacle_score, fr.balance_score,
             fr.total_score, fr.rating
      FROM fitness_records fr
      WHERE fr.child_id = ?
      ORDER BY fr.test_date ASC
    `, [childId]);
    
    res.json({
      ok: true,
      child: {
        id: child.id,
        name: child.name,
        gender: child.gender,
        birthDate: child.birth_date ? new Date(child.birth_date).toISOString().slice(0, 10) : ''
      },
      records: records.map(r => ({
        id: r.id,
        testDate: r.test_date ? new Date(r.test_date).toISOString().slice(0, 10) : '',
        heightCm: r.height_cm,
        weightKg: r.weight_kg,
        bmi: r.bmi,
        gripKg: r.grip_kg,
        gripScore: r.grip_score,
        longJumpCm: r.long_jump_cm,
        jumpScore: r.jump_score,
        sitReachCm: r.sit_reach_cm,
        sitScore: r.sit_score,
        doubleJumpSec: r.double_jump_sec,
        djumpScore: r.djump_score,
        obstacleRunSec: r.obstacle_run_sec,
        obstacleScore: r.obstacle_score,
        balanceBeamSec: r.balance_beam_sec,
        balanceScore: r.balance_score,
        totalScore: r.total_score,
        rating: r.rating
      }))
    });
  }));

  // 教师体测模板下载
  app.get('/user/fitness/template', requireRole('user'), asyncHandler(async (req, res) => {
    // 生成带本班幼儿名单的模板
    const XLSX = require('xlsx');
    const classId = req.session.user.classId;
    let templateRows = [{ 幼儿姓名: '小明', 测试日期: new Date().toISOString().slice(0,10), '身高(CM)': '', '体重(KG)': '', '握力(KG)': '', '立定跳远(CM)': '', '坐位体前屈(CM)': '', '双脚连续跳(秒)': '', '15米绕障碍跑(秒)': '', '走平衡木(秒)': '' }];
    if (classId) {
      const kids = await dbQuery('SELECT name FROM children WHERE class_id = ? AND enabled = 1 ORDER BY name', [classId]);
      if (kids.length) {
        const today = new Date().toISOString().slice(0,10);
        templateRows = kids.map(k => ({ 幼儿姓名: k.name, 测试日期: today, '身高(CM)': '', '体重(KG)': '', '握力(KG)': '', '立定跳远(CM)': '', '坐位体前屈(CM)': '', '双脚连续跳(秒)': '', '15米绕障碍跑(秒)': '', '走平衡木(秒)': '' }));
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(templateRows), '体测数据');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('本班体测导入模板.xlsx')}`);
    res.send(buffer);
  }));

  // 教师体测导入
  app.post('/user/fitness/import', requireRole('user'), upload.single('file'), asyncHandler(async (req, res) => {
    const classId = req.session.user.classId;
    if (!classId) return res.redirect('/user?message=' + encodeURIComponent('未绑定班级，无法导入'));
    const rows = parseWorkbookRows(req.file);
    let inserted = 0, updated = 0, skipped = 0;
    const importedNames = [];
    const updatedNames = [];
    const insertedNames = [];
    const skippedNames = [];
    const importedDateCounts = new Map();
    for (const row of rows) {
      const childName = normalizeText(pickValue(row, ['幼儿姓名', '姓名', 'name']));
      const rawTestDate = pickValue(row, ['测试日期', 'date', '日期']);
      const rawTestDateText = normalizeText(rawTestDate);
      const testDate = rawTestDateText ? normalizeFlexibleDate(rawTestDate) : new Date().toISOString().slice(0, 10);
      if (!childName) { skipped++; skippedNames.push('空姓名'); continue; }
      if (rawTestDateText && !testDate) { skipped++; skippedNames.push(`${childName || '未知幼儿'}：测试日期格式错误(${rawTestDateText})`); continue; }
      const cr = await dbQuery('SELECT id, name, gender, birth_date FROM children WHERE class_id = ? AND name = ? LIMIT 1', [classId, childName]);
      if (!cr.length) { skipped++; skippedNames.push(childName); continue; }
      const child = cr[0];
      const monthAge = calculateMonthAge(child.birth_date, testDate);
      const data = {
        heightCm: Number(pickValue(row, ['身高(CM)', '身高', 'height'])) || null,
        weightKg: Number(pickValue(row, ['体重(KG)', '体重', 'weight'])) || null,
        gripKg: Number(pickValue(row, ['握力(KG)', '握力', 'grip'])) || null,
        longJumpCm: Number(pickValue(row, ['立定跳远(CM)', '立定跳远', 'jump'])) || null,
        sitReachCm: Number(pickValue(row, ['坐位体前屈(CM)', '坐位体前屈', 'sit_reach'])) || null,
        doubleJumpSec: Number(pickValue(row, ['双脚连续跳(秒)', '双脚连续跳', 'double_jump'])) || null,
        obstacleRunSec: Number(pickValue(row, ['15米绕障碍跑(秒)', '15米绕障碍跑', 'obstacle'])) || null,
        balanceBeamSec: Number(pickValue(row, ['走平衡木(秒)', '走平衡木', 'balance'])) || null
      };
      const result = computeFitnessResult(data, child.gender, monthAge);
      const existingRows = await dbQuery('SELECT id FROM fitness_records WHERE child_id = ? AND test_date = ? ORDER BY id DESC LIMIT 1', [child.id, testDate]);
      if (existingRows.length) {
        await dbQuery(`
          UPDATE fitness_records
             SET height_cm = ?, weight_kg = ?, bmi = ?, grip_kg = ?, long_jump_cm = ?, sit_reach_cm = ?,
                 double_jump_sec = ?, obstacle_run_sec = ?, balance_beam_sec = ?,
                 height_score = ?, bmi_score = ?, grip_score = ?, jump_score = ?, sit_score = ?, djump_score = ?, obstacle_score = ?, balance_score = ?,
                 total_score = ?, rating = ?, created_by = ?
           WHERE id = ?`,
          [data.heightCm, data.weightKg, result.bmi,
           data.gripKg, data.longJumpCm, data.sitReachCm,
           data.doubleJumpSec, data.obstacleRunSec, data.balanceBeamSec,
           result.scores.height, result.scores.bmi, result.scores.grip, result.scores.longJump, result.scores.sitReach,
           result.scores.doubleJump, result.scores.obstacleRun, result.scores.balanceBeam,
           result.totalScore, result.rating, req.session.user.id, existingRows[0].id]);
        updated++;
        updatedNames.push(child.name);
        importedNames.push(child.name);
      } else {
        await dbQuery(`
          INSERT INTO fitness_records
            (child_id, test_date, height_cm, weight_kg, bmi, grip_kg, long_jump_cm, sit_reach_cm,
             double_jump_sec, obstacle_run_sec, balance_beam_sec,
             height_score, bmi_score, grip_score, jump_score, sit_score, djump_score, obstacle_score, balance_score,
             total_score, rating, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [child.id, testDate, data.heightCm, data.weightKg, result.bmi,
           data.gripKg, data.longJumpCm, data.sitReachCm,
           data.doubleJumpSec, data.obstacleRunSec, data.balanceBeamSec,
           result.scores.height, result.scores.bmi, result.scores.grip, result.scores.longJump, result.scores.sitReach,
           result.scores.doubleJump, result.scores.obstacleRun, result.scores.balanceBeam,
           result.totalScore, result.rating, req.session.user.id]);
        inserted++;
        insertedNames.push(child.name);
        importedNames.push(child.name);
      }
    }
    audit('fitness_records_imported_by_teacher', {
      actor: req.session.user,
      action: '教师批量导入体测数据',
      target: `体测数据（新增 ${inserted}，覆盖 ${updated}，跳过 ${skipped}）`,
      classId,
      inserted,
      updated,
      skipped,
      targetNames: Array.from(new Set(importedNames)),
      insertedNames: Array.from(new Set(insertedNames)),
      updatedNames: Array.from(new Set(updatedNames)),
      skippedNames: Array.from(new Set(skippedNames)).slice(0, 30),
      ip: req.ip,
      message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '教师'}；教师批量导入体测数据：新增 ${inserted}，覆盖 ${updated}，跳过 ${skipped}；涉及幼儿：${Array.from(new Set(importedNames)).slice(0, 20).join('、') || '无'}`
    });
    res.redirect('/user?message=' + encodeURIComponent(`体测导入完成：新增 ${inserted}，覆盖 ${updated}，跳过 ${skipped}`));
  }));

  // 教师体测导出
  app.get('/user/fitness/export', requireRole('user'), asyncHandler(async (req, res) => {
    const XLSX = require('xlsx');
    const classId = req.session.user.classId;
    if (!classId) return res.redirect('/user?message=' + encodeURIComponent('未绑定班级'));
    const userFitnessFilters = buildUserFitnessQuery(req.query);
    const userSortFieldMap = {
      test_date: 'fr.test_date',
      child_name: 'ch.name',
      height_score: 'fr.height_score',
      bmi_score: 'fr.bmi_score',
      grip_score: 'fr.grip_score',
      jump_score: 'fr.jump_score',
      sit_score: 'fr.sit_score',
      djump_score: 'fr.djump_score',
      obstacle_score: 'fr.obstacle_score',
      balance_score: 'fr.balance_score',
      total_score: 'fr.total_score'
    };
    const conditions = ['ch.class_id = ?'];
    const params = [classId];
    if (userFitnessFilters.keyword) {
      const like = `%${userFitnessFilters.keyword}%`;
      conditions.push('(ch.name LIKE ? OR ch.gender LIKE ?)');
      params.push(like, like);
    }
    if (userFitnessFilters.rating) {
      conditions.push('fr.rating = ?');
      params.push(userFitnessFilters.rating);
    }
    if (userFitnessFilters.batchDate) {
      conditions.push('fr.test_date = ?');
      params.push(userFitnessFilters.batchDate);
    } else {
      const latestRows = await dbQuery(`
        SELECT MAX(fr.test_date) AS latest_date
        FROM fitness_records fr
        JOIN children ch ON ch.id = fr.child_id
        WHERE ch.class_id = ?`, [classId]);
      const latestBatchDate = latestRows[0] && latestRows[0].latest_date ? formatDateOnly(latestRows[0].latest_date) : '1970-01-01';
      conditions.push('fr.test_date = ?');
      params.push(latestBatchDate);
    }
    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderExpr = userSortFieldMap[userFitnessFilters.sortField] || 'fr.test_date';
    const orderDir = userFitnessFilters.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const records = await dbQuery(`
      SELECT ch.name AS 幼儿姓名, ch.gender AS 性别,
             DATE_FORMAT(fr.test_date, '%Y-%m-%d') AS 测试日期,
             fr.height_cm AS '身高(CM)', fr.height_score AS '身高分', fr.weight_kg AS '体重(KG)', fr.bmi AS 'BMI',
             fr.grip_kg AS '握力(KG)', fr.long_jump_cm AS '立定跳远(CM)',
             fr.sit_reach_cm AS '坐位体前屈(CM)', fr.double_jump_sec AS '双脚连续跳(秒)',
             fr.obstacle_run_sec AS '15米绕障碍跑(秒)', fr.balance_beam_sec AS '走平衡木(秒)',
             fr.bmi_score AS 'BMI分', fr.grip_score AS '握力分', fr.jump_score AS '跳远分',
             fr.sit_score AS '体前屈分', fr.djump_score AS '双脚跳分',
             fr.obstacle_score AS '障碍跑分', fr.balance_score AS '平衡木分',
             fr.total_score AS '综合得分', fr.rating AS '评级'
      FROM fitness_records fr
      JOIN children ch ON ch.id = fr.child_id
      ${whereSql}
      ORDER BY ${orderExpr} ${orderDir}, fr.test_date DESC, ch.name`, params);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(records), '本班体测数据');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('本班体测数据导出.xlsx')}`);
    res.send(buffer);
  }));

  // ========== 管理后台路由（拆分） ==========
  mountAdminRoutes(app, upload);

  // ========== 场地预约路由 ==========
  mountVenueRoutes(app, upload);

  // ========== 健康检查 ==========
  app.get('/health', asyncHandler(async (req, res) => {
    const [dbRows, redisStatus] = await Promise.all([dbQuery('SELECT NOW() AS now_time'), redisClient.ping()]);
    res.json({ ok: true, app: 'kindergarten-fitness-platform', mysql: dbRows[0]?.now_time || null, redis: redisStatus, time: new Date().toISOString() });
  }));

  // ========== 错误处理 ==========
  app.use((req, res) => { res.status(404).render('error', { message: '页面不存在' }); });
  app.use((error, req, res, next) => {
    console.error('Application error:', error);
    errorLog(error, req);
    if (res.headersSent) return next(error);
    const detail = [
      error && error.name ? `错误类型：${error.name}` : '',
      error && error.message ? `错误信息：${error.message}` : '',
      error && error.code ? `错误代码：${error.code}` : '',
      error && error.sqlMessage ? `SQL错误：${error.sqlMessage}` : '',
      error && error.stack ? `堆栈：\n${error.stack}` : ''
    ].filter(Boolean).join('\n\n');
    res.status(500).render('error', { message: detail || String(error || '未知错误') });
  });

  app.listen(PORT, '0.0.0.0', () => { console.log(`Server listening on http://0.0.0.0:${PORT}`); });
}

bootstrap().catch((err) => { console.error('Bootstrap failed:', err); process.exit(1); });
