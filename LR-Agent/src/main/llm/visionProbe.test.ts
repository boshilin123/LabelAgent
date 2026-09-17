import {
  buildVisionProbeBody,
  chatCompletionsUrl,
  interpretVisionProbeException,
  interpretVisionProbeHttp,
  runVisionProbeRequest,
  shouldRetryWithoutThinking,
  solidColorPngDataUrl,
} from './visionProbe';

describe('solidColorPngDataUrl', () => {
  it('returns a PNG data URL with the PNG signature', () => {
    const url = solidColorPngDataUrl();
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    const bytes = Buffer.from(url.split(',')[1] ?? '', 'base64');
    expect(Array.from(bytes.subarray(0, 8))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
  });
});

describe('chatCompletionsUrl', () => {
  it('joins OpenAI-compatible base URLs', () => {
    expect(
      chatCompletionsUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/'),
    ).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
  });
});

describe('buildVisionProbeBody', () => {
  it('disables thinking and sends image_url', () => {
    const body = buildVisionProbeBody(
      'qwen3.8-max',
      'data:image/png;base64,xx',
      {
        enableThinkingFalse: true,
      },
    );
    expect(body.enable_thinking).toBe(false);
    expect(body.max_tokens).toBe(64);
    const { content } = (
      body.messages as Array<{ content: Array<{ type: string }> }>
    )[0];
    expect(content.some((part) => part.type === 'image_url')).toBe(true);
  });
});

describe('interpretVisionProbeHttp', () => {
  it('treats HTTP 200 with missing content as vision-capable', () => {
    expect(
      interpretVisionProbeHttp(
        200,
        JSON.stringify({ choices: [{ message: { role: 'assistant' } }] }),
      ),
    ).toEqual({ supportsVision: true, detail: 'probe_ok' });
  });

  it('does not require the reply to contain OK', () => {
    expect(
      interpretVisionProbeHttp(
        200,
        JSON.stringify({
          choices: [{ message: { content: '这是一张红色图片' } }],
        }),
      ).supportsVision,
    ).toBe(true);
  });

  it('rejects HTTP 200 JSON error envelopes', () => {
    const result = interpretVisionProbeHttp(
      200,
      '{"error":{"message":"model does not support image"}}',
    );
    expect(result.supportsVision).toBe(false);
    expect(result.detail).toContain('does not support image');
  });

  it('records HTTP errors with a body snippet', () => {
    const result = interpretVisionProbeHttp(
      400,
      '{"error":{"message":"model does not support image input"}}',
    );
    expect(result.supportsVision).toBe(false);
    expect(result.detail).toContain('probe_error:http_400:');
    expect(result.detail).toContain('does not support image');
  });
});

describe('interpretVisionProbeException', () => {
  it('preserves TypeError Failed to fetch', () => {
    const result = interpretVisionProbeException(
      new TypeError('Failed to fetch'),
    );
    expect(result.supportsVision).toBe(false);
    expect(result.detail).toBe('probe_error:TypeError:Failed to fetch');
  });
});

describe('shouldRetryWithoutThinking', () => {
  it('retries only when enable_thinking is an unknown argument', () => {
    expect(
      shouldRetryWithoutThinking(
        400,
        'parameter.enable_thinking is not supported for this model',
      ),
    ).toBe(true);
    expect(
      shouldRetryWithoutThinking(
        400,
        'parameter.enable_thinking must be set to false for non-streaming calls',
      ),
    ).toBe(false);
    expect(
      shouldRetryWithoutThinking(400, 'model does not support image'),
    ).toBe(false);
  });
});

describe('runVisionProbeRequest', () => {
  it('retries without enable_thinking after a 400 about that field', async () => {
    const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        enable_thinking?: boolean;
      };
      if (body.enable_thinking === false) {
        return {
          status: 400,
          text: async () =>
            'parameter.enable_thinking is not supported for this model',
        } as Response;
      }
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ choices: [{ message: { content: null } }] }),
      } as Response;
    }) as unknown as typeof fetch;

    const result = await runVisionProbeRequest({
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ supportsVision: true, detail: 'probe_ok' });
  });

  it('rejects non-http probe URLs', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const result = await runVisionProbeRequest({
      baseUrl: 'file:///tmp',
      apiKey: 'sk-test',
      model: 'qwen3.8-max',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.supportsVision).toBe(false);
    expect(result.detail).toContain('invalid_probe_url');
  });
});
