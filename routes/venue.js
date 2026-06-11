const path = require('path');
const fs = require('fs');
const { normalizeText, normalizeFlexibleDate, toNullableInt, normalizeAttentionVest, asyncHandler, gradeLabel, requireRole, requireWritable, chinaNowText } = require('../lib/helpers');
const { getPool, dbQuery, buildUserDashboard, getSettings, saveSettings } = require('../lib/db');
const { audit, buildAuditChanges, buildAuditSnapshot } = require('../lib/logger');

function capField(gradeLevel) {
  if (gradeLevel === 'small') return 'cap_small';
  if (gradeLevel === 'middle') return 'cap_middle';
  return 'cap_large';
}

function visiblePoolsForGrade(gradeLevel) {
  return gradeLevel === 'small' ? ['small'] : ['middle', 'large'];
}

function buildVenueBookingLabel(venueName, sortOrder) {
  const normalizedName = normalizeText(venueName);
  const numericSortOrder = Number(sortOrder);

  if (normalizedName && normalizedName.includes('模块')) {
    return normalizedName;
  }

  if (Number.isFinite(numericSortOrder) && numericSortOrder > 0) {
    return normalizedName ? `模块${numericSortOrder}（${normalizedName}）` : `模块${numericSortOrder}`;
  }

  return normalizedName || '已预约模块';
}

function extractVenueDisplayOrder(venueName, sortOrder) {
  const normalizedName = normalizeText(venueName);
  const nameMatch = normalizedName.match(/(\d+)/);
  if (nameMatch) {
    return Number(nameMatch[1]);
  }
  const numericSortOrder = Number(sortOrder);
  if (Number.isFinite(numericSortOrder) && numericSortOrder > 0) {
    return numericSortOrder;
  }
  return Number.MAX_SAFE_INTEGER;
}

function compareVenueDisplayOrder(left, right) {
  const leftOrder = extractVenueDisplayOrder(left && left.venueName, left && left.sortOrder);
  const rightOrder = extractVenueDisplayOrder(right && right.venueName, right && right.sortOrder);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  const leftFallback = Number((left && left.sortOrder) || 0);
  const rightFallback = Number((right && right.sortOrder) || 0);
  if (leftFallback !== rightFallback) return leftFallback - rightFallback;
  return String((left && left.venueName) || '').localeCompare(String((right && right.venueName) || ''), 'zh-CN');
}

const VENUE_ROUND_AUDIT_LABELS = {
  roundDate: '活动日期',
  openTime: '开放时间',
  closeTime: '截止时间'
};

function formatPercent(value, digits = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return digits > 0 ? `0.${'0'.repeat(digits)}%` : '0%';
  return `${numeric.toFixed(digits)}%`;
}

function normalizeRoundDateTimeInput(value) {
  const text = normalizeText(value);
  return text ? text.slice(0, 16).replace(' ', 'T') : '';
}

function formatBookingLocalDateTime(value) {
  const text = normalizeText(value);
  return text || '-';
}

function parseBookingLocalTimeMs(value) {
  const text = normalizeText(value);
  if (!text) return 0;
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const timestamp = Date.parse(`${normalized}+08:00`);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeVestType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'red' || text === 'green') return text;
  return 'yellow';
}

function attentionVestPriority(value) {
  const vestType = normalizeVestType(value);
  if (vestType === 'red') return 0;
  if (vestType === 'yellow') return 1;
  return 2;
}

function attentionVestLabel(value) {
  const vestType = normalizeVestType(value);
  if (vestType === 'red') return '红马甲';
  if (vestType === 'green') return '绿马甲';
  return '黄马甲';
}

function compareAttentionChildren(left, right) {
  const vestDiff = attentionVestPriority(left && left.attention_vest_type) - attentionVestPriority(right && right.attention_vest_type);
  if (vestDiff !== 0) return vestDiff;
  const venueSortDiff = Number((left && left.sort_order) || 0) - Number((right && right.sort_order) || 0);
  if (venueSortDiff !== 0) return venueSortDiff;
  const classDiff = String((left && left.class_name) || '').localeCompare(String((right && right.class_name) || ''), 'zh-CN');
  if (classDiff !== 0) return classDiff;
  return String((left && left.name) || '').localeCompare(String((right && right.name) || ''), 'zh-CN');
}

function buildAttentionReminderChildren(attentionChildren = []) {
  const childMap = new Map();

  attentionChildren
    .slice()
    .sort(compareAttentionChildren)
    .forEach((child) => {
      const childId = Number(child.id);
      if (!childId) return;

      const venueLabel = buildVenueBookingLabel(child.venue_name, child.sort_order);
      const venueOrder = extractVenueDisplayOrder(child.venue_name, child.sort_order);

      if (!childMap.has(childId)) {
        childMap.set(childId, {
          ...child,
          sort_order: venueOrder,
          venueLabels: [],
          venueSummary: ''
        });
      }

      const current = childMap.get(childId);
      if (!current.venueLabels.includes(venueLabel)) {
        current.venueLabels.push(venueLabel);
      }
      current.sort_order = Math.min(Number(current.sort_order || venueOrder), venueOrder);
      current.venueSummary = current.venueLabels.join('、');
    });

  return Array.from(childMap.values()).sort(compareAttentionChildren);
}

function summarizeVenueBookings(bookings = [], classes = [], attentionChildren = []) {
  const confirmedBookings = bookings.filter((booking) => booking.status === 'confirmed');
  const cancelledBookings = bookings.filter((booking) => booking.status === 'cancelled');
  const timeline = confirmedBookings
    .slice()
    .sort((left, right) => parseBookingLocalTimeMs(left.created_at_local_text) - parseBookingLocalTimeMs(right.created_at_local_text))
    .map((booking) => ({
      id: booking.id,
      venueName: booking.venue_name,
      className: booking.class_name,
      teacherName: booking.teacher_name || '-',
      gradePool: booking.grade_pool,
      gradeLabel: gradeLabel(booking.grade_pool),
      timeLabel: formatBookingLocalDateTime(booking.created_at_local_text),
      timeMs: parseBookingLocalTimeMs(booking.created_at_local_text)
    }));

  const confirmedClassIds = new Set(confirmedBookings.map((booking) => Number(booking.class_id)).filter(Boolean));
  const classGroups = {
    small: classes.filter((item) => item.grade_level === 'small'),
    middle: classes.filter((item) => item.grade_level === 'middle'),
    large: classes.filter((item) => item.grade_level === 'large')
  };

  const segmentConfig = {
    small: {
      key: 'small',
      label: '小班',
      pools: ['small']
    },
    mixed: {
      key: 'mixed',
      label: '中大班',
      pools: ['middle', 'large']
    }
  };

  function buildUnbookedClasses(items) {
    return items
      .filter((item) => !confirmedClassIds.has(Number(item.id)))
      .map((item) => ({
        id: item.id,
        name: item.name,
        gradeLevel: item.grade_level,
        gradeLabel: gradeLabel(item.grade_level)
      }));
  }

  function buildVenueRows(targetBookings, options = {}) {
    const venueMap = new Map();
    targetBookings.forEach((booking) => {
      const venueId = Number(booking.venue_id);
      if (!venueMap.has(venueId)) {
        venueMap.set(venueId, {
          venueId,
          venueName: booking.venue_name,
          sortOrder: Number(booking.sort_order || 0),
          totalCount: 0,
          smallCount: 0,
          middleCount: 0,
          largeCount: 0,
          cancelledCount: 0,
          firstTimeMs: 0,
          firstTimeLabel: ''
        });
      }
      const row = venueMap.get(venueId);
      if (booking.status === 'confirmed') {
        row.totalCount += 1;
        if (booking.grade_pool === 'small') row.smallCount += 1;
        if (booking.grade_pool === 'middle') row.middleCount += 1;
        if (booking.grade_pool === 'large') row.largeCount += 1;
        const timeMs = parseBookingLocalTimeMs(booking.created_at_local_text);
        if (!row.firstTimeMs || timeMs < row.firstTimeMs) {
          row.firstTimeMs = timeMs;
          row.firstTimeLabel = formatBookingLocalDateTime(booking.created_at_local_text);
        }
      } else if (booking.status === 'cancelled') {
        row.cancelledCount += 1;
      }
    });

    const totalConfirmed = targetBookings.filter((item) => item.status === 'confirmed').length;
    return Array.from(venueMap.values())
      .sort((left, right) => {
        if (right.totalCount !== left.totalCount) return right.totalCount - left.totalCount;
        return compareVenueDisplayOrder(left, right);
      })
      .map((row) => ({
        ...row,
        sharePercent: totalConfirmed ? (row.totalCount / totalConfirmed) * 100 : 0,
        shareText: totalConfirmed ? formatPercent((row.totalCount / totalConfirmed) * 100, 0) : '0%'
      }));
  }

  const segments = {};
  const smallBookings = bookings.filter((booking) => booking.grade_pool === 'small');
  const mixedBookings = bookings.filter((booking) => booking.grade_pool === 'middle' || booking.grade_pool === 'large');
  const smallConfirmedClasses = new Set(confirmedBookings.filter((booking) => booking.grade_pool === 'small').map((booking) => Number(booking.class_id)).filter(Boolean));
  const middleConfirmedClasses = new Set(confirmedBookings.filter((booking) => booking.grade_pool === 'middle').map((booking) => Number(booking.class_id)).filter(Boolean));
  const largeConfirmedClasses = new Set(confirmedBookings.filter((booking) => booking.grade_pool === 'large').map((booking) => Number(booking.class_id)).filter(Boolean));

  const smallUnbooked = buildUnbookedClasses(classGroups.small);
  const mixedClassList = classGroups.middle.concat(classGroups.large);
  const mixedUnbooked = buildUnbookedClasses(mixedClassList);

  const smallVenueRows = buildVenueRows(smallBookings);
  const mixedVenueRows = buildVenueRows(mixedBookings);
  const overallUnbookedClasses = buildUnbookedClasses(classes);
  const venueCardMap = new Map();
  const attentionByVenue = new Map();

  attentionChildren
    .slice()
    .sort(compareAttentionChildren)
    .forEach((child) => {
      const venueId = Number(child.venue_id);
      if (!venueId) return;
      if (!attentionByVenue.has(venueId)) {
        attentionByVenue.set(venueId, []);
      }
      const vestType = normalizeVestType(child.attention_vest_type);
      attentionByVenue.get(venueId).push({
        ...child,
        vestType,
        vestLabel: attentionVestLabel(vestType)
      });
    });

  segments.small = {
    ...segmentConfig.small,
    totalClasses: classGroups.small.length,
    confirmedClasses: smallConfirmedClasses.size,
    unbookedClasses: smallUnbooked,
    unbookedCount: smallUnbooked.length,
    coverageRateText: classGroups.small.length ? formatPercent((smallConfirmedClasses.size / classGroups.small.length) * 100, 0) : '0%',
    topVenue: smallVenueRows[0] || null,
    venueRows: smallVenueRows
  };

  segments.mixed = {
    ...segmentConfig.mixed,
    totalClasses: mixedClassList.length,
    confirmedClasses: middleConfirmedClasses.size + largeConfirmedClasses.size,
    middleConfirmedClasses: middleConfirmedClasses.size,
    largeConfirmedClasses: largeConfirmedClasses.size,
    unbookedClasses: mixedUnbooked,
    unbookedCount: mixedUnbooked.length,
    coverageRateText: mixedClassList.length ? formatPercent(((middleConfirmedClasses.size + largeConfirmedClasses.size) / mixedClassList.length) * 100, 0) : '0%',
    venueRows: mixedVenueRows
  };

  bookings.forEach((booking) => {
    const venueId = Number(booking.venue_id);
    if (!venueCardMap.has(venueId)) {
      venueCardMap.set(venueId, {
        venueId,
        venueName: booking.venue_name,
        sortOrder: Number(booking.sort_order || 0),
        totalCapacity: Number(booking.cap_small || 0) + Number(booking.cap_middle || 0) + Number(booking.cap_large || 0),
        confirmedCount: 0,
        cancelledCount: 0,
        firstConfirmedMs: 0,
        lastConfirmedMs: 0,
        firstConfirmedLabel: '',
        lastConfirmedLabel: '',
        entries: []
      });
    }
    const card = venueCardMap.get(venueId);
    const timeLabel = formatBookingLocalDateTime(booking.created_at_local_text);
    const timeMs = parseBookingLocalTimeMs(booking.created_at_local_text);
    if (booking.status === 'confirmed') {
      card.confirmedCount += 1;
      if (!card.firstConfirmedMs || timeMs < card.firstConfirmedMs) {
        card.firstConfirmedMs = timeMs;
        card.firstConfirmedLabel = timeLabel;
      }
      if (!card.lastConfirmedMs || timeMs > card.lastConfirmedMs) {
        card.lastConfirmedMs = timeMs;
        card.lastConfirmedLabel = timeLabel;
      }
    } else if (booking.status === 'cancelled') {
      card.cancelledCount += 1;
    }
    card.entries.push({
      id: booking.id,
      className: booking.class_name,
      teacherName: booking.teacher_name || '-',
      gradePool: booking.grade_pool,
      gradeLabel: gradeLabel(booking.grade_pool),
      status: booking.status,
      timeLabel
    });
  });

  const moduleCards = Array.from(venueCardMap.values())
    .map((card) => {
      const durationMinutes = card.firstConfirmedMs && card.lastConfirmedMs
        ? Math.max(0, Math.round((card.lastConfirmedMs - card.firstConfirmedMs) / 60000))
        : 0;
      const isFilled = card.totalCapacity > 0 && card.confirmedCount >= card.totalCapacity;
      const moduleAttentionChildren = (attentionByVenue.get(Number(card.venueId)) || []).slice();
      const attentionVestSummary = moduleAttentionChildren.reduce((accumulator, child) => {
        const vestType = normalizeVestType(child.vestType || child.attention_vest_type);
        accumulator[vestType] += 1;
        return accumulator;
      }, { red: 0, yellow: 0, green: 0 });
      return {
        ...card,
        bookingDurationMinutes: durationMinutes,
        isFilled,
        attentionChildren: moduleAttentionChildren,
        attentionCount: moduleAttentionChildren.length,
        attentionVestSummary,
        bookingDurationLabel: isFilled
          ? (durationMinutes <= 0 ? '1 分钟内抢满' : `${durationMinutes} 分钟抢满`)
          : (card.confirmedCount > 1
            ? (durationMinutes <= 0 ? '1 分钟内完成预约' : `${durationMinutes} 分钟完成当前预约`)
            : (card.confirmedCount === 1 ? '首单即锁定该模块' : '暂无确认预约')),
        entries: card.entries.sort((left, right) => {
          if (left.status !== right.status) return left.status === 'confirmed' ? -1 : 1;
          return left.className.localeCompare(right.className, 'zh-CN');
        }),
        confirmedEntries: card.entries
          .filter((entry) => entry.status === 'confirmed')
          .sort((left, right) => left.className.localeCompare(right.className, 'zh-CN')),
        cancelledEntries: card.entries
          .filter((entry) => entry.status === 'cancelled')
          .sort((left, right) => left.className.localeCompare(right.className, 'zh-CN'))
      };
    })
    .sort(compareVenueDisplayOrder);

  const crowdedVenue = moduleCards
    .filter((item) => item.confirmedCount > 0)
    .sort((left, right) => {
      if (right.confirmedCount !== left.confirmedCount) return right.confirmedCount - left.confirmedCount;
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.venueName.localeCompare(right.venueName, 'zh-CN');
    })[0] || null;

  const fastestVenue = moduleCards
    .filter((item) => item.confirmedCount > 1)
    .sort((left, right) => {
      if (left.bookingDurationMinutes !== right.bookingDurationMinutes) return left.bookingDurationMinutes - right.bookingDurationMinutes;
      return right.confirmedCount - left.confirmedCount;
    })[0] || null;

  const hottestVenue = moduleCards
    .filter((item) => item.isFilled)
    .sort((left, right) => left.bookingDurationMinutes - right.bookingDurationMinutes)[0] || null;

  const firstConfirmed = timeline[0] || null;
  const lastConfirmed = timeline.length ? timeline[timeline.length - 1] : null;
  const bookingSpanMinutes = firstConfirmed && lastConfirmed
    ? Math.max(0, Math.round((lastConfirmed.timeMs - firstConfirmed.timeMs) / 60000))
    : 0;
  const firstMinuteConfirmedCount = firstConfirmed
    ? timeline.filter((item) => item.timeMs <= firstConfirmed.timeMs + 60000).length
    : 0;

  return {
    overview: {
      totalBookings: bookings.length,
      confirmedCount: confirmedBookings.length,
      cancelledCount: cancelledBookings.length,
      cancellationRateText: bookings.length ? formatPercent((cancelledBookings.length / bookings.length) * 100, 0) : '0%',
      firstConfirmedTime: firstConfirmed ? firstConfirmed.timeLabel : '-',
      lastConfirmedTime: lastConfirmed ? lastConfirmed.timeLabel : '-',
      bookingSpanLabel: firstConfirmed && lastConfirmed
        ? (bookingSpanMinutes <= 0 ? '集中在同一分钟完成' : `${bookingSpanMinutes} 分钟内完成主体预约`)
        : '暂无有效预约时间轴',
      firstMinuteConfirmedCount
    },
    segments,
    timelinePreview: timeline.slice(0, 10),
    crowdedVenue: crowdedVenue ? {
      venueName: crowdedVenue.venueName,
      confirmedCount: crowdedVenue.confirmedCount,
      cancelledCount: crowdedVenue.cancelledCount,
      totalCapacity: crowdedVenue.totalCapacity
    } : {
      venueName: '',
      confirmedCount: 0,
      cancelledCount: 0,
      totalCapacity: 0
    },
    fastestVenue: fastestVenue ? {
      venueName: fastestVenue.venueName,
      confirmedCount: fastestVenue.confirmedCount,
      cancelledCount: fastestVenue.cancelledCount,
      bookingDurationLabel: fastestVenue.bookingDurationLabel,
      firstConfirmedLabel: fastestVenue.firstConfirmedLabel || '-',
      lastConfirmedLabel: fastestVenue.lastConfirmedLabel || '-',
      isFilled: !!fastestVenue.isFilled
    } : {
      venueName: '',
      confirmedCount: 0,
      cancelledCount: 0,
      bookingDurationLabel: '本轮暂无可统计的预约速度',
      firstConfirmedLabel: '-',
      lastConfirmedLabel: '-',
      isFilled: false
    },
    hottestVenue: hottestVenue ? {
      venueName: hottestVenue.venueName,
      confirmedCount: hottestVenue.confirmedCount,
      cancelledCount: hottestVenue.cancelledCount,
      bookingDurationLabel: hottestVenue.bookingDurationLabel,
      firstConfirmedLabel: hottestVenue.firstConfirmedLabel || '-',
      lastConfirmedLabel: hottestVenue.lastConfirmedLabel || '-'
    } : {
      venueName: '',
      confirmedCount: 0,
      cancelledCount: 0,
      bookingDurationLabel: '本轮暂无抢满模块',
      firstConfirmedLabel: '-',
      lastConfirmedLabel: '-'
    },
    unbookedClasses: overallUnbookedClasses,
    moduleCards,
    detailSummary: {
      smallCancelledCount: smallBookings.filter((item) => item.status === 'cancelled').length,
      mixedCancelledCount: mixedBookings.filter((item) => item.status === 'cancelled').length
    }
  };
}

