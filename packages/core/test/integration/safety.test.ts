import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AiConfiguration, CompileResult, ProviderAdapter } from '../../src/index.js';
import { NodeFileSystem, analyze, renderMarkdownDocument, stateOf, sync } from '../../src/index.js';

class TestAdapter implements ProviderAdapter {
  public readonly id = 'claude' as const;
  public readonly displayName = 'Test Provider';
  public readonly targetRoots = ['.test/agents'];
  public readonly extensions = [
    {
      id: 'claude.fixture',
      provider: 'claude' as const,
      targetKinds: ['agent'] as const,
      ownedOutputPaths: [],
      executable: false,
    },
  ];

  public compile(configuration: AiConfiguration): CompileResult {
    return {
      files: configuration.agents.map((agent) => ({
        path: `.test/agents/${agent.name}.md`,
        source: { kind: 'agent' as const, name: agent.name },
        content: {
          kind: 'text' as const,
          value: renderMarkdownDocument([['description', agent.description]], agent.body),
        },
      })),
      diagnostics: [],
    };
  }
}

const adapters: readonly ProviderAdapter[] = [new TestAdapter()];
const fileSystem = new NodeFileSystem();

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiconfig-safety-'));
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiconfig-outside-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

const write = (relativePath: string, content: string): void => {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const seedProject = (): void => {
  write('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: [claude]\n');
  write('.ai/agents/reviewer.md', '---\ndescription: Reviews code\n---\n\nYou review code.\n');
};

/**
 * Creating a directory symlink on Windows needs elevation or Developer Mode, so
 * these run only where the platform allows it. The behaviour they cover is
 * POSIX-relevant in any case.
 */
const canCreateSymlinks = (): boolean => {
  const probeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiconfig-symlink-probe-'));
  try {
    fs.symlinkSync(os.tmpdir(), path.join(probeDirectory, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDirectory, { recursive: true, force: true });
  }
};

const symlinks = canCreateSymlinks();

describe.skipIf(!symlinks)('symbolic link containment', () => {
  it('refuses to write through a symlinked output directory', async () => {
    seedProject();
    // A repository could otherwise commit this link and redirect generated
    // files anywhere on the machine.
    fs.symlinkSync(outside, path.join(root, '.test'), 'dir');

    const outcome = await sync(fileSystem, root, adapters);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toContain('UNSAFE_OUTPUT_PATH');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses to read a canonical directory that is a symlink', async () => {
    write('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: [claude]\n');
    fs.mkdirSync(path.join(outside, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(outside, 'agents', 'stolen.md'),
      '---\ndescription: From outside\n---\n\nBody.\n',
      'utf8',
    );
    fs.symlinkSync(path.join(outside, 'agents'), path.join(root, '.ai', 'agents'), 'dir');

    const outcome = await analyze(fileSystem, root, adapters);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.analysis.diagnostics.map((d) => d.code)).toContain('UNSAFE_OUTPUT_PATH');
    expect(outcome.analysis.project.configuration.agents).toEqual([]);
  });

  it('skips a symlinked canonical file rather than following it', async () => {
    seedProject();
    fs.writeFileSync(
      path.join(outside, 'external.md'),
      '---\ndescription: External\n---\n\nBody.\n',
      'utf8',
    );
    fs.symlinkSync(
      path.join(outside, 'external.md'),
      path.join(root, '.ai', 'agents', 'linked.md'),
      'file',
    );

    const outcome = await analyze(fileSystem, root, adapters);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.analysis.project.configuration.agents.map((a) => a.name)).toEqual(['reviewer']);
    expect(outcome.analysis.diagnostics.map((d) => d.code)).toContain('SYMLINK_SKIPPED');
  });

  it('rejects a skill whose SKILL.md is a symbolic link', async () => {
    seedProject();
    fs.writeFileSync(
      path.join(outside, 'SKILL.md'),
      '---\nname: linked\ndescription: External skill\n---\n\nBody.\n',
      'utf8',
    );
    fs.mkdirSync(path.join(root, '.ai', 'skills', 'linked'), { recursive: true });
    fs.symlinkSync(
      path.join(outside, 'SKILL.md'),
      path.join(root, '.ai', 'skills', 'linked', 'SKILL.md'),
      'file',
    );

    const outcome = await analyze(fileSystem, root, adapters);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.analysis.diagnostics.map((d) => d.code)).toContain(
      'SKILL_ENTRYPOINT_NOT_A_FILE',
    );
    expect(outcome.analysis.project.configuration.skills).toEqual([]);
  });

  it('rejects an overlay asset that resolves through a symbolic link', async () => {
    seedProject();
    write(
      '.ai/providers/claude/overlay.yaml',
      'schema: 1\nprovider: claude\nextensions:\n  - fixture\n',
    );
    write(
      '.ai/providers/claude/extensions/fixture.yaml',
      'schema: 1\ntype: claude.fixture\ntarget:\n  kind: agent\n  id: reviewer\nassets:\n  - script.sh\nspec: {}\n',
    );
    fs.writeFileSync(path.join(outside, 'script.sh'), 'outside', 'utf8');
    fs.mkdirSync(path.join(root, '.ai', 'providers', 'claude', 'assets', 'fixture'), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join(outside, 'script.sh'),
      path.join(root, '.ai', 'providers', 'claude', 'assets', 'fixture', 'script.sh'),
      'file',
    );

    const outcome = await analyze(fileSystem, root, adapters);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'OVERLAY_ASSET_UNSAFE',
    );
  });
});

