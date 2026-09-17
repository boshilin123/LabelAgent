import type { AnnotationProjectSnapshot } from '../../shared/annotationAgentTypes';
import type {
  AnnotationProject,
  ImageAnnotationType,
} from '../types/annotation';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import { getEligiblePreAnnotModels } from '../utils/preAnnotModelFilter';
import { getAnnotationTypeLabel } from '../types/annotation';
import { isGeometryAnnotationType } from './annotationAgent/geometryTypes';
import { getAnnotationWorkspaceAgentSnapshot } from './annotationAgentBridge';

export function buildAnnotationProjectSnapshot(
  project: AnnotationProject,
  detectionModels: PretrainedModelConfig[],
  options?: { keypointTemplateId?: string | null },
): AnnotationProjectSnapshot {
  const wsSnap = getAnnotationWorkspaceAgentSnapshot();
  const keypointTemplateId =
    options?.keypointTemplateId ?? wsSnap.keypointTemplateId ?? undefined;

  let eligible = detectionModels.filter((m) => m.enabled);
  if (isGeometryAnnotationType(project.annotationType)) {
    eligible = getEligiblePreAnnotModels(
      project.annotationType as ImageAnnotationType,
      detectionModels,
      project.annotationType === 'keypoint' ? keypointTemplateId : undefined,
    );
  }

  return {
    projectId: project.id,
    name: project.name,
    directoryPath: project.directoryPath,
    modality: project.modality,
    annotationType: project.annotationType,
    labels: project.labels,
    annotationTypeLabel: getAnnotationTypeLabel(
      project.modality,
      project.annotationType,
    ),
    detectionModels: eligible.map((m) => ({
      id: m.id,
      name: m.name,
      isDefault: m.isDefault,
    })),
    keypointTemplateId:
      project.annotationType === 'keypoint' ? keypointTemplateId : undefined,
  };
}
