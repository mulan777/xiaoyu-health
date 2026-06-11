const FITNESS_METRICS = [
  { key: 'grip', label: '握力', scoreField: 'grip_score' },
  { key: 'longJump', label: '跳远', scoreField: 'jump_score' },
  { key: 'sitReach', label: '体前屈', scoreField: 'sit_score' },
  { key: 'doubleJump', label: '双脚跳', scoreField: 'djump_score' },
  { key: 'obstacleRun', label: '障碍跑', scoreField: 'obstacle_score' },
  { key: 'balanceBeam', label: '平衡木', scoreField: 'balance_score' }
];

const RATING_LABELS = ['优秀', '良好', '合格', '不合格'];

const RADAR_BENCHMARK_SERIES = [
  { key: 'pass', label: '合格', value: 60, color: '#f59e0b', fillColor: 'transparent', dasharray: '7 5', visible: false },
  { key: 'good', label: '良好', value: 75, color: '#2563eb', fillColor: 'transparent', dasharray: '7 5', visible: false },
  { key: 'excellent', label: '优秀', value: 83, color: '#22c55e', fillColor: 'transparent', dasharray: '7 5', visible: false }
];

function buildFitnessSummaries(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const nameLinkBuilder = typeof options.nameLinkBuilder === 'function' ? options.nameLinkBuilder : null;
  const narrativeBuilder = typeof options.narrativeBuilder === 'function'
    ? options.narrativeBuilder
    : function defaultNarrative(label, percent, total) {
      return total
        ? `${label}项目有 ${percent}% 的幼儿需要持续加强训练`
        : `${label}项目暂无有效数据`;
    };

  let avgScore = null;
  const ratingCounts = Object.fromEntries(RATING_LABELS.map((label) => [label, 0]));
  const metricNeedTrainingCounts = Object.fromEntries(FITNESS_METRICS.map((metric) => [metric.key, 0]));
  const metricNeedTrainingDenominators = Object.fromEntries(FITNESS_METRICS.map((metric) => [metric.key, 0]));
  const metricNeedTrainingNames = Object.fromEntries(FITNESS_METRICS.map((metric) => [metric.key, new Set()]));

  if (list.length) {
    const validScores = list.filter((item) => item.total_score != null);
    if (validScores.length) {
      avgScore = (validScores.reduce((sum, item) => sum + Number(item.total_score), 0) / validScores.length).toFixed(1);
    }

    for (const item of list) {
      if (item.rating && Object.prototype.hasOwnProperty.call(ratingCounts, item.rating)) {
        ratingCounts[item.rating] += 1;
      }

      for (const metric of FITNESS_METRICS) {
        const metricScore = item[metric.scoreField];
        if (metricScore == null || metricScore === '') continue;
        metricNeedTrainingDenominators[metric.key] += 1;
        if (Number(metricScore) < 60) {
          metricNeedTrainingCounts[metric.key] += 1;
          if (item.child_name) metricNeedTrainingNames[metric.key].add(item.child_name);
        }
      }
    }
  }

  const ratingSummary = RATING_LABELS.map((label) => {
    const count = ratingCounts[label] || 0;
    const percent = list.length ? ((count / list.length) * 100).toFixed(1) : '0.0';
    return { label, count, percent };
  });

  const metricNeedTrainingSummary = FITNESS_METRICS.map((metric) => {
    const count = metricNeedTrainingCounts[metric.key] || 0;
    const total = metricNeedTrainingDenominators[metric.key] || 0;
    const percent = total ? ((count / total) * 100).toFixed(1) : '0.0';
    const names = Array.from(metricNeedTrainingNames[metric.key] || []);
    return {
      key: metric.key,
      label: metric.label,
      count,
      total,
      percent,
      names,
      namesText: names.length ? names.join('、') : '暂无',
      nameLinks: nameLinkBuilder
        ? names.map((name) => ({
          name,
          href: nameLinkBuilder(metric.key, name)
        }))
        : [],
      narrative: narrativeBuilder(metric.label, percent, total)
    };
  });

  const metricHealthSummary = metricNeedTrainingSummary.map((item) => ({
    key: item.key,
    label: item.label,
    score: Number((100 - Number(item.percent || 0)).toFixed(1))
  }));

  return {
    avgScore,
    ratingCounts,
    ratingSummary,
    metricNeedTrainingSummary,
    metricHealthSummary
  };
}

function buildRadarChartData(metricHealthSummary, options = {}) {
  const summaryItems = Array.isArray(metricHealthSummary) ? metricHealthSummary : [];
  const metrics = FITNESS_METRICS.map((metric) => {
    const matched = summaryItems.find((item) => item.key === metric.key);
    return {
      key: metric.key,
      label: matched ? matched.label : metric.label
    };
  });

  function toValues(source) {
    if (!source) return metrics.map(() => 0);
    const lookup = new Map((Array.isArray(source) ? source : []).map((item) => [item.key, Number(item.score || 0)]));
    return metrics.map((metric) => Number((lookup.get(metric.key) || 0).toFixed(1)));
  }

  const currentColor = options.currentColor || '#0f172a';
  const currentFillColor = options.currentFillColor || 'rgba(37, 99, 235, 0.18)';
  const series = [{
    key: 'current',
    label: options.currentLabel || '当前范围',
    color: currentColor,
    fillColor: currentFillColor,
    dasharray: 'none',
    strokeWidth: 3,
    visible: options.currentVisible !== false,
    values: toValues(summaryItems)
  }];

  for (const item of (options.comparisonSeries || [])) {
    if (!item || !item.metricHealthSummary) continue;
    series.push({
      key: item.key,
      label: item.label,
      color: item.color || '#ef4444',
      fillColor: item.fillColor || 'transparent',
      dasharray: item.dasharray || '10 6',
      strokeWidth: item.strokeWidth || 2.4,
      visible: item.visible !== false,
      values: toValues(item.metricHealthSummary)
    });
  }

  if (options.includeBenchmarks !== false) {
    for (const benchmark of RADAR_BENCHMARK_SERIES) {
      series.push({
        key: benchmark.key,
        label: benchmark.label,
        color: benchmark.color,
        fillColor: benchmark.fillColor,
        dasharray: benchmark.dasharray,
        strokeWidth: 2,
        visible: benchmark.visible !== false,
        values: metrics.map(() => benchmark.value)
      });
    }
  }

  return { metrics, series };
}

module.exports = {
  FITNESS_METRICS,
  buildFitnessSummaries,
  buildRadarChartData
};
