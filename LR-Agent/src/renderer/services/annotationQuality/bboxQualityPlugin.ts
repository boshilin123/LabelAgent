import type { EChartsOption } from 'echarts';
import type { ChartSemanticRole } from './chartThemeTokens';
import {
  computeLabelEntropy,
  findDuplicatePairs,
  percentile,
} from './geometry';
import type {
  AnnotationQualitySnapshot,
  ConsistencyFinding,
  QualityMetric,
  QualityMetricPlugin,
} from './types';

const SIZE_TOO_SMALL = 0.0001;
const SIZE_TOO_LARGE = 0.9;

function buildLabelDistribution(snapshot: AnnotationQualitySnapshot): {
  metric: QualityMetric;
  findings: ConsistencyFinding[];
} {
  const labelCounts: Record<string, number> = {};
  for (const file of snapshot.files) {
    for (const box of file.boxes) {
      labelCounts[box.labelName] = (labelCounts[box.labelName] ?? 0) + 1;
    }
  }

  const labels = Object.keys(labelCounts);
  const values = labels.map((name) => labelCounts[name]);
  const total = values.reduce((sum, n) => sum + n, 0);
  const findings: ConsistencyFinding[] = [];

  if (total > 0) {
    for (const [name, count] of Object.entries(labelCounts)) {
      if (count / total > 0.8) {
        findings.push({
          id: `label_dominance_${name}`,
          severity: 'warning',
          code: 'label_dominance',
          message: `标签「${name}」占比 ${((count / total) * 100).toFixed(1)}%，可能存在类别不均衡`,
        });
      }
    }
  }

  const needRotate = labels.length > 4;
  const barOption: EChartsOption = {
    title: { show: false },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: needRotate ? { rotate: 30, fontSize: 11 } : { fontSize: 12 },
    },
    yAxis: { type: 'value', name: '框数' },
    series: [{ type: 'bar', data: values, emphasis: { focus: 'series' } }],
    grid: { left: 40, right: 16, bottom: needRotate ? 48 : 32, top: 32 },
  };

  const pieOption: EChartsOption = {
    title: { show: false },
    tooltip: { trigger: 'item', formatter: '{b}: {c} 框 ({d}%)' },
    series: [
      {
        type: 'pie',
        radius: ['28%', '46%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        minShowLabelAngle: 3,
        label: { show: true, formatter: '{b} {d}%', fontSize: 11 },
        emphasis: {
          label: { fontSize: 14, fontWeight: 'bold' },
        },
        data: labels.map((name) => ({ name, value: labelCounts[name] })),
      },
    ],
  };

  return {
    metric: {
      id: 'label_distribution',
      category: 'distribution',
      title: '标签分布',
      summary:
        total > 0 ? `共 ${labels.length} 个标签，${total} 个框` : '暂无标注框',
      severity: findings.length > 0 ? 'warning' : 'info',
      data: { labelCounts, total },
      chartBindings: [
        {
          chartId: 'label_distribution_bar',
          chartType: 'bar',
          title: '标签分布（柱状）',
          exportFileName: 'label-distribution-bar.png',
          option: barOption,
        },
        {
          chartId: 'label_distribution_pie',
          chartType: 'pie',
          title: '标签分布（饼图）',
          exportFileName: 'label-distribution-pie.png',
          option: pieOption,
        },
      ],
    },
    findings,
  };
}

