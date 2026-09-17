import { describe, expect, it } from '@jest/globals';
import type { LlmProviderConfig } from '../../../shared/agentTypes';
import type { AnnotationProject } from '../../types/annotation';
import { buildQuickInferencePrompt } from './quickInferencePrompts';
import {
  evaluateQuickInferenceReadiness,
  getQuickInferenceUnsupportedReason,
  isQuickInferenceSupported,
  requiresVisionForQuickInference,
} from './quickInferenceSupport';

const mockProvider: LlmProviderConfig = {
  id: 'p1',
  name: 'Test',
  enabled: true,
  apiKey: 'k',
  baseUrl: 'http://localhost',
  model: 'm',
  supportsVision: false,
  isDefault: false,
  visionProbedAt: null,
  visionProbeDetail: '',
  contextWindowTokens: null,
  contextWindowSource: '',
  createdAt: 0,
  updatedAt: 0,
};

const baseProject: AnnotationProject = {
  id: 'p1',
  name: 'Demo',
  directoryPath: '/proj',
  modality: 'image',
  annotationType: 'caption',
  labels: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('isQuickInferenceSupported', () => {
  it('supports all 12 annotation types', () => {
    const types = [
      'caption',
      'classification',
      'instruction',
      'cot',
      'conversation',
      'preference',
      'bbox',
      'rotated_bbox',
      'polygon',
      'keypoint',
      'span_ner',
      'text_classification',
    ] as const;
    for (const type of types) {
      expect(isQuickInferenceSupported(type)).toBe(true);
    }
  });
});

describe('getQuickInferenceUnsupportedReason', () => {
  it('returns null for supported types', () => {
    expect(getQuickInferenceUnsupportedReason('caption')).toBeNull();
    expect(getQuickInferenceUnsupportedReason('span_ner')).toBeNull();
  });
});

describe('requiresVisionForQuickInference', () => {
  it('requires vision for image LLM types only', () => {
    expect(requiresVisionForQuickInference('caption')).toBe(true);
    expect(requiresVisionForQuickInference('classification')).toBe(true);
    expect(requiresVisionForQuickInference('instruction')).toBe(false);
    expect(requiresVisionForQuickInference('bbox')).toBe(false);
    expect(requiresVisionForQuickInference('span_ner')).toBe(false);
  });
});

describe('evaluateQuickInferenceReadiness', () => {
  it('blocks when file or provider missing', () => {
    const result = evaluateQuickInferenceReadiness({
      annotationModeActive: true,
      project: baseProject,
      projectRootMatched: true,
      relativeFilePath: null,
      provider: null,
      detectionModels: [],
      running: false,
    });
    expect(result.canRun).toBe(false);
    expect(result.disabledReason).toContain('请先打开要标注的文件');
  });

  it('blocks caption when provider lacks vision', () => {
    const result = evaluateQuickInferenceReadiness({
      annotationModeActive: true,
      project: baseProject,
      projectRootMatched: true,
      relativeFilePath: 'a.jpg',
      provider: mockProvider,
      detectionModels: [],
      running: false,
    });
    expect(result.canRun).toBe(false);
    expect(result.disabledReason).toContain('视觉');
  });

  it('blocks unsupported annotation types', () => {
    const result = evaluateQuickInferenceReadiness({
      annotationModeActive: true,
      project: {
        ...baseProject,
        annotationType: 'span_ner',
        modality: 'text',
      },
      projectRootMatched: true,
      relativeFilePath: 'doc.txt',
      provider: mockProvider,
      detectionModels: [],
      running: false,
    });
    expect(result.canRun).toBe(true);
  });
});

describe('buildQuickInferencePrompt', () => {
  it('includes project description when set', () => {
    const prompt = buildQuickInferencePrompt('span_ner', {
      ...baseProject,
      modality: 'text',
      annotationType: 'span_ner',
      description: '标注人物与组织',
    });
    expect(prompt).toContain('命名实体');
    expect(prompt).toContain('标注人物与组织');
  });
});
