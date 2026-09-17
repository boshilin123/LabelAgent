import type { AnnotationBatchChange } from '../../../shared/annotationAgentTypes';
import type {
  AnnotationInstance,
  CaptionGranularity,
} from '../../types/annotationDocument';
import { readAnnotationsForPath } from './mutationTargetResolver';

export type AnnotationWriteMode = 'append' | 'replace_matching';

export interface AnnotationWriteMatch {
  kinds?: string[];
  granularity?: CaptionGranularity;
  language?: string;
  matchAllGranularities?: boolean;
}

export interface AnnotationWritePolicy {
  mode: AnnotationWriteMode;
  match?: AnnotationWriteMatch;
}

const ALL_GRANULARITIES = /每种粒度只留/;

function inferGranularity(text: string): CaptionGranularity | undefined {
  if (/brief|简短|短描述/.test(text) || /不超过\s*\d+\s*字/.test(text)) {
    return 'brief';
  }
  if (/dense|密集/.test(text)) return 'dense';
  if (/detailed|详细/.test(text)) return 'detailed';
  return undefined;
}

function inferLanguage(text: string): string | undefined {
  if (/英文|英语|english|\ben\b/i.test(text)) return 'en';
  if (/中文|汉语|chinese|\bzh\b/i.test(text)) return 'zh';
  return undefined;
}

function kindsForType(annotationType: string): string[] {
  if (annotationType === 'keypoint') return ['pose', 'point'];
  return [annotationType];
}

export function inferAnnotationWritePolicy(
  userRequest: string,
  annotationType: string,
  writeMode: AnnotationWriteMode = 'append',
): AnnotationWritePolicy {
  const text = userRequest || '';
  const kinds = kindsForType(annotationType);

  if (writeMode !== 'replace_matching') {
    return { mode: 'append' };
  }

  if (annotationType === 'caption') {
    return {
      mode: 'replace_matching',
      match: {
        kinds,
        granularity: inferGranularity(text),
        language: inferLanguage(text),
        matchAllGranularities: ALL_GRANULARITIES.test(text),
      },
    };
  }

  return { mode: 'replace_matching', match: { kinds } };
}

export function selectIdsToReplace(
  existing: AnnotationInstance[],
  policy: AnnotationWritePolicy,
  incoming: AnnotationInstance[],
): string[] {
  if (policy.mode !== 'replace_matching') return [];
  const kinds = policy.match?.kinds;
  let pool = kinds?.length
    ? existing.filter((a) => kinds.includes(a.kind))
    : [...existing];

  const incomingCaption = incoming.find((a) => a.kind === 'caption');
  const gran = policy.match?.matchAllGranularities
    ? undefined
    : (policy.match?.granularity ??
      (incomingCaption && incomingCaption.kind === 'caption'
        ? incomingCaption.granularity
        : undefined));
  const lang = policy.match?.language;

  if (gran) {
    pool = pool.filter((a) => a.kind === 'caption' && a.granularity === gran);
  }
  if (lang) {
    pool = pool.filter(
      (a) =>
        a.kind !== 'caption' ||
        (a.language || 'zh').toLowerCase() === lang.toLowerCase(),
    );
  }

  return pool.map((a) => a.id);
}

export function prependRewriteDeletes(
  changes: AnnotationBatchChange[],
  existingByPath: Map<string, AnnotationInstance[]>,
  policy: AnnotationWritePolicy,
): AnnotationBatchChange[] {
  if (policy.mode !== 'replace_matching') return changes;
  const deletes: AnnotationBatchChange[] = [];
  for (const change of changes) {
    if (change.operation !== 'append') continue;
    const existing = existingByPath.get(change.relativePath) ?? [];
    const deleteIds = selectIdsToReplace(
      existing,
      policy,
      change.annotations ?? [],
    );
    if (deleteIds.length === 0) continue;
    deletes.push({
      relativePath: change.relativePath,
      absolutePath: change.absolutePath,
      operation: 'delete',
      deleteIds,
    });
  }
  return deletes.length ? [...deletes, ...changes] : changes;
}

export async function attachRewriteDeletes(
  changes: AnnotationBatchChange[],
  projectDir: string,
  policy: AnnotationWritePolicy,
): Promise<AnnotationBatchChange[]> {
  if (policy.mode !== 'replace_matching') return changes;
  const existingByPath = new Map<string, AnnotationInstance[]>();
  const paths = [
    ...new Set(
      changes
        .filter((c) => c.operation === 'append')
        .map((c) => c.relativePath),
    ),
  ];
  await Promise.all(
    paths.map(async (rel) => {
      existingByPath.set(rel, await readAnnotationsForPath(projectDir, rel));
    }),
  );
  return prependRewriteDeletes(changes, existingByPath, policy);
}
