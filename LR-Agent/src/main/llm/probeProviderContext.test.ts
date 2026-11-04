import { probeAndPersistProviderContext } from './probeProviderContext';
import { runContextProbeRequest } from './contextProbe';
import * as repo from '../db/providerRepository';

jest.mock('./contextProbe', () => ({ runContextProbeRequest: jest.fn() }));
jest.mock('../db/providerRepository', () => ({
  getProvider: jest.fn(),
  updateProvider: jest.fn(),
}));
const getProvider = jest.mocked(repo.getProvider);
const updateProvider = jest.mocked(repo.updateProvider);
const runProbe = jest.mocked(runContextProbeRequest);
function row(overrides: Partial<repo.ProviderRow> = {}): repo.ProviderRow {
  return {
    id: 'p',
    name: 'p',
    base_url: 'https://example.invalid/v1',
    api_key_encrypted: 'test-only-key',
    encryption_key_id: 'test',
    model: 'deepseek-flash',
    enabled: 1,
    is_default: 1,
    supports_vision: 0,
    vision_probed_at: null,
    vision_probe_detail: '',
    context_window_tokens: null,
    context_window_source: '',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}
beforeEach(() => {
  jest.clearAllMocks();
});

it('persists the exact discovered window', async () => {
  getProvider.mockReturnValue(row());
  runProbe.mockResolvedValue({
    contextWindowTokens: 1_048_576,
    source: 'probe',
    detail: 'probe_ok',
  });
  updateProvider.mockReturnValue(
    row({ context_window_tokens: 1_048_576, context_window_source: 'probe' }),
  );
  await probeAndPersistProviderContext('p');
  expect(updateProvider).toHaveBeenCalledWith('p', {
    contextWindowTokens: 1_048_576,
    contextWindowSource: 'probe',
  });
});

it('preserves a manual window set while a probe is in flight', async () => {
  const manual = row({
    context_window_tokens: 64_000,
    context_window_source: 'manual',
  });
  getProvider.mockReturnValueOnce(row()).mockReturnValue(manual);
  runProbe.mockResolvedValue({
    contextWindowTokens: 1_048_576,
    source: 'probe',
    detail: 'probe_ok',
  });
  expect(await probeAndPersistProviderContext('p')).toBe(manual);
  expect(updateProvider).not.toHaveBeenCalled();
});

it('does not erase an existing window when discovery fails', async () => {
  const existing = row({
    context_window_tokens: 128_000,
    context_window_source: 'heuristic',
  });
  getProvider.mockReturnValue(existing);
  runProbe.mockResolvedValue({
    contextWindowTokens: null,
    source: '',
    detail: 'probe_error:http_503',
  });
  expect(await probeAndPersistProviderContext('p')).toBe(existing);
  expect(updateProvider).not.toHaveBeenCalled();
});
