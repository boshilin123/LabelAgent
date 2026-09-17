import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  VscodeButton,
  VscodeOption,
  VscodeProgressRing,
  VscodeSingleSelect,
} from '@vscode-elements/react-elements';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { usePretrainedModels } from '../../context/PretrainedModelsContext';
import { useToast } from '../../context/ToastContext';
import {
  assertPreAnnotResult,
  runPreAnnot,
} from '../../services/preAnnotService';
import type { ImageAnnotationType } from '../../types/annotation';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import { getKeypointTemplate } from '../../types/keypointTemplate';
import {
  isDetectResult,
  isPolygonResult,
  isPoseResult,
} from '../../../shared/preAnnotTypes';
import {
  getEligiblePreAnnotModels,
  loadSavedPreAnnotModelId,
  pickDefaultPreAnnotModel,
  savePreAnnotModelId,
} from '../../utils/preAnnotModelFilter';
import { resolveLabelIdForPoseTemplate } from '../../utils/preAnnotLabelMapping';
import './PreAnnotToolbarSection.css';

export interface PreAnnotToolbarSectionProps {
  mode: 'bbox' | 'rotated_bbox' | 'polygon' | 'keypoint';
  imagePath: string;
  disabled?: boolean;
}

function getModelOptionLabel(model: PretrainedModelConfig): string {
  return (
    model.name.trim() || model.checkpointPath.split(/[/\\]/).pop() || model.id
  );
}

function isBboxGeometry(
  geometry: unknown,
): geometry is { x: number; y: number; width: number; height: number } {
  return (
    typeof geometry === 'object' &&
    geometry !== null &&
    'x' in geometry &&
    'y' in geometry
  );
}

function isObbGeometry(geometry: unknown): geometry is {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
} {
  return (
    typeof geometry === 'object' &&
    geometry !== null &&
    'cx' in geometry &&
    'angle' in geometry
  );
}

