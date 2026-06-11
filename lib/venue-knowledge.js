/**
 * lib/venue-knowledge.js
 * 从 venues + venue_skill_guides 数据库读取场地训练知识，
 * 解析每条技能对应的体测桥接指标，提供：
 *   - getVenueKnowledge() —— 全量结构化数据
 *   - buildScopedRecommendation(weakKeys) —— 给定薄弱项 metric key 列表，
 *       返回可作为 AI Prompt 的"推荐场地+技能"片段
 *
 * METRIC_KEYS 与 lib/fitness-analytics.js 保持一致：
 *   grip / longJump / sitReach / doubleJump / obstacleRun / balanceBeam
 *   另外加一个泛指 "comprehensive" 处理 "综合体能"
 */

const { dbQuery } = require('./db');

// 体测项目识别词 -> metric key
const METRIC_PATTERNS = [
  { key: 'grip', label: '握力', re: /握力|手臂力量|抓握|悬吊|抓杠/ },
  { key: 'longJump', label: '立定跳远', re: /立定跳远/ },
  { key: 'sitReach', label: '坐位体前屈', re: /坐位体前屈|体前屈|柔韧/ },
  { key: 'doubleJump', label: '双脚连续跳', re: /双脚连续跳|连续跳|双脚跳/ },
  { key: 'obstacleRun', label: '15米绕障碍跑', re: /绕障碍跑|障碍跑|15米/ },
  { key: 'balanceBeam', label: '走平衡木', re: /走平衡木|平衡木|平衡/ },
  { key: 'comprehensive', label: '综合体能', re: /综合体能|综合素质/ }
];

function detectMetrics(text) {
  const hit = new Set();
  if (!text) return [];
  for (const p of METRIC_PATTERNS) {
    if (p.re.test(text)) hit.add(p.key);
  }
  return Array.from(hit);
}

function cleanMultiline(text, max = 0) {
  if (!text) return '';
  let s = String(text).replace(/\r\n/g, '\n').trim();
  if (max && s.length > max) s = s.slice(0, max) + '…';
  return s;
}

function flattenSkillNames(text) {
  if (!text) return [];
  return String(text).split(/\n+/).map((line) => line.replace(/^[\s\d.、)）]+/, '').trim()).filter(Boolean);
}

function flattenEquipment(text) {
  if (!text) return [];
  return String(text).split(/[，,、\n]+/).map((s) => s.trim()).filter(Boolean);
}

let cache = null;
let cacheAt = 0;
const CACHE_TTL = 60 * 1000;

async function getVenueKnowledge(force = false) {
  const now = Date.now();
  if (!force && cache && (now - cacheAt) < CACHE_TTL) return cache;

  const venues = await dbQuery(`SELECT id, name, equipment, skill_tags, sort_order FROM venues WHERE enabled = 1 ORDER BY sort_order, id`);
  const guides = await dbQuery(`SELECT id, venue_id, title,
       basic_skill_names, basic_equipment, basic_action_points, basic_safety_points,
       advanced_skill_names, advanced_equipment, advanced_action_points, advanced_safety_points,
       extra_skill_names, extra_equipment, bridge_indicators, sort_order
    FROM venue_skill_guides WHERE enabled = 1 ORDER BY venue_id, sort_order, id`);

  const venueMap = new Map();
  for (const v of venues) {
    venueMap.set(v.id, {
      id: v.id,
      name: v.name,
      equipment: v.equipment ? flattenEquipment(v.equipment) : [],
      skillTags: v.skill_tags ? flattenEquipment(v.skill_tags) : [],
      guides: []
    });
  }

  // 把 metric -> [ {venue, guide, levelText} ] 也聚合一份
  const byMetric = {};
  for (const p of METRIC_PATTERNS) byMetric[p.key] = [];

  for (const g of guides) {
    const venue = venueMap.get(g.venue_id);
    if (!venue) continue;
    const basicSkills = flattenSkillNames(g.basic_skill_names);
    const advancedSkills = flattenSkillNames(g.advanced_skill_names);
    const extraSkills = flattenSkillNames(g.extra_skill_names);
    const equipment = Array.from(new Set([
      ...flattenEquipment(g.basic_equipment),
      ...flattenEquipment(g.advanced_equipment),
      ...flattenEquipment(g.extra_equipment)
    ]));
    const bridgeText = cleanMultiline(g.bridge_indicators);
    const metricKeys = detectMetrics(bridgeText + ' ' + (g.title || ''));

    const guideEntry = {
      id: g.id,
      venueId: g.venue_id,
      venueName: venue.name,
      title: g.title,
      basicSkills,
      advancedSkills,
      extraSkills,
      equipment,
      bridgeText,
      metricKeys,
      basicActionPoints: cleanMultiline(g.basic_action_points, 200),
      advancedActionPoints: cleanMultiline(g.advanced_action_points, 200),
      safetyPoints: cleanMultiline(g.basic_safety_points || g.advanced_safety_points, 200)
    };
    venue.guides.push(guideEntry);
    for (const mk of metricKeys) {
      if (!byMetric[mk]) byMetric[mk] = [];
      byMetric[mk].push(guideEntry);
    }
  }

  cache = {
    venues: Array.from(venueMap.values()),
    guides,
    byMetric,
    metricLabels: Object.fromEntries(METRIC_PATTERNS.map((p) => [p.key, p.label]))
  };
  cacheAt = now;
  return cache;
}

