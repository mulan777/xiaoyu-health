const path = require('path');
const XLSX = require('xlsx');

const TABLE_DIR = path.join(__dirname, '..', 'biao');

const WEIGHTS = {
  height: 0.20,
  bmi: 0.10,
  grip: 0.10,
  longJump: 0.10,
  sitReach: 0.10,
  doubleJump: 0.15,
  obstacleRun: 0.10,
  balanceBeam: 0.15
};

function readSheetRows(filename) {
  const workbook = XLSX.readFile(path.join(TABLE_DIR, filename));
  return XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    raw: false,
    defval: ''
  });
}

function rowText(row = []) {
  return row.map((value) => String(value || '').trim()).filter(Boolean).join(' ');
}

function nonEmptyCells(row = []) {
  return row
    .map((value, index) => [index, String(value || '').trim()])
    .filter(([, value]) => value);
}

function findTableStart(rows, pattern, label) {
  const index = rows.findIndex((row) => pattern.test(rowText(row)));
  if (index === -1) {
    throw new Error(`未找到评分表：${label}`);
  }
  return index;
}

function findTableEnd(rows, titleRow) {
  for (let index = titleRow + 1; index < rows.length; index += 1) {
    if (/^表\s*\d+[-－]\d+/.test(rowText(rows[index]))) {
      return index;
    }
  }
  return rows.length;
}

function normalizeGender(gender) {
  return gender === '女' ? '女' : '男';
}

function normalizeHalfYearAgeKey(label) {
  const text = String(label || '').replace(/\s+/g, '');
  if (!text) return null;
  if (text.includes('3.5')) return '3.5';
  if (text.includes('4.5')) return '4.5';
  if (text.includes('5.5')) return '5.5';
  if (text.includes('6.5')) return '6.5';
  if (text.includes('6.0') || text.includes('6岁')) return '6';
  const match = text.match(/(\d+(?:\.\d+)?)岁/);
  return match ? String(Number(match[1])) : null;
}

function normalizeBmiAgeKey(label) {
  const text = String(label || '').replace(/\s+/g, '');
  const monthMatch = text.match(/(\d+)月/);
  if (monthMatch) return Number(monthMatch[1]);
  if (text.includes('6.5')) return 78;
  if (text.includes('6.0') || text.includes('6岁')) return 72;
  return null;
}

function extractScore(label) {
  const match = String(label || '').match(/(\d+)\s*分/);
  return match ? Number(match[1]) : null;
}

function parseRangeRule(value) {
  const text = String(value || '')
    .replace(/\s+/g, '')
    .replace(/,/g, '')
    .replace(/[–—]/g, '-');
  if (!text) return null;

  if (text.startsWith('≤')) return { kind: 'lte', value: Number(text.slice(1)) };
  if (text.startsWith('≥')) return { kind: 'gte', value: Number(text.slice(1)) };
  if (text.startsWith('<')) return { kind: 'lt', value: Number(text.slice(1)) };
  if (text.startsWith('>')) return { kind: 'gt', value: Number(text.slice(1)) };

  const rangeMatch = text.match(/^(-?\d+(?:\.\d+)?)\-(-?\d+(?:\.\d+)?)$/);
  if (rangeMatch) {
    const first = Number(rangeMatch[1]);
    const second = Number(rangeMatch[2]);
    return {
      kind: 'range',
      min: Math.min(first, second),
      max: Math.max(first, second)
    };
  }

  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    return { kind: 'eq', value: Number(text) };
  }

  return null;
}

function matchesRule(value, rule) {
  if (value == null || !rule) return false;
  switch (rule.kind) {
    case 'lt':
      return value < rule.value;
    case 'lte':
      return value <= rule.value;
    case 'gt':
      return value > rule.value;
    case 'gte':
      return value >= rule.value;
    case 'eq':
      return value === rule.value;
    case 'range':
      return value >= rule.min && value <= rule.max;
    default:
      return false;
  }
}

