/**
 * name-masking.js — 幼儿姓名展示脱敏（2026-09-17）
 * 规则（与智慧校园刷卡/家长访谈口径一致）：
 *   默认：末字打星            付博静 -> 付博*
 *   同班末字星撞车：该组改中间星  朱瑾瑜/朱瑾言 -> 朱*瑜 / 朱*言
 *   中间星仍撞：该组显示全名（极端兜底）
 * 只影响展示层；数据库、导入导出、业务逻辑仍用全名。
 */

function normalizeStudentName(value) {
  return String(value == null ? '' : value).replace(/[\s\u00a0]/g, '');
}

function maskNameTail(value) {
  const name = normalizeStudentName(value);
  return name ? name.slice(0, -1) + '*' : '*';
}

function maskNameMiddle(value) {
  const name = normalizeStudentName(value);
  if (!name) return '*';
  if (name.length <= 1) return '*';
  if (name.length === 2) return name[0] + '*';
  return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1];
}

/**
 * 构建「班级\u0001全名 -> 展示名」映射
 * @param {Array<{class_name: string, name: string}>} rows 全园在册幼儿（class_name+name）
 */
function buildDisplayMap(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const cls = String((row && row.class_name) || '');
    const nm = normalizeStudentName(row && row.name);
    if (!cls || !nm) continue;
    if (!groups.has(cls)) groups.set(cls, new Set());
    groups.get(cls).add(nm);
  }
  const map = new Map();
  for (const [cls, names] of groups) {
    const tail = new Map();
    for (const nm of names) {
      const m = maskNameTail(nm);
      if (!tail.has(m)) tail.set(m, []);
      tail.get(m).push(nm);
    }
    for (const [masked, list] of tail) {
      if (list.length === 1) {
        map.set(cls + '\u0001' + list[0], masked);
        continue;
      }
      // 末字星撞车 → 组内改中间星
      const mid = new Map();
      for (const nm of list) {
        const mm = maskNameMiddle(nm);
        if (!mid.has(mm)) mid.set(mm, []);
        mid.get(mm).push(nm);
      }
      for (const [mm, ns] of mid) {
        for (const nm of ns) map.set(cls + '\u0001' + nm, ns.length === 1 ? mm : nm);
      }
    }
  }
  return map;
}

module.exports = { normalizeStudentName, maskNameTail, maskNameMiddle, buildDisplayMap };
