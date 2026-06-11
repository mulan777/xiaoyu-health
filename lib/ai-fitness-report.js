/**
 * lib/ai-fitness-report.js
 * 把体测分析数据（avgScore / ratingSummary / radarChartData / metricNeedTrainingSummary / trendSummary 等）
 * 拼成 prompt，调用 ai-client 输出体质分析报告。
 */

const { chatCompletion, chatCompletionStream } = require('./ai-client');
const { getVenueKnowledge, buildKnowledgeBrief } = require('./venue-knowledge');

const METRIC_LABELS = {
  height: '身高',
  bmi: 'BMI',
  grip: '握力',
  longJump: '立定跳远',
  sitReach: '坐位体前屈',
  doubleJump: '双脚连续跳',
  obstacleRun: '15米绕障碍跑',
  balanceBeam: '走平衡木'
};

function safeNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function summarizeRadar(radarData) {
  if (!radarData || !Array.isArray(radarData.metrics) || !radarData.metrics.length) return '（暂无雷达数据）';
  const lines = radarData.metrics.map((m) => {
    const score = safeNum(m.score);
    return `- ${m.label || METRIC_LABELS[m.key] || m.key}：${score == null ? '暂无' : score + ' 分'}`;
  });
  return lines.join('\n');
}

function summarizeRatings(ratingSummary) {
  if (!Array.isArray(ratingSummary) || !ratingSummary.length) return '（暂无评级数据）';
  return ratingSummary.map((r) => `- ${r.label}：${r.count} 人（${r.percent}%）`).join('\n');
}

function summarizeNeedTraining(metricNeedTrainingSummary) {
  if (!Array.isArray(metricNeedTrainingSummary) || !metricNeedTrainingSummary.length) return '（暂无薄弱项分析）';
  return metricNeedTrainingSummary.map((item) => {
    const denom = item.denominator != null ? item.denominator : (item.total || 0);
    const names = (item.nameLinks || []).map((n) => n.name).slice(0, 6).join('、');
    return `- ${item.label}：薄弱人数 ${item.count}/${denom}（${item.percent || 0}%）${names ? '；典型：' + names : ''}`;
  }).join('\n');
}

// metric label 反查 metric key
const METRIC_LABEL_TO_KEY = {
  '握力': 'grip', '站定跳远': 'longJump', '立定跳远': 'longJump',
  '体前屈': 'sitReach', '坐位体前屈': 'sitReach',
  '双脚跳': 'doubleJump', '双脚连续跳': 'doubleJump',
  '障碍跑': 'obstacleRun', '15米绕障碍跑': 'obstacleRun',
  '平衡木': 'balanceBeam', '走平衡木': 'balanceBeam'
};

function extractWeakMetricKeys(metricNeedTrainingSummary) {
  if (!Array.isArray(metricNeedTrainingSummary)) return [];
  return metricNeedTrainingSummary
    .filter((m) => Number(m.percent) >= 15 || Number(m.count) >= 1)
    .map((m) => METRIC_LABEL_TO_KEY[m.label] || null)
    .filter(Boolean);
}

function summarizeTrend(trendSummary) {
  if (!Array.isArray(trendSummary) || !trendSummary.length) return '（暂无趋势数据）';
  const lines = trendSummary.map((t) => `- ${t.label || t.period}：平均分 ${t.avgScore == null ? '暂无' : t.avgScore}，样本 ${t.count || t.recordCount || 0} 人次`);
  // 补充一个“趋势概述”，为 AI 提供预加工信号
  const valid = trendSummary.filter((t) => t.avgScore != null);
  if (valid.length >= 2) {
    const first = Number(valid[0].avgScore);
    const last = Number(valid[valid.length - 1].avgScore);
    const max = valid.reduce((m, t) => Number(t.avgScore) > Number(m.avgScore) ? t : m);
    const min = valid.reduce((m, t) => Number(t.avgScore) < Number(m.avgScore) ? t : m);
    lines.push('');
    lines.push(`趋势提示：首末变化 ${(last - first).toFixed(1)} 分；高点 ${max.label}·${max.avgScore} 分；低点 ${min.label}·${min.avgScore} 分。`);
  }
  return lines.join('\n');
}

/**
 * 单个幼儿视角的报告 prompt
 */