function buildCoverage(snapshot: AnnotationQualitySnapshot): {
  metric: QualityMetric;
  findings: ConsistencyFinding[];
} {
  const coverage =
    snapshot.totalFiles > 0 ? snapshot.annotatedFiles / snapshot.totalFiles : 0;
  const findings: ConsistencyFinding[] = [];

  if (snapshot.totalFiles > 0 && coverage < 0.5) {
    findings.push({
      id: 'low_coverage',
      severity: 'warning',
      code: 'low_coverage',
      message: `标注覆盖率仅 ${(coverage * 100).toFixed(1)}%（${snapshot.annotatedFiles}/${snapshot.totalFiles}）`,
    });
  }

  const unannotatedFiles = Math.max(
    0,
    snapshot.totalFiles - snapshot.annotatedFiles,
  );
  const coveragePieOption: EChartsOption = {
    title: { show: false },
    tooltip: { trigger: 'item', formatter: '{b}: {c} 张 ({d}%)' },
    legend: { bottom: 0, left: 'center', textStyle: { fontSize: 12 } },
    series: [
      {
        type: 'pie',
        radius: ['44%', '64%'],
        center: ['50%', '44%'],
        label: { show: true, formatter: '{b}\n{d}%', fontSize: 12 },
        emphasis: {
          label: { fontSize: 15, fontWeight: 'bold' },
        },
        data: [
          {
            name: '已标注',
            value: snapshot.annotatedFiles,
            themeRole: 'success' as ChartSemanticRole,
          },
          {
            name: '未标注',
            value: unannotatedFiles,
            themeRole: 'muted' as ChartSemanticRole,
          },
        ] as Array<{
          name: string;
          value: number;
          themeRole?: ChartSemanticRole;
        }>,
      },
    ],
  };

  return {
    metric: {
      id: 'coverage',
      category: 'coverage',
      title: '标注覆盖率',
      summary: `${snapshot.annotatedFiles}/${snapshot.totalFiles} 张图片已有标注（${(coverage * 100).toFixed(1)}%）`,
      severity: findings.length > 0 ? 'warning' : 'info',
      data: {
        annotatedFiles: snapshot.annotatedFiles,
        totalFiles: snapshot.totalFiles,
        coverage,
      },
      chartBindings: [
        {
          chartId: 'coverage_pie',
          chartType: 'pie',
          title: '标注覆盖率',
          exportFileName: 'coverage.png',
          option: coveragePieOption,
        },
      ],
    },
    findings,
  };
}

function buildBoxesPerFile(snapshot: AnnotationQualitySnapshot): {
  metric: QualityMetric;
  findings: ConsistencyFinding[];
} {
  const counts = snapshot.files.map((f) => f.boxes.length);
  const findings: ConsistencyFinding[] = [];
  const p99 = percentile(counts, 99);
  const threshold = p99 > 0 ? p99 * 3 : 0;

  for (const file of snapshot.files) {
    if (threshold > 0 && file.boxes.length > threshold) {
      findings.push({
        id: `boxes_per_file_${file.relativePath}`,
        severity: 'warning',
        code: 'boxes_per_file_outlier',
        message: `${file.relativePath} 含 ${file.boxes.length} 个框，显著高于 P99（${p99}）`,
        relativePath: file.relativePath,
      });
    }
  }

  const maxCount = Math.max(...counts, 1);
  const bucketSize = Math.max(1, Math.ceil(maxCount / 10));
  const buckets: Record<number, number> = {};
  for (const count of counts) {
    const bucket = Math.min(10, Math.floor(count / bucketSize));
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }

  const histOption: EChartsOption = {
    title: { show: false },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: {
      type: 'category',
      data: Object.keys(buckets).map(
        (b) => `${Number(b) * bucketSize}-${(Number(b) + 1) * bucketSize - 1}`,
      ),
      axisLabel: { fontSize: 11 },
    },
    yAxis: { type: 'value', name: '图片数' },
    series: [
      {
        type: 'bar',
        data: Object.values(buckets),
        emphasis: { focus: 'series' },
      },
    ],
    grid: { left: 40, right: 16, bottom: 40, top: 32 },
  };

  return {
    metric: {
      id: 'boxes_per_file',
      category: 'distribution',
      title: '每图框数分布',
      summary: counts.length
        ? `平均 ${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)} 框/图，P99=${p99}`
        : '无图片',
      severity: findings.length > 0 ? 'warning' : 'info',
      data: { counts, p99, threshold },
      chartBindings: [
        {
          chartId: 'boxes_per_file_hist',
          chartType: 'histogram',
          title: '每图框数分布',
          exportFileName: 'boxes-per-file.png',
          option: histOption,
        },
      ],
    },
    findings,
  };
}

