import { describe, expect, it, jest } from '@jest/globals';
import { buildClientContextPayload } from './agentClientContextBuilder';
import type { AnnotationProject } from '../types/annotation';

jest.mock('./annotationAgentBridge', () => ({
  getAnnotationWorkspaceAgentSnapshot: () => ({
    selectedAnnotationId: null,
    selectedAnnotationIds: [],
    workspaceProjectId: null,
  }),
}));

const sampleProject: AnnotationProject = {
  id: 'proj-1',
  name: 'Demo',
  directoryPath: '/tmp/project',
  modality: 'image',
  annotationType: 'bbox',
  labels: [{ id: 'l1', name: 'cat', color: '#f00' }],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('buildClientContextPayload', () => {
  it('omits annotation snapshot in editor work mode', () => {
    const payload = buildClientContextPayload({
      rootPath: '/tmp/project',
      activeFilePath: '/tmp/project/a.jpg',
      activeProject: sampleProject,
      agentMode: 'annotation',
      workMode: 'editor',
      detectionModels: [],
      workspaceMemoryEnabled: true,
      memoryIndex: '- leftover',
    });

    expect(payload.workMode).toBe('editor');
    expect(payload.agentMode).toBe('annotation');
    expect(payload.annotationProjectSnapshot).toBeUndefined();
    expect(payload.activeAnnotationProjectId).toBeNull();
    expect(payload.workspaceMemoryEnabled).toBe(false);
    expect(payload.memoryIndex).toBeNull();
  });

  it('forwards editor Ask as chat without annotation snapshot', () => {
    const payload = buildClientContextPayload({
      rootPath: '/tmp/project',
      activeFilePath: '/tmp/project/a.ts',
      activeProject: sampleProject,
      agentMode: 'chat',
      workMode: 'editor',
      detectionModels: [],
    });

    expect(payload.agentMode).toBe('chat');
    expect(payload.workMode).toBe('editor');
    expect(payload.annotationProjectSnapshot).toBeUndefined();
  });

  it('includes annotation snapshot in annotation work mode', () => {
    const payload = buildClientContextPayload({
      rootPath: '/tmp/project',
      activeFilePath: '/tmp/project/a.jpg',
      activeProject: sampleProject,
      agentMode: 'annotation',
      workMode: 'annotation',
      detectionModels: [],
    });

    expect(payload.annotationProjectSnapshot?.projectId).toBe('proj-1');
    expect(payload.activeAnnotationProjectId).toBe('proj-1');
    expect(payload.workspaceMemoryEnabled).toBe(false);
  });

  it('forwards workspace memory flag when enabled', () => {
    const payload = buildClientContextPayload({
      rootPath: '/tmp/project',
      activeFilePath: '/tmp/project/a.jpg',
      activeProject: sampleProject,
      agentMode: 'annotation',
      workMode: 'annotation',
      detectionModels: [],
      workspaceMemoryEnabled: true,
      memoryIndex: '- [进度](topics/progress.md)',
    });

    expect(payload.workspaceMemoryEnabled).toBe(true);
    expect(payload.memoryIndex).toBe('- [进度](topics/progress.md)');
  });
});
