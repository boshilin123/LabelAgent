import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  MAX_CATALOG_ENTRIES,
  MAX_DESCRIPTION_CHARS,
  MAX_SKILL_CHARS,
  MAX_SKILL_FILE_LIST,
  clearSkillsCache,
  listSkillFiles,
  parseSkillFrontmatter,
  readSkillFile,
  readSkillMarkdown,
  scanSkillsCatalog,
  scanSkillsInventory,
} from './skillScanner';

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => os.tmpdir()),
  },
}));

describe('parseSkillFrontmatter', () => {
  it('parses single-line name and description', () => {
    const content = `---
name: caveman
description: Ultra-compressed communication mode.
---
Body here`;
    expect(parseSkillFrontmatter(content)).toEqual({
      name: 'caveman',
      description: 'Ultra-compressed communication mode.',
      disableModelInvocation: undefined,
    });
  });

  it('parses folded (> ) description as a single line', () => {
    const content = `---
name: folded-skill
description: >
  Ultra-compressed communication mode.
  Keep technical accuracy.
---
Body here`;
    expect(parseSkillFrontmatter(content)?.description).toBe(
      'Ultra-compressed communication mode. Keep technical accuracy.',
    );
  });

  it('parses literal (|) description preserving newlines', () => {
    const content = `---
name: literal-skill
description: |
  line one
  line two
---
Body here`;
    expect(parseSkillFrontmatter(content)?.description).toBe(
      'line one\nline two',
    );
  });

  it('returns null when frontmatter is missing', () => {
    expect(parseSkillFrontmatter('# Just a heading')).toBeNull();
  });

  it('parses disable-model-invocation flag', () => {
    const content = `---
name: hidden-skill
description: internal only
disable-model-invocation: true
---`;
    expect(parseSkillFrontmatter(content)?.disableModelInvocation).toBe(true);
  });
});

describe('scanSkillsCatalog', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearSkillsCache();
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.remove(tmpDir);
    }
  });

  it('collects valid skill directories only', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'caveman', 'SKILL.md'),
      '---\nname: caveman\ndescription: Talk like caveman.\n---\nBody',
    );
    await fs.outputFile(
      path.join(tmpDir, 'not-a-skill', 'readme.txt'),
      'no skill here',
    );
    await fs.outputFile(
      path.join(tmpDir, '.hidden', 'SKILL.md'),
      '---\nname: hidden\ndescription: skipped hidden dir\n---\n',
    );

    const catalog = await scanSkillsCatalog(tmpDir);
    expect(catalog).toEqual([
      { name: 'caveman', description: 'Talk like caveman.', scope: 'user' },
    ]);
  });

  it('excludes skills with disable-model-invocation', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'internal', 'SKILL.md'),
      '---\nname: internal\ndescription: do not invoke\ndisable-model-invocation: true\n---\n',
    );
    await fs.outputFile(
      path.join(tmpDir, 'public', 'SKILL.md'),
      '---\nname: public\ndescription: invoke me\n---\n',
    );

    const catalog = await scanSkillsCatalog(tmpDir);
    expect(catalog.map((s) => s.name)).toEqual(['public']);
  });

  it('falls back to directory name when name is missing, drops entries without description', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'nameless', 'SKILL.md'),
      '---\ndescription: has description only\n---\n',
    );
    await fs.outputFile(
      path.join(tmpDir, 'no-desc', 'SKILL.md'),
      '---\nname: no-desc\n---\n',
    );

    const catalog = await scanSkillsCatalog(tmpDir);
    expect(catalog).toEqual([
      { name: 'nameless', description: 'has description only', scope: 'user' },
    ]);
  });

  it('uses directory name in catalog when frontmatter name differs', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'my-docx', 'SKILL.md'),
      '---\nname: docx\ndescription: Word documents.\n---\nBody',
    );

    const catalog = await scanSkillsCatalog(tmpDir);
    expect(catalog).toEqual([
      { name: 'my-docx', description: 'Word documents.', scope: 'user' },
    ]);
  });

  it('caps catalog at MAX_CATALOG_ENTRIES and truncates description', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    for (let i = 0; i < MAX_CATALOG_ENTRIES + 5; i += 1) {
      await fs.outputFile(
        path.join(tmpDir, `skill-${i}`, 'SKILL.md'),
        `---\nname: skill-${i}\ndescription: ${'d'.repeat(400)}\n---\n`,
      );
    }

    const catalog = await scanSkillsCatalog(tmpDir);
    expect(catalog).toHaveLength(MAX_CATALOG_ENTRIES);
    expect(catalog[0]!.description.length).toBe(MAX_DESCRIPTION_CHARS);
  });
});

