/** @jest-environment node */

import { serialize } from 'node:v8';
import type { AnnotationProjectSnapshot } from '../../../../shared/annotationAgentTypes';
import { localAgentFetch } from '../../../config';
import { buildQualitySnapshot } from '../buildQualitySnapshot';
import { renderChartToDataUrl } from '../chartExportService';
import { runQualityReportGeneration } from '../reportGenerationRunner';
import type {
  AnnotationQualitySnapshot,
  QualityDashboardViewModel,
  QualityReportProgressEvent,
} from '../types';

jest.mock('../../../config', () => ({
  resolveLocalAgentBaseUrl: jest.fn(async () => 'http://localhost/api/v1'),
  localAgentFetch: jest.fn(),
}));

jest.mock('../buildQualitySnapshot', () => ({
  buildQualitySnapshot: jest.fn(),
  deriveCurrentFolderPath: jest.fn(),
}));

jest.mock('../chartExportService', () => ({
  renderChartToDataUrl: jest.fn(async () => 'data:image/png;base64,aW1hZ2U='),
  dataUrlToBase64: jest.fn(() => 'aW1hZ2U='),
}));

const project: AnnotationProjectSnapshot = {
  projectId: 'proj-1',
  name: 'Demo',
  directoryPath: 'C:/proj',
  modality: 'image',
  annotationType: 'bbox',
  labels: [{ id: 'label-car', name: 'car', color: '#0f0' }],
  detectionModels: [],
};
const snapshot: AnnotationQualitySnapshot = {
  schemaVersion: 1,
  scope: 'full_project',
  projectId: 'proj-1',
  projectName: 'Demo',
  annotationType: 'bbox',
  labels: [{ id: 'label-car', name: 'car' }],
  totalFiles: 2,
  annotatedFiles: 1,
  totalBoxes: 1,
  files: [
    {
      relativePath: 'a.jpg',
      boxes: [
        {
          id: 'box-1',
          labelId: 'label-car',
          labelName: 'car',
          x: 0.1,
          y: 0.1,
          width: 0.2,
          height: 0.2,
          area: 0.04,
        },
      ],
    },
    { relativePath: 'b.jpg', boxes: [] },
  ],
};

function installQualityApi() {
  const api = {
    createRun: jest.fn(async () => ({
      runId: 'run-1',
      runAbsolutePath: 'C:/proj/.lr-agent/quality-reports/run-1',
    })),
    writeSnapshot: jest.fn(
      async (_dir: string, _runId: string, payload: unknown) => {
        // 模拟 Electron IPC 的序列化边界：包含函数时必须失败。
        serialize(payload);
        return { ok: true };
      },
    ),
    writeFindings: jest.fn(async () => ({ ok: true })),
    writeChart: jest.fn(
      async (_dir: string, _runId: string, name: string) => `charts/${name}`,
    ),
    writeReport: jest.fn(async () => ({
      reportRelativePath: '.lr-agent/quality-reports/run-1/report.md',
    })),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electron: { quality: api } },
  });
  return api;
}

function mockReportStream(events: Array<Record<string, string>>) {
  const data = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  const reader = {
    read: jest
      .fn()
      .mockResolvedValueOnce({
        done: false,
        value: new TextEncoder().encode(data),
      })
      .mockResolvedValue({ done: true }),
    releaseLock: jest.fn(),
  };
  jest.mocked(localAgentFetch).mockResolvedValue({
    ok: true,
    body: { getReader: () => reader },
  } as unknown as Response);
}

async function run() {
  const events: QualityReportProgressEvent[] = [];
  for await (const event of runQualityReportGeneration({
    project,
    providerId: 'provider-1',
    providerApiKey: 'test-key',
    providerBaseUrl: 'https://provider.example/v1',
    providerModel: 'test-model',
    scope: 'full_project',
  })) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(buildQualitySnapshot).mockResolvedValue(snapshot);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

it('saves a serializable snapshot and completes the report while preserving chart callbacks', async () => {
  const api = installQualityApi();
  mockReportStream([
    { type: 'text_delta', content: '# 质量报告\n覆盖率为 50%。' },
    { type: 'done' },
  ]);

  const events = await run();
  const stored = api.writeSnapshot.mock
    .calls[0][2] as QualityDashboardViewModel;
  expect(stored.snapshot.totalFiles).toBe(2);
  expect(stored.snapshot.totalBoxes).toBe(1);
  expect(
    stored.metrics.find((metric) => metric.id === 'coverage')?.data.coverage,
  ).toBe(0.5);
  expect(api.writeFindings).toHaveBeenCalled();
  expect(api.writeReport).toHaveBeenCalledWith(
    'C:/proj',
    'run-1',
    '# 质量报告\n覆盖率为 50%。',
    expect.any(Object),
  );
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'report_complete' }),
  );

  const radar = jest
    .mocked(renderChartToDataUrl)
    .mock.calls.map(([option]) => option)
    .find((option) => option.radar);
  const series = radar?.series as Array<{
    data: Array<{
      label: { formatter: (params: { value: number }) => string };
    }>;
  }>;
  expect(series[0].data[0].label.formatter({ value: 0.75 })).toBe('75');
});

it('reports model errors without saving a successful report', async () => {
  const api = installQualityApi();
  mockReportStream([{ type: 'error', message: 'provider failed' }]);
  const events = await run();
  expect(events).toContainEqual({ type: 'error', message: 'provider failed' });
  expect(api.writeReport).not.toHaveBeenCalled();
  expect(events.some((event) => event.type === 'report_complete')).toBe(false);
});
