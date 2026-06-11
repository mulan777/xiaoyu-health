/**
 * routes/admin.js — 管理后台所有路由
 */

const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { normalizeText, normalizeFlexibleDate, toNullableInt, normalizeAttentionVest, uniqueNumberIds, buildPlaceholders, buildAdminMessageUrl, requireRole, asyncHandler, normalizeRole, pickValue, requirePermission, requireAnyPermission, requireWritable, hasPermission, hasAnyPermission, gradeLabel, calculateMonthAge } = require('../lib/helpers');
const { dbQuery, getSettings, saveSettings, getHomeFeatures, getQuickLinks, saveHomeContent, ensureClassByName, syncClassTeachers, fetchAdminData, paginateItems, getRoles, createRole, updateRole, deleteRole, getRoleById, cloneRole, getAiSettings, saveAiSettings, clearAiApiKey } = require('../lib/db');
const aiClient = require('../lib/ai-client');
const aiFitnessReport = require('../lib/ai-fitness-report');
const { parseWorkbookRows, sendWorkbook, buildUserTemplateWorkbook, importUsersFromRows, buildUserExportWorkbook, buildChildTemplateWorkbook, importChildrenFromRows, buildChildExportWorkbook, buildFitnessTemplateWorkbook } = require('../lib/excel');
const { computeFitnessResult } = require('../lib/fitness-scoring');
const { buildFitnessSummaries, buildRadarChartData } = require('../lib/fitness-analytics');
const { audit, buildAuditChanges, buildAuditSnapshot, formatAuditValue, pruneJsonLog } = require('../lib/logger');

