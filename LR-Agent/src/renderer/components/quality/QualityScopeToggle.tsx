import type { QualityScope } from '../../services/annotationQuality/types';

interface QualityScopeToggleProps {
  scope: QualityScope;
  scopePath?: string;
  onChange: (scope: QualityScope) => void;
}

export default function QualityScopeToggle({
  scope,
  scopePath,
  onChange,
}: QualityScopeToggleProps) {
  return (
    <div className="quality-scope-toggle">
      <button
        type="button"
        className={`quality-scope-btn${scope === 'full_project' ? ' quality-scope-btn--active' : ''}`}
        onClick={() => onChange('full_project')}
      >
        全项目
      </button>
      <button
        type="button"
        className={`quality-scope-btn${scope === 'current_folder' ? ' quality-scope-btn--active' : ''}`}
        onClick={() => onChange('current_folder')}
        title={
          scopePath
            ? `当前文件夹：${scopePath}`
            : '将使用当前打开图片所在文件夹'
        }
      >
        当前文件夹
      </button>
    </div>
  );
}
