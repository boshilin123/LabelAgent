import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readSourceTextForProject } from './sourceTextUtil';

import { readWorkspaceTextFile } from '../../../utils/workspaceFileRead';

jest.mock('../../../utils/workspaceFileRead', () => ({
  readWorkspaceTextFile: jest.fn(),
}));

const mockRead = readWorkspaceTextFile as jest.MockedFunction<
  typeof readWorkspaceTextFile
>;

describe('readSourceTextForProject', () => {
  beforeEach(() => {
    mockRead.mockReset();
  });

  it('returns file content when exists', async () => {
    mockRead.mockResolvedValue({
      content: '水池问题正文',
      exists: true,
    });
    const text = await readSourceTextForProject('/project', 'pool.txt');
    expect(text).toBe('水池问题正文');
    expect(mockRead).toHaveBeenCalledWith({
      project: { directoryPath: '/project' },
      workspaceRoot: null,
      relativePath: 'pool.txt',
    });
  });

  it('returns empty string when file missing', async () => {
    mockRead.mockResolvedValue({ content: '', exists: false });
    const text = await readSourceTextForProject('/project', 'missing.txt');
    expect(text).toBe('');
  });
});
