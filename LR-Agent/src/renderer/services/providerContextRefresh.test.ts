import {
  ensureLlmProviderContext,
  invalidateLlmProviderContext,
} from './llmProviderService';
import { probeLlmProviderContextOnApi } from './llmProviderApi';
import type { LlmProviderConfig } from '../../shared/agentTypes';

jest.mock('./llmProviderApi', () => ({
  probeLlmProviderContextOnApi: jest.fn(),
}));
const probe = jest.mocked(probeLlmProviderContextOnApi);
function provider(
  overrides: Partial<LlmProviderConfig> = {},
): LlmProviderConfig {
  return {
    id: 'p',
    name: 'p',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'local-test-key',
    model: 'deepseek-flash',
    enabled: true,
    isDefault: true,
    supportsVision: false,
    visionProbedAt: null,
    visionProbeDetail: '',
    contextWindowTokens: 128_000,
    contextWindowSource: 'heuristic',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
beforeEach(() => {
  invalidateLlmProviderContext();
  probe.mockReset();
});

it('refreshes actual model metadata and reuses it for repeated sends', async () => {
  probe.mockResolvedValue(
    provider({ contextWindowTokens: 1_048_576, contextWindowSource: 'probe' }),
  );
  const first = await ensureLlmProviderContext(provider());
  const second = await ensureLlmProviderContext(provider());
  expect(first.contextWindowTokens).toBe(1_048_576);
  expect(second.contextWindowTokens).toBe(1_048_576);
  expect(first.apiKey).toBe('local-test-key');
  expect(probe).toHaveBeenCalledTimes(1);
});

it('keeps manual model windows untouched', async () => {
  const manual = provider({
    contextWindowTokens: 64_000,
    contextWindowSource: 'manual',
  });
  expect(await ensureLlmProviderContext(manual)).toBe(manual);
  expect(probe).not.toHaveBeenCalled();
});

it('retains existing metadata when discovery is unavailable', async () => {
  probe.mockRejectedValue(new Error('offline'));
  const original = provider();
  expect(await ensureLlmProviderContext(original)).toBe(original);
});

it('does not use the window of a model changed during discovery', async () => {
  probe.mockResolvedValue(
    provider({ model: 'other', contextWindowTokens: 2_000_000 }),
  );
  const original = provider();
  expect(await ensureLlmProviderContext(original)).toBe(original);
});

it('invalidates cached probes after a provider configuration change', async () => {
  probe.mockResolvedValue(provider());
  await ensureLlmProviderContext(provider());
  invalidateLlmProviderContext('p');
  await ensureLlmProviderContext(provider());
  expect(probe).toHaveBeenCalledTimes(2);
});
