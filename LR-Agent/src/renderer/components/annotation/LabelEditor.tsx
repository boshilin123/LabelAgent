import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import { useRef } from 'react';
import { LABEL_COLOR_PRESETS, LabelDefinition } from '../../types/annotation';
import {
  findTemplatesByDefaultLabel,
  formatKeypointLabelRenameWarning,
} from '../../types/keypointTemplate';
import './LabelEditor.css';

interface LabelEditorProps {
  labels: LabelDefinition[];
  onChange: (labels: LabelDefinition[]) => void;
  /** When true, warn if renaming a template-bound label (person/hand/face) */
  keypointMode?: boolean;
  emptyHint?: string;
}

function nextPresetColor(index: number): string {
  return LABEL_COLOR_PRESETS[index % LABEL_COLOR_PRESETS.length];
}

export default function LabelEditor({
  labels,
  onChange,
  keypointMode = false,
  emptyHint,
}: LabelEditorProps) {
  const nameAtFocusRef = useRef<Map<string, string>>(new Map());

  const addLabel = () => {
    onChange([
      ...labels,
      {
        id: crypto.randomUUID(),
        name: '',
        color: nextPresetColor(labels.length),
      },
    ]);
  };

  const updateLabel = (id: string, patch: Partial<LabelDefinition>) => {
    onChange(
      labels.map((label) => (label.id === id ? { ...label, ...patch } : label)),
    );
  };

  const removeLabel = (id: string) => {
    onChange(labels.filter((label) => label.id !== id));
  };

  const handleNameFocus = (id: string, currentName: string) => {
    nameAtFocusRef.current.set(id, currentName);
  };

  const handleNameBlur = (id: string, newName: string) => {
    const originalName = nameAtFocusRef.current.get(id) ?? newName;
    nameAtFocusRef.current.delete(id);

    if (!keypointMode) return;

    const trimmedOrig = originalName.trim();
    const trimmedNew = newName.trim();
    if (
      !trimmedOrig ||
      trimmedNew.toLowerCase() === trimmedOrig.toLowerCase()
    ) {
      return;
    }

    const linkedTemplates = findTemplatesByDefaultLabel(trimmedOrig);
    if (linkedTemplates.length === 0) return;

    const confirmed = window.confirm(
      formatKeypointLabelRenameWarning(
        trimmedOrig,
        trimmedNew,
        linkedTemplates,
      ),
    );

    if (!confirmed) {
      updateLabel(id, { name: originalName });
    }
  };

  const defaultEmptyHint = keypointMode
    ? '将根据骨架模板自动生成 person、hand、face 等标签，也可手动添加。'
    : '可选：添加标签名称与颜色，后续标注时使用。';

  return (
    <div className="label-editor">
      <div className="label-editor-header">
        <span className="label-editor-title">
          {keypointMode ? '模板关联标签' : '标签定义'}
        </span>
        <VscodeButton secondary icon="add" onClick={addLabel}>
          添加标签
        </VscodeButton>
      </div>

      {keypointMode && labels.length > 0 ? (
        <p className="label-editor-keypoint-hint">
          以下名称与骨架模板绑定；改名可能导致对应模板无法匹配（失焦时会提示）。
        </p>
      ) : null}

      {labels.length === 0 ? (
        <p className="label-editor-empty">{emptyHint ?? defaultEmptyHint}</p>
      ) : (
        <ul className="label-editor-list">
          {labels.map((label) => {
            const linked = keypointMode
              ? findTemplatesByDefaultLabel(label.name)
              : [];
            return (
              <li key={label.id} className="label-editor-row">
                <input
                  type="color"
                  className="label-editor-color"
                  value={label.color}
                  onChange={(event) =>
                    updateLabel(label.id, { color: event.target.value })
                  }
                  aria-label="标签颜色"
                />
                <div className="label-editor-name-wrap">
                  <input
                    type="text"
                    className="label-editor-name"
                    placeholder={
                      keypointMode
                        ? '如 person、hand、face'
                        : '标签名称，如 dog'
                    }
                    value={label.name}
                    onFocus={() => handleNameFocus(label.id, label.name)}
                    onChange={(event) =>
                      updateLabel(label.id, { name: event.target.value })
                    }
                    onBlur={(event) =>
                      handleNameBlur(label.id, event.target.value)
                    }
                  />
                  {linked.length > 0 ? (
                    <span
                      className="label-editor-template-badge"
                      title={linked.map((t) => t.name).join('、')}
                    >
                      {linked.map((t) => t.name).join(' · ')}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="label-editor-remove"
                  aria-label="删除标签"
                  onClick={() => removeLabel(label.id)}
                >
                  <VscodeIcon name="close" size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function normalizeLabels(labels: LabelDefinition[]): LabelDefinition[] {
  const seen = new Set<string>();
  const result: LabelDefinition[] = [];

  labels.forEach((label) => {
    const name = label.name.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push({
      id: label.id,
      name,
      color: label.color,
    });
  });

  return result;
}