function buildChildPrompt({ child, recentRecords, latest, knowledgeBrief, weakMetricLabels }) {
  const name = (child && child.name) || '该幼儿';
  const gender = (child && child.gender) || '未知';
  const className = (child && child.class_name) || (child && child.className) || '未知班级';
  const birth = (child && child.birth_date) ? String(child.birth_date).slice(0, 10) : '未知';
  const records = Array.isArray(recentRecords) ? recentRecords : [];

  const latestLine = latest
    ? `最新一次（${latest.test_date || '日期未知'}）：综合 ${latest.total_score == null ? '暂无' : latest.total_score} 分，评级 ${latest.rating || '暂无'}；身高 ${latest.height_cm || '-'} cm，BMI ${latest.bmi || '-'}，握力 ${latest.grip_kg || '-'}，立定跳远 ${latest.long_jump_cm || '-'}，体前屈 ${latest.sit_reach_cm || '-'}，双脚连续跳 ${latest.double_jump_sec || '-'}，绕障碍跑 ${latest.obstacle_run_sec || '-'}，走平衡木 ${latest.balance_beam_sec || '-'}`
    : '尚无体测记录。';

  const historyLines = records.slice(0, 5).map((r) => {
    return `- ${r.test_date || '-'}：综合 ${r.total_score == null ? '-' : r.total_score} 分，评级 ${r.rating || '-'}`;
  }).join('\n') || '（暂无历史记录）';

  const trendBlock = (() => {
    const valid = records.filter((r) => r.total_score != null);
    if (valid.length < 2) return '（仅一次记录，暂无趋势变化可供参考）';
    const sorted = valid.slice().sort((a, b) => new Date(a.test_date) - new Date(b.test_date));
    return sorted.map((r) => `- ${r.test_date || '-'}：${r.total_score} 分`).join('\n');
  })();

  return [
    `请基于以下幼儿体测数据，生成一份个性化体质分析与训练建议报告。`,
    ``,
    `【幼儿基本信息】`,
    `- 姓名：${name}`,
    `- 性别：${gender}`,
    `- 班级：${className}`,
    `- 出生日期：${birth}`,
    ``,
    `【最近体测情况】`,
    latestLine,
    ``,
    `【历史体测记录】`,
    historyLines,
    ``,
    `【趋势波形】`,
    trendBlock,
    ``,
    knowledgeBrief ? '【园所可用训练资源（请严格仅引用以下模块与技能名称，不要虚构）】\n' + knowledgeBrief + '\n' : '',
    `请输出以下五个部分（用 Markdown 二级标题）：`,
    `## 一、体质画像总结`,
    `## 二、亮点与优势`,
    `## 三、趋势波形解读（结合历次得分变化说明进步点与需加强点）`,
    `## 四、场地训练推荐（根据薄弱项${weakMetricLabels && weakMetricLabels.length ? '（' + weakMetricLabels.join('、') + '）' : ''}推荐去哪个模块、玩哪些技能/游戏、使用什么器械，严格只能引用上面【园所可用训练资源】中的名称）`,
    `## 五、给家长的一段话（≤120字，可转发家长群）`,
    ``,
    `要求：使用安全、适龄（3-6 岁）的语言；不出现医学诊断；不要编造数据，只基于上述事实推断；场地推荐部分请明确写出“去 {模块名} 玩 {技能}”这样的具体句式。`
  ].filter(Boolean).join('\n');
}

/**
 * 班级 / 年级 / 全园视角的报告 prompt
 */