function buildLabelBalance(snapshot: AnnotationQualitySnapshot): {
  metric: QualityMetric;
  findings: ConsistencyFinding[];
} {
  const labelCounts: Record<string, number> = {};
  let unlabeled = 0;
  let duplicateCount = 0;
  let sizeAnomaly = 0;

  for (const file of snapshot.files) {
    duplicateCount += findDuplicatePairs(file.boxes).length;
    for (const box of file.boxes) {
      if (!box.labelId) unlabeled += 1;
      if (box.area < SIZE_TOO_SMALL || box.area > SIZE_TOO_LARGE) {
        sizeAnomaly += 1;
      }
      labelCounts[box.labelName] = (labelCounts[box.labelName] ?? 0) + 1;
    }
  }

  const coverage =
    snapshot.totalFiles > 0 ? snapshot.annotatedFiles / snapshot.totalFiles : 0;
  const balance = computeLabelEntropy(labelCounts);
  const unlabeledRate =
    snapshot.totalBoxes > 0 ? 1 - unlabeled / snapshot.totalBoxes : 1;
  const noDuplicateRate =
    snapshot.totalBoxes > 0
      ? Math.max(0, 1 - duplicateCount / snapshot.totalBoxes)
      : 1;
  const sizeOkRate =
    snapshot.totalBoxes > 0
      ? Math.max(0, 1 - sizeAnomaly / snapshot.totalBoxes)
      : 1;

  const dimensions = [
    { name: '覆盖率', value: coverage },
    { name: '标签均衡', value: balance },
    { name: '已标框占比', value: unlabeledRate },
    { name: '无重复', value: noDuplicateRate },
    { name: '尺寸合理', value: sizeOkRate },
  ];

  const composite =
    dimensions.reduce((sum, d) => sum + d.value, 0) / dimensions.length;

  const findings: ConsistencyFinding[] = [];
  if (composite < 0.5) {
    findings.push({
      id: 'low_composite_score',
      severity: 'warning',
      code: 'low_composite_score',
      message: `综合质量评分 ${(composite * 100).toFixed(0)}/100，建议重点复核`,
    });
  }

  const radarLabelValue = (value: unknown): number => {
    if (typeof value === 'number') return value;
    if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
    return 0;
  };

  const radarOption: EChartsOption = {
    title: { show: false },
    radar: {
      center: ['50%', '54%'],
      radius: '58%',
      axisNameGap: 8,
      indicator: dimensions.map((d) => ({ name: d.name, max: 1 })),
    },
    series: [
      {
        type: 'radar',
        data: [
          {
            value: dimensions.map((d) => Number(d.value.toFixed(3))),
            name: '质量维度',
            label: {
              show: true,
              formatter: (params) =>
                `${(radarLabelValue(params.value) * 100).toFixed(0)}`,
              fontSize: 10,
            },
          },
        ],
      },
    ],
  };

  return {
    metric: {
      id: 'label_balance',
      category: 'consistency',
      title: '综合质量评分',
      summary: `综合评分 ${(composite * 100).toFixed(0)}/100`,
      severity: findings.length > 0 ? 'warning' : 'info',
      data: {
        composite,
        dimensions: Object.fromEntries(
          dimensions.map((d) => [d.name, d.value]),
        ),
      },
      chartBindings: [
        {
          chartId: 'label_balance_radar',
          chartType: 'radar',
          title: '综合质量雷达',
          exportFileName: 'quality-radar.png',
          option: radarOption,
        },
      ],
    },
    findings,
  };
}

function buildDuplicateBoxes(snapshot: AnnotationQualitySnapshot): {
  metric: QualityMetric;
  findings: ConsistencyFinding[];
} {
  const findings: ConsistencyFinding[] = [];
  let totalPairs = 0;

  for (const file of snapshot.files) {
    const pairs = findDuplicatePairs(file.boxes);
    if (pairs.length === 0) continue;
    totalPairs += pairs.length;
    findings.push({
      id: `duplicate_${file.relativePath}`,
      severity: 'critical',
      code: 'duplicate_boxes',
      message: `${file.relativePath} 存在 ${pairs.length} 对疑似重复框（IOU≥0.9）`,
      relativePath: file.relativePath,
      boxIds: pairs.flat(),
    });
  }

  return {
    metric: {
      id: 'duplicate_boxes',
      category: 'consistency',
      title: '重复框检测',
      summary:
        totalPairs > 0
          ? `发现 ${totalPairs} 对疑似重复框`
          : '未发现高 IOU 重复框',
      severity: totalPairs > 0 ? 'critical' : 'info',
      data: { totalPairs },
      chartBindings: [],
    },
    findings,
  };
}