export default function PreAnnotToolbarSection({
  mode,
  imagePath,
  disabled = false,
}: PreAnnotToolbarSectionProps) {
  const { activeProject } = useAnnotation();
  const { showToast } = useToast();
  const { models, loading: modelsLoading } = usePretrainedModels();
  const {
    activeTemplateId,
    activeLabelId,
    setTool,
    addPreAnnotBboxes,
    addPreAnnotRotatedBboxes,
    addPreAnnotPoses,
    clearPreAnnots,
  } = useAnnotationWorkspace();

  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [running, setRunning] = useState(false);

  const annotationType = mode as ImageAnnotationType;

  const eligibleModels = useMemo(
    () =>
      getEligiblePreAnnotModels(
        annotationType,
        models,
        mode === 'keypoint' ? activeTemplateId : undefined,
      ),
    [annotationType, models, mode, activeTemplateId],
  );

  const selectedModel = useMemo(
    () => eligibleModels.find((m) => m.id === selectedModelId) ?? null,
    [eligibleModels, selectedModelId],
  );

  useEffect(() => {
    if (!activeProject || eligibleModels.length === 0) {
      setSelectedModelId('');
      return;
    }

    const saved = loadSavedPreAnnotModelId(activeProject.id);
    const savedModel = saved
      ? eligibleModels.find((m) => m.id === saved)
      : null;
    const fallback = pickDefaultPreAnnotModel(
      annotationType,
      models,
      mode === 'keypoint' ? activeTemplateId : undefined,
    );

    setSelectedModelId((savedModel ?? fallback)?.id ?? '');
  }, [
    activeProject,
    eligibleModels,
    annotationType,
    models,
    mode,
    activeTemplateId,
  ]);

  const persistModelChoice = useCallback(
    (modelId: string) => {
      setSelectedModelId(modelId);
      if (activeProject && modelId) {
        savePreAnnotModelId(activeProject.id, modelId);
      }
    },
    [activeProject],
  );

  const handleClear = useCallback(() => {
    const count = clearPreAnnots();
    showToast(count > 0 ? `已清除 ${count} 条预标注` : '当前没有预标注可清除', {
      type: 'info',
    });
  }, [clearPreAnnots, showToast]);

  const runDetect = useCallback(async () => {
    if (!selectedModel || !imagePath || !activeProject) return;

    setRunning(true);
    try {
      const kind = mode === 'rotated_bbox' ? 'yolo_obb' : 'yolo_detect';
      const response = await runPreAnnot(kind, imagePath, selectedModel);
      const result = assertPreAnnotResult(response, isDetectResult, '检测');

      if (mode === 'bbox') {
        const mapped = result.items.flatMap((item) => {
          if (!isBboxGeometry(item.geometry)) return [];
          return [
            {
              labelId: null,
              x: item.geometry.x,
              y: item.geometry.y,
              width: item.geometry.width,
              height: item.geometry.height,
            },
          ];
        });

        const count = addPreAnnotBboxes(mapped);
        showToast(count > 0 ? `已生成 ${count} 条预标注` : '未检测到目标', {
          type: 'info',
        });
        return;
      }

      const mapped = result.items.flatMap((item) => {
        if (!isObbGeometry(item.geometry)) return [];
        return [
          {
            labelId: null,
            cx: item.geometry.cx,
            cy: item.geometry.cy,
            width: item.geometry.width,
            height: item.geometry.height,
            angle: item.geometry.angle,
          },
        ];
      });

      const count = addPreAnnotRotatedBboxes(mapped);
      showToast(count > 0 ? `已生成 ${count} 条预标注` : '未检测到目标', {
        type: 'info',
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '预标注失败', {
        type: 'error',
      });
    } finally {
      setRunning(false);
    }
  }, [
    selectedModel,
    imagePath,
    activeProject,
    mode,
    addPreAnnotBboxes,
    addPreAnnotRotatedBboxes,
    showToast,
  ]);

  const runKeypoint = useCallback(
    async (kind: 'keypoint_full' | 'keypoint_roi') => {
      if (!selectedModel || !imagePath || !activeProject) return;

      const template = getKeypointTemplate(activeTemplateId);
      if (!template) {
        showToast('未找到当前骨架模板', { type: 'error' });
        return;
      }

      const labelId = resolveLabelIdForPoseTemplate(
        template,
        activeProject.labels,
      );
      if (!labelId) {
        showToast(
          `请先在项目中添加与模板匹配的标签「${template.defaultLabel}」`,
          { type: 'info' },
        );
        return;
      }

      if (kind === 'keypoint_roi') {
        setTool('preannot_roi_box');
        showToast('请在画布上框选区域', { type: 'info' });
        return;
      }

      setRunning(true);
      try {
        const response = await runPreAnnot(
          'keypoint_full',
          imagePath,
          selectedModel,
          {
            templateId: activeTemplateId,
          },
        );
        const result = assertPreAnnotResult(response, isPoseResult, '关键点');

        const items = result.poses.map((pose) => ({
          labelId,
          templateId: pose.templateId || activeTemplateId,
          cx: pose.cx,
          cy: pose.cy,
          width: pose.width,
          height: pose.height,
          angle: pose.angle,
          keypoints: pose.keypoints.map((kp) => ({
            x: kp.x,
            y: kp.y,
            visibility: kp.visibility,
          })),
        }));

        const count = addPreAnnotPoses(items);
        showToast(count > 0 ? `已生成 ${count} 条骨架预标注` : '未检测到实例', {
          type: 'info',
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : '关键点预标注失败', {
          type: 'error',
        });
      } finally {
        setRunning(false);
      }
    },
    [
      selectedModel,
      imagePath,
      activeProject,
      activeTemplateId,
      setTool,
      addPreAnnotPoses,
      showToast,
    ],
  );

  const handleSamBoxTool = useCallback(() => {
    if (!activeLabelId) {
      showToast('请先选择绘制标签', { type: 'info' });
      return;
    }
    if (!selectedModel) {
      showToast('请先选择 SAM2 模型', { type: 'info' });
      return;
    }
    setTool('preannot_sam_box');
    showToast('请在画布上框选分割区域', { type: 'info' });
  }, [activeLabelId, selectedModel, setTool, showToast]);

  if (!activeProject) return null;

  const controlsDisabled = disabled || running || modelsLoading || !imagePath;

  return (
    <div className="preannot-toolbar-section">
      <div className="image-annotation-toolbar-divider" aria-hidden />

      <div className="preannot-toolbar-group" role="group" aria-label="预标注">
        <VscodeSingleSelect
          className="preannot-model-select"
          value={selectedModelId}
          disabled={controlsDisabled || eligibleModels.length === 0}
          aria-label="选择预训练模型"
          onChange={(event) => {
            const target = event.target as HTMLElement & { value?: string };
            if (typeof target.value === 'string') {
              persistModelChoice(target.value);
            }
          }}
        >
          {eligibleModels.length === 0 ? (
            <VscodeOption value="" disabled>
              无可用模型
            </VscodeOption>
          ) : (
            eligibleModels.map((model: PretrainedModelConfig) => (
              <VscodeOption key={model.id} value={model.id}>
                {getModelOptionLabel(model)}
              </VscodeOption>
            ))
          )}
        </VscodeSingleSelect>

        {running ? <VscodeProgressRing /> : null}

        {(mode === 'bbox' || mode === 'rotated_bbox') && (
          <VscodeButton
            secondary
            icon="sparkle"
            disabled={controlsDisabled || !selectedModel}
            onClick={() => runDetect()}
          >
            生成预标注
          </VscodeButton>
        )}

        {mode === 'polygon' && (
          <VscodeButton
            secondary
            icon="selection"
            disabled={controlsDisabled || !selectedModel}
            onClick={handleSamBoxTool}
          >
            框选分割
          </VscodeButton>
        )}

        {mode === 'keypoint' && (
          <>
            <VscodeButton
              secondary
              icon="sparkle"
              disabled={controlsDisabled || !selectedModel}
              onClick={() => runKeypoint('keypoint_full')}
            >
              检测全部
            </VscodeButton>
            <VscodeButton
              secondary
              icon="selection"
              disabled={controlsDisabled || !selectedModel}
              onClick={() => runKeypoint('keypoint_roi')}
            >
              框选检测
            </VscodeButton>
          </>
        )}

        <VscodeButton
          secondary
          icon="discard"
          disabled={controlsDisabled}
          onClick={handleClear}
        >
          清除预标注
        </VscodeButton>
      </div>
    </div>
  );
}

/** Run SAM2 box segmentation — called from polygon editor after user draws a box */
export async function runSam2PreAnnot(params: {
  imagePath: string;
  model: PretrainedModelConfig;
  box: { x1: number; y1: number; x2: number; y2: number };
}): Promise<{ x: number; y: number }[]> {
  const response = await runPreAnnot(
    'sam2_box',
    params.imagePath,
    params.model,
    {
      box: params.box,
    },
  );
  const result = assertPreAnnotResult(response, isPolygonResult, 'SAM2');
  return result.points;
}

/** Run keypoint ROI detection — called from keypoint editor after user draws a box */
export async function runKeypointRoiPreAnnot(params: {
  imagePath: string;
  model: PretrainedModelConfig;
  templateId: string;
  box: { x1: number; y1: number; x2: number; y2: number };
}): Promise<
  Array<{
    templateId: string;
    cx: number;
    cy: number;
    width: number;
    height: number;
    angle: number;
    keypoints: { x: number; y: number; visibility: 0 | 1 | 2 }[];
  }>
> {
  const response = await runPreAnnot(
    'keypoint_roi',
    params.imagePath,
    params.model,
    {
      templateId: params.templateId,
      box: params.box,
    },
  );
  const result = assertPreAnnotResult(response, isPoseResult, '关键点');
  return result.poses.map((pose) => ({
    templateId: pose.templateId,
    cx: pose.cx,
    cy: pose.cy,
    width: pose.width,
    height: pose.height,
    angle: pose.angle,
    keypoints: pose.keypoints.map((kp) => ({
      x: kp.x,
      y: kp.y,
      visibility: kp.visibility,
    })),
  }));
}
