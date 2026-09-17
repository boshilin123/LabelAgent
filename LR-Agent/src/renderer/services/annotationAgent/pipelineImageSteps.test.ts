import type { AnnotationPipelineStep } from '../../../shared/agentTypes';
import {
  extractImagePathFromWorkerMessage,
  upsertImageDetailPipelineStep,
} from './pipelineImageSteps';

function workerStep(
  partial: Partial<AnnotationPipelineStep> &
    Pick<AnnotationPipelineStep, 'message' | 'status'>,
): AnnotationPipelineStep {
  return {
    stage: 'worker',
    label: '处理图片',
    ...partial,
  };
}

describe('pipelineImageSteps', () => {
  it('extracts path from worker messages', () => {
    expect(extractImagePathFromWorkerMessage('完成：data/7.jpg')).toBe(
      'data/7.jpg',
    );
    expect(extractImagePathFromWorkerMessage('处理中 (2/5)：foo/bar.png')).toBe(
      'foo/bar.png',
    );
  });

  it('upserts running and done for the same image into one row', () => {
    let steps: AnnotationPipelineStep[] = [];
    steps = upsertImageDetailPipelineStep(
      steps,
      workerStep({
        message: '处理中 (1/3)：a.jpg',
        status: 'running',
        imagePath: 'a.jpg',
      }),
    );
    steps = upsertImageDetailPipelineStep(
      steps,
      workerStep({
        message: '完成：a.jpg',
        status: 'done',
        detail: '映射 2 框',
        imagePath: 'a.jpg',
      }),
    );
    steps = upsertImageDetailPipelineStep(
      steps,
      workerStep({
        message: '完成：b.jpg',
        status: 'done',
        detail: '映射 4 框',
        imagePath: 'b.jpg',
      }),
    );
    const details = steps.filter((s) => s.stage === 'worker');
    expect(details).toHaveLength(2);
    expect(details.find((s) => s.imagePath === 'a.jpg')?.status).toBe('done');
    expect(details.find((s) => s.imagePath === 'b.jpg')?.detail).toBe(
      '映射 4 框',
    );
  });
});
