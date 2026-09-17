import { createAgentId } from '../../../shared/agentTypes';
import type {
  AnnotationBatchChange,
  AnnotationBatchProposal,
  AnnotationPatch,
  AnnotationProjectSnapshot,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import { prepareMutationAnnotation } from '../annotationAgentApi';
import { getAnnotationWorkspaceAgentSnapshot } from '../annotationAgentBridge';
import { logAnnotationDebug } from './annotationAgentDebug';
import { overlayPendingAnnotations } from '../pendingAnnotationOverlay';
import {
  buildAnnotationDigest,
  labelIdByName,
  parseMutationOperation,
  readAnnotationsForPath,
  resolveMutationTargets,
  type MutationOperationSpec,
} from './mutationTargetResolver';

export type MutationProgressEvent =
  | {
      type: 'progress';
      stage: string;
      message: string;
      status?: 'running' | 'done' | 'error';
      detail?: string;
    }
  | { type: 'proposal'; proposal: AnnotationBatchProposal }
  | { type: 'text'; content: string }
  | { type: 'error'; message: string };

function progress(
  stage: string,
  message: string,
  status: 'running' | 'done' | 'error' = 'running',
  detail?: string,
): MutationProgressEvent {
  return { type: 'progress', stage, message, status, detail };
}

function patchesFromOperation(
  ids: string[],
  op: MutationOperationSpec,
  labels: AnnotationProjectSnapshot['labels'],
): { patches?: AnnotationPatch[]; error?: string } {
  if (op.mutation_kind === 'patch_label') {
    const labelId = labelIdByName(op.new_label_name, labels);
    if (!labelId) {
      return { error: `未知标签 ${op.new_label_name ?? ''}` };
    }
    return { patches: ids.map((id) => ({ id, labelId })) };
  }

  if (op.mutation_kind === 'patch_geometry') {
    const geom: Pick<
      AnnotationPatch,
      | 'x'
      | 'y'
      | 'width'
      | 'height'
      | 'points'
      | 'cx'
      | 'cy'
      | 'angle'
      | 'keypoints'
    > = {};
    if (op.x != null) geom.x = op.x;
    if (op.y != null) geom.y = op.y;
    if (op.width != null) geom.width = op.width;
    if (op.height != null) geom.height = op.height;
    if (op.cx != null) geom.cx = op.cx;
    if (op.cy != null) geom.cy = op.cy;
    if (op.angle != null) geom.angle = op.angle;
    if (op.points?.length) geom.points = op.points;
    if (op.keypoints?.length) geom.keypoints = op.keypoints;
    if (
      geom.x == null &&
      geom.y == null &&
      geom.width == null &&
      geom.height == null &&
      geom.cx == null &&
      geom.cy == null &&
      geom.angle == null &&
      !geom.points &&
      !geom.keypoints
    ) {
      return { error: '缺少几何字段' };
    }
    return { patches: ids.map((id) => ({ id, ...geom })) };
  }

  if (op.mutation_kind === 'patch_content') {
    const content: Pick<
      AnnotationPatch,
      | 'text'
      | 'granularity'
      | 'language'
      | 'steps'
      | 'answer'
      | 'instruction'
      | 'input'
      | 'output'
      | 'start'
      | 'end'
      | 'prompt'
      | 'chosen'
      | 'rejected'
      | 'turns'
      | 'note'
    > = {};
    if (op.text != null) content.text = op.text;
    if (op.granularity) content.granularity = op.granularity;
    if (op.language) content.language = op.language;
    if (op.steps) content.steps = op.steps;
    if (op.answer != null) content.answer = op.answer;
    if (op.instruction != null) content.instruction = op.instruction;
    if (op.input != null) content.input = op.input;
    if (op.output != null) content.output = op.output;
    if (op.start != null) content.start = op.start;
    if (op.end != null) content.end = op.end;
    if (op.prompt != null) content.prompt = op.prompt;
    if (op.chosen != null) content.chosen = op.chosen;
    if (op.rejected != null) content.rejected = op.rejected;
    if (op.turns) content.turns = op.turns;
    if (op.note != null) content.note = op.note;
    if (Object.keys(content).length === 0) {
      return { error: '缺少正文字段' };
    }
    return { patches: ids.map((id) => ({ id, ...content })) };
  }

  return { error: '未知变更类型' };
}

async function loadWorkingAnnotations(
  project: AnnotationProjectSnapshot,
  relativePath: string,
  pending: AnnotationBatchChange[] | undefined,
) {
  const disk = await readAnnotationsForPath(
    project.directoryPath,
    relativePath,
  );
  return overlayPendingAnnotations(disk, relativePath, pending ?? [], {
    id: project.projectId,
    modality: project.modality,
    annotationType: project.annotationType,
  });
}

export async function* runAnnotationMutationJob(options: {
  providerId: string;
  userRequest: string;
  sessionId?: string;
  conversationTranscript?: string;
  project: AnnotationProjectSnapshot;
  currentFileAbsolutePath: string | null;
  candidates: ImageCandidate[];
  currentRelativePath: string;
  selectedAnnotationIds?: string[];
  pendingAnnotationChanges?: AnnotationBatchChange[];
  providerApiKey?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  isCancelled?: () => boolean;
}): AsyncGenerator<MutationProgressEvent> {
  const {
    providerId,
    userRequest,
    sessionId,
    project,
    candidates,
    currentRelativePath,
  } = options;

  yield progress('prepare', '解析标注变更意图', 'running');

  const digestParts: string[] = [];
  for (const candidate of candidates.slice(0, 48)) {
    const anns = await loadWorkingAnnotations(
      project,
      candidate.relativePath,
      options.pendingAnnotationChanges,
    );
    if (anns.length === 0) continue;
    digestParts.push(
      buildAnnotationDigest(candidate.relativePath, anns, project.labels),
    );
  }
  const annotationDigest = digestParts.length
    ? `【已有标注摘要】\n${digestParts.join('\n').slice(0, 12_000)}`
    : '';
  const conversationTranscript = [
    options.conversationTranscript,
    annotationDigest,
  ]
    .filter((part) => part?.trim())
    .join('\n\n');

  let prepareResult;
  try {
    const wsSnap = getAnnotationWorkspaceAgentSnapshot();
    const selectedIds =
      options.selectedAnnotationIds ??
      wsSnap.selectedAnnotationIds ??
      (wsSnap.selectedAnnotationId ? [wsSnap.selectedAnnotationId] : []);

    prepareResult = await prepareMutationAnnotation(providerId, {
      userRequest,
      sessionId,
      conversationTranscript,
      currentRelativePath,
      candidates,
      labelCandidates: project.labels.map((l) => ({ id: l.id, name: l.name })),
      project,
      selectedAnnotationIds: selectedIds,
      providerApiKey: options.providerApiKey,
      providerBaseUrl: options.providerBaseUrl,
      providerModel: options.providerModel,
    });
  } catch (err) {
    yield progress(
      'prepare',
      '变更准备失败',
      'error',
      err instanceof Error ? err.message : undefined,
    );
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : '变更准备失败',
    };
    return;
  }

  if (options.isCancelled?.()) return;

  const rawOperations = prepareResult.operations ?? [];
  const operations = rawOperations
    .map(parseMutationOperation)
    .filter((op): op is NonNullable<typeof op> => op != null);
  if (operations.length < rawOperations.length) {
    logAnnotationDebug('prepare', '忽略非法 mutation operations', {
      rawCount: rawOperations.length,
      parsedCount: operations.length,
    });
  }
  if (operations.length === 0 && !prepareResult.selected_paths?.length) {
    yield progress('prepare', '未识别变更目标', 'error');
    yield {
      type: 'text',
      content:
        prepareResult.intent_summary ||
        '未能识别要修改或删除的标注。请指定文件与目标（如「把 data/7.jpg 左侧 person 改成 worker」），或先在画布选中。',
    };
    return;
  }

  yield progress(
    'prepare',
    '变更意图已解析',
    'done',
    prepareResult.intent_summary,
  );
  yield progress('resolve', '定位标注目标', 'running');

  const changes: AnnotationBatchChange[] = [];
  const resolveErrors: string[] = [];
  const wsSnap = getAnnotationWorkspaceAgentSnapshot();
  const selectedIds =
    options.selectedAnnotationIds ??
    wsSnap.selectedAnnotationIds ??
    (wsSnap.selectedAnnotationId ? [wsSnap.selectedAnnotationId] : []);

  const candidateByPath = new Map(
    candidates.map((c) => [c.relativePath, c] as const),
  );

  for (const op of operations) {
    const rel = op.relative_path?.replace(/\\/g, '/');
    if (!rel) continue;
    const image = candidateByPath.get(rel);
    if (!image) {
      resolveErrors.push(`${rel}: 不在候选列表`);
      continue;
    }

    const annotations = await loadWorkingAnnotations(
      project,
      rel,
      options.pendingAnnotationChanges,
    );
    let targets = op.targets ?? [];
    if (op.mutation_kind === 'delete' && targets.length === 0) {
      targets = [{ by: 'all' }];
    }
    const { ids, errors } = resolveMutationTargets(
      annotations,
      targets,
      project.labels,
      selectedIds,
    );
    resolveErrors.push(...errors.map((e) => `${rel}: ${e}`));

    if (ids.length === 0) {
      resolveErrors.push(`${rel}: 未解析到任何目标标注`);
      continue;
    }

    if (op.mutation_kind === 'delete') {
      changes.push({
        relativePath: rel,
        absolutePath: image.absolutePath,
        operation: 'delete',
        deleteIds: ids,
      });
      continue;
    }

    const built = patchesFromOperation(ids, op, project.labels);
    if (built.error || !built.patches?.length) {
      resolveErrors.push(`${rel}: ${built.error ?? '无法构造变更'}`);
      continue;
    }
    changes.push({
      relativePath: rel,
      absolutePath: image.absolutePath,
      operation: 'patch',
      patches: built.patches,
    });
  }

  if (changes.length === 0) {
    yield progress(
      'resolve',
      '目标解析失败',
      'error',
      resolveErrors.join('；') || undefined,
    );
    yield {
      type: 'text',
      content: `未能定位要变更的标注。${resolveErrors.join('；')}`,
    };
    return;
  }

  yield progress(
    'resolve',
    `已定位 ${changes.length} 个文件变更`,
    'done',
    resolveErrors.length ? resolveErrors.join('；') : undefined,
  );

  const patchCount = changes.reduce(
    (n, c) =>
      n +
      (c.patches?.length ?? c.deleteIds?.length ?? c.annotations?.length ?? 0),
    0,
  );

  const proposal: AnnotationBatchProposal = {
    id: createAgentId('mutation-proposal'),
    projectId: project.projectId,
    summary: prepareResult.intent_summary || userRequest,
    changes,
    stats: {
      kind: 'generic',
      processed: changes.length,
      succeeded: changes.length,
      skipped: 0,
    },
    createdAt: Date.now(),
  };

  logAnnotationDebug('mutation-proposal', '变更提案', {
    changes: changes.length,
    patchCount,
  });

  yield { type: 'proposal', proposal };
}
