const { dbQuery, getSettings } = require('./db');

// All teacher band endpoints derive their scope from the authenticated session.
async function requireBandTeacher(req, res) {
  const user = req.session.user;
  const classId = Number(user.classId || user.class_id || 0);
  const deny = (message) => {
    if (req.path.includes('/api')) res.status(403).json({ ok: false, error: message });
    else res.status(403).render('error', { message });
    return null;
  };
  if (!classId) return deny('未绑定班级，请联系管理员');
  const settings = await getSettings();
  let ids = [];
  try { ids = JSON.parse(settings.bandEnabledClasses || '[]'); } catch (_) {}
  if (!Array.isArray(ids) || !ids.map(Number).includes(classId)) {
    return deny('本班暂未开通手环健康监测，请联系管理员');
  }
  const classes = await dbQuery('SELECT id, name, grade_level FROM classes WHERE id = ? LIMIT 1', [classId]);
  if (!classes.length) return deny('班级不存在');
  return { classId, myClass: classes[0], settings };
}

module.exports = { requireBandTeacher };
