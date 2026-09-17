import type { AnnotationBatchChange } from '../../shared/annotationAgentTypes';
import {
  FILE_ANNOTATION_SCHEMA_VERSION,
  type AnnotationInstance,
  type FileAnnotationDocument,
} from '../types/annotationDocument';
import { applyChangeToDoc } from './annotationMutationApply';
import type {
  AnnotationProject,
  AnnotationType,
  Modality,
} from '../types/annotation';

/** 把 pending 提案 changes 叠到磁盘标注上（不写盘）。 */
export function overlayPendingAnnotations(
  diskAnns: AnnotationInstance[],
  relativePath: string,
  pendingChanges: AnnotationBatchChange[],
  project: {
    id: string;
    modality: string;
    annotationType: string;
  },
): AnnotationInstance[] {
  const forPath = pendingChanges.filter(
    (change) => change.relativePath === relativePath,
  );
  if (forPath.length === 0) return diskAnns;

  const stub: AnnotationProject = {
    id: project.id,
    name: project.id,
    directoryPath: '',
    modality: project.modality as Modality,
    annotationType: project.annotationType as AnnotationType,
    labels: [],
    createdAt: '',
    updatedAt: '',
  };

  let doc: FileAnnotationDocument | null =
    diskAnns.length > 0
      ? {
          schemaVersion: FILE_ANNOTATION_SCHEMA_VERSION,
          projectId: project.id,
          filePath: relativePath,
          modality: stub.modality,
          annotationType: stub.annotationType,
          annotations: diskAnns,
          updatedAt: '',
        }
      : null;
  for (const change of forPath) {
    try {
      doc = applyChangeToDoc(doc, change, stub);
    } catch {
      // skip overlay steps that cannot apply to the current doc
    }
  }
  return doc?.annotations ?? diskAnns;
}