describe('readSkillMarkdown', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearSkillsCache();
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.remove(tmpDir);
    }
  });

  it('reads full SKILL.md content', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'caveman', 'SKILL.md'),
      '---\nname: caveman\ndescription: Talk like caveman.\n---\nRespond terse.',
    );

    const content = await readSkillMarkdown('caveman', tmpDir);
    expect(content).toContain('Respond terse.');
  });

  it('rejects invalid skill names (path traversal)', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    expect(await readSkillMarkdown('..', tmpDir)).toBeNull();
    expect(await readSkillMarkdown('a/b', tmpDir)).toBeNull();
    expect(await readSkillMarkdown('../secret', tmpDir)).toBeNull();
  });

  it('returns null for missing skill', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    expect(await readSkillMarkdown('nonexistent', tmpDir)).toBeNull();
  });

  it('truncates oversized SKILL.md content', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'big', 'SKILL.md'),
      'x'.repeat(MAX_SKILL_CHARS + 10_000),
    );

    const content = await readSkillMarkdown('big', tmpDir);
    expect(content!.length).toBeLessThanOrEqual(MAX_SKILL_CHARS + 20);
    expect(content).toContain('…（内容过长已截断）');
  });

  it('resolves skill by frontmatter name when it differs from directory', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'my-docx', 'SKILL.md'),
      '---\nname: docx\ndescription: Word documents.\n---\nUse templates.',
    );

    const content = await readSkillMarkdown('docx', tmpDir);
    expect(content).toContain('Use templates.');
  });
});

describe('readSkillFile and listSkillFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearSkillsCache();
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.remove(tmpDir);
    }
  });

  it('reads bundled relative files and rejects traversal / binary', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'docx', 'SKILL.md'),
      '---\nname: docx\ndescription: Word.\n---\nSee references/guide.md',
    );
    await fs.outputFile(
      path.join(tmpDir, 'docx', 'references', 'guide.md'),
      '# Guide\nUse the template.',
    );
    await fs.outputFile(
      path.join(tmpDir, 'docx', 'assets', 'logo.bin'),
      Buffer.from([0, 1, 2, 3, 0, 9]),
    );
    await fs.outputFile(path.join(tmpDir, 'secret.md'), 'outside');

    const listed = await listSkillFiles('docx', tmpDir);
    expect(listed).toEqual(
      expect.arrayContaining([
        'SKILL.md',
        'references/guide.md',
        'assets/logo.bin',
      ]),
    );

    const guide = await readSkillFile('docx', 'references/guide.md', tmpDir);
    expect(guide).toEqual({
      ok: true,
      relativePath: 'references/guide.md',
      content: '# Guide\nUse the template.',
    });

    expect(await readSkillFile('docx', '../secret.md', tmpDir)).toEqual({
      ok: false,
      error: 'invalid_path',
    });
    expect(await readSkillFile('docx', 'assets/logo.bin', tmpDir)).toEqual({
      ok: false,
      error: 'binary',
    });
    expect(await readSkillFile('missing', undefined, tmpDir)).toEqual({
      ok: false,
      error: 'skill_not_found',
    });
  });

  it('caps listed files at MAX_SKILL_FILE_LIST and skips deep paths', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'big', 'SKILL.md'),
      '---\nname: big\ndescription: many files.\n---\n',
    );
    for (let i = 0; i < MAX_SKILL_FILE_LIST + 5; i += 1) {
      await fs.outputFile(
        path.join(tmpDir, 'big', 'refs', `f-${String(i).padStart(3, '0')}.md`),
        `file ${i}`,
      );
    }
    await fs.outputFile(
      path.join(tmpDir, 'big', 'a', 'b', 'c', 'too-deep.md'),
      'skipped',
    );

    const files = await listSkillFiles('big', tmpDir);
    expect(files).toHaveLength(MAX_SKILL_FILE_LIST);
    expect(files).not.toContain('a/b/c/too-deep.md');
  });
});

