import type { EChartsOption } from 'echarts';
import type { AnnotationType } from '../../types/annotation';

export type QualityScope = 'full_project' | 'current_folder';

export type MetricSeverity = 'info' | 'warning' | 'critical';

export interface BboxQualityBox {
  id: string;
  labelId: string | null;
  labelName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
}

export interface FileQualityRecord {
  relativePath: string;
  imageWidth?: number;
  imageHeight?: number;
  boxes: BboxQualityBox[];
}

export interface AnnotationQualitySnapshot {
  schemaVersion: 1;
  scope: QualityScope;
  scopePath?: string;
  projectId: string;
  projectName: string;
  annotationType: 'bbox';
  labels: Array<{ id: string; name: string }>;
  totalFiles: number;
  annotatedFiles: number;
  totalBoxes: number;
  files: FileQualityRecord[];
}

export interface ChartBinding {
  chartId: string;
  chartType: 'bar' | 'pie' | 'radar' | 'histogram' | 'gauge';
  title: string;
  exportFileName: string;
  option: EChartsOption;
}

export interface QualityMetric {
  id: string;
  category: 'coverage' | 'consistency' | 'distribution';
  title: string;
  summary: string;
  severity: MetricSeverity;
  data: Record<string, unknown>;
  chartBindings: ChartBinding[];
}

export interface ConsistencyFinding {
  id: string;
  severity: MetricSeverity;
  code: string;
  message: string;
  relativePath?: string;
  boxIds?: string[];
}

export interface QualityDashboardViewModel {
  snapshot: AnnotationQualitySnapshot;
  metrics: QualityMetric[];
  findings: ConsistencyFinding[];
}

export interface QualityMetricPlugin {
  id: string;
  supportedTypes: AnnotationType[];
  compute(snapshot: AnnotationQualitySnapshot): {
    metrics: QualityMetric[];
    findings: ConsistencyFinding[];
  };
}

export type QualityReportStage =
  | 'collect'
  | 'analyze'
  | 'export_charts'
  | 'compose_llm'
  | 'write_report'
  | 'done';

export type QualityReportProgressEvent =
  | {
      type: 'progress';
      stage: QualityReportStage;
      message: string;
      status?: 'running' | 'done' | 'error';
      detail?: string;
    }
  | { type: 'text_delta'; content: string }
  | {
      type: 'report_run_ready';
      runId: string;
      reportRootPath: string;
    }
  | {
      type: 'report_complete';
      runId: string;
      reportPath: string;
      markdown: string;
    }
  | { type: 'error'; message: string };

export type { QualityReportIndexEntry } from '../../../shared/qualityReportTypes';