function buildUnlabeledBoxes(snapshot: AnnotationQualitySnapshot): {
  metric: QualityMetric;
  findings: ConsistencyFinding[];
} {
  let unlabeled = 0;
  const findings: ConsistencyFinding[] = [];

  for (const file of snapshot.files) {
    const ids = file.boxes.filter((b) => !b.labelId).map((b) => b.id);
    unlabeled += ids.length;
    if (ids.length > 0) {
      findings.push({
        id: `unlabeled_${file.relativePath}`,
        severity: 'warning',
        code: 'unlabeled_boxes',
        message: `${file.relativePath} 有 ${ids.length} 个未标注标签的框`,
        relativePath: file.relativePath,
        boxIds: ids,
      });
    }
  }

  return {
    metric: {
      id: 'unlabeled_boxes',
      category: 'consistency',
      title: '未标标签框',
      summary:
        unlabeled > 0 ? `${unlabeled} 个框尚未分配标签` : '所有框均已分配标签',
      severity: unlabeled > 0 ? 'warning' : 'info',
      data: { unlabeled },
      chartBindings: [],
    },
    findings,
  };
}

function buildBoxSizeAnomaly(snapshot: AnnotationQualitySnapshot): {
  metric: QualityMetric;
  findings: ConsistencyFinding[];
} {
  let anomalyCount = 0;
  const findings: ConsistencyFinding[] = [];

  for (const file of snapshot.files) {
    const ids = file.boxes
      .filter((b) => b.area < SIZE_TOO_SMALL || b.area > SIZE_TOO_LARGE)
      .map((b) => b.id);
    anomalyCount += ids.length;
    if (ids.length > 0) {
      findings.push({
        id: `size_anomaly_${file.relativePath}`,
        severity: 'warning',
        code: 'box_size_anomaly',
        message: `${file.relativePath} 有 ${ids.length} 个框尺寸异常（过小或过大）`,
        relativePath: file.relativePath,
        boxIds: ids,
      });
    }
  }

  const rate = snapshot.totalBoxes > 0 ? anomalyCount / snapshot.totalBoxes : 0;
  if (rate > 0.05) {
    findings.push({
      id: 'size_anomaly_rate',
      severity: 'warning',
      code: 'box_size_anomaly_rate',
      message: `${(rate * 100).toFixed(1)}% 的框尺寸异常，超过 5% 阈值`,
    });
  }

  return {
    metric: {
      id: 'box_size_anomaly',
      category: 'consistency',
      title: '框尺寸异常',
      summary:
        anomalyCount > 0
          ? `${anomalyCount} 个框尺寸异常（${(rate * 100).toFixed(1)}%）`
          : '未发现明显尺寸异常',
      severity: rate > 0.05 ? 'warning' : 'info',
      data: { anomalyCount, rate },
      chartBindings: [],
    },
    findings,
  };
}

function buildEmptyFiles(snapshot: AnnotationQualitySnapshot): {
  metric: QualityMetric;
  findings: ConsistencyFinding[];
} {
  const emptyFiles = snapshot.files.filter((f) => f.boxes.length === 0);
  const findings: ConsistencyFinding[] = emptyFiles.slice(0, 50).map((f) => ({
    id: `empty_${f.relativePath}`,
    severity: 'info',
    code: 'empty_annotated_file',
    message: `${f.relativePath} 尚无标注框`,
    relativePath: f.relativePath,
  }));

  return {
    metric: {
      id: 'empty_annotated_files',
      category: 'coverage',
      title: '空标注文件',
      summary:
        emptyFiles.length > 0
          ? `${emptyFiles.length} 张图片尚无标注`
          : '所有图片均有至少一个标注框',
      severity: emptyFiles.length > 0 ? 'info' : 'info',
      data: { emptyCount: emptyFiles.length },
      chartBindings: [],
    },
    findings,
  };
}

export const bboxQualityPlugin: QualityMetricPlugin = {
  id: 'bbox',
  supportedTypes: ['bbox'],
  compute(snapshot: AnnotationQualitySnapshot) {
    const parts = [
      buildLabelDistribution(snapshot),
      buildCoverage(snapshot),
      buildBoxesPerFile(snapshot),
      buildLabelBalance(snapshot),
      buildDuplicateBoxes(snapshot),
      buildUnlabeledBoxes(snapshot),
      buildBoxSizeAnomaly(snapshot),
      buildEmptyFiles(snapshot),
    ];

    return {
      metrics: parts.map((p) => p.metric),
      findings: parts.flatMap((p) => p.findings),
    };
  },
};