describe('scanSkillsInventory', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearSkillsCache();
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.remove(tmpDir);
    }
  });

  it('classifies available, disabled, and invalid skills', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'public', 'SKILL.md'),
      '---\nname: public\ndescription: invoke me\n---\nBody',
    );
    await fs.outputFile(
      path.join(tmpDir, 'public', 'references', 'note.md'),
      'note',
    );
    await fs.outputFile(
      path.join(tmpDir, 'internal', 'SKILL.md'),
      '---\nname: internal\ndescription: hidden\ndisable-model-invocation: true\n---\n',
    );
    await fs.outputFile(
      path.join(tmpDir, 'broken', 'SKILL.md'),
      '# no frontmatter',
    );
    await fs.outputFile(
      path.join(tmpDir, 'no-desc', 'SKILL.md'),
      '---\nname: x\n---\n',
    );

    const inventory = await scanSkillsInventory(tmpDir);
    const byDir = Object.fromEntries(
      inventory.map((item) => [item.dirName, item]),
    );

    expect(byDir.public?.status).toBe('available');
    expect(byDir.public?.files).toEqual(
      expect.arrayContaining(['SKILL.md', 'references/note.md']),
    );
    expect(byDir.internal?.status).toBe('disabled');
    expect(byDir.internal?.reason).toBe('已禁用模型调用');
    expect(byDir.broken?.status).toBe('invalid');
    expect(byDir.broken?.reason).toBe('缺少 YAML frontmatter');
    expect(byDir['no-desc']?.status).toBe('invalid');
    expect(byDir['no-desc']?.reason).toBe('缺少 description');
  });

  it('marks skills in the hidden list as hidden', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'public', 'SKILL.md'),
      '---\nname: public\ndescription: invoke me\n---\n',
    );
    await fs.outputFile(
      path.join(tmpDir, 'off', 'SKILL.md'),
      '---\nname: off\ndescription: disabled in app\n---\n',
    );

    const inventory = await scanSkillsInventory(tmpDir, ['off']);
    const byDir = Object.fromEntries(
      inventory.map((item) => [item.dirName, item]),
    );
    expect(byDir.public?.status).toBe('available');
    expect(byDir.off?.status).toBe('hidden');
    expect(byDir.off?.reason).toBe('已在本应用停用');
  });
});

describe('应用内停用清单与 catalog 注入', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearSkillsCache();
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.remove(tmpDir);
    }
  });

  it('停用项不注入 catalog，启用后又能注入（缓存需清空）', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'keep', 'SKILL.md'),
      '---\nname: keep\ndescription: stays\n---\n',
    );
    await fs.outputFile(
      path.join(tmpDir, 'mute', 'SKILL.md'),
      '---\nname: mute\ndescription: muted\n---\n',
    );

    expect(
      (await scanSkillsCatalog(tmpDir, ['mute'])).map((s) => s.name),
    ).toEqual(['keep']);

    clearSkillsCache();
    expect((await scanSkillsCatalog(tmpDir, [])).map((s) => s.name)).toEqual([
      'keep',
      'mute',
    ]);
  });

  it('停用优先于 disable-model-invocation（面板能看到停用项）', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'both', 'SKILL.md'),
      '---\nname: both\ndescription: x\ndisable-model-invocation: true\n---\n',
    );

    const inventory = await scanSkillsInventory(tmpDir, ['both']);
    expect(inventory[0]?.status).toBe('hidden');
    expect(inventory[0]?.reason).toBe('已在本应用停用');
  });
});