function parseAgeScoreTable(rows, pattern, label) {
  const titleRow = findTableStart(rows, pattern, label);
  const headerCells = nonEmptyCells(rows[titleRow + 1])
    .slice(1)
    .map(([index, rawLabel]) => ({ index, ageKey: normalizeHalfYearAgeKey(rawLabel) }))
    .filter((item) => item.ageKey);

  const table = {};
  for (const item of headerCells) {
    table[item.ageKey] = [];
  }

  const endRow = findTableEnd(rows, titleRow);
  for (let rowIndex = titleRow + 2; rowIndex < endRow; rowIndex += 1) {
    const cells = nonEmptyCells(rows[rowIndex]);
    const score = extractScore(cells[0]?.[1]);
    if (score == null) continue;

    for (const { index, ageKey } of headerCells) {
      const rule = parseRangeRule(rows[rowIndex][index]);
      if (rule) table[ageKey].push({ score, rule });
    }
  }

  return table;
}

function parseBmiTable(rows, pattern, label) {
  const titleRow = findTableStart(rows, pattern, label);
  const scoreColumns = nonEmptyCells(rows[titleRow + 1])
    .slice(1)
    .map(([index, rawLabel]) => ({ index, score: extractScore(rawLabel) }))
    .filter((item) => item.score != null);

  const table = {};
  const endRow = findTableEnd(rows, titleRow);

  for (let rowIndex = titleRow + 2; rowIndex < endRow; rowIndex += 1) {
    const cells = nonEmptyCells(rows[rowIndex]);
    const ageKey = normalizeBmiAgeKey(cells[0]?.[1]);
    if (ageKey == null) continue;

    table[ageKey] = scoreColumns
      .map(({ index, score }) => {
        const rule = parseRangeRule(rows[rowIndex][index]);
        return rule ? { score, rule } : null;
      })
      .filter(Boolean);
  }

  return table;
}

function loadAgeScoreWorkbook(filename, malePattern, femalePattern) {
  const rows = readSheetRows(filename);
  return {
    男: parseAgeScoreTable(rows, malePattern, `${filename} 男`),
    女: parseAgeScoreTable(rows, femalePattern, `${filename} 女`)
  };
}

function loadStandardTables() {
  const bodyRows = readSheetRows('BMI 评分表.xlsx');

  return {
    height: {
      男: parseAgeScoreTable(bodyRows, /男性幼儿身高评分表/, '身高评分表 男'),
      女: parseAgeScoreTable(bodyRows, /女性幼儿身高评分表/, '身高评分表 女')
    },
    bmi: {
      男: parseBmiTable(bodyRows, /男性幼儿\s*BMI\s*评分表/, 'BMI 评分表 男'),
      女: parseBmiTable(bodyRows, /女性幼儿\s*BMI\s*评分表/, 'BMI 评分表 女')
    },
    grip: loadAgeScoreWorkbook('握力评分.xlsx', /男性幼儿握力评分表/, /女性幼儿握力评分表/),
    longJump: loadAgeScoreWorkbook('立定跳远评分.xlsx', /男性幼儿立定跳远评分表/, /女性幼儿立定跳远评分表/),
    sitReach: loadAgeScoreWorkbook('坐位体前屈评分.xlsx', /男性.*坐位体前屈评分表/, /女性.*坐位体前屈评分表/),
    doubleJump: loadAgeScoreWorkbook('双脚连续跳评分.xlsx', /男性幼儿双脚连续跳评分表/, /女性幼儿双脚连续跳评分表/),
    obstacleRun: loadAgeScoreWorkbook('15 米绕障碍跑评分.xlsx', /男性幼儿\s*15\s*米绕障碍跑评分表/, /女性幼儿\s*15\s*米绕障碍跑评分表/),
    balanceBeam: loadAgeScoreWorkbook('走平衡木评分.xlsx', /男性幼儿走平衡木评分表/, /女性幼儿走平衡木评分表/)
  };
}

let SCORE_TABLES = {};
try {
  SCORE_TABLES = loadStandardTables();
} catch (err) {
  console.error('⚠️ 体测评分表加载失败（服务仍可运行，但评分功能不可用）:', err.message);
}

