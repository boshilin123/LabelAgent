import { syncWorkspaceFactMemory } from './workspaceFactMemory';
import type { AnnotationProject } from '../types/annotation';

function project(
  overrides: Partial<AnnotationProject> = {},
): AnnotationProject {
  return {
    id: 'proj-1',
    name: 'demo',
    directoryPath: 'D:/data/demo',
    modality: 'image',
    annotationType: 'bbox',
    labels: [],
    workspaceMemoryEnabled: true,
    createdAt: '1',
    updatedAt: '1',
    ...overrides,
  };
}

describe('syncWorkspaceFactMemory', () => {
  const syncFacts = jest.fn().mockResolvedValue({
    annotatedFiles: 1,
    annotationCount: 2,
  });

  beforeEach(() => {
    syncFacts.mockClear();
    const electron = window.electron as typeof window.electron & {
      memory: { syncFacts: typeof syncFacts };
    };
    electron.memory = {
      ...electron.memory,
      syncFacts,
    };
  });

  it('no-ops when workspace memory is disabled', async () => {
    await syncWorkspaceFactMemory(project({ workspaceMemoryEnabled: false }));
    expect(syncFacts).not.toHaveBeenCalled();
  });

  it('no-ops without a project', async () => {
    await syncWorkspaceFactMemory(null);
    expect(syncFacts).not.toHaveBeenCalled();
  });

  it('calls syncFacts when enabled', async () => {
    await syncWorkspaceFactMemory(project());
    expect(syncFacts).toHaveBeenCalledWith({
      scopeKey: 'projects/proj-1',
      projectDir: 'D:/data/demo',
    });
  });

  it('swallows IPC errors', async () => {
    syncFacts.mockRejectedValueOnce(new Error('boom'));
    await expect(syncWorkspaceFactMemory(project())).resolves.toBeUndefined();
  });
});
