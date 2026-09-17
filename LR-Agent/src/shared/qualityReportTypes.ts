export type QualityScope = 'full_project' | 'current_folder';

export interface QualityReportIndexEntry {
  runId: string;
  createdAt: string;
  scope: QualityScope;
  scopePath?: string;
  projectName: string;
  reportRelativePath: string;
  summary?: string;
}