function buildScopePrompt({ scope, scopeLabel, avgScore, ratingSummary, radarChartData, metricNeedTrainingSummary, trendSummary, recordsCount, knowledgeBrief, weakMetricLabels }) {
  const radarBlock = (() => {
    if (!radarChartData) return '（暂无雷达数据）';
    const series = Array.isArray(radarChartData.dataSeries || radarChartData.series) ? (radarChartData.dataSeries || radarChartData.series) : null;
    if (!series || !series.length) return summarizeRadar(radarChartData);
    return series.map((s) => {
      const values = (s.values || s.data || []).map((v) => v == null ? '暂无' : v).join(' / ');
      return `- ${s.label || s.name || '系列'}：${values}`;
    }).join('\n') + '\n（雷达指标顺序：' + ((radarChartData.metrics || []).map((m) => m.label || METRIC_LABELS[m.key] || m.key).join(' / ')) + '）';
  })();

  return [
    `请基于以下幼儿体测群体数据，生成一份面向幼儿园教师与园所管理者的体质分析与训练改进建议报告。`,
    ``,
    `【分析范围】${scopeLabel || scope || '全园'}`,
    `【样本数量】${recordsCount || 0} 条体测记录`,
    `【综合平均分】${avgScore == null || avgScore === '' ? '暂无' : avgScore}`,
    ``,
    `【评级分布】`,
    summarizeRatings(ratingSummary),
    ``,
    `【六维雷达图】`,
    radarBlock,
    ``,
    `【各项目薄弱情况】`,
    summarizeNeedTraining(metricNeedTrainingSummary),
    ``,
    `【时间趋势波形】`,
    summarizeTrend(trendSummary),
    ``,
    knowledgeBrief ? '【园所可用训练资源（请严格仅引用以下模块与技能名称，不要虚构）】\n' + knowledgeBrief + '\n' : '',
    `请输出以下五个部分（Markdown 二级标题）：`,
    `## 一、整体体质评估`,
    `## 二、亮点项目与可推广做法`,
    `## 三、趋势波形解读（结合多期平均分变化、高点低点，评价进步与风险）`,
    `## 四、场地训练改进建议`,
    `   - 针对每个薄弱项${weakMetricLabels && weakMetricLabels.length ? '（当前薄弱：' + weakMetricLabels.join('、') + '）' : ''}请明确写出“推荐去 {模块名} 开展 {技能名}，使用 {器械}”。`,
    `   - 仅能引用上面【园所可用训练资源】中的名称，不要凭空虚构模块。`,
    `   - 需含单次时长、每周频次、教师组织要点。`,
    `## 五、对家长的沟通话术（一段话，≤150字，可粘贴到家长群）`,
    ``,
    `要求：适用于学龄前 3-6 岁幼儿；不出现医学诊断；不编造数据；语气温和、专业、易懂。`
  ].filter(Boolean).join('\n');
}

async function generateReport(payload) {
  const enriched = await enrichPayloadWithKnowledge(payload || {});
  const userPrompt = enriched.kind === 'child' ? buildChildPrompt(enriched) : buildScopePrompt(enriched);
  return chatCompletion({ userPrompt });
}

async function* generateReportStream(payload) {
  const enriched = await enrichPayloadWithKnowledge(payload || {});
  const userPrompt = enriched.kind === 'child' ? buildChildPrompt(enriched) : buildScopePrompt(enriched);
  for await (const piece of chatCompletionStream({ userPrompt })) {
    if (typeof piece === 'string') yield { type: 'content', content: piece };
    else if (piece && piece.content) yield piece;
  }
}

async function enrichPayloadWithKnowledge(payload) {
  const out = Object.assign({}, payload);
  let weakKeys = [];
  let weakLabels = [];
  if (Array.isArray(payload.metricNeedTrainingSummary)) {
    weakKeys = extractWeakMetricKeys(payload.metricNeedTrainingSummary);
    weakLabels = payload.metricNeedTrainingSummary
      .filter((m) => Number(m.percent) >= 15 || Number(m.count) >= 1)
      .map((m) => m.label).filter(Boolean);
  } else if (payload.kind === 'child' && payload.latest) {
    // 个人视角：看最新一次哪几项 < 60 分
    const f = payload.latest;
    const map = [
      ['grip_score', '握力', 'grip'],
      ['jump_score', '立定跳远', 'longJump'],
      ['sit_score', '体前屈', 'sitReach'],
      ['djump_score', '双脚跳', 'doubleJump'],
      ['obstacle_score', '障碍跑', 'obstacleRun'],
      ['balance_score', '平衡木', 'balanceBeam']
    ];
    for (const [field, label, key] of map) {
      const v = f && f[field];
      if (v != null && Number(v) < 80) {
        weakKeys.push(key);
        weakLabels.push(label);
      }
    }
  }
  try {
    const knowledge = await getVenueKnowledge(false);
    out.knowledgeBrief = buildKnowledgeBrief(knowledge, weakKeys);
  } catch (err) {
    out.knowledgeBrief = '';
  }
  out.weakMetricLabels = weakLabels;
  return out;
}

module.exports = {
  generateReport,
  generateReportStream,
  buildScopePrompt,
  buildChildPrompt
};
