const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const workspace = process.env.LR_AGENT_WORKSPACE || 'D:\\Study\\LR-Agent';
const runtime = path.join(workspace, '.venvs', '.runtime');
const project = path.join(workspace, 'LR-Agent');
const requestedModel = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const baseUrl = 'https://api.deepseek.com';
const apiKey = process.env.DEEPSEEK_API_KEY;
const userData =
  process.env.LR_AGENT_USER_DATA ||
  path.join(process.env.APPDATA || '', 'lr-agent');
const resultPath = path.join(runtime, 'logs', 'deepseek-provision-result.json');

if (!apiKey) {
  throw new Error('DEEPSEEK_API_KEY is required');
}

app.setName('lr-agent');
app.setPath('userData', userData);

async function callDeepSeek(endpoint, init = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: response.status, ok: response.ok, body };
}

function errorSummary(result) {
  if (result.ok) return null;
  const error = result.body && result.body.error;
  return {
    status: result.status,
    code: error && error.code,
    message: error && error.message,
  };
}

app
  .whenReady()
  .then(async () => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Electron safeStorage is unavailable');
    }

    const dbPath = path.join(userData, 'lr-agent.db');
    if (!fs.existsSync(dbPath)) {
      throw new Error(`LR-Agent database not found: ${dbPath}`);
    }

    const initSqlJs = require(path.join(project, 'node_modules', 'sql.js'));
    const SQL = await initSqlJs({
      locateFile: (file) =>
        path.join(project, 'node_modules', 'sql.js', 'dist', file),
    });
    const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
    const encrypted = `v1:${safeStorage
      .encryptString(apiKey)
      .toString('base64')}`;
    const now = Date.now();

    db.run('BEGIN');
    try {
      db.run('UPDATE llm_providers SET is_default = 0, updated_at = ?', [now]);
      db.run('DELETE FROM llm_providers WHERE id = ?', ['deepseek-official']);
      db.run(
        `INSERT INTO llm_providers (
          id, name, base_url, api_key_encrypted, encryption_key_id, model,
          enabled, is_default, supports_vision, vision_probed_at,
          vision_probe_detail, context_window_tokens, context_window_source,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'deepseek-official',
          'DeepSeek',
          baseUrl,
          encrypted,
          'v1',
          requestedModel,
          1,
          1,
          1,
          null,
          '',
          128000,
          'manual',
          now,
          now,
        ],
      );
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }

    const backupPath = path.join(runtime, 'cache', 'lr-agent.db.before-deepseek.bak');
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(dbPath, backupPath);
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();

    const models = await callDeepSeek('/models');
    const modelIds = models.ok
      ? (models.body.data || []).map((item) => item.id).filter(Boolean)
      : [];

    const textProbe = await callDeepSeek('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: requestedModel,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 64,
        temperature: 0,
        stream: false,
        enable_thinking: false,
      }),
    });

    const visionImage = `data:image/jpeg;base64,${fs
      .readFileSync(path.join(runtime, 'test-data', 'bus.jpg'))
      .toString('base64')}`;
    const visionProbe = await callDeepSeek('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: requestedModel,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Reply with exactly: OK' },
              { type: 'image_url', image_url: { url: visionImage } },
            ],
          },
        ],
        max_tokens: 64,
        temperature: 0,
        stream: false,
        enable_thinking: false,
      }),
    });

    const probeDb = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
    const probeDetail = visionProbe.ok
      ? 'probe_ok'
      : `probe_error:http_${visionProbe.status}:${
          (visionProbe.body &&
            visionProbe.body.error &&
            visionProbe.body.error.message) ||
          'request_failed'
        }`.slice(0, 240);
    probeDb.run(
      `UPDATE llm_providers
       SET supports_vision = ?, vision_probed_at = ?, vision_probe_detail = ?, updated_at = ?
       WHERE id = ?`,
      [visionProbe.ok ? 1 : 0, Date.now(), probeDetail, Date.now(), 'deepseek-official'],
    );
    fs.writeFileSync(dbPath, Buffer.from(probeDb.export()));
    probeDb.close();

    const summary = {
      stored: true,
      encryptedAtRest: encrypted.startsWith('v1:') && !encrypted.includes(apiKey),
      providerId: 'deepseek-official',
      model: requestedModel,
      modelsEndpoint: models.ok ? { status: models.status, modelIds } : errorSummary(models),
      textProbe: textProbe.ok
        ? {
            status: textProbe.status,
            reply:
              textProbe.body.choices &&
              textProbe.body.choices[0] &&
              textProbe.body.choices[0].message &&
              (textProbe.body.choices[0].message.content ||
                textProbe.body.choices[0].message.reasoning_content),
          }
        : errorSummary(textProbe),
      visionProbe: visionProbe.ok
        ? { status: visionProbe.status, supported: true }
        : { supported: false, ...errorSummary(visionProbe) },
    };
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  })
  .catch((error) => {
    const message = error && error.message ? error.message : String(error);
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(
      resultPath,
      `${JSON.stringify({ stored: false, error: message }, null, 2)}\n`,
    );
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
