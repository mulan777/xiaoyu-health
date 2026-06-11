/**
 * helpers.js — 通用工具函数
 */

const GRADE_LABELS = {
  small: '小班',
  middle: '中班',
  large: '大班'
};

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeFlexibleDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = normalizeText(value);
  if (!raw) return '';

  // Excel 日期序列号：例如 46167 表示 2026-05-25/26 附近的日期。
  // xlsx 有时会把日期单元格解析成数字，不能直接写入 MySQL DATE。
  if (/^\d{4,6}(?:\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (Number.isFinite(serial) && serial >= 20000 && serial <= 80000) {
      const utcMs = Math.round((serial - 25569) * 86400 * 1000);
      const date = new Date(utcMs);
      if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
    }
  }

  const normalized = raw.replace(/[./年]/g, '-').replace(/[月]/g, '-').replace(/[日]/g, '').replace(/\s+/g, '');
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return '';
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function toNullableInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeAttentionVest(value, fallback = '') {
  const text = normalizeText(value).toLowerCase();
  if (['yellow', 'yellow_vest', 'yellow-vest', '黄马甲', '黄'].includes(text)) return 'yellow';
  if (['green', 'green_vest', 'green-vest', '绿马甲', '绿'].includes(text)) return 'green';
  if (['red', 'red_vest', 'red-vest', '红马甲', '红'].includes(text)) return 'red';
  return fallback;
}

function uniqueNumberIds(value) {
  const items = Array.isArray(value) ? value : [value];
  return [...new Set(items.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))];
}

function buildAdminMessageUrl(message) {
  return '/admin?message=' + encodeURIComponent(message);
}

function gradeLabel(value) {
  return GRADE_LABELS[value] || value || '-';
}

function calculateAge(dateValue) {
  if (!dateValue) return '-';
  const birth = new Date(dateValue);
  if (Number.isNaN(birth.getTime())) return '-';

  const now = new Date();
  let years = now.getFullYear() - birth.getFullYear();
  let months = now.getMonth() - birth.getMonth();

  if (now.getDate() < birth.getDate()) {
    months -= 1;
  }

  if (months < 0) {
    years -= 1;
    months += 12;
  }

  if (years < 0) return '-';
  if (years === 0) return `${months}个月`;
  return `${years}岁${months}个月`;
}

function calculateMonthAge(dateValue, referenceDate = new Date()) {
  if (!dateValue) return null;
  const birth = new Date(dateValue);
  if (Number.isNaN(birth.getTime())) return null;
  const current = new Date(referenceDate);
  if (Number.isNaN(current.getTime())) return null;

  let months = (current.getFullYear() - birth.getFullYear()) * 12 + (current.getMonth() - birth.getMonth());
  if (current.getDate() < birth.getDate()) {
    months -= 1;
  }

  return months >= 0 ? months : null;
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function buildPlaceholders(items) {
  return items.map(() => '?').join(', ');
}

function pickValue(row, aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, alias)) {
      const value = row[alias];
      if (normalizeText(value)) return value;
    }
  }
  return '';
}

function normalizeRole(value) {
  const text = normalizeText(value).toLowerCase();
  if (['admin', '管理员', '管理', 'administrator'].includes(text)) return 'admin';
  return 'user';
}

const LEGACY_PERMISSION_MAP = {
  'ops.overview': ['ops.overview.view'],
  'ops.site': ['ops.site.view', 'ops.site.edit'],
  'ops.logs': ['ops.logs.view'],
  'data.users': ['data.users.view', 'data.users.create', 'data.users.edit', 'data.users.delete', 'data.users.import', 'data.users.export'],
  'data.classes': ['data.classes.view', 'data.classes.create', 'data.classes.edit', 'data.classes.delete'],
  'data.children': ['data.children.view', 'data.children.create', 'data.children.edit', 'data.children.delete', 'data.children.import', 'data.children.export'],
  'data.fitness': ['data.fitness.view', 'data.fitness.create', 'data.fitness.edit', 'data.fitness.delete', 'data.fitness.import', 'data.fitness.export'],
  'booking.attention': ['booking.attention.view', 'booking.attention.create', 'booking.attention.edit', 'booking.attention.delete'],
  'booking.venues': ['booking.venues.view', 'booking.venues.create', 'booking.venues.edit', 'booking.venues.delete', 'booking.venues.export'],
  'admin.roles': ['admin.roles.view', 'admin.roles.create', 'admin.roles.edit', 'admin.roles.delete']
};

function expandPermissions(permissions) {
  const set = new Set(Array.isArray(permissions) ? permissions : []);
  for (const perm of [...set]) {
    const implied = LEGACY_PERMISSION_MAP[perm];
    if (implied) implied.forEach((item) => set.add(item));
  }
  return [...set];
}

function inferGradeLevelByClassName(className) {
  const text = normalizeText(className);
  if (text.includes('大')) return 'large';
  if (text.includes('中')) return 'middle';
  return 'small';
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    // 支持 admin 角色和自定义角色（非 user 角色都可进 admin 面板）
    if (role === 'admin') {
      if (req.session.user.role === 'user') return res.status(403).render('error', { message: '无权限访问该页面' });
    } else if (role === 'user') {
      // user 页面：只有 role=user 的可以进
      if (req.session.user.role !== 'user') return res.status(403).render('error', { message: '无权限访问该页面' });
    }
    next();
  };
}

/**
 * 检查当前用户是否拥有指定权限
 */
function hasPermission(user, permission) {
  if (!user || !user.permissions) return false;
  const expanded = expandPermissions(user.permissions);
  return expanded.includes(permission);
}

function hasAnyPermission(user, perms) {
  return (perms || []).some(p => hasPermission(user, p));
}

/**
 * 检查当前用户是否为只读模式
 */
function isReadonly(user) {
  return !!(user && user.isReadonly);
}

/**
 * 中间件：要求指定权限
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!hasPermission(req.session.user, permission)) {
      return res.status(403).render('error', { message: '无权限访问该功能' });
    }
    next();
  };
}

function requireAnyPermission(permissions = []) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!hasAnyPermission(req.session.user, permissions)) {
      return res.status(403).render('error', { message: '无权限访问该功能' });
    }
    next();
  };
}

/**
 * 中间件：要求非只读（写操作）
 */
function requireWritable() {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (isReadonly(req.session.user)) {
      return res.status(403).render('error', { message: '只读账号无法执行此操作' });
    }
    next();
  };
}


function chinaNowText(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  return formatter.format(date).replace(',', '');
}

module.exports = {
  GRADE_LABELS,
  normalizeText,
  normalizeFlexibleDate,
  toNullableInt,
  normalizeAttentionVest,
  uniqueNumberIds,
  buildAdminMessageUrl,
  gradeLabel,
  calculateAge,
  calculateMonthAge,
  asyncHandler,
  buildPlaceholders,
  pickValue,
  normalizeRole,
  inferGradeLevelByClassName,
  formatDateTime,
  requireRole,
  hasPermission,
  isReadonly,
  requirePermission,
  requireAnyPermission,
  requireWritable,
  hasAnyPermission,
  expandPermissions,
  LEGACY_PERMISSION_MAP,
  chinaNowText
};
