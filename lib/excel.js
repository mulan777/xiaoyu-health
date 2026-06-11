/**
 * excel.js — Excel 模板 / 导入 / 导出
 */

const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const { normalizeText, normalizeFlexibleDate, pickValue, normalizeRole, formatDateTime } = require('./helpers');
const { dbQuery, ensureClassByName } = require('./db');

function parseWorkbookRows(file) {
  if (!file || !file.buffer) throw new Error('请先上传 Excel 文件');
  const workbook = XLSX.read(file.buffer, { type: 'buffer' });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error('Excel 文件中没有可读取的工作表');
  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: '' });
}

function sendWorkbook(res, workbook, filename) {
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buffer);
}

// ========== 用户 ==========

function buildUserTemplateWorkbook() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([
    { 姓名: '张老师', 用户名: 'zhanglaoshi', 密码: '123456', 角色: 'user', 班级: '大一班', 生日: '1990-10-17' },
    { 姓名: '李管理员', 用户名: 'liadmin', 密码: 'mysql', 角色: 'admin', 班级: '', 生日: '1988/03/08' }
  ]);
  XLSX.utils.book_append_sheet(wb, ws, '用户导入模板');
  return wb;
}

async function importUsersFromRows(rows) {
  let inserted = 0, updated = 0, skipped = 0, createdClasses = 0;
  for (const row of rows) {
    const name = normalizeText(pickValue(row, ['姓名', 'name', 'Name']));
    const username = normalizeText(pickValue(row, ['用户名', 'username', '账号', '登录账号']));
    const password = normalizeText(pickValue(row, ['密码', 'password', '初始密码']));
    const role = normalizeRole(pickValue(row, ['角色', 'role', '用户类型']));
    const className = normalizeText(pickValue(row, ['班级', 'class', '班级名称']));
    const birthDate = normalizeFlexibleDate(pickValue(row, ['生日', '出生日期', 'birth_date', 'birthday']));
    if (!name || !username) { skipped++; continue; }

    let classId = null;
    if (role === 'user' && className) {
      const cls = await ensureClassByName(className);
      classId = cls.id;
      if (cls.createdNow) createdClasses++;
    }

    const existing = await dbQuery('SELECT id FROM users WHERE username = ? LIMIT 1', [username]);
    if (existing.length) {
      const nextRole = username === 'admin' ? 'admin' : role;
      const nextClassId = username === 'admin' ? null : classId;
      if (password) {
        await dbQuery('UPDATE users SET name = ?, role = ?, birth_date = ?, class_id = ?, enabled = 1, password_hash = ? WHERE id = ?',
          [name, nextRole, birthDate || null, nextClassId, bcrypt.hashSync(password, 10), existing[0].id]);
      } else {
        await dbQuery('UPDATE users SET name = ?, role = ?, birth_date = ?, class_id = ?, enabled = 1 WHERE id = ?', [name, nextRole, birthDate || null, nextClassId, existing[0].id]);
      }
      updated++;
    } else {
      const pw = password || (role === 'admin' ? 'mysql' : '123456');
      await dbQuery('INSERT INTO users (username, password_hash, role, name, birth_date, class_id, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)',
        [username, bcrypt.hashSync(pw, 10), role, name, birthDate || null, classId]);
      inserted++;
    }
  }
  return { inserted, updated, skipped, createdClasses };
}

async function buildUserExportWorkbook(filters = {}) {
  const rows = await dbQuery(`
    SELECT u.id AS ID, u.name AS 姓名, u.username AS 用户名,
           CASE WHEN u.birth_date IS NOT NULL THEN DATE_FORMAT(u.birth_date, '%Y-%m-%d') ELSE '' END AS 生日,
           CASE WHEN u.role = 'admin' THEN 'admin' ELSE 'user' END AS 角色,
           COALESCE(c.name, '') AS 班级,
           CASE WHEN u.enabled = 1 THEN '启用' ELSE '禁用' END AS 状态,
           u.created_at AS 创建时间
    FROM users u LEFT JOIN classes c ON c.id = u.class_id ORDER BY u.id ASC`);
  const keywordRaw = String(filters.userKeyword || '').trim().toLowerCase();
  const classFilter = String(filters.userClassId || '');
  const filteredRows = rows.filter((row) => {
    const haystack = [row.姓名, row.用户名, row.班级, row.角色 === 'admin' ? '管理员' : '教师'].join(' ').toLowerCase();
    const matchKeyword = !keywordRaw || haystack.includes(keywordRaw);
    const matchClass = !classFilter || String(row.班级 || '') === String(classFilter) || String(filters.userClassName || '') === String(row.班级 || '');
    return matchKeyword && matchClass;
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filteredRows.map(r => ({ ...r, 创建时间: formatDateTime(r.创建时间) }))), '用户导出');
  return wb;
}

// ========== 幼儿 ==========

function buildChildTemplateWorkbook() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([
    { 班级: '大一班', 幼儿姓名: '小明', 性别: '男', 出生日期: '2021-06-15', 需要关注: '否', 关注原因: '' },
    { 班级: '大一班', 幼儿姓名: '小红', 性别: '女', 出生日期: '2021-09-20', 需要关注: '是', 关注原因: '平衡能力偏弱，活动时需老师多提醒' }
  ]);
  XLSX.utils.book_append_sheet(wb, ws, '幼儿导入模板');
  return wb;
}

