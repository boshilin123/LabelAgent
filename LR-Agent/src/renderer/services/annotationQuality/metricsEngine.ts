import { bboxQualityPlugin } from './bboxQualityPlugin';
import type {
  AnnotationQualitySnapshot,
  QualityDashboardViewModel,
  QualityMetricPlugin,
} from './types';

const plugins: QualityMetricPlugin[] = [bboxQualityPlugin];

export function runQualityMetricsEngine(
  snapshot: AnnotationQualitySnapshot,
): QualityDashboardViewModel {
  const plugin = plugins.find((p) =>
    p.supportedTypes.includes(snapshot.annotationType),
  );

  if (!plugin) {
    return { snapshot, metrics: [], findings: [] };
  }

  const { metrics, findings } = plugin.compute(snapshot);
  return { snapshot, metrics, findings };
}