function resolveHalfYearAgeKey(monthAge) {
  if (monthAge == null) return null;
  if (monthAge < 42) return '3';
  if (monthAge < 48) return '3.5';
  if (monthAge < 54) return '4';
  if (monthAge < 60) return '4.5';
  if (monthAge < 66) return '5';
  if (monthAge < 72) return '5.5';
  return '6';
}

function resolveBmiAgeKey(monthAge) {
  if (monthAge == null) return null;
  if (monthAge <= 36) return 36;
  if (monthAge <= 71) return monthAge;
  if (monthAge < 78) return 72;
  return 78;
}

function scoreByRules(value, rules) {
  if (value == null || !rules || !rules.length) return null;
  for (const item of rules) {
    if (matchesRule(value, item.rule)) return item.score;
  }
  return null;
}

function scoreHalfYearMetric(value, gender, monthAge, metricKey) {
  const g = normalizeGender(gender);
  const ageKey = resolveHalfYearAgeKey(monthAge);
  return scoreByRules(value, SCORE_TABLES[metricKey]?.[g]?.[ageKey]);
}

function scoreTimedMetric(value, gender, monthAge, metricKey) {
  if (value == null) return null;
  if (value <= 0) return 0;
  return scoreHalfYearMetric(value, gender, monthAge, metricKey);
}

function scoreHeight(heightCm, gender, monthAge) {
  return scoreHalfYearMetric(heightCm, gender, monthAge, 'height');
}

function scoreBMI(bmi, gender, monthAge) {
  const g = normalizeGender(gender);
  const ageKey = resolveBmiAgeKey(monthAge);
  return scoreByRules(bmi, SCORE_TABLES.bmi?.[g]?.[ageKey]);
}

function computeRating(totalScore) {
  if (totalScore == null) return null;
  if (totalScore >= 83) return '优秀';
  if (totalScore >= 75) return '良好';
  if (totalScore >= 60) return '合格';
  return '不合格';
}

function roundMetric(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(1));
}

function computeFitnessResult(data, gender, monthAge) {
  const normalized = {
    heightCm: roundMetric(data.heightCm),
    weightKg: roundMetric(data.weightKg),
    gripKg: roundMetric(data.gripKg),
    longJumpCm: roundMetric(data.longJumpCm),
    sitReachCm: roundMetric(data.sitReachCm),
    doubleJumpSec: roundMetric(data.doubleJumpSec),
    obstacleRunSec: roundMetric(data.obstacleRunSec),
    balanceBeamSec: roundMetric(data.balanceBeamSec)
  };

  const bmi = (normalized.heightCm && normalized.weightKg)
    ? Number((normalized.weightKg / Math.pow(normalized.heightCm / 100, 2)).toFixed(1))
    : null;

  const scores = {
    height: scoreHeight(normalized.heightCm, gender, monthAge),
    bmi: scoreBMI(bmi, gender, monthAge),
    grip: scoreHalfYearMetric(normalized.gripKg, gender, monthAge, 'grip'),
    longJump: scoreHalfYearMetric(normalized.longJumpCm, gender, monthAge, 'longJump'),
    sitReach: scoreHalfYearMetric(normalized.sitReachCm, gender, monthAge, 'sitReach'),
    doubleJump: scoreTimedMetric(normalized.doubleJumpSec, gender, monthAge, 'doubleJump'),
    obstacleRun: scoreTimedMetric(normalized.obstacleRunSec, gender, monthAge, 'obstacleRun'),
    balanceBeam: scoreTimedMetric(normalized.balanceBeamSec, gender, monthAge, 'balanceBeam')
  };

  const scoreKeys = Object.keys(WEIGHTS);
  const hasAllScores = scoreKeys.every((key) => scores[key] != null);
  const totalScore = hasAllScores
    ? Number(scoreKeys.reduce((sum, key) => sum + scores[key] * WEIGHTS[key], 0).toFixed(1))
    : null;

  return {
    bmi,
    scores,
    totalScore,
    rating: computeRating(totalScore)
  };
}

module.exports = {
  WEIGHTS,
  scoreHeight,
  scoreBMI,
  computeRating,
  computeFitnessResult
};
