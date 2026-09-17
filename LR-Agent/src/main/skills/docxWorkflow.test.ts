/**
 * Skill 脚本执行端到端测试：用 docx-demo 夹具走完整文档工作流
 * （生成 docx → 修改 → 读回 → 错误传播），解释器走真实分派
 * （应用 venv python，回退系统 python；两者都无则跳过）。
 * 夹具脚本仅依赖标准库，见 __fixtures__/docx-skill/。
 */
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { runSkillScript } from './skillScriptRunner';
import { getVenvPythonPath } from '../env/runtimeManager';

jest.mock('electron', () => ({
  app: {
    // home → skills 根目录；userData → 真实应用目录（探测运行时 venv）；
    // 其余路径回落 tmpdir。
    getPath: jest.fn((key: string) => {
      if (key === 'home') return os.homedir();
      if (key === 'userData') {
        return process.platform === 'win32'
          ? path.join(os.homedir(), 'AppData', 'Roaming', 'lr-agent')
          : path.join(os.homedir(), '.config', 'lr-agent');
      }
      return os.tmpdir();
    }),
  },
}));

/** 与 runner 的解释器分派保持一致的可用性探测；不可用时跳过整套用例 */
function hasUsablePython(): boolean {
  try {
    const venv = getVenvPythonPath('local-agent');
    if (fs.existsSync(venv)) return true;
  } catch {
    // 运行时未就绪
  }
  const probe = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [
    '--version',
  ]);
  return !probe.error && probe.status === 0;
}

const FIXTURES_DIR = path.join(__dirname, '__fixtures__');
const PYTHON_AVAILABLE = hasUsablePython();
describe('docx-demo skill 工作流（生成 → 修改 → 读回）', () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'docx-demo-'));
  });

  afterAll(async () => {
    await fs.remove(workspace).catch(() => undefined);
  });

  it('make_docx 生成含标题与段落的文档', async () => {
    if (!PYTHON_AVAILABLE) return; // 宿主机无可用 python 时跳过
    const docxPath = path.join(workspace, 'report.docx');
    const result = await runSkillScript(
      'docx-demo',
      'scripts/make_docx.py',
      [docxPath, 'LR-Agent 测试报告', '第一段：生成', '第二段：待修改'],
      { rootDir: FIXTURES_DIR },
    );
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.ok && result.output).toContain('created');
    expect(await fs.pathExists(docxPath)).toBe(true);
  }, 30_000);

  it('edit_docx 就地修改后读回新内容', async () => {
    if (!PYTHON_AVAILABLE) return; // 宿主机无可用 python 时跳过
    const docxPath = path.join(workspace, 'report.docx');
    const edit = await runSkillScript(
      'docx-demo',
      'scripts/edit_docx.py',
      [docxPath, '待修改', '已修改'],
      { rootDir: FIXTURES_DIR },
    );
    expect(edit).toMatchObject({ ok: true, exitCode: 0 });

    const read = await runSkillScript(
      'docx-demo',
      'scripts/read_text.py',
      [docxPath],
      { rootDir: FIXTURES_DIR },
    );
    expect(read).toMatchObject({ ok: true, exitCode: 0 });
    expect(read.ok && read.output).toContain('LR-Agent 测试报告');
    expect(read.ok && read.output).toContain('第二段：已修改');
    expect(read.ok && read.output).not.toContain('待修改');
  }, 30_000);

  it('脚本错误（找不到替换文本）以非零退出码传播给模型', async () => {
    if (!PYTHON_AVAILABLE) return; // 宿主机无可用 python 时跳过
    const docxPath = path.join(workspace, 'report.docx');
    const result = await runSkillScript(
      'docx-demo',
      'scripts/edit_docx.py',
      [docxPath, '不存在的文本', 'x'],
      { rootDir: FIXTURES_DIR },
    );
    expect(result).toMatchObject({ ok: true, exitCode: 1 });
    expect(result.ok && result.output).toContain('text not found');
  }, 30_000);

  it('生成的 docx 是合法 zip（OOXML 包结构）', async () => {
    if (!PYTHON_AVAILABLE) return; // 宿主机无可用 python 时跳过
    const docxPath = path.join(workspace, 'report.docx');
    // 用 venv python 旁路校验（系统 'python' 可能是 WindowsApps 占位符）
    let pythonPath: string | null = null;
    try {
      const venv = getVenvPythonPath('local-agent');
      if (fs.existsSync(venv)) pythonPath = venv;
    } catch {
      // 运行时未就绪
    }
    if (!pythonPath) return;
    const probe = spawnSync(pythonPath, [
      '-c',
      'import zipfile,sys; zf=zipfile.ZipFile(sys.argv[1]); ' +
        'names=zf.namelist(); sys.exit(0 if ' +
        '"[Content_Types].xml" in names and "word/document.xml" in names else 1)',
      docxPath,
    ]);
    expect(probe.status).toBe(0);
  }, 30_000);
});