function roundSelectSql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `
    ${prefix}id,
    ${prefix}round_date,
    ${prefix}open_time,
    ${prefix}close_time,
    ${prefix}status,
    DATE_FORMAT(${prefix}round_date, '%Y-%m-%d') AS round_date_text,
    DATE_FORMAT(${prefix}open_time, '%Y-%m-%d %H:%i:%s') AS open_time_text,
    CASE WHEN ${prefix}close_time IS NOT NULL THEN DATE_FORMAT(${prefix}close_time, '%Y-%m-%d %H:%i:%s') ELSE NULL END AS close_time_text
  `;
}

function deleteUploadedFile(urlPath) {
  if (!urlPath) return;
  try {
    // /static/uploads/xxx.png -> public/uploads/xxx.png
    const relative = urlPath.replace(/^\/static\//, '');
    const fullPath = path.join(__dirname, '..', 'public', relative);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  } catch (e) { /* ignore cleanup errors */ }
}

function saveUploadedFile(file, prefix) {
  if (!file) return null;
  const ext = path.extname(file.originalname || '') || '.png';
  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const destination = path.join(__dirname, '..', 'public', 'uploads', filename);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, file.buffer);
  return `/static/uploads/${filename}`;
}

function saveUploadedFiles(files, prefix) {
  return (Array.isArray(files) ? files : [])
    .map((file) => saveUploadedFile(file, prefix))
    .filter(Boolean);
}

function firstFile(files, key) {
  return files && files[key] && files[key][0] ? files[key][0] : null;
}

function parseMediaList(rawValue, fallbackValues = []) {
  const values = [];
  const pushValue = (value) => {
    const text = normalizeText(value);
    if (text) values.push(text);
  };

  if (Array.isArray(rawValue)) {
    rawValue.forEach(pushValue);
  } else {
    const text = normalizeText(rawValue);
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) parsed.forEach(pushValue);
        else pushValue(text);
      } catch (error) {
        pushValue(text);
      }
    }
  }

  (Array.isArray(fallbackValues) ? fallbackValues : [fallbackValues]).forEach(pushValue);
  return [...new Set(values)];
}

function normalizeSkillGuideLevelType(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === 'basic' || normalized === 'advanced' ? normalized : '';
}

