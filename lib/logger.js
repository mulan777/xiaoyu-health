const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const AUDIT_RETENTION_DAYS = 14;
const AUDIT_IGNORED_EVENTS = new Set(['login_success', 'login_failed', 'logout']);
const HIDDEN_KEYS = new Set(['password', 'password_hash', 'newPassword', 'token', 'secret']);

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function toAuditIsoTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function safeString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function summarizeBody(body = {}) {
  const summary = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (HIDDEN_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      summary[key] = value.slice(0, 8).map((item) => typeof item === 'string' ? item.slice(0, 80) : item);
    } else if (typeof value === 'string') {
      summary[key] = value.slice(0, 160);
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

function formatAuditValue(value) {
  if (value === undefined || value === null || value === '') return '空';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length ? value.map((item) => formatAuditValue(item)).join('、') : '空';
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
  }
  return String(value);
}

function buildAuditChanges(before = {}, after = {}, labelMap = {}) {
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
    ...Object.keys(labelMap || {})
  ]);
  const changes = [];
  for (const key of keys) {
    const left = before ? before[key] : undefined;
    const right = after ? after[key] : undefined;
    const leftText = formatAuditValue(left);
    const rightText = formatAuditValue(right);
    if (leftText === rightText) continue;
    changes.push({
      field: key,
      label: labelMap[key] || key,
      before: left,
      after: right,
      beforeText: leftText,
      afterText: rightText
    });
  }
  return changes;
}

function buildAuditSnapshot(values = {}, labelMap = {}) {
  return Object.keys(values || {}).map((key) => ({
    field: key,
    label: labelMap[key] || key,
    value: values[key],
    valueText: formatAuditValue(values[key])
  }));
}

function pruneJsonLog(filename, retentionDays = AUDIT_RETENTION_DAYS) {
  ensureLogDir();
  const filePath = path.join(LOG_DIR, filename);
  if (!fs.existsSync(filePath)) return;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const kept = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      try {
        const parsed = JSON.parse(line);
        const timeText = parsed.time || parsed.timestamp || '';
        const timeMs = Date.parse(timeText);
        if (!Number.isFinite(timeMs)) return true;
        return timeMs >= cutoffMs;
      } catch (_) {
        return true;
      }
    });
  fs.writeFileSync(filePath, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
}

function appendJsonLog(filename, payload) {
  try {
    ensureLogDir();
    pruneJsonLog(filename);
    const line = JSON.stringify({ time: toAuditIsoTime(new Date()), ...payload }) + '\n';
    fs.appendFileSync(path.join(LOG_DIR, filename), line, 'utf8');
  } catch (error) {
    console.error('Write log failed:', error.message);
  }
}

function clientIp(req) {
  const forwarded = safeString(req.headers['x-forwarded-for']).split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || '';
}

function actor(req) {
  const user = req.session?.user || null;
  return user ? { id: user.id || null, username: user.username || '', role: user.role || '', name: user.name || '' } : null;
}

function requestLogger() {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      appendJsonLog('access.log', {
        type: 'access',
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        durationMs,
        ip: clientIp(req),
        actor: actor(req),
        ua: safeString(req.headers['user-agent'])
      });
    });
    next();
  };
}

function audit(event, payload = {}) {
  if (AUDIT_IGNORED_EVENTS.has(event)) return;
  appendJsonLog('audit.log', { type: 'audit-event', event, ...payload });
}

function errorLog(error, req, errId) {
  appendJsonLog('error.log', {
    type: 'error',
    errorId: errId || '',
    message: error?.message || String(error),
    stack: error?.stack || '',
    path: req?.originalUrl || req?.url || '',
    method: req?.method || '',
    ip: req ? clientIp(req) : '',
    actor: req ? actor(req) : null
  });
}

module.exports = {
  requestLogger,
  audit,
  errorLog,
  ensureLogDir,
  pruneJsonLog,
  buildAuditChanges,
  buildAuditSnapshot,
  formatAuditValue,
  AUDIT_RETENTION_DAYS
};