module.exports = function mountAdminRoutes(app, upload) {
  const adminOnly = requireRole('admin');
  const PANEL_PERMISSIONS = {
    overview: 'ops.overview', site: 'ops.site', ai: 'ops.site', logs: 'ops.logs',
    users: 'data.users', classes: 'data.classes', children: 'data.children',
    attention: 'booking.attention', roles: 'admin.roles'
  };
  function buildVisiblePanels(user) {
    return Object.keys(PANEL_PERMISSIONS).filter(p => hasPermission(user, PANEL_PERMISSIONS[p]));
  }

  function formatAuditRecord(item) {
    const actorName = item.actor && (item.actor.name || item.actor.username)
      ? (item.actor.name || item.actor.username)
      : (item.username || '系统');
    const body = item.bodySummary || {};
    let target = item.target || '';
    let actionText = item.action || item.event || item.method || item.type || '';

    if (!target) {
      if ((item.path || '').includes('/admin/users/add')) target = body.name || body.username || '用户';
      else if ((item.path || '').includes('/admin/users/import')) target = '用户数据';
      else if ((item.path || '').includes('/admin/users/batch')) target = `用户批量处理（${Array.isArray(body.selectedIds) ? body.selectedIds.length : 0}项）`;
      else if ((item.path || '').includes('/admin/users/') && (item.path || '').includes('/reset-password')) target = body.username || '用户密码';
      else if ((item.path || '').includes('/admin/users/') && (item.path || '').includes('/toggle')) target = body.username || '用户状态';
      else if ((item.path || '').includes('/admin/classes/add')) target = body.name || '班级';
      else if ((item.path || '').includes('/admin/classes/') && (item.path || '').includes('/teachers')) target = body.className || '班级教师分配';
      else if ((item.path || '').includes('/admin/classes/') && (item.path || '').includes('/toggle')) target = body.className || '班级状态';
      else if ((item.path || '').includes('/admin/children/add')) target = body.name || '幼儿档案';
      else if ((item.path || '').includes('/admin/children/import')) target = '幼儿档案';
      else if ((item.path || '').includes('/admin/children/batch')) target = `幼儿批量处理（${Array.isArray(body.selectedIds) ? body.selectedIds.length : 0}项）`;
      else if ((item.path || '').includes('/admin/children/') && (item.path || '').includes('/toggle')) target = body.childName || '幼儿档案状态';
      else if ((item.path || '').includes('/admin/children/') && (item.path || '').includes('/attention')) target = body.childName || body.childId || '重点关注';
      else if ((item.path || '').includes('/admin/settings')) target = '站点设置';
      else if ((item.path || '').includes('/admin/content')) target = '首页内容';
      else if ((item.path || '').includes('/admin/fitness/add')) target = body.childName || '体测记录';
      else if ((item.path || '').includes('/admin/fitness/import')) target = '体测数据';
      else if ((item.path || '').includes('/admin/venues')) target = body.venueName || item.venueName || '场地预约';
    }

    if (item.event === 'fitness_record_deleted') actionText = '删除体测记录';
    else if ((item.path || '').includes('/admin/settings')) actionText = '修改站点设置';
    else if ((item.path || '').includes('/admin/content')) actionText = '修改首页内容';
    else if ((item.path || '').includes('/admin/users/add')) actionText = '新增用户';
    else if ((item.path || '').includes('/admin/users/import')) actionText = '导入用户';
    else if ((item.path || '').includes('/admin/users/batch')) actionText = '批量处理用户';
    else if ((item.path || '').includes('/admin/users/') && (item.path || '').includes('/toggle')) actionText = '启用/停用用户';
    else if ((item.path || '').includes('/admin/users/') && (item.path || '').includes('/reset-password')) actionText = '重置用户密码';
    else if ((item.path || '').includes('/admin/classes/add')) actionText = '新增班级';
    else if ((item.path || '').includes('/admin/classes/') && (item.path || '').includes('/toggle')) actionText = '启用/停用班级';
    else if ((item.path || '').includes('/admin/classes/') && (item.path || '').includes('/teachers')) actionText = '修改教师分配';
    else if ((item.path || '').includes('/admin/children/add')) actionText = '新增幼儿档案';
    else if ((item.path || '').includes('/admin/children/import')) actionText = '导入幼儿档案';
    else if ((item.path || '').includes('/admin/children/batch')) actionText = '批量处理幼儿档案';
    else if ((item.path || '').includes('/admin/children/') && (item.path || '').includes('/toggle')) actionText = '启用/停用幼儿档案';
    else if ((item.path || '').includes('/admin/children/') && (item.path || '').includes('/attention/clear')) actionText = '取消重点关注';
    else if ((item.path || '').includes('/admin/children/') && (item.path || '').includes('/attention')) actionText = '修改重点关注';
    else if ((item.path || '').includes('/admin/fitness/add')) actionText = '新增体测记录';
    else if ((item.path || '').includes('/admin/fitness/import')) actionText = '导入体测数据';
    else if ((item.path || '').includes('/admin/venues')) actionText = item.event || '场地预约操作';

    const changeDetail = Array.isArray(item.changes) && item.changes.length
      ? item.changes.map((change) => `${change.label || change.field}：${change.beforeText || formatAuditValue(change.before)} -> ${change.afterText || formatAuditValue(change.after)}`).join('\n')
      : '';
    const snapshotDetail = Array.isArray(item.afterDetails) && item.afterDetails.length
      ? item.afterDetails.map((detail) => `${detail.label || detail.field}：${detail.valueText || formatAuditValue(detail.value)}`).join('\n')
      : '';
    const extraNotes = Array.isArray(item.profileUpdates) && item.profileUpdates.length
      ? `同步补齐档案：${item.profileUpdates.join('、')}`
      : '';

    return {
      ...item,
      actorLabel: actorName,
      targetLabel: target || '-',
      actionLabel: actionText || '-',
      timeLabel: item.time ? new Date(item.time).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : (item.timeLabel || '-'),
      detailLabel: changeDetail || snapshotDetail || extraNotes || (item.message || '') || ((item.targetNames && item.targetNames.length)
        ? `操作人：${actorName}
对象：${summarizeNames(item.targetNames, 20)}
数量：${item.targetNames.length}`
        : ((body && Object.keys(body).length) ? JSON.stringify(body, null, 2) : '-'))
    };
  }

  function readRecentJsonLogs(filename, limit = 0) {
    try {
      pruneJsonLog(filename);
      const filePath = path.join(__dirname, '..', 'logs', filename);
      if (!fs.existsSync(filePath)) return [];
      const allLines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
      const lines = (limit > 0 ? allLines.slice(-limit) : allLines).reverse();
      return lines.map((line) => {
        try { return JSON.parse(line); } catch (_) { return { raw: line, time: '', type: filename }; }
      });
    } catch (error) {
      return [{ time: '', type: 'error', message: '读取日志失败：' + (error.message || error) }];
    }
  }


  function formatTeacherAccessAuditRecord(item) {
    const actor = item.actor || {};
    const actorName = actor.name || actor.username || '教师';
    const pathText = item.path || '';
    let actionText = '教师访问页面';
    let target = pathText || '教师端';
    if (pathText.includes('/user/fitness/import')) { actionText = item.status >= 400 ? '教师导入体测数据失败' : '教师导入体测数据'; target = '本班体测数据'; }
    else if (pathText.includes('/user/fitness/export')) { actionText = '教师导出体测数据'; target = '本班体测数据'; }
    else if (pathText.includes('/user/fitness/template')) { actionText = '教师下载体测模板'; target = '体测导入模板'; }
    else if (pathText.includes('/user/fitness/') && pathText.includes('/update')) { actionText = item.status >= 400 ? '教师修正体测记录失败' : '教师修正体测记录'; target = '本班体测记录'; }
    else if (pathText.includes('/user/fitness/add')) { actionText = item.status >= 400 ? '教师录入体测记录失败' : '教师录入体测记录'; target = '本班体测记录'; }
    else if (pathText.includes('/user/venues/cancel')) { actionText = '教师取消场地预约'; target = '场地预约'; }
    else if (pathText.includes('/user/venues/book')) { actionText = '教师预约场地'; target = '场地预约'; }
    else if (pathText.includes('/user/attention')) { actionText = '教师维护重点关注'; target = '本班重点关注'; }
    else if (pathText.includes('/user?') || pathText === '/user') { actionText = '教师查看工作台'; target = '教师端'; }
    const statusCode = Number(item.status || 0);
    const statusLabel = statusCode >= 400
      ? `失败（${statusCode}）`
      : (statusCode >= 300 ? `成功（${statusCode}跳转）` : (statusCode ? `成功（${statusCode}）` : '-'));
    return {
      time: item.time,
      event: 'teacher_access',
      actorLabel: actorName,
      targetLabel: target,
      actionLabel: actionText,
      status: statusLabel,
      timeLabel: item.time ? new Date(item.time).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '-',
      detailLabel: `操作人：${actorName}\n路径：${pathText}\n方式：${item.method || '-'}\n状态：${statusLabel}\nHTTP状态码：${item.status || '-'}\n耗时：${item.durationMs == null ? '-' : item.durationMs + 'ms'}`
    };
  }

  function extractFeaturesFromBody(body) {
    const items = [];
    for (let i = 1; i <= 8; i++) {
      const title = normalizeText(body[`featureTitle${i}`]);
      const desc = normalizeText(body[`featureDesc${i}`]);
      if (title || desc) items.push({ title, desc });
    }
    return items;
  }

  function extractQuickLinksFromBody(body) {
    const items = [];
    for (let i = 1; i <= 6; i++) {
      const name = normalizeText(body[`quickLinkName${i}`]);
      const path = normalizeText(body[`quickLinkPath${i}`]);
      if (name && path) items.push({ name, path });
    }
    return items;
  }

  function normalizeDateInput(value) {
    return normalizeFlexibleDate(value);
  }

  function extractAttentionTags(values, extraValues = '') {
    const source = [];
    if (Array.isArray(values)) source.push(...values);
    else if (values != null) source.push(values);
    source.push(extraValues);
    return [...new Set(
      source
        .flatMap((item) => normalizeText(item).split(/[、,，\n]/))
        .map((item) => normalizeText(item))
        .filter(Boolean)
    )].slice(0, 12).join(',');
  }

  function buildPanelUrl(message, panel, extras = {}) {
    const params = new URLSearchParams();
    if (message) params.set('message', message);
    if (panel) params.set('panel', panel);
    for (const [key, value] of Object.entries(extras || {})) {
      if (value === undefined || value === null) continue;
      const text = String(value);
      if (text === '') continue;
      params.set(key, text);
    }
    return '/admin?' + params.toString();
  }

  function buildUserQueryExtras(body) {
    return {
      userKeyword: normalizeText(body.userKeyword),
      userClassId: body.userClassId == null ? '' : String(body.userClassId),
      userPage: Math.max(1, Number.parseInt(body.userPage, 10) || 1),
      pageSize: Math.max(1, Number.parseInt(body.pageSize, 10) || 10)
    };
  }

  function buildClassQueryExtras(body) {
    return {
      classKeyword: normalizeText(body.classKeyword),
      classGradeLevel: body.classGradeLevel == null ? '' : String(body.classGradeLevel)
    };
  }

  function hasTooManyClassTeachers(value) {
    return uniqueNumberIds(value).length > 3;
  }

  function normalizeClassTeacherIds(value) {
    return uniqueNumberIds(value).slice(0, 3);
  }

  function buildChildQueryExtras(body) {
    return {
      childKeyword: normalizeText(body.childKeyword),
      childClassId: body.childClassId == null ? '' : String(body.childClassId),
      childPage: Math.max(1, Number.parseInt(body.childPage, 10) || 1),
      pageSize: Math.max(1, Number.parseInt(body.pageSize, 10) || 10)
    };
  }


  function summarizeNames(names, limit = 12) {
    const list = [...new Set((names || []).map((item) => normalizeText(item)).filter(Boolean))];
    if (!list.length) return '无';
    if (list.length <= limit) return list.join('、');
    return list.slice(0, limit).join('、') + ` 等 ${list.length} 项`;
  }

  const USER_AUDIT_LABELS = {
    name: '姓名',
    username: '账号',
    role: '角色',
    birthDate: '出生日期',
    classId: '班级ID',
    className: '班级'
  };

  const CLASS_AUDIT_LABELS = {
    name: '班级名称',
    gradeLevel: '年级',
    capacity: '容量',
    description: '说明',
    teacherNames: '教师分配'
  };

  const FITNESS_AUDIT_LABELS = {
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

  function buildAttentionQueryExtras(body, childId = null) {
    return {
      attentionKeyword: normalizeText(body.attentionKeyword),
      attentionClassId: body.attentionClassId == null ? '' : String(body.attentionClassId),
      attentionStatus: normalizeText(body.attentionStatus) || 'all',
      attentionChildId: childId || toNullableInt(body.attentionChildId) || toNullableInt(body.childId) || '',
      attentionPage: Math.max(1, Number.parseInt(body.attentionPage, 10) || 1),
      pageSize: Math.max(1, Number.parseInt(body.pageSize, 10) || 10)
    };
  }

  function buildFitnessUrl(message, extras = {}) {
    const params = new URLSearchParams();
    if (message) params.set('message', message);
    for (const [key, value] of Object.entries(extras || {})) {
      if (value === undefined || value === null) continue;
      const text = String(value);
      if (text === '') continue;
      params.set(key, text);
    }
    const query = params.toString();
    return '/admin/fitness' + (query ? `?${query}` : '');
  }

  function buildFitnessQueryExtras(source = {}) {
    const filters = normalizeFitnessQuery({
      view: source.view != null ? source.view : source.currentView,
      childId: source.childId != null ? source.childId : source.currentChildId,
      classId: source.classId != null ? source.classId : source.currentClassId,
      gradeLevel: source.gradeLevel != null ? source.gradeLevel : source.currentGradeLevel,
      keyword: source.keyword != null ? source.keyword : source.currentKeyword,
      rating: source.rating != null ? source.rating : source.currentRating,
      dateFrom: source.dateFrom != null ? source.dateFrom : source.currentDateFrom,
      dateTo: source.dateTo != null ? source.dateTo : source.currentDateTo,
      sortField: source.sortField != null ? source.sortField : source.currentSortField,
      sortOrder: source.sortOrder != null ? source.sortOrder : source.currentSortOrder
    });
    return {
      view: filters.viewMode,
      childId: filters.childId || '',
      classId: filters.classId || '',
      gradeLevel: filters.gradeLevel || '',
      keyword: filters.keyword || '',
      rating: filters.rating || '',
      dateFrom: filters.dateFrom || '',
      dateTo: filters.dateTo || '',
      sortField: filters.sortField || 'test_date',
      sortOrder: filters.sortOrder || 'desc',
      page: Math.max(1, Number.parseInt(source.page != null ? source.page : source.currentPage, 10) || 1)
    };
  }

  function normalizeFitnessQuery(query = {}) {
    const rating = normalizeText(query.rating);
    const sortField = normalizeText(query.sortField) || 'test_date';
    const sortOrder = normalizeText(query.sortOrder).toLowerCase() === 'asc' ? 'asc' : 'desc';
    const allowedSortFields = new Set(['test_date', 'child_name', 'height_score', 'bmi_score', 'grip_score', 'jump_score', 'sit_score', 'djump_score', 'obstacle_score', 'balance_score', 'total_score']);
    return {
      batchDate: normalizeDateInput(query.batchDate),
      detailBatchDate: normalizeDateInput(query.detailBatchDate),
      viewMode: normalizeText(query.view) || 'all',
      childId: toNullableInt(query.childId),
      classId: toNullableInt(query.classId),
      gradeLevel: normalizeText(query.gradeLevel),
      keyword: normalizeText(query.keyword),
      rating: ['优秀', '良好', '合格', '不合格'].includes(rating) ? rating : '',
      dateFrom: normalizeDateInput(query.dateFrom),
      dateTo: normalizeDateInput(query.dateTo),
      sortField: allowedSortFields.has(sortField) ? sortField : 'test_date',
      sortOrder
    };
  }

  async function fetchFitnessViewData(query = {}, options = {}) {
    const filters = normalizeFitnessQuery(query);
    const { batchDate, detailBatchDate, viewMode, childId, classId, gradeLevel, keyword, rating, sortField, sortOrder } = filters;
    const classes = await dbQuery(`SELECT id, name, grade_level FROM classes ORDER BY FIELD(grade_level, 'small', 'middle', 'large'), name`);
    const selectedClass = classId ? classes.find((item) => Number(item.id) === Number(classId)) || null : null;
    let title = '全园体测数据';
    const sortFieldMap = {
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
    const orderExpr = sortFieldMap[sortField] || 'fr.test_date';
    const orderDir = sortOrder === 'asc' ? 'ASC' : 'DESC';
    const dateOnly = (value) => value ? new Date(value).toISOString().slice(0, 10) : '';
    const latestBatchRecords = (items) => {
      const list = Array.isArray(items) ? items : [];
      const latestDay = list.length ? dateOnly(list[0].test_date) : '';
      return latestDay ? list.filter((item) => dateOnly(item.test_date) === latestDay) : [];
    };

    function buildScopedFitnessQuery(scopeOptions = {}) {
      const conditions = [];
      const params = [];
      const mode = scopeOptions.mode || 'current';
      const includeKeyword = scopeOptions.includeKeyword !== false;

      if (mode === 'current') {
        if (viewMode === 'child' && childId) {
          conditions.push('fr.child_id = ?');
          params.push(childId);
        } else if (viewMode === 'class' && classId) {
          conditions.push('ch.class_id = ?');
          params.push(classId);
        } else if (viewMode === 'grade' && gradeLevel) {
          conditions.push('c.grade_level = ?');
          params.push(gradeLevel);
        }
      } else if (mode === 'grade' && scopeOptions.gradeLevel) {
        conditions.push('c.grade_level = ?');
        params.push(scopeOptions.gradeLevel);
      }

      if (includeKeyword && keyword) {
        const like = `%${keyword}%`;
        conditions.push('(ch.name LIKE ? OR c.name LIKE ? OR ch.gender LIKE ?)');
        params.push(like, like, like);
      }
      if (rating && scopeOptions.includeRating !== false) {
        conditions.push('fr.rating = ?');
        params.push(rating);
      }
      return {
        whereSql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
        params
      };
    }

    async function loadScopedFitnessRecords(scopeOptions = {}) {
      const queryParts = buildScopedFitnessQuery(scopeOptions);
      const orderSql = scopeOptions.orderSql ? ` ${scopeOptions.orderSql}` : '';
      return dbQuery(`
      SELECT fr.*, ch.name AS child_name, ch.gender, ch.birth_date, c.name AS class_name, c.grade_level
      FROM fitness_records fr
      JOIN children ch ON ch.id = fr.child_id
      LEFT JOIN classes c ON c.id = ch.class_id
      ${queryParts.whereSql}${orderSql}`, queryParts.params);
    }

    // 完整范围记录：用于趋势和取最新批次；不受明细筛选影响。
    const allScopedRecords = await loadScopedFitnessRecords({
      mode: 'current',
      includeKeyword: false,
      includeRating: false,
      orderSql: `ORDER BY fr.test_date DESC, fr.id DESC, c.name, ch.name`
    });
    const latestScopedRecords = latestBatchRecords(allScopedRecords);

    // 明细表：固定按批次查看，未选择时默认最新批次；关键词/评级只影响明细。
    const selectedBatchDate = detailBatchDate || (latestScopedRecords[0] ? dateOnly(latestScopedRecords[0].test_date) : '');
    const allBatchRecords = selectedBatchDate
      ? allScopedRecords.filter((item) => dateOnly(item.test_date) === selectedBatchDate)
      : [];
    const selectedBatchRecords = batchDate
      ? allScopedRecords.filter((item) => dateOnly(item.test_date) === batchDate)
      : [];
    const summaryRecords = batchDate ? selectedBatchRecords : latestScopedRecords;
    let records = allBatchRecords.filter((item) => {
      if (keyword) {
        const text = `${item.child_name || ''} ${item.class_name || ''} ${item.gender || ''}`;
        if (!text.includes(keyword)) return false;
      }
      if (rating && item.rating !== rating) return false;
      return true;
    });
    const sortValue = (item) => {
      if (sortField === 'child_name') return item.child_name || '';
      if (sortField === 'test_date') return item.test_date ? new Date(item.test_date).getTime() : 0;
      const field = (sortFieldMap[sortField] || '').replace('fr.', '');
      const value = item[field];
      return value == null || value === '' ? -Infinity : Number(value);
    };
    records.sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      if (typeof av === 'string' || typeof bv === 'string') return orderDir === 'ASC' ? String(av).localeCompare(String(bv), 'zh-Hans-CN') : String(bv).localeCompare(String(av), 'zh-Hans-CN');
      if (av !== bv) return orderDir === 'ASC' ? av - bv : bv - av;
      return (b.test_date ? new Date(b.test_date).getTime() : 0) - (a.test_date ? new Date(a.test_date).getTime() : 0);
    });

    if (viewMode === 'child' && childId) {
      title = records.length ? `${records[0].child_name} 的体测记录` : '个人体测记录';
      if (!records.length) {
        const rows = await dbQuery('SELECT name FROM children WHERE id = ? LIMIT 1', [childId]);
        if (rows.length) title = `${rows[0].name} 的体测记录`;
      }
    } else if (viewMode === 'class' && classId) {
      title = selectedClass ? `${selectedClass.name} 班级体测数据` : '班级体测数据';
    } else if (viewMode === 'grade' && gradeLevel) {
      title = `${gradeLabel(gradeLevel)} 年级体测数据`;
    }
    const nameLinkBase = viewMode === 'class' && classId
      ? `/admin/fitness?view=class&classId=${encodeURIComponent(String(classId))}`
      : viewMode === 'grade' && gradeLevel
        ? `/admin/fitness?view=grade&gradeLevel=${encodeURIComponent(String(gradeLevel))}`
        : '/admin/fitness?view=all';
    const summary = buildFitnessSummaries(summaryRecords, {
      nameLinkBuilder(metricKey, name) {
        const analysisPart = batchDate ? `&batchDate=${encodeURIComponent(batchDate)}` : '';
        const detailPart = selectedBatchDate ? `&detailBatchDate=${encodeURIComponent(selectedBatchDate)}` : '';
        return `${nameLinkBase}${analysisPart}${detailPart}&keyword=${encodeURIComponent(name)}`;
      },
      narrativeBuilder(label, percent, total) {
        return total
          ? `${label}项目有 ${percent}% 的幼儿存在提升空间`
          : `${label}项目暂无有效数据`;
      }
    });
    const {
      avgScore,
      ratingCounts,
      ratingSummary,
      metricNeedTrainingSummary,
      metricHealthSummary
    } = summary;

    const radarComparisonSeries = [];
    const latestBatchDateForCharts = latestScopedRecords[0] ? dateOnly(latestScopedRecords[0].test_date) : '';
    const allBatchDateListForCharts = Array.from(new Set(allScopedRecords.map((item) => dateOnly(item.test_date)).filter(Boolean)));
    const compareBatchDateForCharts = allBatchDateListForCharts.find((day) => day !== latestBatchDateForCharts) || '';
    if (compareBatchDateForCharts && compareBatchDateForCharts !== latestBatchDateForCharts) {
      radarComparisonSeries.push({
        key: 'selected-batch',
        label: compareBatchDateForCharts,
        color: '#7c3aed',
        dasharray: '5 4',
        strokeWidth: 2.4,
        metricHealthSummary: buildFitnessSummaries(allScopedRecords.filter((item) => dateOnly(item.test_date) === compareBatchDateForCharts)).metricHealthSummary
      });
    }
    if (viewMode === 'grade' && gradeLevel) {
      const allGardenRecords = await loadScopedFitnessRecords({ mode: 'all', includeKeyword: false });
      radarComparisonSeries.push({
        key: 'garden-average',
        label: '全园平均',
        color: '#ef4444',
        dasharray: '10 6',
        strokeWidth: 2.4,
        metricHealthSummary: buildFitnessSummaries(latestBatchRecords(allGardenRecords)).metricHealthSummary
      });
    } else if (viewMode === 'class' && selectedClass && selectedClass.grade_level) {
      const gradeRecords = await loadScopedFitnessRecords({
        mode: 'grade',
        gradeLevel: selectedClass.grade_level,
        includeKeyword: false
      });
      radarComparisonSeries.push({
        key: 'grade-average',
        label: '年级组平均',
        color: '#ef4444',
        dasharray: '10 6',
        strokeWidth: 2.4,
        metricHealthSummary: buildFitnessSummaries(latestBatchRecords(gradeRecords)).metricHealthSummary
      });
    }
    const radarCurrentLabel = viewMode === 'class' && selectedClass
      ? selectedClass.name
      : viewMode === 'grade' && gradeLevel
        ? `${gradeLabel(gradeLevel)}年级组`
        : viewMode === 'child'
          ? ((records[0] && records[0].child_name) || '当前幼儿')
          : '全园';
    const radarChartData = buildRadarChartData(metricHealthSummary, {
      currentLabel: radarCurrentLabel,
      currentColor: '#0f172a',
      currentFillColor: 'rgba(15, 23, 42, 0.12)',
      comparisonSeries: radarComparisonSeries
    });

    const trendBuckets = [];
    const trendMap = new Map();
    for (const item of allScopedRecords.slice().reverse()) {
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
    for (const bucket of trendMap.values()) {
      trendBuckets.push({
        label: bucket.label,
        avgScore: bucket.totalScoreCount ? Number((bucket.totalScoreSum / bucket.totalScoreCount).toFixed(1)) : null,
        recordCount: bucket.recordCount
      });
    }
    const trendSummary = trendBuckets.slice(-8);

    let allChildren = [];
    if (options.includeChildren) {
      allChildren = await dbQuery(`
        SELECT ch.id, ch.name, ch.gender, ch.birth_date, c.name AS class_name
        FROM children ch LEFT JOIN classes c ON c.id = ch.class_id
        WHERE ch.enabled = 1
        ORDER BY c.name, ch.name`);
    }

    const paged = options.paginate === false
      ? { items: records, pagination: paginateItems(records, 1, 10).pagination }
      : paginateItems(records, query.page, 10);

    const childQuickLookup = {};
    for (const item of records) {
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

    return {
      records: paged.items,
      allRecordsCount: records.length,
      totalRecordsCount: allScopedRecords.length,
      latestRecordsCount: latestScopedRecords.length,
      selectedBatchDate,
      fitnessRecordDates: trendBuckets.slice().reverse(),
      fitnessPagination: paged.pagination,
      classes,
      allChildren,
      childQuickLookup,
      title,
      viewMode,
      childId,
      classId,
      gradeLevel,
      avgScore,
      ratingCounts,
      ratingSummary,
      metricNeedTrainingSummary,
      metricHealthSummary,
      radarChartData,
      trendSummary,
      filters,
      currentQuery: { ...buildFitnessQueryExtras({ view: viewMode, childId, classId, gradeLevel, keyword, rating, sortField, sortOrder, page: paged.pagination.currentPage }), batchDate, detailBatchDate: selectedBatchDate }
    };
  }

  async function handleChildAttentionSave(req, res, childId) {
    const redirectExtras = buildAttentionQueryExtras(req.body, childId);
    if (!childId) return res.redirect(buildPanelUrl('重点关注保存失败：请选择幼儿', 'attention', redirectExtras));
    const rows = await dbQuery('SELECT id, name FROM children WHERE id = ? LIMIT 1', [childId]);
    if (!rows.length) return res.redirect(buildPanelUrl('操作失败：幼儿档案不存在', 'attention', redirectExtras));

    const needsAttention = normalizeText(req.body.needsAttention) === '1' ? 1 : 0;
    if (!needsAttention) {
      await dbQuery(
        'UPDATE children SET needs_attention = 0, attention_reason = NULL, attention_start_date = NULL, attention_end_date = NULL, attention_tags = NULL, attention_vest_type = NULL WHERE id = ?',
        [childId]
      );
      audit('child_attention_cleared', { actor: req.session.user, action: '取消重点关注', target: rows[0].name, childName: rows[0].name, childId, targetNames: [rows[0].name], ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；取消重点关注幼儿：${rows[0].name}` });
      return res.redirect(buildPanelUrl(`${rows[0].name} 已恢复为正常状态`, 'attention', redirectExtras));
    }

    const attentionReason = normalizeText(req.body.attentionReason);
    const attentionStartDate = normalizeDateInput(req.body.attentionStartDate) || new Date().toISOString().slice(0, 10);
    const attentionEndDateRaw = normalizeDateInput(req.body.attentionEndDate);
    const attentionEndDate = attentionEndDateRaw || null;
    const attentionTags = extractAttentionTags(req.body.attentionTags, req.body.attentionTagsExtra);
    const attentionVestType = normalizeAttentionVest(req.body.attentionVestType, 'yellow');

    if (attentionEndDate && attentionEndDate < attentionStartDate) {
      return res.redirect(buildPanelUrl('重点关注保存失败：结束日期不能早于开始日期', 'attention', redirectExtras));
    }

    await dbQuery(
      'UPDATE children SET needs_attention = 1, attention_reason = ?, attention_start_date = ?, attention_end_date = ?, attention_tags = ?, attention_vest_type = ? WHERE id = ?',
      [attentionReason || null, attentionStartDate, attentionEndDate, attentionTags || null, attentionVestType, childId]
    );
    audit('child_attention_updated', { actor: req.session.user, action: '修改重点关注', target: rows[0].name, childName: rows[0].name, childId, attentionReason, attentionStartDate, attentionEndDate, attentionTags, attentionVestType, targetNames: [rows[0].name], ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；重点关注幼儿：${rows[0].name}；马甲：${attentionVestType === 'red' ? '红马甲' : (attentionVestType === 'green' ? '绿马甲' : '黄马甲')}；原因：${attentionReason || '未填写'}；时间：${attentionStartDate}${attentionEndDate ? ' 至 ' + attentionEndDate : ' 起'}` });
    return res.redirect(buildPanelUrl(`${rows[0].name} 的重点关注信息已更新`, 'attention', redirectExtras));
  }

  async function handleChildAttentionClear(req, res, childId) {
    const redirectExtras = buildAttentionQueryExtras(req.body, childId);
    if (!childId) return res.redirect(buildPanelUrl('操作失败：幼儿档案不存在', 'attention', redirectExtras));
    const rows = await dbQuery('SELECT id, name FROM children WHERE id = ? LIMIT 1', [childId]);
    if (!rows.length) return res.redirect(buildPanelUrl('操作失败：幼儿档案不存在', 'attention', redirectExtras));
    await dbQuery(
      'UPDATE children SET needs_attention = 0, attention_reason = NULL, attention_start_date = NULL, attention_end_date = NULL, attention_tags = NULL, attention_vest_type = NULL WHERE id = ?',
      [childId]
    );
    audit('child_attention_cleared', { actor: req.session.user, action: '取消重点关注', target: rows[0].name, childName: rows[0].name, childId, ip: req.ip });
    return res.redirect(buildPanelUrl(`${rows[0].name} 已取消重点关注`, 'attention', redirectExtras));
  }

  // ========== 后台首页 ==========
  app.get('/admin', adminOnly, asyncHandler(async (req, res) => {
    const visiblePanels = buildVisiblePanels(req.session.user);
    const allowedPanels = new Set(visiblePanels);
    const requestedPanel = normalizeText(req.query.panel);
    const activePanel = allowedPanels.has(requestedPanel) ? requestedPanel : (visiblePanels[0] || 'overview');
    const data = await fetchAdminData(activePanel, req.query);
    const aiSettings = activePanel === 'ai' ? await getAiSettings(false) : null;
    const roles = await getRoles();
    const activeGroup = ['overview', 'site', 'ai', 'logs'].includes(activePanel) ? 'ops' : (['users', 'classes', 'children', 'roles'].includes(activePanel) ? 'data' : 'booking');
    const logs = activePanel === 'logs' ? (() => {
      const logActor = normalizeText(req.query.logActor);
      const logAction = normalizeText(req.query.logAction);
      const logDate = normalizeText(req.query.logDate);
      const currentPage = Math.max(1, Number.parseInt(req.query.logPage, 10) || 1);
      const pageSize = 10;
      const auditEvents = readRecentJsonLogs('audit.log', 0)
        .filter((item) => (item.type === 'audit-event' || item.event) && !['login_success', 'login_failed', 'logout'].includes(item.event))
        .map(formatAuditRecord);
      const teacherAccessEvents = readRecentJsonLogs('access.log', 0)
        .filter((item) => item.type === 'access' && item.actor && item.actor.role === 'user')
        .filter((item) => item.path && item.path.startsWith('/user') && !item.path.includes('/app-version'))
        .filter((item) => item.method !== 'GET' || item.path === '/user' || item.path.startsWith('/user?') || item.path.includes('/user/fitness/export') || item.path.includes('/user/fitness/template'))
        .map(formatTeacherAccessAuditRecord);
      const allAudit = auditEvents.concat(teacherAccessEvents).sort((a, b) => Date.parse(b.time || 0) - Date.parse(a.time || 0));
      const actorOptions = Array.from(new Set(allAudit.map((item) => item.actorLabel).filter(Boolean)));
      const actionOptions = Array.from(new Set(allAudit.map((item) => item.actionLabel).filter(Boolean)));
      const filteredAudit = allAudit.filter((item) => {
        const matchActor = !logActor || item.actorLabel === logActor;
        const matchAction = !logAction || item.actionLabel === logAction;
        const itemDate = item.time ? new Date(item.time).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) : '';
        const matchDate = !logDate || itemDate === logDate;
        return matchActor && matchAction && matchDate;
      });
      const total = filteredAudit.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(currentPage, totalPages);
      const start = (safePage - 1) * pageSize;
      const audit = filteredAudit.slice(start, start + pageSize);
      return {
        audit,
        actorOptions,
        actionOptions,
        filters: { actor: logActor, action: logAction, date: logDate },
        pagination: { currentPage: safePage, pageSize, total, totalPages }
      };
    })() : { audit: [], actorOptions: [], actionOptions: [], filters: { actor: '', action: '', date: '' }, pagination: { currentPage: 1, pageSize: 10, total: 0, totalPages: 1 } };
    res.render('admin-dashboard', {
      ...data,
      logs,
      aiSettings,
      activePanel,
      activeGroup,
      message: normalizeText(req.query.message),
      query: req.query || {},
      today: new Date().toISOString().slice(0, 10),
      visiblePanels,
      roles,
      hasPerm: (perm) => hasPermission(req.session.user, perm),
      currentUser: req.session.user,
      isReadonly: !!req.session.user.isReadonly,
      allPermissions: [
        {group:'运维管理',items:[
          {key:'ops.overview',label:'工作台概览',actions:[{key:'ops.overview.view',label:'查看'}]},
          {key:'ops.site',label:'站点管理',actions:[{key:'ops.site.view',label:'查看'},{key:'ops.site.edit',label:'编辑'}]},
          {key:'ops.logs',label:'日志记录',actions:[{key:'ops.logs.view',label:'查看'}]}
        ]},
        {group:'数据管理',items:[
          {key:'data.users',label:'用户管理',actions:[{key:'data.users.view',label:'查看'},{key:'data.users.create',label:'新增'},{key:'data.users.edit',label:'编辑'},{key:'data.users.delete',label:'删除'},{key:'data.users.import',label:'导入'},{key:'data.users.export',label:'导出'}]},
          {key:'data.classes',label:'班级管理',actions:[{key:'data.classes.view',label:'查看'},{key:'data.classes.create',label:'新增'},{key:'data.classes.edit',label:'编辑'},{key:'data.classes.delete',label:'删除'}]},
          {key:'data.children',label:'幼儿档案管理',actions:[{key:'data.children.view',label:'查看'},{key:'data.children.create',label:'新增'},{key:'data.children.edit',label:'编辑'},{key:'data.children.delete',label:'删除'},{key:'data.children.import',label:'导入'},{key:'data.children.export',label:'导出'}]},
          {key:'data.fitness',label:'体测数据管理',actions:[{key:'data.fitness.view',label:'查看'},{key:'data.fitness.create',label:'新增'},{key:'data.fitness.edit',label:'编辑'},{key:'data.fitness.delete',label:'删除'},{key:'data.fitness.import',label:'导入'},{key:'data.fitness.export',label:'导出'}]}
        ]},
        {group:'预约管理',items:[
          {key:'booking.attention',label:'重点关注管理',actions:[{key:'booking.attention.view',label:'查看'},{key:'booking.attention.create',label:'新增'},{key:'booking.attention.edit',label:'编辑'},{key:'booking.attention.delete',label:'删除'}]},
          {key:'booking.venues',label:'场地预约管理',actions:[{key:'booking.venues.view',label:'查看'},{key:'booking.venues.create',label:'新增'},{key:'booking.venues.edit',label:'编辑'},{key:'booking.venues.delete',label:'删除'},{key:'booking.venues.export',label:'导出'}]}
        ]},
        {group:'系统管理',items:[
          {key:'admin.roles',label:'角色权限管理',actions:[{key:'admin.roles.view',label:'查看'},{key:'admin.roles.create',label:'新增'},{key:'admin.roles.edit',label:'编辑'},{key:'admin.roles.delete',label:'删除'}]}
        ]}
      ]
    });
  }));


  // ========== 站点设置 ==========
  app.post('/admin/settings', adminOnly, requirePermission('ops.site.edit'), requireWritable(), asyncHandler(async (req, res) => {
    await saveSettings({
      siteName: normalizeText(req.body.siteName),
      subtitle: normalizeText(req.body.subtitle),
      heroTitle: normalizeText(req.body.heroTitle),
      heroDesc: normalizeText(req.body.heroDesc),
      mobileHint: normalizeText(req.body.mobileHint),
      adminNotice: normalizeText(req.body.adminNotice),
      venueRecommendationEnabled: req.body.venueRecommendationEnabled === '1' ? '1' : '0'
    });
    audit('site_settings_updated', { actor: req.session.user, action: '修改站点设置', target: '站点设置', ip: req.ip });
    res.redirect(buildAdminMessageUrl('站点设置已更新'));
  }));

  app.post('/admin/content', adminOnly, requirePermission('ops.site.edit'), requireWritable(), asyncHandler(async (req, res) => {
    const features = extractFeaturesFromBody(req.body);
    const quickLinks = extractQuickLinksFromBody(req.body);
    if (!features.length || !quickLinks.length) return res.redirect(buildAdminMessageUrl('首页内容保存失败：请至少保留 1 个亮点和 1 个快捷入口'));
    await saveHomeContent(features, quickLinks);
    audit('home_content_updated', { actor: req.session.user, action: '修改首页内容', target: '首页内容', ip: req.ip, featureCount: features.length, quickLinkCount: quickLinks.length });
    res.redirect(buildAdminMessageUrl('首页展示内容已更新'));
  }));

  // ========== 用户管理 ==========
  app.post('/admin/users/add', adminOnly, requirePermission('data.users.create'), requireWritable(), asyncHandler(async (req, res) => {
    const redirectExtras = buildUserQueryExtras(req.body);
    const name = normalizeText(req.body.name);
    const username = normalizeText(req.body.username);
    const password = normalizeText(req.body.password);
    const role = normalizeText(req.body.role) || 'user';
    const birthDate = normalizeFlexibleDate(req.body.birthDate) || null;
    const classId = role === 'user' ? toNullableInt(req.body.classId) : null;
    if (!name || !username || !password) return res.redirect(buildPanelUrl('新增用户失败：请填写完整信息', 'users', redirectExtras));
    const existing = await dbQuery('SELECT id FROM users WHERE username = ? LIMIT 1', [username]);
    if (existing.length) return res.redirect(buildPanelUrl('新增用户失败：用户名已存在', 'users', redirectExtras));
    await dbQuery('INSERT INTO users (username, password_hash, role, name, birth_date, class_id, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [username, bcrypt.hashSync(password, 10), role, name, birthDate, classId]);
    audit('user_added', { actor: req.session.user, action: '新增用户', target: name || username, username, role, classId, birthDate, ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；新增用户：${name || username}${birthDate ? '；生日：' + birthDate : ''}` });
    res.redirect(buildPanelUrl('用户新增成功', 'users', redirectExtras));
  }));

  app.post('/admin/users/import', adminOnly, requirePermission('data.users.import'), requireWritable(), upload.single('file'), asyncHandler(async (req, res) => {
    const rows = parseWorkbookRows(req.file);
    const result = await importUsersFromRows(rows);
    audit('users_imported', { actor: req.session.user, action: '导入用户', target: '用户数据', inserted: result.inserted, updated: result.updated, skipped: result.skipped, createdClasses: result.createdClasses, ip: req.ip });
    res.redirect(buildPanelUrl(`用户导入完成：新增 ${result.inserted}，更新 ${result.updated}，跳过 ${result.skipped}，自动新增班级 ${result.createdClasses}`, 'users'));
  }));

  app.get('/admin/users/template', adminOnly, requireAnyPermission(['data.users.import','data.users.create']), requireWritable(), asyncHandler(async (req, res) => {
    sendWorkbook(res, buildUserTemplateWorkbook(), '用户导入模板.xlsx');
  }));

  app.get('/admin/users/export', adminOnly, requirePermission('data.users.export'), requireWritable(), asyncHandler(async (req, res) => {
    const classes = await fetchAdminData('classes', {}).then((data) => data.classes || []);
    const classMap = new Map(classes.map((item) => [String(item.id), item.name]));
    const filters = {
      userKeyword: req.query.userKeyword || '',
      userClassId: req.query.userClassId || '',
      userClassName: classMap.get(String(req.query.userClassId || '')) || ''
    };
    sendWorkbook(res, await buildUserExportWorkbook(filters), '用户导出.xlsx');
  }));

  app.post('/admin/users/batch', adminOnly, requireAnyPermission(['data.users.edit','data.users.delete']), requireWritable(), asyncHandler(async (req, res) => {
    const redirectExtras = buildUserQueryExtras(req.body);
    const selectedIds = uniqueNumberIds(req.body.selectedIds);
    const action = normalizeText(req.body.batchAction);
    const classId = toNullableInt(req.body.batchClassId);
    if (!selectedIds.length) return res.redirect(buildPanelUrl('请先勾选需要批量处理的用户', 'users', redirectExtras));
    const ph = buildPlaceholders(selectedIds);
    const selectedUsers = await dbQuery(`SELECT id, username, name FROM users WHERE id IN (${ph})`, selectedIds);
    const selectedNames = selectedUsers.map((item) => item.name || item.username || `ID:${item.id}`);
    const selectedSummary = summarizeNames(selectedNames);
    if (action === 'enable') { await dbQuery(`UPDATE users SET enabled = 1 WHERE id IN (${ph})`, selectedIds); audit('users_batch_enable', { actor: req.session.user, action: '批量启用用户', target: `批量启用用户（${selectedIds.length}项）`, batchAction: action, selectedIds, targetNames: selectedNames, ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；批量启用：${selectedSummary}` }); return res.redirect(buildPanelUrl('已批量启用所选用户', 'users', redirectExtras)); }
    if (action === 'disable') { const affected = selectedUsers.filter((item) => item.username !== 'admin'); await dbQuery(`UPDATE users SET enabled = 0 WHERE id IN (${ph}) AND username <> ?`, [...selectedIds, 'admin']); audit('users_batch_disable', { actor: req.session.user, action: '批量禁用用户', target: `批量禁用用户（${affected.length}项）`, batchAction: action, selectedIds, targetNames: affected.map((item) => item.name || item.username || `ID:${item.id}`), ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；批量禁用：${summarizeNames(affected.map((item) => item.name || item.username || `ID:${item.id}`))}` }); return res.redirect(buildPanelUrl('已批量禁用所选用户（默认 admin 除外）', 'users', redirectExtras)); }
    if (action === 'delete') {
      const affected = selectedUsers.filter((item) => item.username !== 'admin');
      await dbQuery(`DELETE FROM users WHERE id IN (${ph}) AND username <> ?`, [...selectedIds, 'admin']);
      const totalBeforeDelete = await dbQuery(
        `SELECT COUNT(*) AS total
           FROM users u
           LEFT JOIN classes c ON c.id = u.class_id
          WHERE (? = '' OR LOWER(CONCAT(COALESCE(u.name,''),' ',COALESCE(u.username,''),' ',COALESCE(c.name,''),' ',CASE WHEN u.role = 'admin' THEN 'admin 管理员' ELSE 'user 教师' END)) LIKE ?)
            AND (? = '' OR CAST(u.class_id AS CHAR) = ?)`,
        [
          redirectExtras.userKeyword || '',
          '%' + String(redirectExtras.userKeyword || '').toLowerCase() + '%',
          redirectExtras.userClassId || '',
          redirectExtras.userClassId || ''
        ]
      );
      const pageSize = Math.max(1, Number.parseInt(req.body.pageSize, 10) || 10);
      const requestedPage = Math.max(1, Number.parseInt(req.body.userPage, 10) || 1);
      const totalAfterDelete = totalBeforeDelete[0] ? Number(totalBeforeDelete[0].total || 0) : 0;
      const safePage = Math.max(1, Math.min(requestedPage, Math.max(1, Math.ceil(totalAfterDelete / pageSize))));
      audit('users_batch_delete', { actor: req.session.user, action: '批量删除用户', target: `批量删除用户（${affected.length}项）`, batchAction: action, selectedIds, targetNames: affected.map((item) => item.name || item.username || `ID:${item.id}`), ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；批量删除：${summarizeNames(affected.map((item) => item.name || item.username || `ID:${item.id}`))}` });
      return res.redirect(buildPanelUrl('已批量删除所选用户（默认 admin 除外）', 'users', { ...redirectExtras, userPage: safePage, pageSize }));
    }
    if (action === 'setClass') { if (!classId) return res.redirect(buildPanelUrl('批量设置班级失败：请选择目标班级', 'users', redirectExtras)); await dbQuery(`UPDATE users SET class_id = ? WHERE role = 'user' AND id IN (${ph})`, [classId, ...selectedIds]); audit('users_batch_set_class', { actor: req.session.user, action: '批量设置用户班级', target: `批量设置用户班级（${selectedIds.length}项）`, batchAction: action, selectedIds, targetNames: selectedNames, classId, ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；设置班级用户：${selectedSummary}` }); return res.redirect(buildPanelUrl('已批量设置用户所属班级', 'users', redirectExtras)); }
    if (action === 'clearClass') { await dbQuery(`UPDATE users SET class_id = NULL WHERE role = 'user' AND id IN (${ph})`, selectedIds); audit('users_batch_clear_class', { actor: req.session.user, action: '批量清空用户班级', target: `批量清空用户班级（${selectedIds.length}项）`, batchAction: action, selectedIds, targetNames: selectedNames, ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；清空班级绑定用户：${selectedSummary}` }); return res.redirect(buildPanelUrl('已批量清空教师绑定班级', 'users', redirectExtras)); }
    return res.redirect(buildPanelUrl('未识别的批量操作', 'users', redirectExtras));
  }));

  app.post('/admin/users/:id/toggle', adminOnly, requirePermission('data.users.edit'), requireWritable(), asyncHandler(async (req, res) => {
    const redirectExtras = buildUserQueryExtras(req.body);
    const userId = Number(req.params.id);
    const rows = await dbQuery('SELECT id, username, name, enabled FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!rows.length) return res.redirect(buildPanelUrl('操作失败：用户不存在', 'users', redirectExtras));
    if (rows[0].username === 'admin') return res.redirect(buildPanelUrl('默认 admin 账号不可禁用', 'users', redirectExtras));
    const nextEnabled = rows[0].enabled ? 0 : 1;
    await dbQuery('UPDATE users SET enabled = ? WHERE id = ?', [nextEnabled, userId]);
    const targetName = rows[0].name || rows[0].username;
    audit('user_toggled', { actor: req.session.user, action: nextEnabled ? '启用用户' : '禁用用户', target: targetName, username: rows[0].username, targetNames: [targetName], enabled: nextEnabled, ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；${nextEnabled ? '启用' : '禁用'}用户：${targetName}（${rows[0].username}）` });
    res.redirect(buildPanelUrl('用户状态已更新', 'users', redirectExtras));
  }));

  app.post('/admin/users/:id/reset-password', adminOnly, requirePermission('data.users.edit'), requireWritable(), asyncHandler(async (req, res) => {
    const redirectExtras = buildUserQueryExtras(req.body);
    const userId = Number(req.params.id);
    const password = normalizeText(req.body.password);
    if (!password) return res.redirect(buildPanelUrl('重置失败：请输入新密码', 'users', redirectExtras));
    const rows = await dbQuery('SELECT id, username, name FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!rows.length) return res.redirect(buildPanelUrl('重置失败：用户不存在', 'users', redirectExtras));
    await dbQuery('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(password, 10), userId]);
    const targetName = rows[0] ? (rows[0].name || rows[0].username) : `用户#${userId}`;
    audit('user_password_reset', { actor: req.session.user, action: '重置用户密码', target: targetName, username: rows[0] ? rows[0].username : '', targetNames: [targetName], ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；重置密码用户：${targetName}${rows[0] && rows[0].username ? `（${rows[0].username}）` : ''}` });
    res.redirect(buildPanelUrl('用户密码已重置', 'users', redirectExtras));
  }));

  app.post('/admin/users/:id/edit', adminOnly, requirePermission('data.users.edit'), requireWritable(), asyncHandler(async (req, res) => {
    const redirectExtras = buildUserQueryExtras(req.body);
    const userId = Number(req.params.id);
    const rows = await dbQuery(`
      SELECT u.id, u.username, u.name, u.role, u.birth_date, u.class_id, c.name AS class_name
        FROM users u
        LEFT JOIN classes c ON c.id = u.class_id
       WHERE u.id = ?
       LIMIT 1
    `, [userId]);
    if (!rows.length) return res.redirect(buildPanelUrl('编辑失败：用户不存在', 'users', redirectExtras));
    const current = rows[0];
    const name = normalizeText(req.body.name);
    const username = normalizeText(req.body.username);
    const role = normalizeText(req.body.role) || 'user';
    const birthDate = normalizeFlexibleDate(req.body.birthDate) || null;
    const classId = role === 'user' ? toNullableInt(req.body.classId) : null;
    const password = normalizeText(req.body.password);
    if (!name || !username) return res.redirect(buildPanelUrl('编辑失败：请填写姓名和账号', 'users', redirectExtras));
    const existing = await dbQuery('SELECT id FROM users WHERE username = ? AND id <> ? LIMIT 1', [username, userId]);
    if (existing.length) return res.redirect(buildPanelUrl('编辑失败：账号已存在', 'users', redirectExtras));
    if (current.username === 'admin' && role !== 'admin') return res.redirect(buildPanelUrl('编辑失败：默认 admin 账号角色不可修改', 'users', redirectExtras));
    await dbQuery('UPDATE users SET name = ?, username = ?, role = ?, birth_date = ?, class_id = ? WHERE id = ?', [name, username, role, birthDate, classId, userId]);
    if (password) {
      await dbQuery('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(password, 10), userId]);
    }
    const targetClassRows = classId ? await dbQuery('SELECT name FROM classes WHERE id = ? LIMIT 1', [classId]) : [];
    audit('user_updated', {
      actor: req.session.user,
      action: '编辑用户',
      target: name || username,
      username,
      role,
      classId,
      birthDate,
      targetNames: [name || username],
      ip: req.ip,
      changes: buildAuditChanges({
        name: current.name,
        username: current.username,
        role: current.role,
        birthDate: current.birth_date,
        classId: current.class_id,
        className: current.class_name || ''
      }, {
        name,
        username,
        role,
        birthDate,
        classId,
        className: targetClassRows[0] ? targetClassRows[0].name : ''
      }, USER_AUDIT_LABELS),
      afterDetails: password ? buildAuditSnapshot({ passwordReset: '已重置密码' }, { passwordReset: '附加操作' }) : []
    });
    res.redirect(buildPanelUrl('用户信息已更新', 'users', redirectExtras));
  }));


  // ========== 班级管理 ==========
  app.post('/admin/classes/add', adminOnly, requirePermission('data.classes.create'), requireWritable(), asyncHandler(async (req, res) => {
    const name = normalizeText(req.body.name);
    const { inferGradeLevelByClassName } = require('../lib/helpers');
    const gradeLevel = ['small', 'middle', 'large'].includes(normalizeText(req.body.gradeLevel)) ? normalizeText(req.body.gradeLevel) : inferGradeLevelByClassName(req.body.name);
    const capacity = Number(req.body.capacity || 0) || 0;
    const description = normalizeText(req.body.description);
    if (hasTooManyClassTeachers(req.body.teacherIds)) return res.redirect(buildPanelUrl('每个班级最多可绑定 3 位教师', 'classes'));
    const teacherIds = normalizeClassTeacherIds(req.body.teacherIds);
    if (!name) return res.redirect(buildPanelUrl('新增班级失败：请填写班级名称', 'classes'));
    if (!name) return res.redirect(buildAdminMessageUrl('新增班级失败：请填写班级名称'));
    const existing = await dbQuery('SELECT id FROM classes WHERE name = ? LIMIT 1', [name]);
    if (existing.length) return res.redirect(buildPanelUrl('新增班级失败：班级名称已存在', 'classes'));
    if (existing.length) return res.redirect(buildAdminMessageUrl('新增班级失败：班级名称已存在'));
    await dbQuery('INSERT INTO classes (name, grade_level, teacher_name, capacity, description, enabled) VALUES (?, ?, ?, ?, ?, 1)', [name, gradeLevel, '', capacity, description]);
    const inserted = await dbQuery('SELECT id FROM classes WHERE name = ? LIMIT 1', [name]);
    if (inserted.length) await syncClassTeachers(inserted[0].id, teacherIds);
    audit('class_added', { actor: req.session.user, action: '新增班级', target: name, className: name, gradeLevel, teacherCount: teacherIds.length, ip: req.ip });
    res.redirect(buildAdminMessageUrl('班级新增成功'));
  }));

  app.post('/admin/classes/:id/toggle', adminOnly, requirePermission('data.classes.edit'), requireWritable(), asyncHandler(async (req, res) => {
    const classId = Number(req.params.id);
    const rows = await dbQuery('SELECT id, name, enabled FROM classes WHERE id = ? LIMIT 1', [classId]);
    if (!rows.length) return res.redirect(buildAdminMessageUrl('操作失败：班级不存在'));
    const nextEnabled = rows[0].enabled ? 0 : 1;
    await dbQuery('UPDATE classes SET enabled = ? WHERE id = ?', [nextEnabled, classId]);
    audit('class_toggled', { actor: req.session.user, action: nextEnabled ? '启用班级' : '禁用班级', target: rows[0].name, className: rows[0].name, targetNames: [rows[0].name], enabled: nextEnabled, ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；${nextEnabled ? '启用' : '禁用'}班级：${rows[0].name}` });
    res.redirect(buildAdminMessageUrl('班级状态已更新'));
  }));

  app.post('/admin/classes/:id/teachers', adminOnly, requirePermission('data.classes.edit'), requireWritable(), asyncHandler(async (req, res) => {
    const classId = Number(req.params.id);
    const rows = await dbQuery('SELECT id, name FROM classes WHERE id = ? LIMIT 1', [classId]);
    if (!rows.length) return res.redirect(buildAdminMessageUrl('操作失败：班级不存在'));
    if (hasTooManyClassTeachers(req.body.teacherIds)) return res.redirect(buildPanelUrl('每个班级最多可绑定 3 位教师', 'classes'));
    const teacherIds = normalizeClassTeacherIds(req.body.teacherIds);
    const teachers = teacherIds.length ? await dbQuery(`SELECT id, name, username FROM users WHERE id IN (${buildPlaceholders(teacherIds)})`, teacherIds) : [];
    const teacherNames = teachers.map((item) => item.name || item.username || `ID:${item.id}`);
    await syncClassTeachers(classId, teacherIds);
    audit('class_teachers_updated', { actor: req.session.user, action: '修改教师分配', target: rows[0].name, className: rows[0].name, teacherIds, teacherCount: teacherIds.length, targetNames: [rows[0].name].concat(teacherNames), ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；班级：${rows[0].name}；教师分配：${teacherNames.length ? teacherNames.join('、') : '已清空'}` });
    res.redirect(buildAdminMessageUrl('班级教师分配已更新'));
  }));

  app.post('/admin/classes/:id/edit', adminOnly, requirePermission('data.classes.edit'), requireWritable(), asyncHandler(async (req, res) => {
    const redirectExtras = buildClassQueryExtras(req.body);
    const classId = Number(req.params.id);
    const rows = await dbQuery('SELECT id, name, grade_level, capacity, description FROM classes WHERE id = ? LIMIT 1', [classId]);
    if (!rows.length) return res.redirect(buildPanelUrl('编辑失败：班级不存在', 'classes', redirectExtras));
    const name = normalizeText(req.body.name);
    const gradeLevel = ['small', 'middle', 'large'].includes(normalizeText(req.body.gradeLevel)) ? normalizeText(req.body.gradeLevel) : rows[0].grade_level;
    const capacity = Number(req.body.capacity || 0) || 0;
    const description = normalizeText(req.body.description);
    if (hasTooManyClassTeachers(req.body.teacherIds)) return res.redirect(buildPanelUrl('每个班级最多可绑定 3 位教师', 'classes', redirectExtras));
    const teacherIds = normalizeClassTeacherIds(req.body.teacherIds);
    if (!name) return res.redirect(buildPanelUrl('编辑失败：请填写班级名称', 'classes', redirectExtras));
    const existing = await dbQuery('SELECT id FROM classes WHERE name = ? AND id <> ? LIMIT 1', [name, classId]);
    if (existing.length) return res.redirect(buildPanelUrl('编辑失败：班级名称已存在', 'classes', redirectExtras));
    const beforeTeachers = await dbQuery(`
      SELECT u.name, u.username
        FROM users u
       WHERE u.role = 'user'
         AND u.class_id = ?
       ORDER BY u.id ASC
    `, [classId]);
    await dbQuery('UPDATE classes SET name = ?, grade_level = ?, capacity = ?, description = ? WHERE id = ?', [name, gradeLevel, capacity, description, classId]);
    await syncClassTeachers(classId, teacherIds);
    const teachers = teacherIds.length ? await dbQuery(`SELECT id, name, username FROM users WHERE id IN (${buildPlaceholders(teacherIds)})`, teacherIds) : [];
    const teacherNames = teachers.map((item) => item.name || item.username || `ID:${item.id}`);
    audit('class_updated', {
      actor: req.session.user,
      action: '编辑班级',
      target: name,
      className: name,
      teacherIds,
      teacherCount: teacherIds.length,
      targetNames: [name].concat(teacherNames),
      ip: req.ip,
      changes: buildAuditChanges({
        name: rows[0].name,
        gradeLevel: rows[0].grade_level,
        capacity: rows[0].capacity,
        description: rows[0].description || '',
        teacherNames: beforeTeachers.map((item) => item.name || item.username || '').filter(Boolean)
      }, {
        name,
        gradeLevel,
        capacity,
        description,
        teacherNames
      }, CLASS_AUDIT_LABELS)
    });
    res.redirect(buildPanelUrl('班级信息已更新', 'classes', redirectExtras));
  }));

  // ========== 幼儿档案 ==========
  app.post('/admin/children/add', adminOnly, requirePermission('data.children.create'), requireWritable(), asyncHandler(async (req, res) => {
    const redirectExtras = buildChildQueryExtras(req.body);
    const name = normalizeText(req.body.name);
    const classId = toNullableInt(req.body.classId);
    const gender = ['男', '女'].includes(normalizeText(req.body.gender)) ? normalizeText(req.body.gender) : '男';
    const birthDate = normalizeFlexibleDate(req.body.birthDate) || null;
    const needsAttention = normalizeText(req.body.needsAttention) === '1' ? 1 : 0;
    const attentionReason = needsAttention ? normalizeText(req.body.attentionReason) : '';
    if (!name || !classId) return res.redirect(buildPanelUrl('新增幼儿档案失败：请选择班级并填写幼儿姓名', 'children', redirectExtras));
    await dbQuery(
      `INSERT INTO children (name, gender, birth_date, class_id, guardian_name, guardian_phone, notes, enabled, needs_attention, attention_reason)
       VALUES (?, ?, ?, ?, '', '', '', 1, ?, ?)`,
      [name, gender, birthDate, classId, needsAttention, attentionReason || null]);
    audit('child_added', { actor: req.session.user, action: '新增幼儿档案', target: name, childName: name, classId, gender, needsAttention, ip: req.ip });
    res.redirect(buildPanelUrl('幼儿档案新增成功', 'children', redirectExtras));
  }));

  app.post('/admin/children/import', adminOnly, requirePermission('data.children.import'), requireWritable(), upload.single('file'), asyncHandler(async (req, res) => {
    const rows = parseWorkbookRows(req.file);
    const result = await importChildrenFromRows(rows);
    audit('children_imported', { actor: req.session.user, action: '导入幼儿档案', target: '幼儿档案', inserted: result.inserted, updated: result.updated, skipped: result.skipped, createdClasses: result.createdClasses, ip: req.ip });
    res.redirect(buildPanelUrl(`幼儿导入完成：新增 ${result.inserted}，更新 ${result.updated}，跳过 ${result.skipped}，自动新增班级 ${result.createdClasses}`, 'children'));
  }));

  app.get('/admin/children/template', adminOnly, requireAnyPermission(['data.children.import','data.children.create']), requireWritable(), asyncHandler(async (req, res) => {
    sendWorkbook(res, buildChildTemplateWorkbook(), '幼儿导入模板.xlsx');
  }));

  app.get('/admin/children/export', adminOnly, requirePermission('data.children.export'), requireWritable(), asyncHandler(async (req, res) => {
    const classes = await fetchAdminData('classes', {}).then((data) => data.classes || []);
    const classMap = new Map(classes.map((item) => [String(item.id), item.name]));
    const filters = {
      childKeyword: req.query.childKeyword || '',
      childClassId: req.query.childClassId || '',
      childClassName: classMap.get(String(req.query.childClassId || '')) || ''
    };
    sendWorkbook(res, await buildChildExportWorkbook(filters), '幼儿导出.xlsx');
  }));

  app.post('/admin/children/batch', adminOnly, requireAnyPermission(['data.children.edit','data.children.delete']), requireWritable(), asyncHandler(async (req, res) => {
    const redirectExtras = buildChildQueryExtras(req.body);
    const selectedIds = uniqueNumberIds(req.body.selectedIds);
    const action = normalizeText(req.body.batchAction);
    const classId = toNullableInt(req.body.batchClassId);
    if (!selectedIds.length) return res.redirect(buildPanelUrl('请先勾选需要批量处理的幼儿档案', 'children', redirectExtras));
    const ph = buildPlaceholders(selectedIds);
    const selectedChildren = await dbQuery(`SELECT id, name FROM children WHERE id IN (${ph})`, selectedIds);
    const selectedNames = selectedChildren.map((item) => item.name || `ID:${item.id}`);
    const selectedSummary = summarizeNames(selectedNames);
    if (action === 'enable') { await dbQuery(`UPDATE children SET enabled = 1 WHERE id IN (${ph})`, selectedIds); audit('children_batch_enable', { actor: req.session.user, action: '批量启用幼儿档案', target: `批量启用幼儿档案（${selectedIds.length}项）`, batchAction: action, selectedIds, targetNames: selectedNames, ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；批量启用幼儿：${selectedSummary}` }); return res.redirect(buildPanelUrl('已批量启用所选幼儿档案', 'children', redirectExtras)); }
    if (action === 'disable') { await dbQuery(`UPDATE children SET enabled = 0 WHERE id IN (${ph})`, selectedIds); audit('children_batch_disable', { actor: req.session.user, action: '批量禁用幼儿档案', target: `批量禁用幼儿档案（${selectedIds.length}项）`, batchAction: action, selectedIds, targetNames: selectedNames, ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；批量禁用幼儿：${selectedSummary}` }); return res.redirect(buildPanelUrl('已批量禁用所选幼儿档案', 'children', redirectExtras)); }
    if (action === 'delete') { await dbQuery(`DELETE FROM children WHERE id IN (${ph})`, selectedIds); const totalRows = await dbQuery(`SELECT COUNT(*) AS total FROM children ch LEFT JOIN classes c ON c.id = ch.class_id WHERE (? = '' OR LOWER(CONCAT(COALESCE(ch.name,''),' ',COALESCE(ch.gender,''),' ',COALESCE(c.name,''))) LIKE ?) AND (? = '' OR CAST(ch.class_id AS CHAR) = ?)`, [redirectExtras.childKeyword || '', '%' + String(redirectExtras.childKeyword || '').toLowerCase() + '%', redirectExtras.childClassId || '', redirectExtras.childClassId || '']); const pageSize = Math.max(1, Number.parseInt(req.body.pageSize, 10) || 10); const requestedPage = Math.max(1, Number.parseInt(req.body.childPage, 10) || 1); const totalAfterDelete = totalRows[0] ? Number(totalRows[0].total || 0) : 0; const safePage = Math.max(1, Math.min(requestedPage, Math.max(1, Math.ceil(totalAfterDelete / pageSize)))); audit('children_batch_delete', { actor: req.session.user, action: '批量删除幼儿档案', target: `批量删除幼儿档案（${selectedIds.length}项）`, batchAction: action, selectedIds, targetNames: selectedNames, ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；批量删除幼儿：${selectedSummary}` }); return res.redirect(buildPanelUrl('已批量删除所选幼儿档案', 'children', { ...redirectExtras, childPage: safePage, pageSize })); }
    if (action === 'moveClass') { if (!classId) return res.redirect(buildPanelUrl('批量移动失败：请选择目标班级', 'children', redirectExtras)); await dbQuery(`UPDATE children SET class_id = ? WHERE id IN (${ph})`, [classId, ...selectedIds]); audit('children_batch_move_class', { actor: req.session.user, action: '批量调整幼儿班级', target: `批量调整幼儿班级（${selectedIds.length}项）`, batchAction: action, selectedIds, targetNames: selectedNames, classId, ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；调整班级幼儿：${selectedSummary}` }); return res.redirect(buildPanelUrl('已批量调整幼儿所属班级', 'children', redirectExtras)); }
    return res.redirect(buildPanelUrl('未识别的批量操作', 'children', redirectExtras));
  }));

  app.post('/admin/children/attention/save', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    await handleChildAttentionSave(req, res, toNullableInt(req.body.childId));
  }));

  app.post('/admin/children/:id/attention', adminOnly, requirePermission('booking.attention.edit'), requireWritable(), asyncHandler(async (req, res) => {
    await handleChildAttentionSave(req, res, Number(req.params.id));
  }));

  app.post('/admin/children/attention/clear', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    await handleChildAttentionClear(req, res, toNullableInt(req.body.childId));
  }));

  app.post('/admin/children/:id/attention/clear', adminOnly, requirePermission('booking.attention.delete'), requireWritable(), asyncHandler(async (req, res) => {
    await handleChildAttentionClear(req, res, Number(req.params.id));
  }));

  app.post('/admin/children/:id/toggle', adminOnly, requirePermission('data.children.edit'), requireWritable(), asyncHandler(async (req, res) => {
    const redirectExtras = buildChildQueryExtras(req.body);
    const childId = Number(req.params.id);
    const rows = await dbQuery('SELECT id, name, enabled FROM children WHERE id = ? LIMIT 1', [childId]);
    if (!rows.length) return res.redirect(buildPanelUrl('操作失败：幼儿档案不存在', 'children', redirectExtras));
    const nextEnabled = rows[0].enabled ? 0 : 1;
    await dbQuery('UPDATE children SET enabled = ? WHERE id = ?', [nextEnabled, childId]);
    audit('child_toggled', { actor: req.session.user, action: nextEnabled ? '启用幼儿档案' : '禁用幼儿档案', target: rows[0].name, childName: rows[0].name, targetNames: [rows[0].name], enabled: nextEnabled, ip: req.ip, message: `操作人：${req.session.user && (req.session.user.name || req.session.user.username) || '系统'}；${nextEnabled ? '启用' : '禁用'}幼儿档案：${rows[0].name}` });
    res.redirect(buildPanelUrl('幼儿档案状态已更新', 'children', redirectExtras));
  }));


  // ========== 体测数据录入 ==========
  app.post('/admin/fitness/add', adminOnly, requirePermission('data.fitness.create'), requireWritable(), asyncHandler(async (req, res) => {
    const childId = toNullableInt(req.body.childId);
    const testDate = normalizeText(req.body.testDate) || new Date().toISOString().slice(0, 10);
    const redirectExtras = buildFitnessQueryExtras(req.body);
    if (!childId) return res.redirect(buildFitnessUrl('体测录入失败：请选择幼儿', redirectExtras));

    // 获取幼儿信息（性别、出生日期）
    const childRows = await dbQuery('SELECT id, name, gender, birth_date FROM children WHERE id = ? LIMIT 1', [childId]);
    if (!childRows.length) return res.redirect(buildFitnessUrl('体测录入失败：幼儿不存在', redirectExtras));
    const child = childRows[0];
    const monthAge = calculateMonthAge(child.birth_date, testDate);

    const data = {
      heightCm: req.body.heightCm ? Number(req.body.heightCm) : null,
      weightKg: req.body.weightKg ? Number(req.body.weightKg) : null,
      gripKg: req.body.gripKg ? Number(req.body.gripKg) : null,
      longJumpCm: req.body.longJumpCm ? Number(req.body.longJumpCm) : null,
      sitReachCm: req.body.sitReachCm ? Number(req.body.sitReachCm) : null,
      doubleJumpSec: req.body.doubleJumpSec ? Number(req.body.doubleJumpSec) : null,
      obstacleRunSec: req.body.obstacleRunSec ? Number(req.body.obstacleRunSec) : null,
      balanceBeamSec: req.body.balanceBeamSec ? Number(req.body.balanceBeamSec) : null
    };

    const result = computeFitnessResult(data, child.gender, monthAge);

    const existingRows = await dbQuery(`
      SELECT id, test_date, height_cm, weight_kg, bmi, grip_kg, long_jump_cm, sit_reach_cm,
             double_jump_sec, obstacle_run_sec, balance_beam_sec, total_score, rating
      FROM fitness_records
      WHERE child_id = ? AND test_date = ?
      ORDER BY id DESC
      LIMIT 1
    `, [childId, testDate]);
    const nextAuditState = buildFitnessAuditState(testDate, data, result);
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
    } else {
      await dbQuery(`
        INSERT INTO fitness_records
          (child_id, test_date, height_cm, weight_kg, bmi, grip_kg, long_jump_cm, sit_reach_cm,
           double_jump_sec, obstacle_run_sec, balance_beam_sec,
           height_score, bmi_score, grip_score, jump_score, sit_score, djump_score, obstacle_score, balance_score,
           total_score, rating, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [childId, testDate, data.heightCm, data.weightKg, result.bmi,
         data.gripKg, data.longJumpCm, data.sitReachCm,
         data.doubleJumpSec, data.obstacleRunSec, data.balanceBeamSec,
         result.scores.height, result.scores.bmi, result.scores.grip, result.scores.longJump, result.scores.sitReach,
         result.scores.doubleJump, result.scores.obstacleRun, result.scores.balanceBeam,
         result.totalScore, result.rating, req.session.user.id]);
    }

    if (existingRows.length) {
      const previousAuditState = {
        testDate: existingRows[0].test_date ? new Date(existingRows[0].test_date).toISOString().slice(0, 10) : testDate,
        heightCm: existingRows[0].height_cm,
        weightKg: existingRows[0].weight_kg,
        bmi: existingRows[0].bmi,
        gripKg: existingRows[0].grip_kg,
        longJumpCm: existingRows[0].long_jump_cm,
        sitReachCm: existingRows[0].sit_reach_cm,
        doubleJumpSec: existingRows[0].double_jump_sec,
        obstacleRunSec: existingRows[0].obstacle_run_sec,
        balanceBeamSec: existingRows[0].balance_beam_sec,
        totalScore: existingRows[0].total_score,
        rating: existingRows[0].rating
      };
      audit('fitness_record_updated', {
        actor: req.session.user,
        action: '录入并覆盖体测记录',
        target: child.name,
        childName: child.name,
        childId,
        recordId: existingRows[0].id,
        ip: req.ip,
        changes: buildAuditChanges(previousAuditState, nextAuditState, FITNESS_AUDIT_LABELS)
      });
    } else {
      audit('fitness_record_added', {
        actor: req.session.user,
        action: '新增体测记录',
        target: child.name,
        childName: child.name,
        childId,
        testDate,
        totalScore: result.totalScore,
        rating: result.rating,
        ip: req.ip,
        afterDetails: buildAuditSnapshot(nextAuditState, FITNESS_AUDIT_LABELS)
      });
    }

    res.redirect(buildFitnessUrl(`${child.name} ${existingRows.length ? '体测记录已更新' : '体测录入成功'}，综合得分 ${result.totalScore ?? '-'}，评级 ${result.rating ?? '-'}`, {
      ...redirectExtras,
      view: 'child',
      childId
    }));
  }));

  // ========== 体测模板下载 ==========
  app.get('/admin/fitness/template', adminOnly, requireAnyPermission(['data.fitness.import','data.fitness.create']), requireWritable(), asyncHandler(async (req, res) => {
    sendWorkbook(res, buildFitnessTemplateWorkbook(), '体测数据导入模板.xlsx');
  }));

  // ========== 体测批量导入 ==========
  app.post('/admin/fitness/import', adminOnly, requirePermission('data.fitness.import'), requireWritable(), upload.single('file'), asyncHandler(async (req, res) => {
    const redirectExtras = buildFitnessQueryExtras(req.body);
    const rows = parseWorkbookRows(req.file);
    const scoreFieldLabels = {
      height: '身高',
      bmi: 'BMI（由身高、体重自动计算）',
      grip: '握力',
      longJump: '立定跳远',
      sitReach: '坐位体前屈',
      doubleJump: '双脚连续跳',
      obstacleRun: '15米绕障碍跑',
      balanceBeam: '走平衡木'
    };
    const metricSpecs = [
      { key: 'heightCm', label: '身高(CM)', aliases: ['身高(CM)', '身高', 'height'] },
      { key: 'weightKg', label: '体重(KG)', aliases: ['体重(KG)', '体重', 'weight'] },
      { key: 'gripKg', label: '握力(KG)', aliases: ['握力(KG)', '握力', 'grip'] },
      { key: 'longJumpCm', label: '立定跳远(CM)', aliases: ['立定跳远(CM)', '立定跳远', 'jump'] },
      { key: 'sitReachCm', label: '坐位体前屈(CM)', aliases: ['坐位体前屈(CM)', '坐位体前屈', 'sit_reach'] },
      { key: 'doubleJumpSec', label: '双脚连续跳(秒)', aliases: ['双脚连续跳(秒)', '双脚连续跳', 'double_jump'] },
      { key: 'obstacleRunSec', label: '15米绕障碍跑(秒)', aliases: ['15米绕障碍跑(秒)', '15米绕障碍跑', 'obstacle'] },
      { key: 'balanceBeamSec', label: '走平衡木(秒)', aliases: ['走平衡木(秒)', '走平衡木', 'balance'] }
    ];
    let inserted = 0, updated = 0, skipped = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const excelRowNumber = index + 2;
      const className = normalizeText(pickValue(row, ['班级', 'class']));
      const childName = normalizeText(pickValue(row, ['幼儿姓名', '姓名', 'name']));
      const rawTestDate = pickValue(row, ['测试日期', 'date', '日期']);
      const rawTestDateText = normalizeText(rawTestDate);
      const testDate = rawTestDateText ? normalizeFlexibleDate(rawTestDateText) : new Date().toISOString().slice(0, 10);
      const rowHasAnyValue = [className, childName, rawTestDateText].some(Boolean) || metricSpecs.some((spec) => normalizeText(pickValue(row, spec.aliases)));
      if (!rowHasAnyValue) { skipped++; continue; }
      if (!childName) {
        return res.redirect(buildFitnessUrl('', { ...redirectExtras, error: `体测数据导入失败：第 ${excelRowNumber} 行【幼儿姓名】不能为空` }));
      }
      if (rawTestDateText && !testDate) {
        return res.redirect(buildFitnessUrl('', { ...redirectExtras, error: `体测数据导入失败：第 ${excelRowNumber} 行【测试日期】格式错误（${rawTestDateText}），请填写 YYYY-MM-DD` }));
      }

      let childRow;
      if (className) {
        const cls = await ensureClassByName(className);
        const cr = await dbQuery('SELECT id, name, gender, birth_date FROM children WHERE class_id = ? AND name = ? LIMIT 1', [cls.id, childName]);
        childRow = cr[0];
      }
      if (!childRow) {
        const cr = await dbQuery('SELECT id, name, gender, birth_date FROM children WHERE name = ? LIMIT 1', [childName]);
        childRow = cr[0];
      }
      if (!childRow) {
        return res.redirect(buildFitnessUrl('', { ...redirectExtras, error: `体测数据导入失败：第 ${excelRowNumber} 行未找到幼儿【${childName}】` }));
      }
      if (!childRow.birth_date) {
        return res.redirect(buildFitnessUrl('', { ...redirectExtras, error: `体测数据导入失败：第 ${excelRowNumber} 行对应幼儿【${childName}】缺少出生日期，无法计算月龄和分数` }));
      }

      const data = {};
      for (const spec of metricSpecs) {
        const rawValue = pickValue(row, spec.aliases);
        const text = normalizeText(rawValue);
        if (!text) {
          return res.redirect(buildFitnessUrl('', { ...redirectExtras, error: `体测数据导入失败：第 ${excelRowNumber} 行【${spec.label}】不能为空` }));
        }
        const numericValue = Number(text);
        if (!Number.isFinite(numericValue)) {
          return res.redirect(buildFitnessUrl('', { ...redirectExtras, error: `体测数据导入失败：第 ${excelRowNumber} 行【${spec.label}】不是有效数字（${text}）` }));
        }
        data[spec.key] = numericValue;
      }

      const monthAge = calculateMonthAge(childRow.birth_date, testDate);
      if (monthAge == null) {
        return res.redirect(buildFitnessUrl('', { ...redirectExtras, error: `体测数据导入失败：第 ${excelRowNumber} 行无法计算幼儿【${childName}】月龄` }));
      }
      const result = computeFitnessResult(data, childRow.gender, monthAge);
      const missingScoreLabels = Object.entries(result.scores || {})
        .filter(([, value]) => value == null)
        .map(([key]) => scoreFieldLabels[key] || key);
      if (missingScoreLabels.length || result.totalScore == null || !result.rating) {
        return res.redirect(buildFitnessUrl('', {
          ...redirectExtras,
          error: `体测数据导入失败：第 ${excelRowNumber} 行【${childName}】未能算出完整分数，请检查这些项目是否超出评分标准：${missingScoreLabels.join('、') || '综合得分/评级'}`
        }));
      }

      const existingRows = await dbQuery('SELECT id FROM fitness_records WHERE child_id = ? AND test_date = ? ORDER BY id DESC LIMIT 1', [childRow.id, testDate]);
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
      } else {
        await dbQuery(`
          INSERT INTO fitness_records
            (child_id, test_date, height_cm, weight_kg, bmi, grip_kg, long_jump_cm, sit_reach_cm,
             double_jump_sec, obstacle_run_sec, balance_beam_sec,
             height_score, bmi_score, grip_score, jump_score, sit_score, djump_score, obstacle_score, balance_score,
             total_score, rating, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [childRow.id, testDate, data.heightCm, data.weightKg, result.bmi,
           data.gripKg, data.longJumpCm, data.sitReachCm,
           data.doubleJumpSec, data.obstacleRunSec, data.balanceBeamSec,
           result.scores.height, result.scores.bmi, result.scores.grip, result.scores.longJump, result.scores.sitReach,
           result.scores.doubleJump, result.scores.obstacleRun, result.scores.balanceBeam,
           result.totalScore, result.rating, req.session.user.id]);
        inserted++;
      }
    }
    audit('fitness_records_imported', { actor: req.session.user, action: '导入体测数据', target: '体测数据', inserted, updated, skipped, ip: req.ip });
    res.redirect(buildFitnessUrl(`体测数据导入完成：新增 ${inserted}，覆盖 ${updated}，跳过 ${skipped}`, redirectExtras));
  }));

  // ========== 体测数据查看（个人/班级/年级/全园） ==========
  app.get('/admin/fitness', adminOnly, requirePermission('data.fitness.view'), asyncHandler(async (req, res) => {
    const data = await fetchFitnessViewData(req.query, { includeChildren: true });
    const editId = toNullableInt(req.query.editId);
    let editRecord = null;
    if (editId) {
      const editRows = await dbQuery(`
        SELECT fr.*, ch.name AS child_name, ch.gender, ch.birth_date, c.name AS class_name
        FROM fitness_records fr
        JOIN children ch ON ch.id = fr.child_id
        LEFT JOIN classes c ON c.id = ch.class_id
        WHERE fr.id = ?
        LIMIT 1
      `, [editId]);
      editRecord = editRows[0] || null;
    }
    res.render('admin-fitness', {
      ...data,
      message: normalizeText(req.query.message),
      error: normalizeText(req.query.error),
      editRecord,
      hasPerm: (perm) => hasPermission(req.session.user, perm),
      currentUser: req.session.user,
      isReadonly: !!req.session.user.isReadonly
    });
  }));


  app.post('/admin/fitness/:id/update', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    const recordId = toNullableInt(req.params.id);
    const redirectExtras = buildFitnessQueryExtras(req.body);
    if (!recordId) return res.redirect(buildFitnessUrl('', { ...redirectExtras, error: '体测修正失败：记录不存在' }));

    const recordRows = await dbQuery(`
      SELECT fr.id, fr.child_id, fr.test_date, fr.height_cm, fr.weight_kg, fr.bmi, fr.grip_kg, fr.long_jump_cm, fr.sit_reach_cm,
             fr.double_jump_sec, fr.obstacle_run_sec, fr.balance_beam_sec, fr.total_score, fr.rating,
             ch.name AS child_name, ch.gender, ch.birth_date
      FROM fitness_records fr
      JOIN children ch ON ch.id = fr.child_id
      WHERE fr.id = ?
      LIMIT 1
    `, [recordId]);
    if (!recordRows.length) return res.redirect(buildFitnessUrl('', { ...redirectExtras, error: '体测修正失败：记录不存在' }));

    const record = recordRows[0];
    const testDate = normalizeFlexibleDate(req.body.testDate);
    if (!testDate) {
      return res.redirect(buildFitnessUrl('', { ...redirectExtras, editId: recordId, error: '体测修正失败：测试日期格式不正确，请填写 YYYY-MM-DD' }));
    }
    if (!record.birth_date) {
      return res.redirect(buildFitnessUrl('', { ...redirectExtras, editId: recordId, error: `体测修正失败：幼儿【${record.child_name}】缺少出生日期，无法重新计算分数` }));
    }

    const metricSpecs = [
      ['heightCm', '身高(CM)'],
      ['weightKg', '体重(KG)'],
      ['gripKg', '握力(KG)'],
      ['longJumpCm', '立定跳远(CM)'],
      ['sitReachCm', '坐位体前屈(CM)'],
      ['doubleJumpSec', '双脚连续跳(秒)'],
      ['obstacleRunSec', '15米绕障碍跑(秒)'],
      ['balanceBeamSec', '走平衡木(秒)']
    ];
    const data = {};
    for (const [field, label] of metricSpecs) {
      const textValue = normalizeText(req.body[field]);
      if (!textValue) {
        return res.redirect(buildFitnessUrl('', { ...redirectExtras, editId: recordId, error: `体测修正失败：【${label}】不能为空` }));
      }
      const numericValue = Number(textValue);
      if (!Number.isFinite(numericValue)) {
        return res.redirect(buildFitnessUrl('', { ...redirectExtras, editId: recordId, error: `体测修正失败：【${label}】不是有效数字（${textValue}）` }));
      }
      data[field] = numericValue;
    }

    const monthAge = calculateMonthAge(record.birth_date, testDate);
    const result = computeFitnessResult(data, record.gender, monthAge);
    const scoreFieldLabels = {
      height: '身高',
      bmi: 'BMI（由身高、体重自动计算）',
      grip: '握力',
      longJump: '立定跳远',
      sitReach: '坐位体前屈',
      doubleJump: '双脚连续跳',
      obstacleRun: '15米绕障碍跑',
      balanceBeam: '走平衡木'
    };
    const missingScoreLabels = Object.entries(result.scores || {})
      .filter(([, value]) => value == null)
      .map(([key]) => scoreFieldLabels[key] || key);
    if (missingScoreLabels.length || result.totalScore == null || !result.rating) {
      return res.redirect(buildFitnessUrl('', {
        ...redirectExtras,
        editId: recordId,
        error: `体测修正失败：仍未能算出完整分数，请检查这些项目是否超出评分标准：${missingScoreLabels.join('、') || '综合得分/评级'}`
      }));
    }

    // 预检查唯一约束：同一幼儿 同一天已有另一条记录时提供明确提示
    if (testDate !== (record.test_date ? new Date(record.test_date).toISOString().slice(0, 10) : '')) {
      const dupRows = await dbQuery(
        'SELECT id FROM fitness_records WHERE child_id = ? AND test_date = ? AND id <> ? LIMIT 1',
        [record.child_id, testDate, recordId]
      );
      if (dupRows.length) {
        return res.redirect(buildFitnessUrl('', {
          ...redirectExtras,
          editId: recordId,
          error: `体测修正失败：${record.child_name} 在 ${testDate} 已存在一条体测记录（ID:${dupRows[0].id}）。同一幼儿同一天只能保留一条记录，请先删除/修改其中一条。`
        }));
      }
    }

    try {
      await dbQuery(`
        UPDATE fitness_records
           SET test_date = ?,
               height_cm = ?, weight_kg = ?, bmi = ?, grip_kg = ?, long_jump_cm = ?, sit_reach_cm = ?,
               double_jump_sec = ?, obstacle_run_sec = ?, balance_beam_sec = ?,
               height_score = ?, bmi_score = ?, grip_score = ?, jump_score = ?, sit_score = ?, djump_score = ?, obstacle_score = ?, balance_score = ?,
               total_score = ?, rating = ?
         WHERE id = ?
      `, [
        testDate,
        data.heightCm, data.weightKg, result.bmi, data.gripKg, data.longJumpCm, data.sitReachCm,
        data.doubleJumpSec, data.obstacleRunSec, data.balanceBeamSec,
        result.scores.height, result.scores.bmi, result.scores.grip, result.scores.longJump, result.scores.sitReach,
        result.scores.doubleJump, result.scores.obstacleRun, result.scores.balanceBeam,
        result.totalScore, result.rating, recordId
      ]);
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        return res.redirect(buildFitnessUrl('', {
          ...redirectExtras,
          editId: recordId,
          error: `体测修正失败：${record.child_name} 在 ${testDate} 已存在一条体测记录。同一幼儿同一天只能保留一条记录，请先删除/修改其中一条。`
        }));
      }
      throw err;
    }

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
      action: '修正体测记录',
      target: record.child_name,
      childName: record.child_name,
      childId: record.child_id,
      recordId,
      ip: req.ip,
      changes: buildAuditChanges(previousAuditState, nextAuditState, FITNESS_AUDIT_LABELS)
    });
    res.redirect(buildFitnessUrl(`${record.child_name} 体测记录已修正，综合得分 ${result.totalScore}，评级 ${result.rating}`, redirectExtras));
  }));

  app.post('/admin/fitness/:id/delete', adminOnly, requirePermission('data.fitness.delete'), requireWritable(), asyncHandler(async (req, res) => {
    const recordId = toNullableInt(req.params.id);
    const redirectExtras = buildFitnessQueryExtras(req.body);
    if (!recordId) return res.redirect(buildFitnessUrl('', { ...redirectExtras, error: '删除失败：记录不存在' }));

    const rows = await dbQuery(`
      SELECT fr.id, fr.child_id, fr.test_date, ch.name AS child_name
      FROM fitness_records fr
      JOIN children ch ON ch.id = fr.child_id
      WHERE fr.id = ?
      LIMIT 1
    `, [recordId]);
    if (!rows.length) return res.redirect(buildFitnessUrl('', { ...redirectExtras, error: '删除失败：记录不存在' }));

    const record = rows[0];
    await dbQuery('DELETE FROM fitness_records WHERE id = ? LIMIT 1', [recordId]);
    audit('fitness_record_deleted', {
      actor: req.session.user,
      action: '删除体测记录',
      target: record.child_name,
      childName: record.child_name,
      childId: record.child_id,
      recordId,
      testDate: record.test_date,
      ip: req.ip,
      message: `【高亮】${req.session.user && (req.session.user.name || req.session.user.username) || '系统'} 删除了 ${record.child_name} 在 ${record.test_date ? new Date(record.test_date).toISOString().slice(0, 10) : '-'} 的体测记录（ID:${recordId}）`
    });
    res.redirect(buildFitnessUrl(`${record.child_name} 的体测记录已删除`, redirectExtras));
  }));

  // Admin 幼儿纵向对比数据 (不受班级限制)
  app.get('/admin/fitness/compare/:childId', adminOnly, asyncHandler(async (req, res) => {
    const childId = Number(req.params.childId);
    if (!childId) {
      return res.json({ ok: false, message: '参数错误' });
    }
    const [child] = await dbQuery(
      'SELECT id, name, gender, birth_date FROM children WHERE id = ? LIMIT 1',
      [childId]
    );
    if (!child) {
      return res.json({ ok: false, message: '未找到该幼儿' });
    }
    const sql = 'SELECT fr.id, fr.test_date, fr.height_cm, fr.weight_kg, fr.bmi,' +
      ' fr.grip_kg, fr.long_jump_cm, fr.sit_reach_cm,' +
      ' fr.double_jump_sec, fr.obstacle_run_sec, fr.balance_beam_sec,' +
      ' fr.height_score, fr.bmi_score, fr.grip_score, fr.jump_score,' +
      ' fr.sit_score, fr.djump_score, fr.obstacle_score, fr.balance_score,' +
      ' fr.total_score, fr.rating' +
      ' FROM fitness_records fr WHERE fr.child_id = ? ORDER BY fr.test_date ASC';
    const records = await dbQuery(sql, [childId]);
    res.json({ ok: true, child: { id: child.id, name: child.name, gender: child.gender, birthDate: child.birth_date ? new Date(child.birth_date).toISOString().slice(0, 10) : '' }, records: records.map(r => ({ id: r.id, testDate: r.test_date ? new Date(r.test_date).toISOString().slice(0, 10) : '', heightCm: r.height_cm, weightKg: r.weight_kg, bmi: r.bmi, gripKg: r.grip_kg, gripScore: r.grip_score, longJumpCm: r.long_jump_cm, jumpScore: r.jump_score, sitReachCm: r.sit_reach_cm, sitScore: r.sit_score, doubleJumpSec: r.double_jump_sec, djumpScore: r.djump_score, obstacleRunSec: r.obstacle_run_sec, obstacleScore: r.obstacle_score, balanceBeamSec: r.balance_beam_sec, balanceScore: r.balance_score, totalScore: r.total_score, rating: r.rating })) });
  }));

  app.post('/admin/fitness/batch-delete', adminOnly, requirePermission('data.fitness.delete'), requireWritable(), asyncHandler(async (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : String(req.body.ids || '').split(',').map(s => Number(s.trim())).filter(n => n > 0));
    const redirectExtras = buildFitnessQueryExtras(req.body);
    const redirectUrl = buildFitnessUrl('', redirectExtras);
    if (!ids.length) {
      return res.redirect(redirectUrl + '&message=' + encodeURIComponent('未选择要删除的记录'));
    }
    const placeholders = ids.map(() => '?').join(',');
    const [existing] = await dbQuery(
      `SELECT fr.id, fr.child_id, fr.test_date, ch.name AS child_name 
       FROM fitness_records fr 
       JOIN children ch ON ch.id = fr.child_id 
       WHERE fr.id IN (${placeholders})`,
      ids
    );
    if (existing.length) {
      await dbQuery(`DELETE FROM fitness_records WHERE id IN (${placeholders})`, ids.filter(id => existing.some(e => e.id === id)));
    }
    audit('fitness_records_batch_deleted', {
      actor: req.session.user,
      action: '批量删除体测记录',
      target: `${existing.length}条记录`,
      count: existing.length,
      childNames: existing.map(e => e.child_name),
      ip: req.ip
    });
    res.redirect(redirectUrl + '&message=' + encodeURIComponent(`已删除 ${existing.length} 条体测记录`));
  }));

  app.get('/admin/fitness/export', adminOnly, requirePermission('data.fitness.export'), requireWritable(), asyncHandler(async (req, res) => {
    const data = await fetchFitnessViewData(req.query, { includeChildren: false, paginate: false });
    const rows = data.records.map((r) => ({
      班级: r.class_name || '',
      幼儿姓名: r.child_name || '',
      性别: r.gender || '',
      测试日期: r.test_date ? new Date(r.test_date).toISOString().slice(0, 10) : '',
      '身高(CM)': r.height_cm ?? '',
      身高分: r.height_score ?? '',
      '体重(KG)': r.weight_kg ?? '',
      BMI: r.bmi ?? '',
      BMI分: r.bmi_score ?? '',
      '握力(KG)': r.grip_kg ?? '',
      握力分: r.grip_score ?? '',
      '立定跳远(CM)': r.long_jump_cm ?? '',
      跳远分: r.jump_score ?? '',
      '坐位体前屈(CM)': r.sit_reach_cm ?? '',
      体前屈分: r.sit_score ?? '',
      '双脚连续跳(秒)': r.double_jump_sec ?? '',
      双脚跳分: r.djump_score ?? '',
      '15米绕障碍跑(秒)': r.obstacle_run_sec ?? '',
      障碍跑分: r.obstacle_score ?? '',
      '走平衡木(秒)': r.balance_beam_sec ?? '',
      平衡木分: r.balance_score ?? '',
      综合得分: r.total_score ?? '',
      评级: r.rating || ''
    }));
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), '体测数据');
    const filename = `${data.title.replace(/[\\/:*?"<>|]/g, '_') || '体测数据'}导出.xlsx`;
    sendWorkbook(res, wb, filename);
  }));


  // ========== 角色权限管理 ==========
  app.post('/admin/roles/add', adminOnly, requirePermission('admin.roles.create'), requireWritable(), asyncHandler(async (req, res) => {
    const name = normalizeText(req.body.name).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const displayName = normalizeText(req.body.displayName);
    const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : (req.body.permissions ? [req.body.permissions] : []);
    const isReadonly = req.body.isReadonly === '1';
    if (!name || !displayName) return res.redirect('/admin?panel=roles&message=' + encodeURIComponent('角色名称不能为空'));
    try {
      await createRole(name, displayName, permissions, isReadonly);
      audit('role_create', { actor: req.session.user, role: { name, displayName, permissions, isReadonly } });
      res.redirect('/admin?panel=roles&message=' + encodeURIComponent('角色已创建'));
    } catch (err) {
      res.redirect('/admin?panel=roles&message=' + encodeURIComponent('创建失败: ' + (err.code === 'ER_DUP_ENTRY' ? '角色名已存在' : err.message)));
    }
  }));

  app.post('/admin/roles/:id/edit', adminOnly, requirePermission('admin.roles.edit'), requireWritable(), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const displayName = normalizeText(req.body.displayName);
    const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : (req.body.permissions ? [req.body.permissions] : []);
    const isReadonly = req.body.isReadonly === '1';
    await updateRole(id, displayName, permissions, isReadonly);
    audit('role_update', { actor: req.session.user, roleId: id, displayName, permissions, isReadonly });
    res.redirect('/admin?panel=roles&message=' + encodeURIComponent('角色已更新'));
  }));


  app.post('/admin/roles/:id/clone', adminOnly, requirePermission('admin.roles.create'), requireWritable(), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const name = normalizeText(req.body.name).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const displayName = normalizeText(req.body.displayName);
    if (!name || !displayName) return res.redirect('/admin?panel=roles&message=' + encodeURIComponent('角色名称不能为空'));
    try {
      await cloneRole(id, name, displayName);
      audit('role_clone', { actor: req.session.user, sourceId: id, newRole: { name, displayName } });
      res.redirect('/admin?panel=roles&message=' + encodeURIComponent('角色已复制'));
    } catch (err) {
      res.redirect('/admin?panel=roles&message=' + encodeURIComponent('复制失败: ' + (err.code === 'ER_DUP_ENTRY' ? '角色名已存在' : err.message)));
    }
  }));

  app.post('/admin/roles/:id/delete', adminOnly, requirePermission('admin.roles.delete'), requireWritable(), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const ok = await deleteRole(id);
    const msg = ok ? '角色已删除' : '无法删除：admin 角色不可删除，或该角色下仍有用户使用';
    res.redirect('/admin?panel=roles&message=' + encodeURIComponent(msg));
  }));

  // ========== AI 接入管理 ==========
  app.post('/admin/ai/settings', adminOnly, requirePermission('ops.site.edit'), requireWritable(), asyncHandler(async (req, res) => {
    const before = await getAiSettings(false);
    const aiEnabled = req.body.aiEnabled ? '1' : '0';
    const payload = {
      aiEnabled,
      aiBaseUrl: normalizeText(req.body.aiBaseUrl),
      aiModel: normalizeText(req.body.aiModel),
      aiProviderName: normalizeText(req.body.aiProviderName),
      aiTimeoutMs: normalizeText(req.body.aiTimeoutMs),
      aiTemperature: normalizeText(req.body.aiTemperature),
      aiMaxTokens: normalizeText(req.body.aiMaxTokens),
      aiSystemPrompt: normalizeText(req.body.aiSystemPrompt)
    };
    const rawKey = String(req.body.aiApiKey || '').trim();
    if (rawKey && !rawKey.includes('****')) {
      payload.aiApiKey = rawKey;
    }
    if (req.body.clearApiKey === '1') {
      await clearAiApiKey();
    }
    await saveAiSettings(payload);
    audit('ai_settings_updated', {
      actor: req.session.user,
      action: '修改AI接入设置',
      target: 'AI 接入设置',
      ip: req.ip,
      changes: [
        { field: 'aiEnabled', label: '启用状态', before: before.aiEnabled, after: aiEnabled },
        { field: 'aiBaseUrl', label: '接口 URL', before: before.aiBaseUrl, after: payload.aiBaseUrl },
        { field: 'aiModel', label: '模型', before: before.aiModel, after: payload.aiModel },
        { field: 'aiProviderName', label: '供应商', before: before.aiProviderName, after: payload.aiProviderName },
        { field: 'aiApiKey', label: 'API Key', before: before.aiApiKeyMasked || '未设置', after: rawKey ? '已更新' : (req.body.clearApiKey === '1' ? '已清空' : (before.aiApiKeyMasked || '未设置')) }
      ]
    });
    res.redirect('/admin?panel=ai&message=' + encodeURIComponent('AI 接入设置已保存'));
  }));

  // 连通性测试
  app.get('/admin/ai/test', adminOnly, requirePermission('ops.site.view'), asyncHandler(async (req, res) => {
    try {
      const result = await aiClient.testConnection();
      res.json({ ok: true, model: result.model, sample: result.sample });
    } catch (err) {
      const status = err.code === 'AI_NOT_CONFIGURED' ? 200 : 200;
      res.status(status).json({ ok: false, code: err.code || 'UNKNOWN', message: err.message || String(err) });
    }
  }));

  // 体测智能分析报告 (SSE 流式)
  app.get('/admin/fitness/ai-report', adminOnly, requirePermission('data.fitness.view'), asyncHandler(async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    function sse(event, data) {
      res.write('event: ' + event + '\n');
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    }

    let aborted = false;
    req.on('close', () => { aborted = true; });

    try {
      const data = await fetchFitnessViewData(req.query, { includeChildren: false, paginate: false });
      const records = Array.isArray(data.records) ? data.records : [];
      const recordsCount = records.length;
      if (!recordsCount) {
        sse('error', { message: '当前筛选范围内没有体测数据，无法生成报告。' });
        sse('done', { ok: false });
        return res.end();
      }

      const viewMode = data.viewMode || 'all';
      const scopeLabel = data.title || '全园体测数据';

      let payload;
      if (viewMode === 'child') {
        const first = records[0] || {};
        const sortedRecords = records.slice().sort((a, b) => {
          const da = a.test_date ? new Date(a.test_date).getTime() : 0;
          const db = b.test_date ? new Date(b.test_date).getTime() : 0;
          return db - da;
        });
        payload = {
          kind: 'child',
          child: {
            name: first.child_name,
            gender: first.gender,
            birth_date: first.birth_date ? String(first.birth_date).slice(0, 10) : '',
            class_name: first.class_name
          },
          latest: sortedRecords[0],
          recentRecords: sortedRecords.slice(0, 8)
        };
      } else {
        payload = {
          kind: 'scope',
          scope: viewMode,
          scopeLabel,
          recordsCount,
          avgScore: data.avgScore,
          ratingSummary: data.ratingSummary,
          radarChartData: data.radarChartData,
          metricNeedTrainingSummary: data.metricNeedTrainingSummary,
          trendSummary: data.trendSummary
        };
      }

      sse('meta', {
        scope: payload.kind === 'child' ? '个人画像' : scopeLabel,
        recordsCount,
        generatedAt: new Date().toISOString()
      });

      // 心跳：避免代理/浏览器在思维链期间认为连接闲置而断开
      const heartbeat = setInterval(() => {
        if (aborted) return;
        try { res.write(': keep-alive\n\n'); } catch (e) {}
      }, 15000);

      let totalText = '';
      let reasoningText = '';
      try {
        for await (const piece of aiFitnessReport.generateReportStream(payload)) {
          if (aborted) break;
          if (!piece || !piece.content) continue;
          if (piece.type === 'reasoning') {
            reasoningText += piece.content;
            sse('reasoning', { content: piece.content });
          } else {
            totalText += piece.content;
            sse('delta', { content: piece.content });
          }
        }
      } catch (err) {
        clearInterval(heartbeat);
        sse('error', { code: err.code || 'AI_ERROR', message: err.message || String(err) });
        sse('done', { ok: false });
        return res.end();
      }
      clearInterval(heartbeat);

      audit('ai_fitness_report', {
        actor: req.session.user,
        action: '生成AI体测报告',
        target: scopeLabel,
        ip: req.ip,
        scope: payload.kind,
        recordsCount,
        outputLength: totalText.length,
        reasoningLength: reasoningText.length
      });
      sse('done', { ok: true, length: totalText.length, reasoningLength: reasoningText.length });
      res.end();
    } catch (err) {
      try {
        sse('error', { code: err.code || 'INTERNAL', message: err.message || String(err) });
        sse('done', { ok: false });
      } catch (e) {}
      res.end();
    }
  }));


};
