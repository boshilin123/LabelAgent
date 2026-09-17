import type {
  AnnotationBatchChange,
  AnnotationJudgeSummary,
} from '../../../shared/annotationAgentTypes';
import type { SubImageTimingBreakdown } from './annotationTiming';
import type { MapMappingRow } from './annotationAgentDebug';

export interface FusionSubImageResult {
  ok: boolean;
  relativePath: string;
  absolutePath: string;
  change?: AnnotationBatchChange;
  reason?: string;
  rawCount?: number;
  keptCount?: number;
  mappedCount?: number;
  unmappedCount?: number;
  unlabeledInProposal?: number;
  autoFinalized?: boolean;
  method?: string;
  mapHint?: string;
  mapMappings?: MapMappingRow[];
  judge?: AnnotationJudgeSummary;
  judgeAttempts?: number;
  judgeRetryRounds?: number;
  weakAccepted?: boolean;
  rejectedByJudge?: boolean;
  elapsedMs?: number;
  timing?: SubImageTimingBreakdown;
}
