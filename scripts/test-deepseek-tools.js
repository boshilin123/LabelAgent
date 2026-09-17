const fs = require('fs');
const path = require('path');

const workspace = process.env.LR_AGENT_WORKSPACE || 'D:\\Study\\LR-Agent';
const runtime = path.join(workspace, '.venvs', '.runtime');
const apiKey = process.env.DEEPSEEK_API_KEY;
const model = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const resultPath = path.join(runtime, 'logs', 'deepseek-tool-probe-result.json');

if (!apiKey) {
  throw new Error('DEEPSEEK_API_KEY is required');
}

(async () => {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: 'Call get_workspace_status for D:\\Study\\LR-Agent. Do not answer directly.',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_workspace_status',
            description: 'Read the status of a local workspace.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
              required: ['path'],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: 'auto',
      max_tokens: 128,
      stream: false,
      enable_thinking: false,
    }),
  });
  const body = await response.json();
  const message = body.choices && body.choices[0] && body.choices[0].message;
  const toolCalls = (message && message.tool_calls) || [];
  const summary = {
    status: response.status,
    ok: response.ok,
    model,
    finishReason:
      body.choices && body.choices[0] && body.choices[0].finish_reason,
    toolCallCount: toolCalls.length,
    toolNames: toolCalls.map((item) => item.function && item.function.name),
    argumentsValidJson: toolCalls.every((item) => {
      try {
        JSON.parse(item.function.arguments);
        return true;
      } catch {
        return false;
      }
    }),
    error:
      body.error && {
        code: body.error.code,
        message: body.error.message,
      },
  };
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!response.ok || toolCalls.length === 0) process.exitCode = 1;
})().catch((error) => {
  const summary = { ok: false, error: error.message || String(error) };
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = 1;
});
