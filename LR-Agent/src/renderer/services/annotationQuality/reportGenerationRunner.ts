import { localAgentFetch, resolveLocalAgentBaseUrl } from '../../config';
import type { AnnotationProjectSnapshot } from '../../../shared/annotationAgentTypes';
import type { EffectiveTheme } from '../../theme/themeConstants';
import { parseApiError } from '../authenticatedFetch';
import {
  buildQualitySnapshot,
  deriveCurrentFolderPath,
} from './buildQualitySnapshot';
import { dataUrlToBase64, renderChartToDataUrl } from './chartExportService';
import { runQualityMetricsEngine } from './metricsEngine';
import type {
  QualityReportIndexEntry,
  QualityReportProgressEvent,
  QualityScope,
} from './types';

function progress(
  stage: QualityReportProgressEvent extends infer _U
    ? Extract<QualityReportProgressEvent, { type: 'progress' }>['stage']
    : never,
  message: string,
  status: 'running' | 'done' | 'error' = 'running',
  detail?: string,
): QualityReportProgressEvent {
  return { type: 'progress', stage, message, status, detail };
}

function parseSseBuffer(buffer: string): {
  events: Array<{ type: string; content?: string; message?: string }>;
  rest: string;
} {
  const events: Array<{ type: string; content?: string; message?: string }> =
    [];
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';

  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // ignore
    }
  }
  return { events, rest };
}

function buildComposePayload(
  viewModel: ReturnType<typeof runQualityMetricsEngine>,
) {
  const { snapshot, metrics, findings } = viewModel;
  return {
    snapshot_summary: {
      projectName: snapshot.projectName,
      scope: snapshot.scope,
      scopePath: snapshot.scopePath,
      totalFiles: snapshot.totalFiles,
      annotatedFiles: snapshot.annotatedFiles,
      totalBoxes: snapshot.totalBoxes,
      labelCount: snapshot.labels.length,
    },
    metrics: metrics.map((m) => ({
      id: m.id,
      title: m.title,
      summary: m.summary,
      severity: m.severity,
      category: m.category,
      data: m.data,
    })),
    findings: findings.slice(0, 50).map((f) => ({
      severity: f.severity,
      code: f.code,
      message: f.message,
      relativePath: f.relativePath,
    })),
    chart_paths: metrics.flatMap((m) =>
      m.chartBindings.map((c) => ({
        chart_id: c.chartId,
        title: c.title,
        path: `charts/${c.exportFileName}`,
      })),
    ),
  };
}