describe('modified orphans', () => {
  it('refuses to delete a no-longer-generated file that was edited', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);

    // The file is now owned but hand-edited, and its canonical source is gone.
    write('.test/agents/reviewer.md', 'notes I want to keep');
    fs.rmSync(path.join(root, '.ai', 'agents', 'reviewer.md'));

    const analysis = await analyze(fileSystem, root, adapters);
    expect(analysis.ok).toBe(true);
    if (!analysis.ok) {
      return;
    }
    expect(analysis.analysis.plan.actions.map(stateOf)).toEqual(['drift']);

    const outcome = await sync(fileSystem, root, adapters);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toContain('ORPHAN_MODIFIED');
    expect(fs.readFileSync(path.join(root, '.test', 'agents', 'reviewer.md'), 'utf8')).toBe(
      'notes I want to keep',
    );
  });

  it('deletes an untouched orphan without complaint', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    fs.rmSync(path.join(root, '.ai', 'agents', 'reviewer.md'));

    const outcome = await sync(fileSystem, root, adapters);

    expect(outcome.ok).toBe(true);
    expect(fs.existsSync(path.join(root, '.test', 'agents', 'reviewer.md'))).toBe(false);
  });

  it('keeps a modified orphan even under the drift override', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    write('.test/agents/reviewer.md', 'hand edited');
    fs.rmSync(path.join(root, '.ai', 'agents', 'reviewer.md'));

    const outcome = await sync(fileSystem, root, adapters, { force: true });

    // Overwriting drift is recoverable, because the canonical source
    // regenerates the file. Deleting a modified orphan is not recoverable at
    // all, so no flag enables it.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toContain('ORPHAN_MODIFIED');
    expect(fs.readFileSync(path.join(root, '.test', 'agents', 'reviewer.md'), 'utf8')).toBe(
      'hand edited',
    );
  });

  it('still overwrites ordinary drift under the override', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    write('.test/agents/reviewer.md', 'hand edited');

    // The canonical source still exists, so this is recoverable and allowed.
    const outcome = await sync(fileSystem, root, adapters, { force: true });

    expect(outcome.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, '.test', 'agents', 'reviewer.md'), 'utf8')).toContain(
      'You review code.',
    );
  });
});

describe('encoding', () => {
  it('rejects a UTF-16 canonical file rather than producing mojibake', async () => {
    seedProject();
    fs.writeFileSync(
      path.join(root, '.ai', 'agents', 'utf16.md'),
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('---\ndescription: X\n---\n\nBody.\n', 'utf16le'),
      ]),
    );

    const outcome = await analyze(fileSystem, root, adapters);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.analysis.diagnostics.map((d) => d.code)).toContain('UNSUPPORTED_ENCODING');
  });
});

describe('manifest stability', () => {
  it('does not rewrite the manifest when nothing changed', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);

    const manifestPath = path.join(root, '.ai', '.generated.json');
    const before = fs.statSync(manifestPath).mtimeMs;

    await sync(fileSystem, root, adapters);

    // The manifest lives inside the watched .ai/ tree, so rewriting it on a
    // no-op would retrigger an editor watcher.
    expect(fs.statSync(manifestPath).mtimeMs).toBe(before);
  });
});

describe('atomic writes', () => {
  it('replaces an existing file repeatedly without failing', async () => {
    // Windows refuses a replacing rename while any process holds the
    // destination without delete sharing, which a scanner or indexer does
    // sporadically to a file that was just written. That surfaced as an
    // intermittent WRITE_FAILED on a file AI Config owns.
    const target = path.join(root, 'nested', 'target.md');

    await fileSystem.writeFileAtomic(target, Buffer.from('first', 'utf8'), { exclusive: true });

    for (let generation = 0; generation < 60; generation += 1) {
      const content = `generation ${String(generation)}`;
      // Read between writes, the way the planner probes before it writes.
      await fileSystem.readFile(target);
      await fileSystem.writeFileAtomic(target, Buffer.from(content, 'utf8'));
      expect(fs.readFileSync(target, 'utf8')).toBe(content);
    }

    // No temporary file is left behind by any path through the write.
    expect(
      fs.readdirSync(path.join(root, 'nested')).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('still refuses to clobber a file that appears before an exclusive write', async () => {
    const target = path.join(root, 'taken.md');
    fs.writeFileSync(target, 'not ours', 'utf8');

    await expect(
      fileSystem.writeFileAtomic(target, Buffer.from('ours', 'utf8'), { exclusive: true }),
    ).rejects.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('not ours');
  });
});
