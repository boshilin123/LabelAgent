import { useMemo } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import type {
  AnnotationPipelineStep,
  AnnotationPipelineTask,
  PipelineKind,
} from '../../types/agent';
import {
  isImageDetailPipelineStage,
  resolvePipelineImagePath,
  workerStepDisplayLabel,
  workerStepDisplayMessage,
} from '../../services/annotationAgent/pipelineImageSteps';
import { PIPELINE_TITLES } from '../../services/annotationAgent/pipelineKinds';

import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import './AgentAnnotationPipelineBlock.css';

interface AgentAnnotationPipelineBlockProps {
  steps: AnnotationPipelineStep[];
  collapsed: boolean;
  streaming?: boolean;
  pipelineCompleted?: boolean;
  batchCompleted?: boolean;
  pipelineKind?: PipelineKind;
  /** 客户端标注工具任务队列（从同消息 tool_call 块派生） */
  tasks?: AnnotationPipelineTask[];
  onToggle: () => void;
}

const TASK_STATUS_LABELS: Record<AnnotationPipelineTask['status'], string> = {
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  error: '失败',
};

function taskStatusIcon(status: AnnotationPipelineTask['status']): string {
  switch (status) {
    case 'done':
      return 'check';
    case 'error':
      return 'error';
    case 'running':
      return 'sync';
    default:
      return 'circle-large';
  }
}

function statusIcon(status: AnnotationPipelineStep['status']): string {
  switch (status) {
    case 'done':
      return 'check';
    case 'error':
    case 'skipped':
      return 'error';
    case 'running':
      return 'sync';
    default:
      return 'circle-large';
  }
}

function statusClass(status: AnnotationPipelineStep['status']): string {
  return `agent-pipeline-step--${status}`;
}

function sortWorkerSteps(
  steps: AnnotationPipelineStep[],
): AnnotationPipelineStep[] {
  const statusRank = (status: AnnotationPipelineStep['status']): number => {
    if (status === 'running') return 0;
    if (status === 'error' || status === 'skipped') return 1;
    return 2;
  };
  return [...steps].sort((a, b) => {
    const rank = statusRank(a.status) - statusRank(b.status);
    if (rank !== 0) return rank;
    const pathA = resolvePipelineImagePath(a) ?? a.message;
    const pathB = resolvePipelineImagePath(b) ?? b.message;
    return pathA.localeCompare(pathB, undefined, { numeric: true });
  });
}

export default function AgentAnnotationPipelineBlock({
  steps,
  collapsed,
  streaming = false,
  pipelineCompleted = false,
  batchCompleted = false,
  pipelineKind = 'batch',
  tasks,
  onToggle,
}: AgentAnnotationPipelineBlockProps) {
  const completed = pipelineCompleted || batchCompleted;
  const running = steps.some((s) => s.status === 'running');
  const pending = steps.some((s) => s.status === 'pending');
  const failed = steps.some(
    (s) => s.status === 'error' && !isImageDetailPipelineStage(s.stage),
  );
  const taskInProgress = (tasks ?? []).some(
    (t) => t.status === 'queued' || t.status === 'running',
  );
  // 进行中只认 step 状态；streaming 只兜底「尚无终态 step、等第一帧进度」的冷启动，
  // 避免 Keep All 后续跑（消息重新 streaming）时把已完成的 pipeline 又转起来。
  const inProgress =
    running ||
    pending ||
    taskInProgress ||
    (streaming && !failed && !completed && steps.length === 0);
  const titles = PIPELINE_TITLES[pipelineKind] ?? PIPELINE_TITLES.batch;
  const title = inProgress
    ? titles.active
    : failed
      ? titles.failed
      : titles.idle;

  const mainStages = steps.filter((s) => !isImageDetailPipelineStage(s.stage));
  const workerSteps = useMemo(
    () =>
      sortWorkerSteps(steps.filter((s) => isImageDetailPipelineStage(s.stage))),
    [steps],
  );
  const workerDoneCount = workerSteps.filter((s) => s.status === 'done').length;
  const workerErrorCount = workerSteps.filter(
    (s) => s.status === 'error' || s.status === 'skipped',
  ).length;

  return (
    <div className="agent-pipeline-block">
      <button
        type="button"
        className="agent-pipeline-toggle"
        onClick={onToggle}
      >
        <VscodeIcon
          name={collapsed ? 'chevron-right' : 'chevron-down'}
          size={12}
        />
        <span>{title}</span>
        {inProgress && (
          <VscodeIcon name="sync" size={12} className="agent-pipeline-spin" />
        )}
      </button>

      {!collapsed && (
        <div className="agent-pipeline-body">
          {tasks && tasks.length > 0 ? (
            <ul className="agent-pipeline-list agent-pipeline-list--tasks">
              {tasks.map((task) => (
                <li
                  key={task.id}
                  className={`agent-pipeline-step agent-pipeline-step--task agent-pipeline-step--${task.status}`}
                >
                  <VscodeIcon
                    name={taskStatusIcon(task.status)}
                    size={14}
                    className={
                      task.status === 'running'
                        ? 'agent-pipeline-spin'
                        : undefined
                    }
                  />
                  <div className="agent-pipeline-step-text">
                    <span className="agent-pipeline-step-label">
                      {task.label}
                    </span>
                    <span className="agent-pipeline-step-message">
                      {TASK_STATUS_LABELS[task.status]}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <ul className="agent-pipeline-list">
            {mainStages.map((step) => (
              <li
                key={`${step.stage}-${step.message}`}
                className={`agent-pipeline-step ${statusClass(step.status)}`}
              >
                <VscodeIcon
                  name={statusIcon(step.status)}
                  size={14}
                  className={
                    inProgress && step.status === 'running'
                      ? 'agent-pipeline-spin'
                      : undefined
                  }
                />
                <div className="agent-pipeline-step-text">
                  <span className="agent-pipeline-step-label">
                    {step.label}
                  </span>
                  <span className="agent-pipeline-step-message">
                    {step.message}
                  </span>
                  {step.detail ? (
                    <span className="agent-pipeline-step-detail">
                      {step.detail}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          {workerSteps.length > 0 && pipelineKind === 'batch' ? (
            <details className="agent-pipeline-workers" open={inProgress}>
              <summary>
                图片处理明细（{workerSteps.length}
                {!inProgress && workerSteps.length > 0
                  ? ` · 成功 ${workerDoneCount}${workerErrorCount ? ` · 失败 ${workerErrorCount}` : ''}`
                  : ''}
                ）
              </summary>
              <OverlayVerticalScrollArea maxHeight="160px">
                <ul className="agent-pipeline-list agent-pipeline-list--nested">
                  {workerSteps.map((step) => {
                    const rowKey =
                      resolvePipelineImagePath(step) ??
                      `${step.stage}-${step.message}`;
                    const displayMessage = workerStepDisplayMessage(step);
                    return (
                      <li
                        key={rowKey}
                        className={`agent-pipeline-step ${statusClass(step.status)}`}
                      >
                        <VscodeIcon
                          name={statusIcon(step.status)}
                          size={12}
                          className={
                            inProgress && step.status === 'running'
                              ? 'agent-pipeline-spin'
                              : undefined
                          }
                        />
                        <div className="agent-pipeline-step-text">
                          <span className="agent-pipeline-step-label">
                            {workerStepDisplayLabel(step)}
                          </span>
                          <span className="agent-pipeline-step-message">
                            {displayMessage}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </OverlayVerticalScrollArea>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}