async function* streamQualityReportCompose(options: {
  providerId: string;
  providerApiKey: string;
  providerBaseUrl: string;
  providerModel: string;
  payload: ReturnType<typeof buildComposePayload>;
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const baseUrl = await resolveLocalAgentBaseUrl();
  const response = await localAgentFetch(
    `${baseUrl}/agent/annotation-quality/report/compose/stream`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        provider_id: options.providerId,
        api_key: options.providerApiKey,
        base_url: options.providerBaseUrl,
        model: options.providerModel,
        compose_payload: options.payload,
      }),
      signal: options.signal,
    },
  );

  if (!response.ok) {
    throw await parseApiError(response);
  }
  if (!response.body) {
    throw new Error('报告流响应体为空');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.type === 'text_delta' && event.content) {
          yield event.content;
        }
        if (event.type === 'error') {
          throw new Error(event.message || '报告生成失败');
        }
        if (event.type === 'done') {
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* runQualityReportGeneration(options: {
  project: AnnotationProjectSnapshot;
  providerId: string;
  providerApiKey: string;
  providerBaseUrl: string;
  providerModel: string;
  scope: QualityScope;
  scopePath?: string;
  relativeFilePath?: string | null;
  theme?: EffectiveTheme;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
}): AsyncGenerator<QualityReportProgressEvent> {
  const scopePath =
    options.scope === 'current_folder'
      ? (options.scopePath ??
        deriveCurrentFolderPath(options.relativeFilePath ?? null))
      : undefined;

  yield progress('collect', '正在采集标注数据…', 'running');

  let snapshot;
  try {
    snapshot = await buildQualitySnapshot({
      project: options.project,
      scope: options.scope,
      scopePath,
      onProgress: (processed, total) => {
        // progress updates handled via re-yield in caller if needed
        void processed;
        void total;
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '数据采集失败';
    yield progress('collect', '数据采集失败', 'error', msg);
    yield { type: 'error', message: msg };
    return;
  }

  if (options.isCancelled?.()) return;

  yield progress(
    'collect',
    `已采集 ${snapshot.totalFiles} 张图、${snapshot.totalBoxes} 个框`,
    'done',
  );

  yield progress('analyze', '正在运行质量与一致性检查…', 'running');
  const viewModel = runQualityMetricsEngine(snapshot);
  yield progress(
    'analyze',
    `完成 ${viewModel.metrics.length} 项指标、${viewModel.findings.length} 条发现`,
    'done',
  );

  if (options.isCancelled?.()) return;

  const qualityApi = window.electron?.quality;
  if (!qualityApi) {
    yield { type: 'error', message: '质量报告存储不可用' };
    return;
  }

  let runId: string;
  let reportRootPath: string;
  try {
    const run = await qualityApi.createRun(options.project.directoryPath);
    runId = run.runId;
    reportRootPath = run.runAbsolutePath;
    yield {
      type: 'report_run_ready',
      runId,
      reportRootPath,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '创建报告目录失败';
    yield { type: 'error', message: msg };
    return;
  }

  await qualityApi.writeSnapshot(
    options.project.directoryPath,
    runId,
    viewModel,
  );
  await qualityApi.writeFindings(
    options.project.directoryPath,
    runId,
    viewModel.findings,
  );

  yield progress('export_charts', '正在导出图表…', 'running');
  const chartPaths: string[] = [];
  const bindings = viewModel.metrics.flatMap((m) => m.chartBindings);

  for (let i = 0; i < bindings.length; i += 1) {
    if (options.isCancelled?.()) return;
    const binding = bindings[i];
    try {
      const dataUrl = await renderChartToDataUrl(binding.option, {
        theme: options.theme,
      });
      const relative = await qualityApi.writeChart(
        options.project.directoryPath,
        runId,
        binding.exportFileName,
        dataUrlToBase64(dataUrl),
      );
      chartPaths.push(relative);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '图表导出失败';
      yield progress(
        'export_charts',
        `图表 ${binding.title} 导出失败`,
        'error',
        msg,
      );
    }
  }

  yield progress('export_charts', `已导出 ${chartPaths.length} 张图表`, 'done');

  if (options.isCancelled?.()) return;

  yield progress('compose_llm', 'AI 正在撰写报告…', 'running');
  const composePayload = buildComposePayload(viewModel);
  let markdown = '';

  if (
    !options.providerApiKey.trim() ||
    !options.providerBaseUrl.trim() ||
    !options.providerModel.trim()
  ) {
    const msg =
      '所选大模型缺少 API Key、Base URL 或 Model，请在「大模型配置」中补全';
    yield progress('compose_llm', 'AI 报告撰写失败', 'error', msg);
    yield { type: 'error', message: msg };
    return;
  }

  try {
    for await (const delta of streamQualityReportCompose({
      providerId: options.providerId,
      providerApiKey: options.providerApiKey,
      providerBaseUrl: options.providerBaseUrl,
      providerModel: options.providerModel,
      payload: composePayload,
      signal: options.signal,
    })) {
      if (options.isCancelled?.()) return;
      markdown += delta;
      yield { type: 'text_delta', content: delta };
    }
    yield progress('compose_llm', '报告内容已生成', 'done');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'AI 报告撰写失败';
    yield progress('compose_llm', 'AI 报告撰写失败', 'error', msg);
    yield { type: 'error', message: msg };
    return;
  }

  if (!markdown.trim()) {
    markdown = buildFallbackMarkdown(viewModel, chartPaths);
  }

  yield progress('write_report', '正在写入报告…', 'running');

  const indexEntry: QualityReportIndexEntry = {
    runId,
    createdAt: new Date().toISOString(),
    scope: options.scope,
    scopePath,
    projectName: options.project.name,
    reportRelativePath: `.lr-agent/quality-reports/${runId}/report.md`,
    summary: viewModel.metrics.find((m) => m.id === 'label_balance')?.summary,
  };

  try {
    const result = await qualityApi.writeReport(
      options.project.directoryPath,
      runId,
      markdown,
      indexEntry,
    );
    yield progress('write_report', '报告已保存', 'done');
    yield progress('done', '质量报告生成完成', 'done');
    yield {
      type: 'report_complete',
      runId,
      reportPath: result.reportRelativePath,
      markdown,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '报告写盘失败';
    yield progress('write_report', '报告写盘失败', 'error', msg);
    yield { type: 'error', message: msg };
  }
}

function buildFallbackMarkdown(
  viewModel: ReturnType<typeof runQualityMetricsEngine>,
  chartPaths: string[],
): string {
  const lines = [
    `# ${viewModel.snapshot.projectName} 标注质量报告`,
    '',
    '## 概览',
    `- 扫描范围：${viewModel.snapshot.scope === 'full_project' ? '全项目' : `文件夹 ${viewModel.snapshot.scopePath ?? ''}`}`,
    `- 图片总数：${viewModel.snapshot.totalFiles}`,
    `- 已标注图片：${viewModel.snapshot.annotatedFiles}`,
    `- 标注框总数：${viewModel.snapshot.totalBoxes}`,
    '',
    '## 指标摘要',
    ...viewModel.metrics.map((m) => `- **${m.title}**：${m.summary}`),
    '',
  ];

  if (chartPaths.length > 0) {
    lines.push('## 图表', '');
    for (const p of chartPaths) {
      lines.push(`![图表](${p})`, '');
    }
  }

  if (viewModel.findings.length > 0) {
    lines.push('## 一致性问题', '');
    for (const f of viewModel.findings.slice(0, 30)) {
      lines.push(`- [${f.severity}] ${f.message}`);
    }
  }

  return lines.join('\n');
}

export async function loadQualityDashboard(options: {
  project: AnnotationProjectSnapshot;
  scope: QualityScope;
  scopePath?: string;
  relativeFilePath?: string | null;
  onCollectProgress?: (processed: number, total: number) => void;
}): Promise<ReturnType<typeof runQualityMetricsEngine>> {
  const scopePath =
    options.scope === 'current_folder'
      ? (options.scopePath ??
        deriveCurrentFolderPath(options.relativeFilePath ?? null))
      : undefined;

  const snapshot = await buildQualitySnapshot({
    project: options.project,
    scope: options.scope,
    scopePath,
    onProgress: options.onCollectProgress,
  });

  return runQualityMetricsEngine(snapshot);
}
