import QualityEChart from './QualityEChart';
import type { QualityMetric } from '../../services/annotationQuality/types';

interface QualityMetricCardProps {
  metric: QualityMetric;
}

function severityLabel(severity: QualityMetric['severity']): string {
  switch (severity) {
    case 'critical':
      return '严重';
    case 'warning':
      return '警告';
    default:
      return '正常';
  }
}

export default function QualityMetricCard({ metric }: QualityMetricCardProps) {
  return (
    <article
      className={`quality-metric-card quality-metric-card--${metric.severity}`}
    >
      <header className="quality-metric-card__header">
        <h3 className="quality-metric-card__title">{metric.title}</h3>
        <span
          className={`quality-metric-card__badge quality-metric-card__badge--${metric.severity}`}
        >
          {severityLabel(metric.severity)}
        </span>
      </header>
      <p className="quality-metric-card__summary">{metric.summary}</p>
      {metric.chartBindings.map((binding) => (
        <div key={binding.chartId} className="quality-metric-card__chart">
          <QualityEChart
            option={binding.option}
            height={
              binding.chartId === 'label_distribution_pie' ? 280 : undefined
            }
          />
        </div>
      ))}
    </article>
  );
}
