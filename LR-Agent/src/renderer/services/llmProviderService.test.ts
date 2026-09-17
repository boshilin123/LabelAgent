import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  loadAuxiliaryProviderId,
  persistAuxiliaryProviderId,
  resolveAuxiliaryProvider,
} from './llmProviderService';
import type { LlmProviderConfig } from '../../shared/agentTypes';

function provider(id: string, enabled = true): LlmProviderConfig {
  return {
    id,
    name: id,
    baseUrl: 'https://example.com',
    apiKey: 'k',
    model: 'm',
    enabled,
    isDefault: false,
    supportsVision: false,
    visionProbedAt: null,
    visionProbeDetail: '',
    contextWindowTokens: null,
    contextWindowSource: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('auxiliary provider', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('persists and loads aux provider id', () => {
    expect(loadAuxiliaryProviderId()).toBeNull();
    persistAuxiliaryProviderId('aux-1');
    expect(loadAuxiliaryProviderId()).toBe('aux-1');
    persistAuxiliaryProviderId(null);
    expect(loadAuxiliaryProviderId()).toBeNull();
  });

  it('resolves only when configured, present and enabled', () => {
    const list = [provider('a'), provider('b', false)];
    expect(resolveAuxiliaryProvider(list)).toBeNull();

    persistAuxiliaryProviderId('a');
    expect(resolveAuxiliaryProvider(list)?.id).toBe('a');

    // 已禁用 → 回退 null（跟随会话模型）
    persistAuxiliaryProviderId('b');
    expect(resolveAuxiliaryProvider(list)).toBeNull();

    // 已删除 → 回退 null
    persistAuxiliaryProviderId('missing');
    expect(resolveAuxiliaryProvider(list)).toBeNull();
  });
});