function clampInt(value, min, max, fallback) {
  const numeric = Math.round(Number(value));
  const base = Number.isFinite(numeric) ? numeric : fallback;
  return Math.max(min, Math.min(max, base));
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

async function loadOwnClassDashboard(user) {
  if (!user || !user.classId) {
    return { assignedClass: null, children: [] };
  }
  const dashboard = await buildUserDashboard({ classId: user.classId });
  return {
    assignedClass: dashboard && dashboard.assignedClass ? dashboard.assignedClass : null,
    children: dashboard && Array.isArray(dashboard.children) ? dashboard.children : []
  };
}

function settingEnabled(value, fallback = true) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return fallback;
  return !['0', 'false', 'off', 'no', 'disabled', '关闭'].includes(text);
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function averageScore(records, fieldName) {
  const values = records
    .map((record) => safeNumber(record[fieldName], NaN))
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const FITNESS_WEAKNESS_RULES = [
  { key: 'balance', field: 'balance_score', label: '平衡能力', keywords: ['平衡', '稳定', '独木', '木', '核心'], weight: 18 },
  { key: 'obstacle', field: 'obstacle_score', label: '灵敏速度', keywords: ['跑', '绕', '障碍', '敏捷', '速度', '追逐'], weight: 18 },
  { key: 'jump', field: 'jump_score', label: '下肢爆发', keywords: ['跳', '跃', '弹', '跨', '下肢'], weight: 16 },
  { key: 'djump', field: 'djump_score', label: '连续跳协调', keywords: ['连续跳', '双脚', '跳', '协调', '节奏'], weight: 15 },
  { key: 'grip', field: 'grip_score', label: '上肢力量', keywords: ['力量', '握', '抓', '攀', '爬', '拉', '推', '投', '上肢'], weight: 14 },
  { key: 'sit', field: 'sit_score', label: '柔韧伸展', keywords: ['柔韧', '伸展', '拉伸', '体前屈', '弯腰'], weight: 12 },
  { key: 'bmi', field: 'bmi_score', label: '体态与耐力', keywords: ['耐力', '循环', '综合', '走', '慢跑', '基础'], weight: 8 }
];

function buildVenueSearchText(venue, gradeLevel) {
  const guideTexts = (Array.isArray(venue.skillGuides) ? venue.skillGuides : []).flatMap((guide) => [
    guide.title,
    guide.basic_skill_names,
    guide.basic_equipment,
    guide.basic_action_points,
    guide.advanced_skill_names,
    guide.advanced_equipment,
    guide.advanced_action_points,
    guide.extra_skill_names,
    guide.extra_equipment,
    guide.extra_action_points,
    guide.bridge_indicators
  ]);
  return [
    venue.name,
    venue.equipment,
    venue.skill_tags,
    gradeLevel === 'small' ? venue.play_desc_small : venue.play_desc_ml,
    gradeLevel === 'small' ? venue.loop_guide_desc_small : venue.loop_guide_desc_ml,
    ...guideTexts
  ].map((item) => normalizeText(item).toLowerCase()).filter(Boolean).join(' ');
}

function keywordHitCount(text, keywords) {
  return keywords.reduce((count, keyword) => count + (text.includes(keyword.toLowerCase()) ? 1 : 0), 0);
}

function buildClassFitnessProfile(fitnessRecords, gradeLevel) {
  const latestByChild = new Map();
  fitnessRecords.forEach((record) => {
    const childId = Number(record.child_id);
    if (childId && !latestByChild.has(childId)) latestByChild.set(childId, record);
  });
  const latestRecords = Array.from(latestByChild.values());
  const totalAverage = averageScore(latestRecords, 'total_score');
  const weaknesses = FITNESS_WEAKNESS_RULES
    .map((rule) => ({ ...rule, average: averageScore(latestRecords, rule.field) }))
    .filter((rule) => rule.average == null || rule.average < 78)
    .sort((left, right) => safeNumber(left.average, 0) - safeNumber(right.average, 0))
    .slice(0, 3);

  if (!weaknesses.length) {
    weaknesses.push({
      key: 'balanced',
      label: `${gradeLabel(gradeLevel)}综合巩固`,
      keywords: ['综合', '循环', '协调', '平衡', '跳'],
      weight: 10,
      average: totalAverage
    });
  }

  return {
    sampleSize: latestRecords.length,
    totalAverage,
    weaknesses
  };
}

function buildFitnessReason(profile, matchedWeaknesses) {
  if (!profile.sampleSize) {
    return '暂无本班体测记录，优先按年级容量、当前预约拥挤度和轮换规则推荐。';
  }
  if (matchedWeaknesses.length) {
    return `匹配本班体测短板：${matchedWeaknesses.map((item) => item.label).join('、')}。`;
  }
  const labels = profile.weaknesses.map((item) => item.label).join('、');
  return labels ? `本班待加强方向为${labels}，该模块适合作为综合补充。` : '本班体测表现较均衡，该模块适合综合巩固。';
}

async function buildVenueRecommendations({ classId, gradeLevel, activeRound, venues }) {
  if (!classId || !activeRound || !venues.length) return [];

  const previousBookings = await dbQuery(
    `SELECT vb.venue_id, v.name AS venue_name, v.sort_order, vr.round_date
       FROM venue_bookings vb
       JOIN venues v ON v.id = vb.venue_id
       JOIN venue_round vr ON vr.id = vb.round_id
      WHERE vb.class_id = ?
        AND vb.status = 'confirmed'
        AND vb.round_id <> ?
      ORDER BY vr.round_date DESC, vb.created_at DESC, vb.id DESC
      LIMIT 12`,
    [classId, activeRound.id]
  );
  const mostRecentVenueId = previousBookings.length ? Number(previousBookings[0].venue_id) : null;
  const historyCounts = previousBookings.reduce((accumulator, booking) => {
    const venueId = Number(booking.venue_id);
    accumulator[venueId] = (accumulator[venueId] || 0) + 1;
    return accumulator;
  }, {});

  const fitnessRecords = await dbQuery(
    `SELECT fr.*
       FROM fitness_records fr
       JOIN children ch ON ch.id = fr.child_id
      WHERE ch.class_id = ?
        AND ch.enabled = 1
      ORDER BY fr.child_id ASC, fr.test_date DESC, fr.id DESC`,
    [classId]
  );
  const profile = buildClassFitnessProfile(fitnessRecords, gradeLevel);
  const availableVenues = venues.filter((venue) => Number(venue.enabled) !== 0 && !venue._full && safeNumber(venue._myPoolCapacity) > 0);
  const rotationFiltered = mostRecentVenueId && availableVenues.filter((venue) => Number(venue.id) !== mostRecentVenueId).length >= 2
    ? availableVenues.filter((venue) => Number(venue.id) !== mostRecentVenueId)
    : availableVenues;

  return rotationFiltered
    .map((venue) => {
      const searchText = buildVenueSearchText(venue, gradeLevel);
      const matchedWeaknesses = [];
      let fitnessScore = 0;
      profile.weaknesses.forEach((weakness) => {
        const hitCount = keywordHitCount(searchText, weakness.keywords || []);
        if (hitCount > 0) {
          matchedWeaknesses.push(weakness);
          fitnessScore += weakness.weight + Math.min(hitCount, 3) * 3;
        }
      });

      const capacity = Math.max(1, safeNumber(venue._myPoolCapacity));
      const remaining = Math.max(0, safeNumber(venue._remainingMine));
      const occupancyRatio = safeNumber(venue._myPoolBooked) / capacity;
      const capacityScore = remaining * 8 + (1 - Math.min(1, occupancyRatio)) * 18;
      const gradeTextBonus = searchText.includes(gradeLabel(gradeLevel)) || (gradeLevel === 'small' && searchText.includes('小班')) || (gradeLevel !== 'small' && searchText.includes('中大班')) ? 8 : 0;
      const historyPenalty = safeNumber(historyCounts[Number(venue.id)]) * 10;
      const lastVenuePenalty = mostRecentVenueId === Number(venue.id) ? 35 : 0;
      const score = fitnessScore + capacityScore + gradeTextBonus - historyPenalty - lastVenuePenalty;

      const reasons = [
        buildFitnessReason(profile, matchedWeaknesses),
        `当前${gradeLabel(gradeLevel)}名额剩余 ${remaining}/${capacity}，比已满模块更容易预约成功。`
      ];
      if (mostRecentVenueId && Number(venue.id) !== mostRecentVenueId) {
        reasons.push(`已避开上一次选择的${buildVenueBookingLabel(previousBookings[0].venue_name, previousBookings[0].sort_order)}，帮助班级轮换体验不同区域。`);
      } else if (historyCounts[Number(venue.id)]) {
        reasons.push('可选模块较少，本次保留历史选择但已降低重复推荐权重。');
      } else {
        reasons.push('本班近期未重复使用该模块，符合轮换优先规则。');
      }

      return {
        venueId: venue.id,
        venueName: venue.name,
        label: buildVenueBookingLabel(venue.name, venue.sort_order),
        score,
        matchedWeaknesses: matchedWeaknesses.map((item) => item.label),
        reasons
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .map((item, index) => ({
      ...item,
      rank: index === 0 ? '最优选择' : '次优选择'
    }));
}

function buildUserAttentionPageUrl(message) {
  const params = new URLSearchParams();
  params.set('view', 'attention');
  if (message) params.set('message', message);
  return `/user?${params.toString()}`;
}

function normalizeHotspotHintColor(value, fallback = '#2563eb') {
  const raw = normalizeText(value);
  if (!raw) return fallback;
  const normalized = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(normalized) ? normalized : fallback;
}

function normalizeHotspotPoints(rawValue) {
  if (rawValue == null || rawValue === '') return null;

  let parsed;
  try {
    parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
  } catch (error) {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  const points = parsed
    .map((point) => {
      if (Array.isArray(point)) {
        return { x: Math.round(Number(point[0])), y: Math.round(Number(point[1])) };
      }
      return { x: Math.round(Number(point && point.x)), y: Math.round(Number(point && point.y)) };
    })
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: Math.max(0, point.x),
      y: Math.max(0, point.y)
    }))
    .slice(0, 24);

  if (points.length < 3) return null;
  return JSON.stringify(points);
}

function parseHotspotPoints(rawValue) {
  const normalized = normalizeHotspotPoints(rawValue);
  if (!normalized) return [];
  try {
    return JSON.parse(normalized);
  } catch (error) {
    return [];
  }
}

function calculateHotspotCentroid(points) {
  if (!Array.isArray(points) || !points.length) {
    return { x: 0, y: 0 };
  }

  const totals = points.reduce((accumulator, point) => ({
    x: accumulator.x + Number(point.x || 0),
    y: accumulator.y + Number(point.y || 0)
  }), { x: 0, y: 0 });

  return {
    x: Math.round(totals.x / points.length),
    y: Math.round(totals.y / points.length)
  };
}

function hydrateVenueHotspots(venues) {
  return (venues || []).map((venue) => {
    const hotspotPoints = parseHotspotPoints(venue.hotspot_points);
    const centroid = calculateHotspotCentroid(hotspotPoints);
    const hintX = venue.hotspot_hint_x == null ? centroid.x : Math.max(0, Number(venue.hotspot_hint_x));
    const hintY = venue.hotspot_hint_y == null ? centroid.y : Math.max(0, Number(venue.hotspot_hint_y));
    const loopGuideImages = parseMediaList(venue.loop_guide_images, [venue.loop_guide_image_path]);
    const loopGuideStationImages = parseMediaList(venue.loop_guide_station_images, [venue.loop_guide_station_image_path]);
    const loopGuideVideos = parseMediaList(venue.loop_guide_videos, [venue.loop_guide_video_path]);

    return {
      ...venue,
      hotspot_points: hotspotPoints,
      hotspot_hint_x: Number.isFinite(hintX) ? hintX : centroid.x,
      hotspot_hint_y: Number.isFinite(hintY) ? hintY : centroid.y,
      hotspot_hint_label: normalizeText(venue.hotspot_hint_label) || normalizeText(venue.name) || '查看场地',
      hotspot_hint_label_size: clampInt(venue.hotspot_hint_label_size, 10, 36, 14),
      hotspot_hint_color: normalizeHotspotHintColor(venue.hotspot_hint_color),
      hotspot_hint_size: clampInt(venue.hotspot_hint_size, 12, 96, 28),
      hotspot_hint_length: clampInt(venue.hotspot_hint_length, 16, 200, 54),
      hotspot_hint_bounce_ms: clampInt(venue.hotspot_hint_bounce_ms, 400, 4000, 1500),
      loop_guide_images: loopGuideImages,
      loop_guide_station_images: loopGuideStationImages,
      loop_guide_videos: loopGuideVideos,
      loop_guide_image_path: loopGuideImages[0] || null,
      loop_guide_station_image_path: loopGuideStationImages[0] || null,
      loop_guide_video_path: loopGuideVideos[0] || null,
      loop_guide_video_autoplay: Number(venue.loop_guide_video_autoplay) ? 1 : 0,
      detail_view_width: clampInt(venue.detail_view_width, 480, 1600, 960),
      detail_view_height: clampInt(venue.detail_view_height, 320, 1200, 640)
    };
  });
}

function attachLayoutDefaults(venues) {
  const defaultWidth = 100;
  const defaultHeight = 65;
  const gapX = 8;
  const gapY = 8;
  const startX = 16;
  const startY = 16;
  const columns = 5;
  const hasCustomLayout = venues.some((venue) =>
    venue.map_x != null || venue.map_y != null || venue.map_width != null || venue.map_height != null
  );
  const minBoardWidth = hasCustomLayout ? 320 : 700;
  const minBoardHeight = hasCustomLayout ? 240 : 420;

  let minLeft = Number.POSITIVE_INFINITY;
  let minTop = Number.POSITIVE_INFINITY;
  let maxRight = 0;
  let maxBottom = 0;

  venues.forEach((venue, index) => {
    const fallbackX = startX + (index % columns) * (defaultWidth + gapX);
    const fallbackY = startY + Math.floor(index / columns) * (defaultHeight + gapY);
    const width = Number(venue.map_width || venue.image_width || defaultWidth);
    const height = Number(venue.map_height || Math.max(Number(venue.image_height || 180) + 96, defaultHeight));
    const x = venue.map_x == null ? fallbackX : Number(venue.map_x);
    const y = venue.map_y == null ? fallbackY : Number(venue.map_y);

    venue.map_x = x;
    venue.map_y = y;
    venue.map_width = width;
    venue.map_height = height;

    minLeft = Math.min(minLeft, x);
    minTop = Math.min(minTop, y);
    maxRight = Math.max(maxRight, x + width);
    maxBottom = Math.max(maxBottom, y + height);
  });

  if (venues.length) {
    const offsetX = Number.isFinite(minLeft) && minLeft < 0 ? Math.ceil(-minLeft) : 0;
    const offsetY = Number.isFinite(minTop) && minTop < 0 ? Math.ceil(-minTop) : 0;
    if (offsetX || offsetY) {
      venues.forEach((venue) => {
        venue.map_x += offsetX;
        venue.map_y += offsetY;
      });
      maxRight += offsetX;
      maxBottom += offsetY;
    }
  }

  const boardWidth = venues.length
    ? Math.max(minBoardWidth, Math.ceil(maxRight + (hasCustomLayout ? 0 : startX)))
    : minBoardWidth;
  const boardHeight = venues.length
    ? Math.max(minBoardHeight, Math.ceil(maxBottom + (hasCustomLayout ? 0 : startY)))
    : minBoardHeight;

  return {
    venues,
    boardWidth,
    boardHeight,
    hasCustomLayout
  };
}

function groupRowsByVenue(rows) {
  return rows.reduce((accumulator, row) => {
    const venueId = Number(row.venue_id);
    if (!accumulator[venueId]) accumulator[venueId] = [];
    accumulator[venueId].push(row);
    return accumulator;
  }, {});
}

async function loadVenueElements(venueIds, onlyEnabled = false) {
  if (!venueIds.length) return {};
  const placeholders = venueIds.map(() => '?').join(', ');
  const whereEnabled = onlyEnabled ? " AND enabled = 1" : '';
  const rows = await dbQuery(
    `SELECT * FROM venue_elements
      WHERE venue_id IN (${placeholders})${whereEnabled}
      ORDER BY venue_id ASC, sort_order ASC, id ASC`,
    venueIds
  );
  return groupRowsByVenue(rows);
}

async function loadVenueSkillGuides(venueIds, onlyEnabled = false) {
  if (!venueIds.length) return {};
  const placeholders = venueIds.map(() => '?').join(', ');
  const whereEnabled = onlyEnabled ? ' AND enabled = 1' : '';
  const rows = await dbQuery(
    `SELECT * FROM venue_skill_guides
      WHERE venue_id IN (${placeholders})${whereEnabled}
      ORDER BY venue_id ASC, sort_order ASC, id ASC`,
    venueIds
  );
  return groupRowsByVenue(rows.map((row) => {
    const basicImagePaths = parseMediaList(row.basic_image_paths, [row.basic_image_path]);
    const basicVideoPaths = parseMediaList(row.basic_video_paths, [row.basic_video_path]);
    const advancedImagePaths = parseMediaList(row.advanced_image_paths, [row.advanced_image_path]);
    const advancedVideoPaths = parseMediaList(row.advanced_video_paths, [row.advanced_video_path]);
    const extraImagePaths = parseMediaList(row.extra_image_paths, [row.extra_image_path]);
    const extraVideoPaths = parseMediaList(row.extra_video_paths, [row.extra_video_path]);
    return {
      ...row,
      extra_level_type: normalizeSkillGuideLevelType(row.extra_level_type) || null,
      basic_image_paths: basicImagePaths,
      basic_video_paths: basicVideoPaths,
      advanced_image_paths: advancedImagePaths,
      advanced_video_paths: advancedVideoPaths,
      extra_image_paths: extraImagePaths,
      extra_video_paths: extraVideoPaths,
      basic_image_path: basicImagePaths[0] || null,
      basic_video_path: basicVideoPaths[0] || null,
      advanced_image_path: advancedImagePaths[0] || null,
      advanced_video_path: advancedVideoPaths[0] || null,
      extra_image_path: extraImagePaths[0] || null,
      extra_video_path: extraVideoPaths[0] || null,
      extra_video_autoplay: Number(row.extra_video_autoplay) ? 1 : 0
    };
  }));
}

async function loadVenueBackgrounds(onlyEnabled = false) {
  const whereEnabled = onlyEnabled ? 'WHERE enabled = 1' : '';
  return dbQuery(
    `SELECT * FROM venue_backgrounds
      ${whereEnabled}
      ORDER BY sort_order ASC, id ASC`
  );
}

function normalizeBackgroundLayers(backgrounds) {
  return (backgrounds || []).map((background, index) => {
    const width = Math.max(80, Number(background.map_width || 320));
    const height = Math.max(80, Number(background.map_height || 180));
    const x = Math.max(0, Number(background.map_x || 0));
    const y = Math.max(0, Number(background.map_y || 0));
    return {
      ...background,
      map_x: x,
      map_y: y,
      map_width: width,
      map_height: height,
      sort_order: Number(background.sort_order || index + 1),
      enabled: Number(background.enabled) ? 1 : 0,
      is_fixed: Number(background.is_fixed) ? 1 : 0
    };
  });
}

function applyLayoutBoardOffset(layout, backgrounds = []) {
  const layers = normalizeBackgroundLayers(backgrounds).map((background) => ({ ...background }));
  const venues = (layout.venues || []).map((venue) => ({ ...venue }));
  const hasVisualLayout = !!layout.hasCustomLayout || layers.length > 0;
  let minLeft = Number.POSITIVE_INFINITY;
  let minTop = Number.POSITIVE_INFINITY;
  let maxRight = 0;
  let maxBottom = 0;
  let hasAny = false;

  const registerBounds = (x, y, width, height) => {
    minLeft = Math.min(minLeft, x);
    minTop = Math.min(minTop, y);
    maxRight = Math.max(maxRight, x + width);
    maxBottom = Math.max(maxBottom, y + height);
    hasAny = true;
  };

  venues.forEach((venue) => {
    registerBounds(Number(venue.map_x || 0), Number(venue.map_y || 0), Number(venue.map_width || 0), Number(venue.map_height || 0));
  });
  layers.forEach((background) => {
    registerBounds(background.map_x, background.map_y, background.map_width, background.map_height);
  });

  if (!hasAny) {
    return {
      venues,
      backgrounds: layers,
      boardWidth: layout.boardWidth,
      boardHeight: layout.boardHeight,
      hasCustomLayout: hasVisualLayout
    };
  }

  const offsetX = Number.isFinite(minLeft) && minLeft < 0 ? Math.ceil(-minLeft) : 0;
  const offsetY = Number.isFinite(minTop) && minTop < 0 ? Math.ceil(-minTop) : 0;
  const shiftedVenues = venues.map((venue) => ({
    ...venue,
    map_x: Number(venue.map_x || 0) + offsetX,
    map_y: Number(venue.map_y || 0) + offsetY
  }));
  const shiftedBackgrounds = layers.map((background) => ({
    ...background,
    map_x: background.map_x + offsetX,
    map_y: background.map_y + offsetY
  }));
  const minBoardWidth = hasVisualLayout ? 320 : 700;
  const minBoardHeight = hasVisualLayout ? 240 : 420;
  const boardWidth = Math.max(minBoardWidth, Math.ceil(maxRight + offsetX));
  const boardHeight = Math.max(minBoardHeight, Math.ceil(maxBottom + offsetY));

  return {
    venues: shiftedVenues,
    backgrounds: shiftedBackgrounds,
    boardWidth,
    boardHeight,
    hasCustomLayout: hasVisualLayout
  };
}

const VENUE_WRITE_COLUMNS = [
  ['map_x', "map_x INT NULL COMMENT '地图布局 x'"],
  ['map_y', "map_y INT NULL COMMENT '地图布局 y'"],
  ['map_width', "map_width INT NULL COMMENT '地图布局宽(px)'"],
  ['map_height', "map_height INT NULL COMMENT '地图布局高(px)'"],
  ['hotspot_points', "hotspot_points TEXT NULL COMMENT 'venue hotspot polygon json'"],
  ['hotspot_hint_x', "hotspot_hint_x INT NULL COMMENT 'venue hotspot hint x'"],
  ['hotspot_hint_y', "hotspot_hint_y INT NULL COMMENT 'venue hotspot hint y'"],
  ['hotspot_hint_label', "hotspot_hint_label VARCHAR(50) NULL COMMENT 'venue hotspot hint label'"],
  ['hotspot_hint_label_size', "hotspot_hint_label_size INT NULL DEFAULT 14 COMMENT 'venue hotspot hint label size'"],
  ['hotspot_hint_color', "hotspot_hint_color VARCHAR(20) NULL COMMENT 'venue hotspot hint color'"],
  ['hotspot_hint_size', "hotspot_hint_size INT NULL DEFAULT 28 COMMENT 'venue hotspot hint arrow size'"],
  ['hotspot_hint_length', "hotspot_hint_length INT NULL DEFAULT 54 COMMENT 'venue hotspot hint arrow length'"],
  ['hotspot_hint_bounce_ms', "hotspot_hint_bounce_ms INT NULL DEFAULT 1500 COMMENT 'venue hotspot hint bounce duration'"],
  ['detail_image_path', "detail_image_path VARCHAR(500) NULL COMMENT 'venue fullscreen scene image'"],
  ['detail_view_width', "detail_view_width INT NULL DEFAULT 960 COMMENT 'venue fullscreen scene width'"],
  ['detail_view_height', "detail_view_height INT NULL DEFAULT 640 COMMENT 'venue fullscreen scene height'"],
  ['play_desc_small', "play_desc_small TEXT NULL COMMENT '小班玩法说明'"],
  ['play_images_small', "play_images_small LONGTEXT NULL COMMENT '小班玩法图片列表 json'"],
  ['play_desc_ml', "play_desc_ml TEXT NULL COMMENT '中大班玩法说明'"],
  ['play_images_ml', "play_images_ml LONGTEXT NULL COMMENT '中大班玩法图片列表 json'"],
  ['cap_middle', "cap_middle INT NOT NULL DEFAULT 2 COMMENT '中班可约班数'"],
  ['cap_large', "cap_large INT NOT NULL DEFAULT 2 COMMENT '大班可约班数'"],
  ['equipment', "equipment TEXT NULL COMMENT '器材说明'"],
  ['loop_guide_image_path', "loop_guide_image_path VARCHAR(500) NULL COMMENT '大循环示意图'"],
  ['loop_guide_station_image_path', "loop_guide_station_image_path VARCHAR(500) NULL COMMENT '大循环指导站位图'"],
  ['loop_guide_video_path', "loop_guide_video_path VARCHAR(500) NULL COMMENT '大循环指导视频'"],
  ['loop_guide_video_autoplay', "loop_guide_video_autoplay TINYINT(1) NOT NULL DEFAULT 0 COMMENT '大循环视频自动播放'"],
  ['loop_guide_desc_small', "loop_guide_desc_small TEXT NULL COMMENT '小班大循环指导说明'"],
  ['loop_guide_desc_ml', "loop_guide_desc_ml TEXT NULL COMMENT '中大班大循环指导说明'"]
];

VENUE_WRITE_COLUMNS.push(
  ['loop_guide_images', "loop_guide_images LONGTEXT NULL COMMENT 'loop guide images json'"],
  ['loop_guide_station_images', "loop_guide_station_images LONGTEXT NULL COMMENT 'loop guide station images json'"],
  ['loop_guide_videos', "loop_guide_videos LONGTEXT NULL COMMENT 'loop guide videos json'"]
);

const SKILL_GUIDE_WRITE_COLUMNS = [
  ['extra_level_type', "extra_level_type VARCHAR(20) NULL COMMENT 'skill guide extra level type'"],
  ['extra_skill_names', "extra_skill_names TEXT NULL COMMENT 'skill guide extra level skill names'"],
  ['extra_equipment', "extra_equipment TEXT NULL COMMENT 'skill guide extra level equipment'"],
  ['extra_action_points', "extra_action_points TEXT NULL COMMENT 'skill guide extra level action points'"],
  ['extra_safety_points', "extra_safety_points TEXT NULL COMMENT 'skill guide extra level safety points'"],
  ['extra_image_path', "extra_image_path VARCHAR(500) NULL COMMENT 'skill guide extra image'"],
  ['extra_video_path', "extra_video_path VARCHAR(500) NULL COMMENT 'skill guide extra video'"],
  ['extra_video_autoplay', "extra_video_autoplay TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'skill guide extra videos autoplay'"],
  ['basic_image_paths', "basic_image_paths LONGTEXT NULL COMMENT 'skill guide basic images json'"],
  ['basic_video_paths', "basic_video_paths LONGTEXT NULL COMMENT 'skill guide basic videos json'"],
  ['advanced_image_paths', "advanced_image_paths LONGTEXT NULL COMMENT 'skill guide advanced images json'"],
  ['advanced_video_paths', "advanced_video_paths LONGTEXT NULL COMMENT 'skill guide advanced videos json'"],
  ['extra_image_paths', "extra_image_paths LONGTEXT NULL COMMENT 'skill guide extra images json'"],
  ['extra_video_paths', "extra_video_paths LONGTEXT NULL COMMENT 'skill guide extra videos json'"]
];

let ensureVenueWriteColumnsPromise = null;

async function ensureVenueWriteColumns() {
  if (ensureVenueWriteColumnsPromise) return ensureVenueWriteColumnsPromise;

  ensureVenueWriteColumnsPromise = (async () => {
    const databaseRows = await dbQuery('SELECT DATABASE() AS database_name');
    const databaseName = normalizeText(databaseRows[0] && databaseRows[0].database_name);
    if (!databaseName) return;

    for (const [columnName, definitionSql] of VENUE_WRITE_COLUMNS) {
      const rows = await dbQuery(
        `SELECT COUNT(*) AS total
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'venues' AND COLUMN_NAME = ?`,
        [databaseName, columnName]
      );

      if (Number(rows[0]?.total || 0)) continue;

      try {
        await dbQuery(`ALTER TABLE venues ADD COLUMN ${definitionSql}`);
      } catch (error) {
        if (!error || error.code !== 'ER_DUP_FIELDNAME') {
          throw error;
        }
      }
    }
  })().catch((error) => {
    ensureVenueWriteColumnsPromise = null;
    throw error;
  });

  return ensureVenueWriteColumnsPromise;
}

let ensureVenueResourceSchemaPromise = null;

async function ensureVenueResourceSchema() {
  if (ensureVenueResourceSchemaPromise) return ensureVenueResourceSchemaPromise;

  ensureVenueResourceSchemaPromise = (async () => {
    await ensureVenueWriteColumns();
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS venue_skill_guides (
        id INT AUTO_INCREMENT PRIMARY KEY,
        venue_id INT NOT NULL,
        title VARCHAR(120) NOT NULL COMMENT '技能分类名称',
        basic_skill_names TEXT NULL COMMENT '基础级技能名称',
        basic_equipment TEXT NULL COMMENT '基础级对应器械',
        basic_action_points TEXT NULL COMMENT '基础级动作要领',
        basic_safety_points TEXT NULL COMMENT '基础级安全指导要点',
        basic_image_path VARCHAR(500) NULL COMMENT '基础级配图',
        basic_video_path VARCHAR(500) NULL COMMENT '基础级视频',
        basic_video_autoplay TINYINT(1) NOT NULL DEFAULT 0 COMMENT '基础级视频自动播放',
        advanced_skill_names TEXT NULL COMMENT '提升级技能名称',
        advanced_equipment TEXT NULL COMMENT '提升级对应器械',
        advanced_action_points TEXT NULL COMMENT '提升级动作要领',
        advanced_safety_points TEXT NULL COMMENT '提升级安全指导要点',
        advanced_image_path VARCHAR(500) NULL COMMENT '提升级配图',
        advanced_video_path VARCHAR(500) NULL COMMENT '提升级视频',
        advanced_video_autoplay TINYINT(1) NOT NULL DEFAULT 0 COMMENT '提升级视频自动播放',
        extra_level_type VARCHAR(20) NULL COMMENT '额外等级类型',
        extra_skill_names TEXT NULL COMMENT '额外等级技能名称',
        extra_equipment TEXT NULL COMMENT '额外等级对应器械',
        extra_action_points TEXT NULL COMMENT '额外等级动作要领',
        extra_safety_points TEXT NULL COMMENT '额外等级安全指导要点',
        extra_image_path VARCHAR(500) NULL COMMENT '额外等级配图',
        extra_video_path VARCHAR(500) NULL COMMENT '额外等级视频',
        extra_video_autoplay TINYINT(1) NOT NULL DEFAULT 0 COMMENT '额外等级视频自动播放',
        bridge_indicators TEXT NULL COMMENT '幼小衔接指标',
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_vsg_venue (venue_id),
        CONSTRAINT fk_vsg_venue FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const databaseRows = await dbQuery('SELECT DATABASE() AS database_name');
    const databaseName = normalizeText(databaseRows[0] && databaseRows[0].database_name);
    if (databaseName) {
      for (const [columnName, definitionSql] of SKILL_GUIDE_WRITE_COLUMNS) {
        const rows = await dbQuery(
          `SELECT COUNT(*) AS total
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'venue_skill_guides' AND COLUMN_NAME = ?`,
          [databaseName, columnName]
        );
        if (Number(rows[0]?.total || 0)) continue;
        try {
          await dbQuery(`ALTER TABLE venue_skill_guides ADD COLUMN ${definitionSql}`);
        } catch (error) {
          if (!error || error.code !== 'ER_DUP_FIELDNAME') {
            throw error;
          }
        }
      }
    }
  })().catch((error) => {
    ensureVenueResourceSchemaPromise = null;
    throw error;
  });

  return ensureVenueResourceSchemaPromise;
}

module.exports = function mountVenueRoutes(app, upload) {
  const adminOnly = requireRole('admin');
  const userOnly = requireRole('user');

  app.get('/admin/venues', adminOnly, asyncHandler(async (req, res) => {
    await ensureVenueResourceSchema();
    const settings = await getSettings();
    const venues = hydrateVenueHotspots(await dbQuery('SELECT * FROM venues ORDER BY sort_order ASC, id ASC'));
    const rounds = await dbQuery(`SELECT ${roundSelectSql()} FROM venue_round ORDER BY round_date DESC LIMIT 20`);
    const roundIds = rounds.map((round) => Number(round.id)).filter(Boolean);
    const roundBookingRows = roundIds.length
      ? await dbQuery(`
          SELECT round_id,
                 COUNT(*) AS total_count,
                 SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_count,
                 SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count
            FROM venue_bookings
           WHERE round_id IN (${roundIds.map(() => '?').join(', ')})
           GROUP BY round_id
        `, roundIds)
      : [];
    const roundBookingMap = roundBookingRows.reduce((accumulator, row) => {
      accumulator[Number(row.round_id)] = {
        totalCount: Number(row.total_count || 0),
        confirmedCount: Number(row.confirmed_count || 0),
        cancelledCount: Number(row.cancelled_count || 0)
      };
      return accumulator;
    }, {});
    const layout = applyLayoutBoardOffset(attachLayoutDefaults(venues), await loadVenueBackgrounds(false));
    const elementsByVenue = await loadVenueElements(layout.venues.map((venue) => venue.id));
    const skillGuidesByVenue = await loadVenueSkillGuides(layout.venues.map((venue) => venue.id));

    layout.venues.forEach((venue) => {
      venue.elements = elementsByVenue[venue.id] || [];
      venue.skillGuides = skillGuidesByVenue[venue.id] || [];
    });

    res.render('admin-venues', {
      venues: layout.venues,
      backgrounds: layout.backgrounds,
      rounds: rounds.map((round) => ({
        ...round,
        open_time_input: normalizeRoundDateTimeInput(round.open_time_text),
        close_time_input: normalizeRoundDateTimeInput(round.close_time_text),
        bookingSummary: roundBookingMap[Number(round.id)] || { totalCount: 0, confirmedCount: 0, cancelledCount: 0 }
      })),
      layoutBoardWidth: layout.boardWidth,
      layoutBoardHeight: layout.boardHeight,
      venueRecommendationEnabled: settingEnabled(settings.venueRecommendationEnabled, true),
      message: normalizeText(req.query.message),
      title: '场地预约管理'
    });
  }));

  app.post('/admin/venues/recommendation/toggle', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    const enabled = req.body.venueRecommendationEnabled === '1' ? '1' : '0';
    await saveSettings({ venueRecommendationEnabled: enabled });
    audit('venue_recommendation_setting_updated', {
      actor: req.session.user,
      action: enabled === '1' ? '开启场地智能推荐' : '关闭场地智能推荐',
      target: '场地智能推荐',
      enabled: enabled === '1',
      ip: req.ip
    });
    res.redirect('/admin/venues?message=' + encodeURIComponent(enabled === '1' ? '教师端智能推荐已开启' : '教师端智能推荐已关闭'));
  }));

  app.post('/admin/venues/add', adminOnly, requireWritable(), upload.fields([{name:'image',maxCount:1},{name:'detailImage',maxCount:1},{name:'playImagesSmall',maxCount:10},{name:'playImagesMl',maxCount:10},{name:'loopGuideImage',maxCount:12},{name:'loopGuideStationImage',maxCount:12},{name:'loopGuideVideo',maxCount:8}]), asyncHandler(async (req, res) => {
    const name = normalizeText(req.body.name);
    if (!name) {
      return res.redirect('/admin/venues?message=' + encodeURIComponent('请输入场地名称'));
    }

    await ensureVenueResourceSchema();

    const capSmall = Math.max(0, Number(req.body.capSmall) || 1);
    const capMiddle = Math.max(0, Number(req.body.capMiddle) || 2);
    const capLarge = Math.max(0, Number(req.body.capLarge) || 2);
    const playDescSmall = normalizeText(req.body.playDescSmall);
    const playDescMl = normalizeText(req.body.playDescMl);
    const loopGuideDescSmall = normalizeText(req.body.loopGuideDescSmall);
    const loopGuideDescMl = normalizeText(req.body.loopGuideDescMl);
    const loopGuideVideoAutoplay = normalizeText(req.body.loopGuideVideoAutoplay) === '1' ? 1 : 0;
    const imgWidth = toNullableInt(req.body.imageWidth) || 280;
    const imgHeight = toNullableInt(req.body.imageHeight) || 180;
    const sortOrder = Number(req.body.sortOrder) || 1;
    const equipment = normalizeText(req.body.equipment);
    const hotspotPoints = normalizeHotspotPoints(req.body.hotspotPoints);
    const parsedHotspotPoints = parseHotspotPoints(hotspotPoints);
    const hotspotCentroid = calculateHotspotCentroid(parsedHotspotPoints);
    const hotspotHintX = hotspotPoints ? clampInt(req.body.hotspotHintX, 0, 4000, hotspotCentroid.x) : null;
    const hotspotHintY = hotspotPoints ? clampInt(req.body.hotspotHintY, 0, 4000, hotspotCentroid.y) : null;
    const hotspotHintLabel = normalizeText(req.body.hotspotHintLabel) || name;
    const hotspotHintLabelSize = clampInt(req.body.hotspotHintLabelSize, 10, 36, 14);
    const hotspotHintColor = normalizeHotspotHintColor(req.body.hotspotHintColor);
    const hotspotHintSize = clampInt(req.body.hotspotHintSize, 12, 96, 28);
    const hotspotHintLength = clampInt(req.body.hotspotHintLength, 16, 200, 54);
    const hotspotHintBounceMs = clampInt(req.body.hotspotHintBounceMs, 400, 4000, 1500);
    const detailViewWidth = clampInt(req.body.detailViewWidth, 480, 1600, 960);
    const detailViewHeight = clampInt(req.body.detailViewHeight, 320, 1200, 640);
    const imageFile = req.files && req.files.image ? req.files.image[0] : null;
    const imagePath = saveUploadedFile(imageFile, 'venue');
    const detailImagePath = saveUploadedFile(firstFile(req.files, 'detailImage'), 'venue_detail');
    const loopGuideImages = saveUploadedFiles(req.files && req.files.loopGuideImage, 'venue_loop_image');
    const loopGuideStationImages = saveUploadedFiles(req.files && req.files.loopGuideStationImage, 'venue_loop_station');
    const loopGuideVideos = saveUploadedFiles(req.files && req.files.loopGuideVideo, 'venue_loop_video');
    const playImgSmall = (req.files && req.files.playImagesSmall || []).map(f => saveUploadedFile(f, 'venue')).filter(Boolean);
    const playImgMl = (req.files && req.files.playImagesMl || []).map(f => saveUploadedFile(f, 'venue')).filter(Boolean);

    await dbQuery(
      `INSERT INTO venues (
         name, image_path, image_width, image_height, hotspot_points, hotspot_hint_x, hotspot_hint_y, hotspot_hint_label,
         hotspot_hint_label_size, hotspot_hint_color, hotspot_hint_size, hotspot_hint_length, hotspot_hint_bounce_ms,
         detail_image_path, detail_view_width, detail_view_height, play_desc_small, play_images_small, play_desc_ml, play_images_ml,
         loop_guide_image_path, loop_guide_images, loop_guide_station_image_path, loop_guide_station_images, loop_guide_video_path, loop_guide_videos, loop_guide_video_autoplay, loop_guide_desc_small, loop_guide_desc_ml,
         cap_small, cap_middle, cap_large, sort_order, equipment, enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        name,
        imagePath,
        imgWidth,
        imgHeight,
        hotspotPoints,
        hotspotHintX,
        hotspotHintY,
        hotspotHintLabel,
        hotspotHintLabelSize,
        hotspotHintColor,
        hotspotHintSize,
        hotspotHintLength,
        hotspotHintBounceMs,
        detailImagePath,
        detailViewWidth,
        detailViewHeight,
        playDescSmall,
        JSON.stringify(playImgSmall),
        playDescMl,
        JSON.stringify(playImgMl),
        loopGuideImages[0] || null,
        JSON.stringify(loopGuideImages),
        loopGuideStationImages[0] || null,
        JSON.stringify(loopGuideStationImages),
        loopGuideVideos[0] || null,
        JSON.stringify(loopGuideVideos),
        loopGuideVideoAutoplay,
        loopGuideDescSmall,
        loopGuideDescMl,
        capSmall,
        capMiddle,
        capLarge,
        sortOrder,
        equipment
      ]
    );

    audit('venue_added', { actor: req.session.user, venueName: name, ip: req.ip });
    res.redirect('/admin/venues?message=' + encodeURIComponent(`场地「${name}」添加成功`));
  }));

  app.post('/admin/venues/:id/edit', adminOnly, requireWritable(), upload.fields([{name:'image',maxCount:1},{name:'detailImage',maxCount:1},{name:'playImagesSmall',maxCount:10},{name:'playImagesMl',maxCount:10},{name:'loopGuideImage',maxCount:12},{name:'loopGuideStationImage',maxCount:12},{name:'loopGuideVideo',maxCount:8}]), asyncHandler(async (req, res) => {
    const venueId = Number(req.params.id);
    await ensureVenueResourceSchema();
    const name = normalizeText(req.body.name);
    const capSmall = Math.max(0, Number(req.body.capSmall) || 0);
    const capMiddle = Math.max(0, Number(req.body.capMiddle) || 0);
    const capLarge = Math.max(0, Number(req.body.capLarge) || 0);
    const playDescSmall = normalizeText(req.body.playDescSmall);
    const playDescMl = normalizeText(req.body.playDescMl);
    const loopGuideDescSmall = normalizeText(req.body.loopGuideDescSmall);
    const loopGuideDescMl = normalizeText(req.body.loopGuideDescMl);
    const loopGuideVideoAutoplay = normalizeText(req.body.loopGuideVideoAutoplay) === '1' ? 1 : 0;
    const imgWidth = toNullableInt(req.body.imageWidth) || 280;
    const imgHeight = toNullableInt(req.body.imageHeight) || 180;
    const sortOrder = Number(req.body.sortOrder) || 1;
    const equipment = normalizeText(req.body.equipment);
    const hotspotPoints = normalizeHotspotPoints(req.body.hotspotPoints);
    const parsedHotspotPoints = parseHotspotPoints(hotspotPoints);
    const hotspotCentroid = calculateHotspotCentroid(parsedHotspotPoints);
    const hotspotHintX = hotspotPoints ? clampInt(req.body.hotspotHintX, 0, 4000, hotspotCentroid.x) : null;
    const hotspotHintY = hotspotPoints ? clampInt(req.body.hotspotHintY, 0, 4000, hotspotCentroid.y) : null;
    const hotspotHintLabel = normalizeText(req.body.hotspotHintLabel) || name;
    const hotspotHintLabelSize = clampInt(req.body.hotspotHintLabelSize, 10, 36, 14);
    const hotspotHintColor = normalizeHotspotHintColor(req.body.hotspotHintColor);
    const hotspotHintSize = clampInt(req.body.hotspotHintSize, 12, 96, 28);
    const hotspotHintLength = clampInt(req.body.hotspotHintLength, 16, 200, 54);
    const hotspotHintBounceMs = clampInt(req.body.hotspotHintBounceMs, 400, 4000, 1500);
    const detailViewWidth = clampInt(req.body.detailViewWidth, 480, 1600, 960);
    const detailViewHeight = clampInt(req.body.detailViewHeight, 320, 1200, 640);
    const imageFile = req.files && req.files.image ? req.files.image[0] : null;
    const imagePath = saveUploadedFile(imageFile, 'venue');
    const detailImagePath = saveUploadedFile(firstFile(req.files, 'detailImage'), 'venue_detail');
    const newLoopGuideImages = saveUploadedFiles(req.files && req.files.loopGuideImage, 'venue_loop_image');
    const newLoopGuideStationImages = saveUploadedFiles(req.files && req.files.loopGuideStationImage, 'venue_loop_station');
    const newLoopGuideVideos = saveUploadedFiles(req.files && req.files.loopGuideVideo, 'venue_loop_video');

    // 处理玩法图片
    const existingRows = await dbQuery('SELECT play_images_small, play_images_ml, detail_image_path, loop_guide_image_path, loop_guide_images, loop_guide_station_image_path, loop_guide_station_images, loop_guide_video_path, loop_guide_videos FROM venues WHERE id = ?', [venueId]);
    const existRow = existingRows[0] || {};
    let existSmall = []; let existMl = [];
    try { existSmall = JSON.parse(existRow.play_images_small || '[]'); } catch(e) {}
    try { existMl = JSON.parse(existRow.play_images_ml || '[]'); } catch(e) {}
    const newSmall = (req.files && req.files.playImagesSmall || []).map(f => saveUploadedFile(f, 'venue')).filter(Boolean);
    const newMl = (req.files && req.files.playImagesMl || []).map(f => saveUploadedFile(f, 'venue')).filter(Boolean);
    const removeSmall = [].concat(req.body.removePlayImagesSmall || []).filter(Boolean);
    const removeMl = [].concat(req.body.removePlayImagesMl || []).filter(Boolean);
    // Delete removed play images from disk
    removeSmall.forEach(p => deleteUploadedFile(p));
    removeMl.forEach(p => deleteUploadedFile(p));
    const finalSmall = existSmall.filter(p => !removeSmall.includes(p)).concat(newSmall);
    const finalMl = existMl.filter(p => !removeMl.includes(p)).concat(newMl);
    const existLoopGuideImages = parseMediaList(existRow.loop_guide_images, [existRow.loop_guide_image_path]);
    const existLoopGuideStationImages = parseMediaList(existRow.loop_guide_station_images, [existRow.loop_guide_station_image_path]);
    const existLoopGuideVideos = parseMediaList(existRow.loop_guide_videos, [existRow.loop_guide_video_path]);
    const removeLoopGuideImages = [].concat(req.body.removeLoopGuideImages || []).filter(Boolean);
    const removeLoopGuideStationImages = [].concat(req.body.removeLoopGuideStationImages || []).filter(Boolean);
    const removeLoopGuideVideos = [].concat(req.body.removeLoopGuideVideos || []).filter(Boolean);
    removeLoopGuideImages.forEach((item) => deleteUploadedFile(item));
    removeLoopGuideStationImages.forEach((item) => deleteUploadedFile(item));
    removeLoopGuideVideos.forEach((item) => deleteUploadedFile(item));
    const finalLoopGuideImages = existLoopGuideImages.filter((item) => !removeLoopGuideImages.includes(item)).concat(newLoopGuideImages);
    const finalLoopGuideStationImages = existLoopGuideStationImages.filter((item) => !removeLoopGuideStationImages.includes(item)).concat(newLoopGuideStationImages);
    const finalLoopGuideVideos = existLoopGuideVideos.filter((item) => !removeLoopGuideVideos.includes(item)).concat(newLoopGuideVideos);

    const params = [
      name,
      imgWidth,
      imgHeight,
      hotspotPoints,
      hotspotHintX,
      hotspotHintY,
      hotspotHintLabel,
      hotspotHintLabelSize,
      hotspotHintColor,
      hotspotHintSize,
      hotspotHintLength,
      hotspotHintBounceMs,
      detailViewWidth,
      detailViewHeight,
      playDescSmall,
      JSON.stringify(finalSmall),
      playDescMl,
      JSON.stringify(finalMl),
      finalLoopGuideImages[0] || null,
      JSON.stringify(finalLoopGuideImages),
      finalLoopGuideStationImages[0] || null,
      JSON.stringify(finalLoopGuideStationImages),
      finalLoopGuideVideos[0] || null,
      JSON.stringify(finalLoopGuideVideos),
      loopGuideVideoAutoplay,
      loopGuideDescSmall,
      loopGuideDescMl,
      capSmall,
      capMiddle,
      capLarge,
      sortOrder,
      equipment
    ];
    let imageSql = '';
    let detailImageSql = '';
    if (imagePath) {
      // clean up old venue image
      const oldImgRows = await dbQuery('SELECT image_path FROM venues WHERE id = ?', [venueId]);
      if (oldImgRows[0] && oldImgRows[0].image_path) deleteUploadedFile(oldImgRows[0].image_path);
      imageSql = ', image_path = ?';
      params.push(imagePath);
    }
    if (detailImagePath) {
      if (existRow.detail_image_path) deleteUploadedFile(existRow.detail_image_path);
      detailImageSql = ', detail_image_path = ?';
      params.push(detailImagePath);
    }
    params.push(venueId);

    await dbQuery(
      `UPDATE venues
          SET name = ?, image_width = ?, image_height = ?, hotspot_points = ?, hotspot_hint_x = ?, hotspot_hint_y = ?, hotspot_hint_label = ?,
              hotspot_hint_label_size = ?, hotspot_hint_color = ?, hotspot_hint_size = ?, hotspot_hint_length = ?, hotspot_hint_bounce_ms = ?,
              detail_view_width = ?, detail_view_height = ?, play_desc_small = ?, play_images_small = ?, play_desc_ml = ?, play_images_ml = ?,
              loop_guide_image_path = ?, loop_guide_images = ?, loop_guide_station_image_path = ?, loop_guide_station_images = ?, loop_guide_video_path = ?, loop_guide_videos = ?,
              loop_guide_video_autoplay = ?, loop_guide_desc_small = ?, loop_guide_desc_ml = ?,
              cap_small = ?, cap_middle = ?, cap_large = ?, sort_order = ?, equipment = ?${imageSql}${detailImageSql}
        WHERE id = ?`,
      params
    );

    audit('venue_updated', { actor: req.session.user, venueId, venueName: name, ip: req.ip });
    res.redirect('/admin/venues?message=' + encodeURIComponent('场地已更新'));
  }));

  app.post('/admin/venues/:id/hotspot', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    const venueId = Number(req.params.id);
    await ensureVenueWriteColumns();
    const rows = await dbQuery('SELECT name FROM venues WHERE id = ? LIMIT 1', [venueId]);
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: '场地不存在' });
    }

    const venueName = normalizeText(req.body.name) || normalizeText(rows[0].name) || '';
    const hotspotPoints = normalizeHotspotPoints(req.body.hotspotPoints);
    const parsedHotspotPoints = parseHotspotPoints(hotspotPoints);
    const hotspotCentroid = calculateHotspotCentroid(parsedHotspotPoints);
    const hotspotHintX = hotspotPoints ? clampInt(req.body.hotspotHintX, 0, 4000, hotspotCentroid.x) : null;
    const hotspotHintY = hotspotPoints ? clampInt(req.body.hotspotHintY, 0, 4000, hotspotCentroid.y) : null;
    const hotspotHintLabel = normalizeText(req.body.hotspotHintLabel) || venueName;
    const hotspotHintLabelSize = clampInt(req.body.hotspotHintLabelSize, 10, 36, 14);
    const hotspotHintColor = normalizeHotspotHintColor(req.body.hotspotHintColor);
    const hotspotHintSize = clampInt(req.body.hotspotHintSize, 12, 96, 28);
    const hotspotHintLength = clampInt(req.body.hotspotHintLength, 16, 200, 54);
    const hotspotHintBounceMs = clampInt(req.body.hotspotHintBounceMs, 400, 4000, 1500);

    await dbQuery(
      `UPDATE venues
          SET hotspot_points = ?, hotspot_hint_x = ?, hotspot_hint_y = ?, hotspot_hint_label = ?,
              hotspot_hint_label_size = ?, hotspot_hint_color = ?, hotspot_hint_size = ?, hotspot_hint_length = ?, hotspot_hint_bounce_ms = ?
        WHERE id = ?`,
      [
        hotspotPoints,
        hotspotHintX,
        hotspotHintY,
        hotspotHintLabel,
        hotspotHintLabelSize,
        hotspotHintColor,
        hotspotHintSize,
        hotspotHintLength,
        hotspotHintBounceMs,
        venueId
      ]
    );

    audit('venue_hotspot_updated', { actor: req.session.user, venueId, venueName, ip: req.ip });
    res.json({
      ok: true,
      message: '热区已保存',
      hotspot: {
        points: parsedHotspotPoints,
        hintX: hotspotHintX,
        hintY: hotspotHintY,
        hintLabel: hotspotHintLabel,
        hintLabelSize: hotspotHintLabelSize,
        hintColor: hotspotHintColor,
        hintSize: hotspotHintSize,
        hintLength: hotspotHintLength,
        hintBounceMs: hotspotHintBounceMs
      }
    });
  }));

  app.post('/admin/venues/layout', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    const raw = normalizeText(req.body.layoutJson);
    let items = [];

    try {
      items = JSON.parse(raw || '[]');
    } catch (error) {
      return res.redirect('/admin/venues?message=' + encodeURIComponent('布局数据格式不正确'));
    }

    for (const item of items) {
      const entityType = normalizeText(item.type) === 'background' ? 'background' : 'venue';
      const entityId = Number(item.id);
      if (!Number.isInteger(entityId) || entityId <= 0) continue;

      const x = Math.max(0, Math.round(Number(item.x) || 0));
      const y = Math.max(0, Math.round(Number(item.y) || 0));
      const width = Math.max(60, Math.round(Number(item.width) || 100));
      const height = Math.max(40, Math.round(Number(item.height) || 65));

      if (entityType === 'background') {
        await dbQuery(
          `UPDATE venue_backgrounds
              SET map_x = ?, map_y = ?, map_width = ?, map_height = ?, sort_order = ?, is_fixed = ?, enabled = ?
            WHERE id = ?`,
          [
            x,
            y,
            Math.max(80, width),
            Math.max(80, height),
            Math.max(1, Math.round(Number(item.sortOrder) || 1)),
            normalizeText(item.isFixed) === '1' || Number(item.isFixed) ? 1 : 0,
            normalizeText(item.enabled) === '0' || Number(item.enabled) === 0 ? 0 : 1,
            entityId
          ]
        );
      } else {
        await dbQuery(
          `UPDATE venues
              SET map_x = ?, map_y = ?, map_width = ?, map_height = ?
            WHERE id = ?`,
          [x, y, width, height, entityId]
        );
      }
    }

    audit('venue_layout_saved', { actor: req.session.user, count: items.length, ip: req.ip });
    res.redirect('/admin/venues?message=' + encodeURIComponent('场地布局已保存'));
  }));

  app.post('/admin/venues/backgrounds/add', adminOnly, requireWritable(), upload.fields([{ name: 'image', maxCount: 1 }]), asyncHandler(async (req, res) => {
    const name = normalizeText(req.body.name) || '背景层';
    await dbQuery(
      `INSERT INTO venue_backgrounds (
         name, image_path, map_x, map_y, map_width, map_height, sort_order, is_fixed, enabled
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        saveUploadedFile(firstFile(req.files, 'image'), 'venue_bg'),
        Math.max(0, Number(req.body.mapX) || 0),
        Math.max(0, Number(req.body.mapY) || 0),
        Math.max(80, Number(req.body.mapWidth) || 600),
        Math.max(80, Number(req.body.mapHeight) || 320),
        Math.max(1, Number(req.body.sortOrder) || 1),
        normalizeText(req.body.isFixed) === '1' ? 1 : 0,
        normalizeText(req.body.enabled) === '0' ? 0 : 1
      ]
    );

    res.redirect('/admin/venues?message=' + encodeURIComponent('背景层已添加'));
  }));

  app.post('/admin/venues/backgrounds/:id/edit', adminOnly, requireWritable(), upload.fields([{ name: 'image', maxCount: 1 }]), asyncHandler(async (req, res) => {
    const backgroundId = Number(req.params.id);
    const imagePath = saveUploadedFile(firstFile(req.files, 'image'), 'venue_bg');
    const updates = [
      normalizeText(req.body.name) || '背景层',
      Math.max(0, Number(req.body.mapX) || 0),
      Math.max(0, Number(req.body.mapY) || 0),
      Math.max(80, Number(req.body.mapWidth) || 600),
      Math.max(80, Number(req.body.mapHeight) || 320),
      Math.max(1, Number(req.body.sortOrder) || 1),
      normalizeText(req.body.isFixed) === '1' ? 1 : 0,
      normalizeText(req.body.enabled) === '0' ? 0 : 1
    ];

    let sql = `UPDATE venue_backgrounds
                  SET name = ?, map_x = ?, map_y = ?, map_width = ?, map_height = ?, sort_order = ?, is_fixed = ?, enabled = ?`;
    if (imagePath) {
      const oldRows = await dbQuery('SELECT image_path FROM venue_backgrounds WHERE id = ?', [backgroundId]);
      if (oldRows[0] && oldRows[0].image_path) deleteUploadedFile(oldRows[0].image_path);
      sql += ', image_path = ?';
      updates.push(imagePath);
    }
    sql += ' WHERE id = ?';
    updates.push(backgroundId);

    await dbQuery(sql, updates);
    res.redirect('/admin/venues?message=' + encodeURIComponent('背景层已更新'));
  }));

  app.post('/admin/venues/backgrounds/:id/delete', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    const backgroundId = Number(req.params.id);
    const rows = await dbQuery('SELECT image_path FROM venue_backgrounds WHERE id = ?', [backgroundId]);
    if (rows[0] && rows[0].image_path) deleteUploadedFile(rows[0].image_path);
    await dbQuery('DELETE FROM venue_backgrounds WHERE id = ?', [backgroundId]);
    res.redirect('/admin/venues?message=' + encodeURIComponent('背景层已删除'));
  }));

  app.post('/admin/venues/:id/delete', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    await dbQuery('DELETE FROM venues WHERE id = ?', [Number(req.params.id)]);
    audit('venue_deleted', { actor: req.session.user, venueId: Number(req.params.id), ip: req.ip });
    res.redirect('/admin/venues?message=' + encodeURIComponent('场地已删除'));
  }));

  app.post('/admin/venues/:id/toggle', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    const rows = await dbQuery('SELECT enabled FROM venues WHERE id = ? LIMIT 1', [Number(req.params.id)]);
    if (rows.length) {
      await dbQuery('UPDATE venues SET enabled = ? WHERE id = ?', [rows[0].enabled ? 0 : 1, Number(req.params.id)]);
    }
    audit('venue_toggled', { actor: req.session.user, venueId: Number(req.params.id), ip: req.ip });
    res.redirect('/admin/venues?message=' + encodeURIComponent('状态已更新'));
  }));

  app.post(
    '/admin/venues/:id/skill-guides/add',
    adminOnly,
    requireWritable(),
    upload.fields([
      { name: 'basicImage', maxCount: 12 },
      { name: 'basicVideo', maxCount: 8 },
      { name: 'advancedImage', maxCount: 12 },
      { name: 'advancedVideo', maxCount: 8 },
      { name: 'extraImage', maxCount: 12 },
      { name: 'extraVideo', maxCount: 8 }
    ]),
    asyncHandler(async (req, res) => {
      const venueId = Number(req.params.id);
      await ensureVenueResourceSchema();
      const title = normalizeText(req.body.title);
      if (!title) {
        return res.redirect('/admin/venues?message=' + encodeURIComponent('请填写技能分类名称'));
      }

      const basicImagePaths = saveUploadedFiles(req.files && req.files.basicImage, 'venue_skill_basic_image');
      const basicVideoPaths = saveUploadedFiles(req.files && req.files.basicVideo, 'venue_skill_basic_video');
      const advancedImagePaths = saveUploadedFiles(req.files && req.files.advancedImage, 'venue_skill_advanced_image');
      const advancedVideoPaths = saveUploadedFiles(req.files && req.files.advancedVideo, 'venue_skill_advanced_video');
      const extraImagePaths = saveUploadedFiles(req.files && req.files.extraImage, 'venue_skill_extra_image');
      const extraVideoPaths = saveUploadedFiles(req.files && req.files.extraVideo, 'venue_skill_extra_video');

      await dbQuery(
        `INSERT INTO venue_skill_guides (
           venue_id, title, basic_skill_names, basic_equipment, basic_action_points, basic_safety_points, basic_image_path, basic_image_paths, basic_video_path, basic_video_paths, basic_video_autoplay,
           advanced_skill_names, advanced_equipment, advanced_action_points, advanced_safety_points, advanced_image_path, advanced_image_paths, advanced_video_path, advanced_video_paths, advanced_video_autoplay,
           extra_level_type, extra_skill_names, extra_equipment, extra_action_points, extra_safety_points, extra_image_path, extra_image_paths, extra_video_path, extra_video_paths, extra_video_autoplay,
           bridge_indicators, enabled, sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          venueId,
          title,
          normalizeText(req.body.basicSkillNames),
          normalizeText(req.body.basicEquipment),
          normalizeText(req.body.basicActionPoints),
          normalizeText(req.body.basicSafetyPoints),
          basicImagePaths[0] || null,
          JSON.stringify(basicImagePaths),
          basicVideoPaths[0] || null,
          JSON.stringify(basicVideoPaths),
          normalizeText(req.body.basicVideoAutoplay) === '1' ? 1 : 0,
          normalizeText(req.body.advancedSkillNames),
          normalizeText(req.body.advancedEquipment),
          normalizeText(req.body.advancedActionPoints),
          normalizeText(req.body.advancedSafetyPoints),
          advancedImagePaths[0] || null,
          JSON.stringify(advancedImagePaths),
          advancedVideoPaths[0] || null,
          JSON.stringify(advancedVideoPaths),
          normalizeText(req.body.advancedVideoAutoplay) === '1' ? 1 : 0,
          normalizeSkillGuideLevelType(req.body.extraLevelType) || null,
          normalizeText(req.body.extraSkillNames),
          normalizeText(req.body.extraEquipment),
          normalizeText(req.body.extraActionPoints),
          normalizeText(req.body.extraSafetyPoints),
          extraImagePaths[0] || null,
          JSON.stringify(extraImagePaths),
          extraVideoPaths[0] || null,
          JSON.stringify(extraVideoPaths),
          normalizeText(req.body.extraVideoAutoplay) === '1' ? 1 : 0,
          normalizeText(req.body.bridgeIndicators),
          normalizeText(req.body.enabled) === '0' ? 0 : 1,
          Math.max(1, Number(req.body.sortOrder) || 1)
        ]
      );

      res.redirect('/admin/venues?message=' + encodeURIComponent(`已新增技能指导：${title}`));
    })
  );

  app.post(
    '/admin/venues/skill-guides/:id/edit',
    adminOnly,
    requireWritable(),
    upload.fields([
      { name: 'basicImage', maxCount: 12 },
      { name: 'basicVideo', maxCount: 8 },
      { name: 'advancedImage', maxCount: 12 },
      { name: 'advancedVideo', maxCount: 8 },
      { name: 'extraImage', maxCount: 12 },
      { name: 'extraVideo', maxCount: 8 }
    ]),
    asyncHandler(async (req, res) => {
      const guideId = Number(req.params.id);
      await ensureVenueResourceSchema();
      const rows = await dbQuery('SELECT * FROM venue_skill_guides WHERE id = ? LIMIT 1', [guideId]);
      if (!rows.length) {
        return res.redirect('/admin/venues?message=' + encodeURIComponent('技能指导不存在'));
      }

      const current = rows[0];
      const title = normalizeText(req.body.title);
      if (!title) {
        return res.redirect('/admin/venues?message=' + encodeURIComponent('请填写技能分类名称'));
      }

      const newBasicImagePaths = saveUploadedFiles(req.files && req.files.basicImage, 'venue_skill_basic_image');
      const newBasicVideoPaths = saveUploadedFiles(req.files && req.files.basicVideo, 'venue_skill_basic_video');
      const newAdvancedImagePaths = saveUploadedFiles(req.files && req.files.advancedImage, 'venue_skill_advanced_image');
      const newAdvancedVideoPaths = saveUploadedFiles(req.files && req.files.advancedVideo, 'venue_skill_advanced_video');
      const newExtraImagePaths = saveUploadedFiles(req.files && req.files.extraImage, 'venue_skill_extra_image');
      const newExtraVideoPaths = saveUploadedFiles(req.files && req.files.extraVideo, 'venue_skill_extra_video');
      const removeBasicImages = [].concat(req.body.removeBasicImages || []).filter(Boolean);
      const removeBasicVideos = [].concat(req.body.removeBasicVideos || []).filter(Boolean);
      const removeAdvancedImages = [].concat(req.body.removeAdvancedImages || []).filter(Boolean);
      const removeAdvancedVideos = [].concat(req.body.removeAdvancedVideos || []).filter(Boolean);
      const removeExtraImages = [].concat(req.body.removeExtraImages || []).filter(Boolean);
      const removeExtraVideos = [].concat(req.body.removeExtraVideos || []).filter(Boolean);
      const currentBasicImagePaths = parseMediaList(current.basic_image_paths, [current.basic_image_path]);
      const currentBasicVideoPaths = parseMediaList(current.basic_video_paths, [current.basic_video_path]);
      const currentAdvancedImagePaths = parseMediaList(current.advanced_image_paths, [current.advanced_image_path]);
      const currentAdvancedVideoPaths = parseMediaList(current.advanced_video_paths, [current.advanced_video_path]);
      const currentExtraImagePaths = parseMediaList(current.extra_image_paths, [current.extra_image_path]);
      const currentExtraVideoPaths = parseMediaList(current.extra_video_paths, [current.extra_video_path]);
      removeBasicImages.forEach((item) => deleteUploadedFile(item));
      removeBasicVideos.forEach((item) => deleteUploadedFile(item));
      removeAdvancedImages.forEach((item) => deleteUploadedFile(item));
      removeAdvancedVideos.forEach((item) => deleteUploadedFile(item));
      removeExtraImages.forEach((item) => deleteUploadedFile(item));
      removeExtraVideos.forEach((item) => deleteUploadedFile(item));
      const finalBasicImagePaths = currentBasicImagePaths.filter((item) => !removeBasicImages.includes(item)).concat(newBasicImagePaths);
      const finalBasicVideoPaths = currentBasicVideoPaths.filter((item) => !removeBasicVideos.includes(item)).concat(newBasicVideoPaths);
      const finalAdvancedImagePaths = currentAdvancedImagePaths.filter((item) => !removeAdvancedImages.includes(item)).concat(newAdvancedImagePaths);
      const finalAdvancedVideoPaths = currentAdvancedVideoPaths.filter((item) => !removeAdvancedVideos.includes(item)).concat(newAdvancedVideoPaths);
      const finalExtraImagePaths = currentExtraImagePaths.filter((item) => !removeExtraImages.includes(item)).concat(newExtraImagePaths);
      const finalExtraVideoPaths = currentExtraVideoPaths.filter((item) => !removeExtraVideos.includes(item)).concat(newExtraVideoPaths);

      const params = [
        title,
        normalizeText(req.body.basicSkillNames),
        normalizeText(req.body.basicEquipment),
        normalizeText(req.body.basicActionPoints),
        normalizeText(req.body.basicSafetyPoints),
        finalBasicImagePaths[0] || null,
        JSON.stringify(finalBasicImagePaths),
        finalBasicVideoPaths[0] || null,
        JSON.stringify(finalBasicVideoPaths),
        normalizeText(req.body.basicVideoAutoplay) === '1' ? 1 : 0,
        normalizeText(req.body.advancedSkillNames),
        normalizeText(req.body.advancedEquipment),
        normalizeText(req.body.advancedActionPoints),
        normalizeText(req.body.advancedSafetyPoints),
        finalAdvancedImagePaths[0] || null,
        JSON.stringify(finalAdvancedImagePaths),
        finalAdvancedVideoPaths[0] || null,
        JSON.stringify(finalAdvancedVideoPaths),
        normalizeText(req.body.advancedVideoAutoplay) === '1' ? 1 : 0,
        normalizeSkillGuideLevelType(req.body.extraLevelType) || null,
        normalizeText(req.body.extraSkillNames),
        normalizeText(req.body.extraEquipment),
        normalizeText(req.body.extraActionPoints),
        normalizeText(req.body.extraSafetyPoints),
        finalExtraImagePaths[0] || null,
        JSON.stringify(finalExtraImagePaths),
        finalExtraVideoPaths[0] || null,
        JSON.stringify(finalExtraVideoPaths),
        normalizeText(req.body.extraVideoAutoplay) === '1' ? 1 : 0,
        normalizeText(req.body.bridgeIndicators),
        normalizeText(req.body.enabled) === '0' ? 0 : 1,
        Math.max(1, Number(req.body.sortOrder) || 1)
      ];

      params.push(guideId);

      await dbQuery(
        `UPDATE venue_skill_guides
            SET title = ?, basic_skill_names = ?, basic_equipment = ?, basic_action_points = ?, basic_safety_points = ?,
                basic_image_path = ?, basic_image_paths = ?, basic_video_path = ?, basic_video_paths = ?, basic_video_autoplay = ?,
                advanced_skill_names = ?, advanced_equipment = ?, advanced_action_points = ?, advanced_safety_points = ?,
                advanced_image_path = ?, advanced_image_paths = ?, advanced_video_path = ?, advanced_video_paths = ?, advanced_video_autoplay = ?,
                extra_level_type = ?, extra_skill_names = ?, extra_equipment = ?, extra_action_points = ?, extra_safety_points = ?,
                extra_image_path = ?, extra_image_paths = ?, extra_video_path = ?, extra_video_paths = ?, extra_video_autoplay = ?,
                bridge_indicators = ?, enabled = ?, sort_order = ?
          WHERE id = ?`,
        params
      );

      res.redirect('/admin/venues?message=' + encodeURIComponent(`已更新技能指导：${title}`));
    })
  );

  app.post('/admin/venues/skill-guides/:id/delete', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    const guideId = Number(req.params.id);
    await ensureVenueResourceSchema();
    const rows = await dbQuery('SELECT title, basic_image_path, basic_image_paths, basic_video_path, basic_video_paths, advanced_image_path, advanced_image_paths, advanced_video_path, advanced_video_paths, extra_image_path, extra_image_paths, extra_video_path, extra_video_paths FROM venue_skill_guides WHERE id = ? LIMIT 1', [guideId]);
    if (rows.length) {
      const row = rows[0];
      parseMediaList(row.basic_image_paths, [row.basic_image_path]).forEach((item) => deleteUploadedFile(item));
      parseMediaList(row.basic_video_paths, [row.basic_video_path]).forEach((item) => deleteUploadedFile(item));
      parseMediaList(row.advanced_image_paths, [row.advanced_image_path]).forEach((item) => deleteUploadedFile(item));
      parseMediaList(row.advanced_video_paths, [row.advanced_video_path]).forEach((item) => deleteUploadedFile(item));
      parseMediaList(row.extra_image_paths, [row.extra_image_path]).forEach((item) => deleteUploadedFile(item));
      parseMediaList(row.extra_video_paths, [row.extra_video_path]).forEach((item) => deleteUploadedFile(item));
      await dbQuery('DELETE FROM venue_skill_guides WHERE id = ?', [guideId]);
    }
    res.redirect('/admin/venues?message=' + encodeURIComponent('已删除技能指导'));
  }));

  app.post(
    '/admin/venues/:id/elements/add',
    adminOnly,
    requireWritable(),
    upload.fields([
      { name: 'icon', maxCount: 1 },
      { name: 'detailImageSmall', maxCount: 1 },
      { name: 'detailImageMl', maxCount: 1 }
    ]),
    asyncHandler(async (req, res) => {
      const venueId = Number(req.params.id);
      const elementName = normalizeText(req.body.elementName);
      if (!elementName) {
        return res.redirect('/admin/venues?message=' + encodeURIComponent('请填写游戏标记名称'));
      }

      await dbQuery(
        `INSERT INTO venue_elements (
           venue_id, element_name, icon_path, detail_image_small, detail_image_ml,
           detail_desc_small, detail_desc_ml, pos_x, pos_y, box_width, box_height, enabled, sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          venueId,
          elementName,
          saveUploadedFile(firstFile(req.files, 'icon'), 'venue_element_icon'),
          saveUploadedFile(firstFile(req.files, 'detailImageSmall'), 'venue_element_small'),
          saveUploadedFile(firstFile(req.files, 'detailImageMl'), 'venue_element_ml'),
          normalizeText(req.body.detailDescSmall),
          normalizeText(req.body.detailDescMl),
          Math.max(0, Number(req.body.posX) || 20),
          Math.max(0, Number(req.body.posY) || 20),
          Math.max(24, Number(req.body.boxWidth) || 44),
          Math.max(24, Number(req.body.boxHeight) || 44),
          normalizeText(req.body.enabled) === '0' ? 0 : 1,
          Number(req.body.sortOrder) || 1
        ]
      );

      res.redirect('/admin/venues?message=' + encodeURIComponent(`已添加标记：${elementName}`));
    })
  );

  app.post(
    '/admin/venues/elements/:id/edit',
    adminOnly,
    requireWritable(),
    upload.fields([
      { name: 'icon', maxCount: 1 },
      { name: 'detailImageSmall', maxCount: 1 },
      { name: 'detailImageMl', maxCount: 1 }
    ]),
    asyncHandler(async (req, res) => {
      const elementId = Number(req.params.id);
      const elementName = normalizeText(req.body.elementName);
      if (!elementName) {
        return res.redirect('/admin/venues?message=' + encodeURIComponent('请填写游戏标记名称'));
      }

      const updates = [
        elementName,
        normalizeText(req.body.detailDescSmall),
        normalizeText(req.body.detailDescMl),
        Math.max(0, Number(req.body.posX) || 20),
        Math.max(0, Number(req.body.posY) || 20),
        Math.max(24, Number(req.body.boxWidth) || 44),
        Math.max(24, Number(req.body.boxHeight) || 44),
        normalizeText(req.body.enabled) === '0' ? 0 : 1,
        Number(req.body.sortOrder) || 1
      ];

      let sql = `
        UPDATE venue_elements
           SET element_name = ?, detail_desc_small = ?, detail_desc_ml = ?, pos_x = ?, pos_y = ?,
               box_width = ?, box_height = ?, enabled = ?, sort_order = ?
      `;

      const iconPath = saveUploadedFile(firstFile(req.files, 'icon'), 'venue_element_icon');
      const detailImageSmall = saveUploadedFile(firstFile(req.files, 'detailImageSmall'), 'venue_element_small');
      const detailImageMl = saveUploadedFile(firstFile(req.files, 'detailImageMl'), 'venue_element_ml');

      if (iconPath) {
        sql += ', icon_path = ?';
        updates.push(iconPath);
      }
      if (detailImageSmall) {
        sql += ', detail_image_small = ?';
        updates.push(detailImageSmall);
      }
      if (detailImageMl) {
        sql += ', detail_image_ml = ?';
        updates.push(detailImageMl);
      }

      sql += ' WHERE id = ?';
      updates.push(elementId);

      await dbQuery(sql, updates);
      res.redirect('/admin/venues?message=' + encodeURIComponent('标记已更新'));
    })
  );

  app.post('/admin/venues/elements/:id/delete', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    await dbQuery('DELETE FROM venue_elements WHERE id = ?', [Number(req.params.id)]);
    res.redirect('/admin/venues?message=' + encodeURIComponent('标记已删除'));
  }));

  app.post('/admin/venues/round/add', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    const roundDate = normalizeText(req.body.roundDate);
    const openTime = normalizeText(req.body.openTime);
    const closeTime = normalizeText(req.body.closeTime) || null;

    if (!roundDate || !openTime) {
      return res.redirect('/admin/venues?message=' + encodeURIComponent('请填写活动日期和开放时间'));
    }

    try {
      await dbQuery(
        `INSERT INTO venue_round (round_date, open_time, close_time, status)
         VALUES (?, ?, ?, 'pending')`,
        [roundDate, openTime.replace('T', ' '), closeTime ? closeTime.replace('T', ' ') : null]
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.redirect('/admin/venues?message=' + encodeURIComponent('该日期已存在预约轮次'));
      }
      throw error;
    }

    res.redirect('/admin/venues?message=' + encodeURIComponent(`${roundDate} 预约轮次已创建`));
  }));

  app.post('/admin/venues/round/:id/update', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    const roundId = Number(req.params.id);
    const roundDate = normalizeText(req.body.roundDate);
    const openTime = normalizeText(req.body.openTime);
    const closeTime = normalizeText(req.body.closeTime) || null;

    if (!roundId || !roundDate || !openTime) {
      return res.redirect('/admin/venues?message=' + encodeURIComponent('请填写完整的轮次日期和开放时间'));
    }

    const currentRows = await dbQuery(`SELECT ${roundSelectSql()} FROM venue_round WHERE id = ? LIMIT 1`, [roundId]);
    if (!currentRows.length) {
      return res.redirect('/admin/venues?message=' + encodeURIComponent('轮次不存在'));
    }
    const current = currentRows[0];

    try {
      await dbQuery(
        `UPDATE venue_round
            SET round_date = ?,
                open_time = ?,
                close_time = ?
          WHERE id = ?`,
        [roundDate, openTime.replace('T', ' '), closeTime ? closeTime.replace('T', ' ') : null, roundId]
      );
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.redirect('/admin/venues?message=' + encodeURIComponent('该日期已存在预约轮次，请换一个活动日期'));
      }
      throw error;
    }

    audit('venue_round_updated', {
      actor: req.session.user,
      action: '编辑预约轮次',
      target: roundDate,
      roundId,
      ip: req.ip,
      changes: buildAuditChanges({
        roundDate: current.round_date_text,
        openTime: current.open_time_text,
        closeTime: current.close_time_text || ''
      }, {
        roundDate,
        openTime: openTime.replace('T', ' '),
        closeTime: closeTime ? closeTime.replace('T', ' ') : ''
      }, VENUE_ROUND_AUDIT_LABELS)
    });

    res.redirect('/admin/venues?message=' + encodeURIComponent(`${roundDate} 轮次时间已更新`));
  }));

  app.post('/admin/venues/round/:id/status', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    const status = normalizeText(req.body.status);
    if (!['pending', 'open', 'closed'].includes(status)) {
      return res.redirect('/admin/venues?message=' + encodeURIComponent('无效状态'));
    }

    await dbQuery('UPDATE venue_round SET status = ? WHERE id = ?', [status, Number(req.params.id)]);
    res.redirect('/admin/venues?message=' + encodeURIComponent('轮次状态已更新'));
  }));

  app.post('/admin/venues/round/:id/delete', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    await dbQuery('DELETE FROM venue_round WHERE id = ?', [Number(req.params.id)]);
    res.redirect('/admin/venues?message=' + encodeURIComponent('轮次已删除'));
  }));

  app.get('/admin/venues/bookings', adminOnly, asyncHandler(async (req, res) => {
    const roundId = toNullableInt(req.query.roundId);
    const rounds = await dbQuery(`SELECT ${roundSelectSql()} FROM venue_round ORDER BY round_date DESC LIMIT 30`);
    const classes = await dbQuery(`
      SELECT id, name, grade_level
        FROM classes
       ORDER BY CASE grade_level WHEN 'small' THEN 1 WHEN 'middle' THEN 2 WHEN 'large' THEN 3 ELSE 99 END, name ASC
    `);
    let bookings = [];
    let selectedRound = null;
    let bookingAnalytics = summarizeVenueBookings([], classes);

    if (roundId) {
      selectedRound = (await dbQuery(`SELECT ${roundSelectSql()} FROM venue_round WHERE id = ? LIMIT 1`, [roundId]))[0] || null;
      bookings = await dbQuery(`
        SELECT vb.*,
               DATE_FORMAT(DATE_ADD(vb.created_at, INTERVAL 8 HOUR), '%Y-%m-%d %H:%i:%s') AS created_at_local_text,
               v.name AS venue_name,
               v.sort_order,
               v.cap_small,
               v.cap_middle,
               v.cap_large,
               c.name AS class_name,
               c.grade_level,
               u.name AS teacher_name
          FROM venue_bookings vb
          JOIN venues v ON v.id = vb.venue_id
          JOIN classes c ON c.id = vb.class_id
          JOIN users u ON u.id = vb.user_id
         WHERE vb.round_id = ?
         ORDER BY v.sort_order ASC, vb.grade_pool ASC, c.name ASC
       `, [roundId]);
      const attentionChildren = await dbQuery(`
        SELECT DISTINCT ch.id,
               ch.name,
               ch.gender,
               ch.birth_date,
               ch.attention_reason,
               ch.attention_start_date,
               ch.attention_end_date,
               ch.attention_tags,
               ch.attention_vest_type,
               c.name AS class_name,
               c.grade_level,
               vb.venue_id,
               v.sort_order
          FROM venue_bookings vb
          JOIN venues v ON v.id = vb.venue_id
          JOIN children ch ON ch.class_id = vb.class_id
          JOIN classes c ON c.id = ch.class_id
         WHERE vb.round_id = ?
           AND vb.status = 'confirmed'
           AND ch.enabled = 1
           AND ch.needs_attention = 1
           AND (ch.attention_start_date IS NULL OR ch.attention_start_date <= CURDATE())
           AND (ch.attention_end_date IS NULL OR ch.attention_end_date >= CURDATE())
         ORDER BY vb.venue_id ASC,
                  CASE ch.attention_vest_type
                    WHEN 'red' THEN 1
                    WHEN 'yellow' THEN 2
                    WHEN 'green' THEN 3
                    ELSE 2
                  END ASC,
                  c.name ASC,
                  ch.name ASC
       `, [roundId]);
      bookingAnalytics = summarizeVenueBookings(bookings, classes, attentionChildren);
    }

    res.render('admin-venue-bookings', {
      rounds,
      bookings,
      selectedRound,
      bookingAnalytics,
      roundId,
      title: '预约记录',
      message: normalizeText(req.query.message),
      gradeLabel,
      formatBookingLocalDateTime
    });
  }));

  app.post('/admin/venues/bookings/:id/cancel', adminOnly, requireWritable(), asyncHandler(async (req, res) => {
    const roundId = normalizeText(req.query.roundId) || '';
    await dbQuery(`UPDATE venue_bookings SET status = 'cancelled' WHERE id = ?`, [Number(req.params.id)]);
    res.redirect(`/admin/venues/bookings?roundId=${roundId}&message=` + encodeURIComponent('已取消'));
  }));

  app.get('/user/venues', userOnly, asyncHandler(async (req, res) => {
    await ensureVenueResourceSchema();
    const user = req.session.user;
    const todayText = chinaNowText().slice(0, 10);
    const settings = await getSettings();
    const venueRecommendationEnabled = settingEnabled(settings.venueRecommendationEnabled, true);
    const baseView = {
      venues: [],
      backgrounds: [],
      activeRound: null,
      bookingMap: {},
      venueRecommendations: [],
      venueRecommendationEnabled,
      bookedVenueLabel: '',
      myGrade: null,
      myGradeLabel: '',
      classId: null,
      assignedClass: null,
      ownClassChildren: [],
      attentionChildren: [],
      attentionReminderChildren: [],
      sceneAttentionRows: [],
      layoutBoardWidth: 860,
      layoutBoardHeight: 420,
      message: normalizeText(req.query.message),
      todayText,
      now: Date.now()
    };

    if (!user.classId) {
      return res.render('user-venues', {
        ...baseView,
        message: '您的账号未绑定班级，请联系管理员。'
      });
    }

    const ownClassDashboard = await loadOwnClassDashboard(user);
    const myGrade = ownClassDashboard.assignedClass ? ownClassDashboard.assignedClass.grade_level : 'small';
    const myGradeLabel = gradeLabel(myGrade);

    const roundRows = await dbQuery(`
      SELECT ${roundSelectSql()}
        FROM venue_round
       WHERE status IN ('pending', 'open')
       ORDER BY round_date ASC
       LIMIT 1
    `);
    let activeRound = roundRows[0] || null;

    let venues = [];
    let backgrounds = [];
    let bookingMap = {};
    let bookedVenueLabel = '';
    let attentionChildren = [];
    let venueRecommendations = [];
    let layoutBoardWidth = 860;
    let layoutBoardHeight = 420;

    if (activeRound) {
      const nowText = chinaNowText();
      if (activeRound.status === 'pending' && nowText >= activeRound.open_time_text) {
        await dbQuery('UPDATE venue_round SET status = ? WHERE id = ? AND status = ?', ['open', activeRound.id, 'pending']);
        activeRound.status = 'open';
      }
      if (activeRound.close_time_text && nowText >= activeRound.close_time_text && activeRound.status === 'open') {
        await dbQuery('UPDATE venue_round SET status = ? WHERE id = ? AND status = ?', ['closed', activeRound.id, 'open']);
        activeRound = null;
      }
    }

    if (activeRound) {
      venues = hydrateVenueHotspots(await dbQuery('SELECT * FROM venues WHERE enabled = 1 ORDER BY sort_order ASC, id ASC'));
      backgrounds = normalizeBackgroundLayers(await loadVenueBackgrounds(true));
      const layout = applyLayoutBoardOffset(attachLayoutDefaults(venues), backgrounds);
      venues = layout.venues;
      backgrounds = layout.backgrounds;
      layoutBoardWidth = layout.boardWidth;
      layoutBoardHeight = layout.boardHeight;

      const venueIds = venues.map((venue) => venue.id);
      const elementsByVenue = await loadVenueElements(venueIds, true);
      const skillGuidesByVenue = await loadVenueSkillGuides(venueIds, true);
      const allBookingRows = venueIds.length
        ? await dbQuery(`
            SELECT vb.id, vb.venue_id, vb.class_id, vb.grade_pool, c.name AS class_name, c.grade_level
              FROM venue_bookings vb
              JOIN classes c ON c.id = vb.class_id
             WHERE vb.round_id = ?
               AND vb.status = 'confirmed'
               AND vb.venue_id IN (${venueIds.map(() => '?').join(', ')})
             ORDER BY vb.venue_id ASC, vb.grade_pool ASC, c.name ASC
          `, [activeRound.id, ...venueIds])
        : [];

      const bookingRowsByVenue = groupRowsByVenue(allBookingRows);
      const visiblePools = visiblePoolsForGrade(myGrade);

      venues.forEach((venue) => {
        const rows = bookingRowsByVenue[venue.id] || [];
        const smallRows = rows.filter((row) => row.grade_pool === 'small');
        const middleRows = rows.filter((row) => row.grade_pool === 'middle');
        const largeRows = rows.filter((row) => row.grade_pool === 'large');
        const visibleRows = rows.filter((row) => visiblePools.includes(row.grade_pool));

        venue.elements = elementsByVenue[venue.id] || [];
        venue.skillGuides = skillGuidesByVenue[venue.id] || [];
        venue._bookedSmall = smallRows.length;
        venue._bookedMiddle = middleRows.length;
        venue._bookedLarge = largeRows.length;
        venue._visibleBookings = visibleRows;
        venue._booked = visibleRows.length;
        venue._visibleCapacity = myGrade === 'small' ? venue.cap_small : venue.cap_middle + venue.cap_large;
        venue._myPoolBooked = myGrade === 'small'
          ? smallRows.length
          : myGrade === 'middle'
            ? middleRows.length
            : largeRows.length;
        venue._myPoolCapacity = venue[capField(myGrade)];
        venue._remainingVisible = Math.max(0, venue._visibleCapacity - venue._booked);
        venue._remainingMine = Math.max(0, venue._myPoolCapacity - venue._myPoolBooked);
        venue._full = venue._myPoolBooked >= venue._myPoolCapacity;
      });

      const myBookings = await dbQuery(
        `SELECT vb.id,
                vb.venue_id,
                v.name AS venue_name,
                v.sort_order
           FROM venue_bookings vb
           JOIN venues v ON v.id = vb.venue_id
          WHERE vb.round_id = ?
            AND vb.class_id = ?
            AND vb.status = 'confirmed'`,
        [activeRound.id, user.classId]
      );

      bookingMap = myBookings.reduce((accumulator, booking) => {
        accumulator[booking.venue_id] = booking;
        return accumulator;
      }, {});

      if (myBookings.length) {
        bookedVenueLabel = buildVenueBookingLabel(myBookings[0].venue_name, myBookings[0].sort_order);
      }

      if (venueRecommendationEnabled && !myBookings.length) {
        venueRecommendations = await buildVenueRecommendations({
          classId: user.classId,
          gradeLevel: myGrade,
          activeRound,
          venues
        });
      }

      const bookedVenueIds = myBookings.map((booking) => Number(booking.venue_id)).filter(Boolean);
      if (bookedVenueIds.length && visiblePools.length) {
        attentionChildren = await dbQuery(
          `SELECT DISTINCT ch.id, ch.name, ch.gender, ch.birth_date,
                  ch.attention_reason, ch.attention_start_date, ch.attention_end_date, ch.attention_tags, ch.attention_vest_type,
                  c.name AS class_name, c.grade_level, vb.venue_id,
                  v.name AS venue_name, v.sort_order
             FROM venue_bookings vb
             JOIN venues v ON v.id = vb.venue_id
             JOIN children ch ON ch.class_id = vb.class_id
             JOIN classes c ON c.id = ch.class_id
            WHERE vb.round_id = ?
              AND vb.status = 'confirmed'
              AND vb.venue_id IN (${bookedVenueIds.map(() => '?').join(', ')})
              AND vb.grade_pool IN (${visiblePools.map(() => '?').join(', ')})
              AND ch.enabled = 1
              AND ch.needs_attention = 1
              AND (ch.attention_start_date IS NULL OR ch.attention_start_date <= CURDATE())
              AND (ch.attention_end_date IS NULL OR ch.attention_end_date >= CURDATE())
            ORDER BY vb.venue_id ASC,
                     CASE c.grade_level WHEN 'small' THEN 1 WHEN 'middle' THEN 2 WHEN 'large' THEN 3 ELSE 99 END,
                     c.name ASC,
                     ch.name ASC`,
          [activeRound.id, ...bookedVenueIds, ...visiblePools]
        );
        attentionChildren = attentionChildren.slice().sort(compareAttentionChildren);
      }
    }

    const sceneAttentionRows = attentionChildren;
    const attentionReminderChildren = buildAttentionReminderChildren(sceneAttentionRows);

    res.render('user-venues', {
      ...baseView,
      venues,
      backgrounds,
      activeRound,
      bookingMap,
      venueRecommendations,
      venueRecommendationEnabled,
      bookedVenueLabel,
      myGrade,
      myGradeLabel,
      classId: user.classId,
      assignedClass: ownClassDashboard.assignedClass,
      ownClassChildren: ownClassDashboard.children,
      attentionChildren: attentionReminderChildren,
      attentionReminderChildren,
      sceneAttentionRows,
      layoutBoardWidth,
      layoutBoardHeight
    });
  }));

  app.post(['/user/attention/save', '/user/venues/attention/save'], userOnly, asyncHandler(async (req, res) => {
    const user = req.session.user;
    const childId = toNullableInt(req.body.childId);

    if (!user.classId || !childId) {
      return res.redirect(buildUserAttentionPageUrl('请选择本班幼儿后再保存重点关注'));
    }

    const rows = await dbQuery(
      'SELECT id, name FROM children WHERE id = ? AND class_id = ? AND enabled = 1 LIMIT 1',
      [childId, user.classId]
    );
    if (!rows.length) {
      return res.redirect(buildUserAttentionPageUrl('只能维护自己班级中启用状态的幼儿'));
    }

    const attentionReason = normalizeText(req.body.attentionReason);
    const attentionStartDate = normalizeDateInput(req.body.attentionStartDate) || chinaNowText().slice(0, 10);
    const attentionEndDateRaw = normalizeDateInput(req.body.attentionEndDate);
    const attentionEndDate = attentionEndDateRaw || null;
    const attentionTags = extractAttentionTags(req.body.attentionTags, req.body.attentionTagsExtra);
    const attentionVestType = normalizeAttentionVest(req.body.attentionVestType, 'yellow');

    if (attentionEndDate && attentionEndDate < attentionStartDate) {
      return res.redirect(buildUserAttentionPageUrl('结束日期不能早于开始日期'));
    }

    await dbQuery(
      `UPDATE children
          SET needs_attention = 1,
              attention_reason = ?,
              attention_start_date = ?,
              attention_end_date = ?,
              attention_tags = ?,
              attention_vest_type = ?
        WHERE id = ?
          AND class_id = ?`,
      [attentionReason || null, attentionStartDate, attentionEndDate, attentionTags || null, attentionVestType, childId, user.classId]
    );

    audit('user_child_attention_updated', {
      actor: req.session.user,
      action: '教师更新本班重点关注',
      target: rows[0].name,
      childId,
      childName: rows[0].name,
      attentionReason,
      attentionStartDate,
      attentionEndDate,
      attentionTags,
      attentionVestType,
      ip: req.ip
    });

    res.redirect(buildUserAttentionPageUrl(`${rows[0].name} 的重点关注信息已更新`));
  }));

  app.post(['/user/attention/clear', '/user/venues/attention/clear'], userOnly, asyncHandler(async (req, res) => {
    const user = req.session.user;
    const childId = toNullableInt(req.body.childId);

    if (!user.classId || !childId) {
      return res.redirect(buildUserAttentionPageUrl('参数错误'));
    }

    const rows = await dbQuery(
      'SELECT id, name FROM children WHERE id = ? AND class_id = ? AND enabled = 1 LIMIT 1',
      [childId, user.classId]
    );
    if (!rows.length) {
      return res.redirect(buildUserAttentionPageUrl('只能维护自己班级中启用状态的幼儿'));
    }

    await dbQuery(
      `UPDATE children
          SET needs_attention = 0,
              attention_reason = NULL,
              attention_start_date = NULL,
              attention_end_date = NULL,
              attention_tags = NULL,
              attention_vest_type = NULL
        WHERE id = ?
          AND class_id = ?`,
      [childId, user.classId]
    );

    audit('user_child_attention_cleared', {
      actor: req.session.user,
      action: '教师取消本班重点关注',
      target: rows[0].name,
      childId,
      childName: rows[0].name,
      ip: req.ip
    });

    res.redirect(buildUserAttentionPageUrl(`${rows[0].name} 已取消重点关注`));
  }));

  app.post('/user/venues/book', userOnly, asyncHandler(async (req, res) => {
    const user = req.session.user;
    const venueId = toNullableInt(req.body.venueId);
    const roundId = toNullableInt(req.body.roundId);

    if (!user.classId || !venueId || !roundId) {
      return res.redirect('/user/venues?message=' + encodeURIComponent('参数错误'));
    }

    const classRows = await dbQuery('SELECT id, name, grade_level FROM classes WHERE id = ? LIMIT 1', [user.classId]);
    if (!classRows.length) {
      return res.redirect('/user/venues?message=' + encodeURIComponent('班级不存在'));
    }
    const myGrade = classRows[0].grade_level;

    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [roundRows] = await connection.execute(
        `SELECT ${roundSelectSql()}
           FROM venue_round
          WHERE id = ?
          FOR UPDATE`,
        [roundId]
      );
      if (roundRows.length) {
        const nowText = chinaNowText();
        if (roundRows[0].status === 'pending' && nowText >= roundRows[0].open_time_text) {
          await connection.execute('UPDATE venue_round SET status = ? WHERE id = ? AND status = ?', ['open', roundId, 'pending']);
          roundRows[0].status = 'open';
        }
        if (roundRows[0].close_time_text && nowText >= roundRows[0].close_time_text && roundRows[0].status === 'open') {
          await connection.execute('UPDATE venue_round SET status = ? WHERE id = ? AND status = ?', ['closed', roundId, 'open']);
          roundRows[0].status = 'closed';
        }
      }
      if (!roundRows.length || roundRows[0].status !== 'open') {
        await connection.rollback();
        if (roundRows.length && roundRows[0].status === 'pending') {
          return res.redirect('/user/venues?message=' + encodeURIComponent('预约尚未开放，请等待倒计时结束'));
        }
        return res.redirect('/user/venues?message=' + encodeURIComponent('当前没有开放的预约'));
      }

      const nowText = chinaNowText();
      if (nowText < roundRows[0].open_time_text) {
        await connection.rollback();
        return res.redirect('/user/venues?message=' + encodeURIComponent('预约尚未开放'));
      }
      if (roundRows[0].close_time_text && nowText > roundRows[0].close_time_text) {
        await connection.rollback();
        return res.redirect('/user/venues?message=' + encodeURIComponent('预约已截止'));
      }

      const [venueRows] = await connection.execute('SELECT * FROM venues WHERE id = ? FOR UPDATE', [venueId]);
      if (!venueRows.length || !venueRows[0].enabled) {
        await connection.rollback();
        return res.redirect('/user/venues?message=' + encodeURIComponent('场地不存在'));
      }
      const venue = venueRows[0];

      const [existingBookingRows] = await connection.execute(
        `SELECT id, status
           FROM venue_bookings
          WHERE round_id = ?
            AND class_id = ?
          FOR UPDATE`,
        [roundId, user.classId]
      );
      const confirmedExistingBooking = existingBookingRows.find((booking) => booking.status === 'confirmed');
      const cancelledExistingBooking = existingBookingRows.find((booking) => booking.status === 'cancelled');
      if (confirmedExistingBooking) {
        await connection.rollback();
        return res.redirect('/user/venues?message=' + encodeURIComponent('您的班级本轮已预约了场地，请先取消才能更换'));
      }

      const capacityColumn = capField(myGrade);
      const maxCapacity = Number(venue[capacityColumn] || 0);
      const [countRows] = await connection.execute(
        `SELECT COUNT(*) AS cnt
           FROM venue_bookings
          WHERE round_id = ?
            AND venue_id = ?
            AND grade_pool = ?
            AND status = 'confirmed'`,
        [roundId, venueId, myGrade]
      );
      const booked = Number(countRows[0].cnt || 0);

      if (booked >= maxCapacity) {
        await connection.rollback();
        return res.redirect('/user/venues?message=' + encodeURIComponent(`该场地的${gradeLabel(myGrade)}名额已满`));
      }

      if (cancelledExistingBooking) {
        await connection.execute(
          `UPDATE venue_bookings
              SET venue_id = ?,
                  user_id = ?,
                  grade_pool = ?,
                  status = 'confirmed'
            WHERE id = ?
              AND round_id = ?
              AND class_id = ?
              AND status = 'cancelled'`,
          [venueId, user.id, myGrade, cancelledExistingBooking.id, roundId, user.classId]
        );
      } else {
        await connection.execute(
          `INSERT INTO venue_bookings (round_id, venue_id, class_id, user_id, grade_pool, status)
           VALUES (?, ?, ?, ?, ?, 'confirmed')`,
          [roundId, venueId, user.classId, user.id, myGrade]
        );
      }

      await connection.commit();
      const bookedVenueLabel = buildVenueBookingLabel(venue.name, venue.sort_order);
      audit('user_venue_booked', {
        actor: req.session.user,
        action: '教师预约场地',
        target: bookedVenueLabel,
        venueId,
        roundId,
        classId: user.classId,
        className: classRows[0].name,
        ip: req.ip,
        afterDetails: buildAuditSnapshot({
          venue: bookedVenueLabel,
          gradePool: gradeLabel(myGrade),
          roundDate: roundRows[0].round_date_text,
          className: classRows[0].name
        }, {
          venue: '预约模块',
          gradePool: '预约年级池',
          roundDate: '活动日期',
          className: '预约班级'
        })
      });
      res.redirect('/user/venues?message=' + encodeURIComponent(`预约成功：${bookedVenueLabel}`));
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return res.redirect('/user/venues?message=' + encodeURIComponent('您的班级本轮已有预约'));
      }
      console.error('Venue booking error:', error);
      res.redirect('/user/venues?message=' + encodeURIComponent('预约失败，请重试'));
    } finally {
      connection.release();
    }
  }));

  app.post('/user/venues/cancel', userOnly, asyncHandler(async (req, res) => {
    const user = req.session.user;
    const bookingId = toNullableInt(req.body.bookingId);
    if (!bookingId) {
      return res.redirect('/user/venues?message=' + encodeURIComponent('参数错误'));
    }

    const bookingRows = await dbQuery(`
      SELECT vb.id, vb.round_id, vb.class_id, vb.grade_pool, vb.status,
             DATE_FORMAT(vr.round_date, '%Y-%m-%d') AS round_date_text,
             c.name AS class_name,
             v.name AS venue_name,
             v.sort_order
        FROM venue_bookings vb
        JOIN venue_round vr ON vr.id = vb.round_id
        JOIN classes c ON c.id = vb.class_id
        JOIN venues v ON v.id = vb.venue_id
       WHERE vb.id = ?
         AND vb.class_id = ?
         AND vb.status = 'confirmed'
       LIMIT 1
    `, [bookingId, user.classId]);

    await dbQuery(
      `UPDATE venue_bookings
          SET status = 'cancelled'
        WHERE id = ?
          AND class_id = ?
          AND status = 'confirmed'`,
      [bookingId, user.classId]
    );

    if (bookingRows.length) {
      const booking = bookingRows[0];
      audit('user_venue_booking_cancelled', {
        actor: req.session.user,
        action: '教师取消场地预约',
        target: buildVenueBookingLabel(booking.venue_name, booking.sort_order),
        bookingId,
        roundId: booking.round_id,
        classId: booking.class_id,
        className: booking.class_name,
        ip: req.ip,
        changes: buildAuditChanges({
          status: '已确认'
        }, {
          status: '已取消'
        }, {
          status: '预约状态'
        }),
        afterDetails: buildAuditSnapshot({
          venue: buildVenueBookingLabel(booking.venue_name, booking.sort_order),
          gradePool: gradeLabel(booking.grade_pool),
          roundDate: booking.round_date_text,
          className: booking.class_name
        }, {
          venue: '预约模块',
          gradePool: '预约年级池',
          roundDate: '活动日期',
          className: '预约班级'
        })
      });
    }

    res.redirect('/user/venues?message=' + encodeURIComponent('已取消预约'));
  }));

  app.get('/api/venue-round/status', userOnly, asyncHandler(async (req, res) => {
    const rows = await dbQuery(`
      SELECT ${roundSelectSql()}
        FROM venue_round
       WHERE status IN ('pending', 'open')
       ORDER BY round_date ASC
       LIMIT 1
    `);

    if (!rows.length) {
      return res.json({ active: false });
    }

    const round = rows[0];
    const nowText = chinaNowText();

    if (round.status === 'pending' && nowText >= round.open_time_text) {
      await dbQuery('UPDATE venue_round SET status = ? WHERE id = ? AND status = ?', ['open', round.id, 'pending']);
      round.status = 'open';
    }

    if (round.close_time_text && nowText >= round.close_time_text && round.status === 'open') {
      await dbQuery('UPDATE venue_round SET status = ? WHERE id = ? AND status = ?', ['closed', round.id, 'open']);
      round.status = 'closed';
    }

    res.json({
      active: true,
      roundId: round.id,
      roundDate: round.round_date_text || round.round_date,
      openTime: round.open_time_text,
      closeTime: round.close_time_text,
      status: round.status,
      serverTime: Date.now()
    });
  }));
};
