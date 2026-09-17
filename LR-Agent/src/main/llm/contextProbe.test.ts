import {
  heuristicContextWindow,
  interpretModelsResponse,
  matchModelsEntry,
} from './contextProbe';

describe('heuristicContextWindow', () => {
  it('matches the longest prefix for generational families', () => {
    // V4 单列 1M，不落到 deepseek 家族的 128K
    expect(heuristicContextWindow('deepseek-v4-flash-0731')).toBe(1_000_000);
    expect(heuristicContextWindow('deepseek-chat')).toBe(128_000);
    // Qwen 新代 1M，老代 128K
    expect(heuristicContextWindow('qwen3.8-max')).toBe(1_000_000);
    expect(heuristicContextWindow('qwen3.5-plus')).toBe(1_000_000);
    expect(heuristicContextWindow('qwen2.5-72b-instruct')).toBe(131_072);
    // GLM-5 1M；Kimi K2.5+ 256K
    expect(heuristicContextWindow('glm-5.2')).toBe(1_000_000);
    expect(heuristicContextWindow('kimi-k2.6')).toBe(262_144);
  });

  it('is case-insensitive and tolerant of whitespace', () => {
    expect(heuristicContextWindow(' DeepSeek-V4-Flash ')).toBe(1_000_000);
  });

  it('returns null for unknown models', () => {
    expect(heuristicContextWindow('some-unknown-model')).toBeNull();
    expect(heuristicContextWindow('')).toBeNull();
  });
});

describe('interpretModelsResponse', () => {
  it('reads context_length from a matched /models entry (probe source)', () => {
    const body = JSON.stringify({
      data: [
        { id: 'other-model' },
        { id: 'deepseek-v4-flash-0731', context_length: 1_000_000 },
      ],
    });
    const result = interpretModelsResponse(200, body, 'deepseek-v4-flash-0731');
    expect(result).toEqual({
      contextWindowTokens: 1_000_000,
      source: 'probe',
      detail: 'probe_ok',
    });
  });

  it('matches by path segment suffix (gateway prefixed ids)', () => {
    const body = JSON.stringify({
      data: [{ id: 'openai/gpt-4o', max_model_len: 128_000 }],
    });
    const result = interpretModelsResponse(200, body, 'gpt-4o');
    expect(result.contextWindowTokens).toBe(128_000);
    expect(result.source).toBe('probe');
    expect(
      matchModelsEntry([{ id: 'openai/gpt-4o' }], 'gpt-4o'),
    ).not.toBeNull();
  });

  it('rejects implausible field values', () => {
    const body = JSON.stringify({
      data: [{ id: 'm-1', context_length: 512 }],
    });
    const result = interpretModelsResponse(200, body, 'm-1');
    expect(result.source).toBe('');
    expect(result.contextWindowTokens).toBeNull();
  });

  it('falls back to the name table when no field is present', () => {
    const body = JSON.stringify({ data: [{ id: 'qwen3.8-max' }] });
    const result = interpretModelsResponse(200, body, 'qwen3.8-max');
    expect(result).toEqual({
      contextWindowTokens: 1_000_000,
      source: 'heuristic',
      detail: 'heuristic_name_match',
    });
  });

  it('reports unknown for non-2xx responses', () => {
    const result = interpretModelsResponse(401, 'unauthorized', 'gpt-4o');
    expect(result.source).toBe('');
    expect(result.contextWindowTokens).toBeNull();
  });
});
