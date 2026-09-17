import { describe, expect, it } from '@jest/globals';
import type { AnnotationPipelineStep } from '../../../shared/agentTypes';
import {
  buildPipelineStepFromProgressEvent,
  upsertPipelineSteps,
} from './pipelineStepAccumulator';

describe('pipelineStepAccumulator', () => {
  it('builds pipeline step from progress event', () => {
    const step = buildPipelineStepFromProgressEvent({
      type: 'annotation_progress',
      stage: 'prepare',
      message: '正在准备…',
      status: 'running',
    });
    expect(step.stage).toBe('prepare');
    expect(step.message).toBe('正在准备…');
    expect(step.status).toBe('running');
  });

  it('upserts main stage and marks previous running as done', () => {
    const initial: AnnotationPipelineStep[] = [
      {
        stage: 'prepare',
        label: '准备',
        message: '准备中',
        status: 'running',
      },
    ];
    const next = upsertPipelineSteps(initial, {
      type: 'annotation_progress',
      stage: 'generate',
      message: '生成中',
      status: 'running',
    });
    expect(next).toHaveLength(2);
    expect(next[0].status).toBe('done');
    expect(next[1].stage).toBe('generate');
    expect(next[1].status).toBe('running');
  });

  it('updates existing stage in place', () => {
    const initial: AnnotationPipelineStep[] = [
      {
        stage: 'prepare',
        label: '准备',
        message: '准备中',
        status: 'running',
      },
    ];
    const next = upsertPipelineSteps(initial, {
      type: 'annotation_progress',
      stage: 'prepare',
      message: '准备完成',
      status: 'done',
      detail: '已选定 1 张图片',
    });
    expect(next).toHaveLength(1);
    expect(next[0].message).toBe('准备完成');
    expect(next[0].status).toBe('done');
    expect(next[0].detail).toBe('已选定 1 张图片');
  });

  it('marks all running steps as error when a main-stage fails', () => {
    const initial: AnnotationPipelineStep[] = [
      {
        stage: 'prepare',
        label: '准备',
        message: '准备完成',
        status: 'done',
      },
      {
        stage: 'workers',
        label: '批量处理',
        message: '处理中',
        status: 'running',
      },
      {
        stage: 'worker',
        label: '处理图片',
        message: '处理中：data/1.jpg',
        status: 'running',
        imagePath: 'data/1.jpg',
      },
    ];
    const next = upsertPipelineSteps(initial, {
      type: 'annotation_progress',
      stage: 'prepare',
      message: '未能生成可应用的矩形框标注。',
      status: 'error',
    });
    expect(next.find((step) => step.stage === 'prepare')?.status).toBe('error');
    expect(next.find((step) => step.stage === 'workers')?.status).toBe('error');
    expect(next.find((step) => step.stage === 'worker')?.status).toBe('error');
  });

  it('does not mark other images error when one worker fails', () => {
    const initial: AnnotationPipelineStep[] = [
      {
        stage: 'workers',
        label: '批量处理',
        message: '处理中',
        status: 'running',
      },
      {
        stage: 'worker',
        label: '处理图片',
        message: '处理中：data/1.jpg',
        status: 'running',
        imagePath: 'data/1.jpg',
      },
      {
        stage: 'worker',
        label: '处理图片',
        message: '处理中：data/2.jpg',
        status: 'running',
        imagePath: 'data/2.jpg',
      },
    ];
    const next = upsertPipelineSteps(initial, {
      type: 'annotation_progress',
      stage: 'worker',
      message: '跳过：data/1.jpg',
      status: 'error',
      imagePath: 'data/1.jpg',
    });
    expect(next.find((step) => step.imagePath === 'data/1.jpg')?.status).toBe(
      'error',
    );
    expect(next.find((step) => step.imagePath === 'data/2.jpg')?.status).toBe(
      'running',
    );
    expect(next.find((step) => step.stage === 'workers')?.status).toBe(
      'running',
    );
  });
});
