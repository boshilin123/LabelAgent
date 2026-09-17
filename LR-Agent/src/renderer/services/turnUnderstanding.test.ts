import { buildApiClientContext } from './agentClientContext';
import type { ClientContextPayload } from '../../shared/agentTypes';

describe('buildApiClientContext', () => {
  it('passes directory and relative paths', () => {
    const ctx: ClientContextPayload = {
      activeRelativePath: 'data/2.jpg',
      projectDirectoryPath: 'D:/proj',
      annotationProjectSnapshot: {
        projectId: 'p1',
        name: 'demo',
        directoryPath: 'D:/proj',
        modality: 'image',
        annotationType: 'bbox',
        labels: [],
        detectionModels: [],
      },
    };
    const api = buildApiClientContext(ctx);
    expect(api.active_relative_path).toBe('data/2.jpg');
    expect(api.project_directory_path).toBe('D:/proj');
    const snap = api.annotation_project_snapshot as Record<string, unknown>;
    expect(snap.project_directory_path).toBe('D:/proj');
  });
});
