import { describe, expect, it } from '@jest/globals';
import { readStoredWorkMode } from './workModeStorage';

describe('readStoredWorkMode', () => {
  it('defaults to editor when storage empty', () => {
    localStorage.removeItem('lr-agent:workMode');
    expect(readStoredWorkMode()).toBe('editor');
  });

  it('restores annotation when stored', () => {
    localStorage.setItem('lr-agent:workMode', 'annotation');
    expect(readStoredWorkMode()).toBe('annotation');
  });
});