async function importChildrenFromRows(rows) {
  let inserted = 0, updated = 0, skipped = 0, createdClasses = 0;
  for (const row of rows) {
    const className = normalizeText(pickValue(row, ['班级', 'class', '班级名称']));
    const childName = normalizeText(pickValue(row, ['幼儿姓名', '姓名', 'name', 'Name']));
    const genderRaw = normalizeText(pickValue(row, ['性别', 'gender', 'Gender']));
    const gender = ['男', '女'].includes(genderRaw) ? genderRaw : '男';
    const birthDateRaw = pickValue(row, ['出生日期', '生日', 'birth_date', 'birthday', '出生年月']);
    const needsAttentionRaw = normalizeText(pickValue(row, ['需要关注', '重点关注', '是否需要关注', 'needs_attention', 'needsAttention'])).toLowerCase();
    const attentionReason = normalizeText(pickValue(row, ['关注原因', '重点关注原因', 'attention_reason', 'attentionReason']));
    const needsAttention = ['1', '是', 'y', 'yes', 'true', '需要', '需关注'].includes(needsAttentionRaw) ? 1 : 0;
    let birthDate = normalizeFlexibleDate(birthDateRaw) || null;
    if (birthDateRaw && !birthDate) {
      // 支持 Excel 序列号和字符串日期
      const num = Number(birthDateRaw);
      if (num > 30000 && num < 60000) {
        // Excel serial date
        const d = new Date((num - 25569) * 86400000);
        birthDate = d.toISOString().slice(0, 10);
      } else {
        birthDate = normalizeFlexibleDate(birthDateRaw);
        if (!birthDate) {
          const d = new Date(birthDateRaw);
          if (!isNaN(d.getTime())) birthDate = d.toISOString().slice(0, 10);
        }
      }
    }
    if (!className || !childName) { skipped++; continue; }
    const cls = await ensureClassByName(className);
    if (cls.createdNow) createdClasses++;
    const existing = await dbQuery('SELECT id FROM children WHERE class_id = ? AND name = ? LIMIT 1', [cls.id, childName]);
    if (existing.length) {
      await dbQuery('UPDATE children SET gender = ?, birth_date = ?, enabled = 1, needs_attention = ?, attention_reason = ? WHERE id = ?', [gender, birthDate, needsAttention, needsAttention ? (attentionReason || null) : null, existing[0].id]);
      updated++;
    } else {
      await dbQuery(
        `INSERT INTO children (name, gender, birth_date, class_id, guardian_name, guardian_phone, notes, enabled, needs_attention, attention_reason)
         VALUES (?, ?, ?, ?, '', '', '', 1, ?, ?)`,
        [childName, gender, birthDate, cls.id, needsAttention, needsAttention ? (attentionReason || null) : null]);
      inserted++;
    }
  }
  return { inserted, updated, skipped, createdClasses };
}

async function buildChildExportWorkbook(filters = {}) {
  const rows = await dbQuery(`
    SELECT ch.id AS ID, COALESCE(c.name, '') AS 班级, ch.name AS 幼儿姓名,
           ch.gender AS 性别,
           CASE WHEN ch.birth_date IS NOT NULL THEN DATE_FORMAT(ch.birth_date, '%Y-%m-%d') ELSE '' END AS 出生日期,
           CASE WHEN ch.needs_attention = 1 THEN '是' ELSE '否' END AS 需要关注,
           COALESCE(ch.attention_reason, '') AS 关注原因,
           CASE WHEN ch.enabled = 1 THEN '启用' ELSE '禁用' END AS 状态,
           ch.created_at AS 创建时间
    FROM children ch LEFT JOIN classes c ON c.id = ch.class_id ORDER BY ch.id ASC`);
  const keywordRaw = String(filters.childKeyword || '').trim().toLowerCase();
  const classFilter = String(filters.childClassId || '');
  const filteredRows = rows.filter((row) => {
    const haystack = [row.幼儿姓名, row.性别, row.班级].join(' ').toLowerCase();
    const matchKeyword = !keywordRaw || haystack.includes(keywordRaw);
    const matchClass = !classFilter || String(row.班级 || '') === String(filters.childClassName || '');
    return matchKeyword && matchClass;
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filteredRows.map(r => ({ ...r, 创建时间: formatDateTime(r.创建时间) }))), '幼儿导出');
  return wb;
}

// ========== 体测数据导入模板 ==========
function buildFitnessTemplateWorkbook() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([{
    班级: '大一班',
    幼儿姓名: '小明',
    测试日期: '2026-04-07',
    '身高(CM)': 110,
    '体重(KG)': 18.5,
    '握力(KG)': 7.0,
    '立定跳远(CM)': 85,
    '坐位体前屈(CM)': 9,
    '双脚连续跳(秒)': 7.5,
    '15米绕障碍跑(秒)': 8.0,
    '走平衡木(秒)': 15
  }]);
  XLSX.utils.book_append_sheet(wb, ws, '体测数据导入模板');
  return wb;
}

module.exports = {
  parseWorkbookRows,
  sendWorkbook,
  buildUserTemplateWorkbook,
  importUsersFromRows,
  buildUserExportWorkbook,
  buildChildTemplateWorkbook,
  importChildrenFromRows,
  buildChildExportWorkbook,
  buildFitnessTemplateWorkbook
};