/**
 * 给定薄弱项 metric keys，构造推荐用的 prompt 片段（Markdown 块）
 * 同时附上"全部模块 + 技能 + 器械"的清单，让 AI 在写"场地推荐章节"时有素材可引用。
 */
function buildKnowledgeBrief(knowledge, weakMetricKeys = []) {
  const lines = [];
  // 1. 模块全景
  lines.push('### 园所现有训练模块（数据库实录，以下信息均为真实数据）');
  for (const v of knowledge.venues) {
    if (!v.guides.length) continue;
    lines.push(`- **${v.name}** ：包含 ${v.guides.length} 类技能 → ${v.guides.map((g) => g.title).join(' / ')}`);
  }
  // 2. 各技能详情（控制 token，长度截断）
  lines.push('\n### 模块技能与器械明细');
  for (const v of knowledge.venues) {
    if (!v.guides.length) continue;
    lines.push(`#### ${v.name}`);
    for (const g of v.guides) {
      const basics = g.basicSkills.length ? `基础：${g.basicSkills.join('、')}` : '';
      const advs = g.advancedSkills.length ? `进阶：${g.advancedSkills.join('、')}` : '';
      const extras = g.extraSkills.length ? `拓展：${g.extraSkills.join('、')}` : '';
      const eq = g.equipment.length ? `器械：${g.equipment.join('、')}` : '';
      const tag = g.metricKeys.length ? `对应体测：${g.metricKeys.map((k) => knowledge.metricLabels[k] || k).join('、')}` : '';
      const detail = [basics, advs, extras, eq, tag].filter(Boolean).join('；');
      lines.push(`- **${g.title}**：${detail}`);
    }
  }

  // 3. 针对薄弱项的"模块→技能"映射（重点强调）
  const interesting = (weakMetricKeys || []).filter((k) => knowledge.byMetric[k] && knowledge.byMetric[k].length);
  if (interesting.length) {
    lines.push('\n### 针对当前薄弱项目的可推荐训练（来自数据库桥接关系）');
    for (const mk of interesting) {
      const label = knowledge.metricLabels[mk] || mk;
      lines.push(`- **${label}** → 推荐前往：`);
      const seen = new Set();
      for (const g of knowledge.byMetric[mk]) {
        const key = g.venueName + '|' + g.title;
        if (seen.has(key)) continue;
        seen.add(key);
        const skills = [...g.basicSkills, ...g.advancedSkills].slice(0, 4).join('、');
        const eq = g.equipment.slice(0, 3).join('、');
        lines.push(`  · ${g.venueName} ${g.title}${skills ? '（动作：' + skills + '）' : ''}${eq ? '（器械：' + eq + '）' : ''}`);
      }
    }
  }
  return lines.join('\n');
}

module.exports = {
  getVenueKnowledge,
  buildKnowledgeBrief,
  METRIC_PATTERNS
};
