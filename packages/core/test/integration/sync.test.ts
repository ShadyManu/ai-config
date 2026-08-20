import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AiConfiguration, CompileResult, ProviderAdapter } from '../../src/index.js';
import {
  MANIFEST_PATH,
  NodeFileSystem,
  analyze,
  disableProvider,
  enableProvider,
  init,
  readManifest,
  renderMarkdownDocument,
  skillArtifacts,
  stateOf,
  sync,
} from '../../src/index.js';

/**
 * A minimal adapter, so these tests exercise the synchronization engine rather
 * than any real provider's formatting rules.
 */
class TestAdapter implements ProviderAdapter {
  public readonly id = 'claude' as const;
  public readonly displayName = 'Test Provider';
  public readonly targetRoots = ['.test/agents'];

  public compile(configuration: AiConfiguration): CompileResult {
    return {
      files: [
        ...configuration.agents.map((agent) => ({
          path: `.test/agents/${agent.name}.md`,
          source: { kind: 'agent' as const, name: agent.name },
          content: {
            kind: 'text' as const,
            value: renderMarkdownDocument([['description', agent.description]], agent.body),
          },
        })),
        ...skillArtifacts(configuration, '.test/skills'),
      ],
      diagnostics: [],
    };
  }
}

const adapters: readonly ProviderAdapter[] = [new TestAdapter()];
const fileSystem = new NodeFileSystem();

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiconfig-test-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const write = (relativePath: string, content: string): void => {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const read = (relativePath: string): string | undefined => {
  const target = path.join(root, ...relativePath.split('/'));
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
};

const exists = (relativePath: string): boolean =>
  fs.existsSync(path.join(root, ...relativePath.split('/')));

/**
 * Every file under `.ai/`, with its contents.
 *
 * The manifest is excluded: it lives at `.ai/.generated.json` and is the one
 * thing under `.ai/` that AI Config does own.
 */
const snapshotAiDirectory = (): Record<string, string> => {
  const base = path.join(root, '.ai');
  const files: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const nested = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(nested, relative);
      } else if (entry.isFile() && !entry.name.startsWith('.')) {
        files[relative] = fs.readFileSync(nested, 'utf8');
      }
    }
  };
  if (fs.existsSync(base)) {
    walk(base, '');
  }
  return files;
};

const seedProject = (): void => {
  write('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: [claude]\n');
  write('.ai/agents/reviewer.md', '---\ndescription: Reviews code\n---\n\nYou review code.\n');
};

const runSync = async (options?: { dryRun?: boolean; force?: boolean }) =>
  sync(fileSystem, root, adapters, options ?? {});

describe('init', () => {
  it('creates the canonical directory structure', async () => {
    const result = await init(fileSystem, root, {
      providers: ['claude', 'codex'],
      adapters,
      version: 'test',
    });

    expect(result.ok).toBe(true);
    expect(exists('.ai/config.yaml')).toBe(true);
    expect(exists('.ai/instructions')).toBe(true);
    expect(exists('.ai/agents')).toBe(true);
    expect(exists('.ai/skills')).toBe(true);
    expect(exists('.ai/commands')).toBe(true);
    expect(read('.ai/config.yaml')).toContain('schema: 1');
    expect(read('.ai/config.yaml')).toContain('- claude');
    expect(read('.ai/config.yaml')).toContain('- codex');
  });

  it('creates no provider directory, so the tree shows only what is configured', async () => {
    const result = await init(fileSystem, root, {
      providers: ['claude', 'codex'],
      adapters,
      version: 'test',
    });

    expect(result.ok).toBe(true);
    // An empty '.ai/providers/<provider>/' implies an override exists where none
    // does, for every enabled provider at once. The directory arrives with the
    // first override written into it.
    expect(exists('.ai/providers')).toBe(false);
    expect(exists('.ai/providers/claude')).toBe(false);
    expect(exists('.ai/providers/codex')).toBe(false);
    expect(result.ok && result.created.some((created) => created.includes('providers'))).toBe(
      false,
    );
  });

  it('never creates source files under .ai during a sync', async () => {
    seedProject();
    const before = snapshotAiDirectory();

    const outcome = await runSync();

    expect(outcome.ok).toBe(true);
    expect(snapshotAiDirectory()).toEqual(before);
  });

  it('refuses to touch an existing .ai directory', async () => {
    write('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: []\n');
    write('.ai/agents/mine.md', 'precious');

    const result = await init(fileSystem, root, {
      providers: ['claude'],
      adapters,
      version: 'test',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.diagnostics[0]?.code).toBe('ALREADY_INITIALIZED');
    expect(read('.ai/agents/mine.md')).toBe('precious');
    expect(read('.ai/config.yaml')).toBe('schema: 1\nproviders:\n  enabled: []\n');
  });
});

describe('sync lifecycle', () => {
  it('creates generated files and records them in the manifest', async () => {
    seedProject();

    const outcome = await runSync();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }

    expect(read('.test/agents/reviewer.md')).toContain('You review code.');
    expect(outcome.result.summary.written).toBe(1);

    const manifest = await readManifest(fileSystem, root);
    expect(manifest.manifest.entries.map((entry) => entry.path)).toEqual([
      '.test/agents/reviewer.md',
    ]);
    expect(manifest.manifest.entries[0]?.providers).toEqual(['claude']);
    expect(manifest.manifest.entries[0]?.source).toBe('agents/reviewer');
  });

  it('is idempotent: a second sync writes nothing', async () => {
    seedProject();
    await runSync();

    const outcome = await runSync();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.summary.written).toBe(0);
    expect(outcome.result.summary.unchanged).toBe(1);
  });

  it('updates generated output when the canonical source changes', async () => {
    seedProject();
    await runSync();

    write('.ai/agents/reviewer.md', '---\ndescription: Reviews code\n---\n\nRevised guidance.\n');

    const analysis = await analyze(fileSystem, root, adapters);
    expect(analysis.ok).toBe(true);
    if (!analysis.ok) {
      return;
    }
    expect(analysis.analysis.plan.actions.map(stateOf)).toEqual(['stale']);

    await runSync();
    expect(read('.test/agents/reviewer.md')).toContain('Revised guidance.');
  });

  it('deletes an owned file once its canonical source is removed', async () => {
    seedProject();
    await runSync();
    expect(exists('.test/agents/reviewer.md')).toBe(true);

    fs.rmSync(path.join(root, '.ai', 'agents', 'reviewer.md'));

    const outcome = await runSync();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.summary.deleted).toBe(1);
    expect(exists('.test/agents/reviewer.md')).toBe(false);

    const manifest = await readManifest(fileSystem, root);
    expect(manifest.manifest.entries).toEqual([]);
  });

  it('preserves files it does not own inside a provider directory', async () => {
    seedProject();
    write('.test/agents/handwritten.md', 'written by a human');
    await runSync();

    fs.rmSync(path.join(root, '.ai', 'agents', 'reviewer.md'));
    await runSync();

    // Deleting every owned file must not touch a neighbour AI Config never made.
    expect(read('.test/agents/handwritten.md')).toBe('written by a human');
  });

  it('restores a generated file that was deleted', async () => {
    seedProject();
    await runSync();
    fs.rmSync(path.join(root, '.test', 'agents', 'reviewer.md'));

    const analysis = await analyze(fileSystem, root, adapters);
    expect(analysis.ok).toBe(true);
    if (!analysis.ok) {
      return;
    }
    expect(analysis.analysis.plan.actions[0]?.kind).toBe('restore');

    await runSync();
    expect(exists('.test/agents/reviewer.md')).toBe(true);
  });

  it('copies skill supporting files and keeps them byte-identical', async () => {
    seedProject();
    write(
      '.ai/skills/demo/SKILL.md',
      '---\nname: demo\ndescription: A demo skill\n---\n\nDo it.\n',
    );
    write('.ai/skills/demo/references/notes.md', 'Reference notes.\n');

    await runSync();

    expect(read('.test/skills/demo/SKILL.md')).toBe(read('.ai/skills/demo/SKILL.md'));
    expect(read('.test/skills/demo/references/notes.md')).toBe(
      read('.ai/skills/demo/references/notes.md'),
    );
  });
});

describe('drift', () => {
  it('reports drift and blocks the write', async () => {
    seedProject();
    await runSync();
    write('.test/agents/reviewer.md', 'edited by hand');

    const analysis = await analyze(fileSystem, root, adapters);
    expect(analysis.ok).toBe(true);
    if (!analysis.ok) {
      return;
    }
    expect(analysis.analysis.plan.actions.map(stateOf)).toEqual(['drift']);
    expect(analysis.analysis.providers[0]?.status).toBe('drift');

    const outcome = await runSync();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toContain('DRIFT_BLOCKS_WRITE');
    // The hand edit survives a blocked sync.
    expect(read('.test/agents/reviewer.md')).toBe('edited by hand');
  });

  it('overwrites drift only when forced', async () => {
    seedProject();
    await runSync();
    write('.test/agents/reviewer.md', 'edited by hand');

    const outcome = await runSync({ force: true });
    expect(outcome.ok).toBe(true);
    expect(read('.test/agents/reviewer.md')).toContain('You review code.');
  });
});

describe('untracked targets', () => {
  it('refuses to overwrite an existing file it never created', async () => {
    seedProject();
    write('.test/agents/reviewer.md', 'pre-existing content');

    const outcome = await runSync();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toContain('UNTRACKED_TARGET_EXISTS');
    expect(read('.test/agents/reviewer.md')).toBe('pre-existing content');
  });

  it('does not overwrite an untracked file even with --force', async () => {
    seedProject();
    write('.test/agents/reviewer.md', 'pre-existing content');

    const outcome = await runSync({ force: true });
    expect(outcome.ok).toBe(false);
    expect(read('.test/agents/reviewer.md')).toBe('pre-existing content');
  });
});

describe('failure containment', () => {
  it('writes nothing when validation fails', async () => {
    seedProject();
    write('.ai/agents/broken.md', '---\ntools: Read\n---\n\nBody.\n');

    const outcome = await runSync();
    expect(outcome.ok).toBe(false);
    // Not even the valid agent is written.
    expect(exists('.test/agents/reviewer.md')).toBe(false);
    expect(exists(MANIFEST_PATH)).toBe(false);
  });

  it('leaves the previous state intact when a later sync fails', async () => {
    seedProject();
    await runSync();
    const before = read('.test/agents/reviewer.md');

    write('.ai/agents/broken.md', '---\ndescription: 5\n---\n\nBody.\n');
    const outcome = await runSync();

    expect(outcome.ok).toBe(false);
    expect(read('.test/agents/reviewer.md')).toBe(before);
  });
});

describe('dry run', () => {
  it('reports what would change without touching the filesystem', async () => {
    seedProject();

    const outcome = await runSync({ dryRun: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }

    expect(outcome.result.applied).toBe(false);
    expect(outcome.result.summary.written).toBe(1);
    expect(exists('.test/agents/reviewer.md')).toBe(false);
    expect(exists(MANIFEST_PATH)).toBe(false);
  });
});

describe('disabled providers', () => {
  it('generates nothing when no provider is enabled', async () => {
    write('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: []\n');
    write('.ai/agents/reviewer.md', '---\ndescription: Reviews code\n---\n\nBody.\n');

    const outcome = await runSync();
    expect(outcome.ok).toBe(true);
    expect(exists('.test/agents/reviewer.md')).toBe(false);
  });

  it('removes files owned by a provider that was disabled', async () => {
    seedProject();
    await runSync();
    expect(exists('.test/agents/reviewer.md')).toBe(true);

    write('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: []\n');
    await runSync();

    expect(exists('.test/agents/reviewer.md')).toBe(false);
  });

  /**
   * The whole round trip, through the two functions the view and the CLI both
   * call: turning a provider on writes to `config.yaml` and nowhere else, and
   * turning it off leaves only what the user wrote.
   */
  it('generates and removes a provider file as it is enabled and disabled', async () => {
    write('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: []\n');
    write('.ai/agents/reviewer.md', '---\ndescription: Reviews code\n---\n\nBody.\n');

    expect(await enableProvider(fileSystem, root, 'claude')).toMatchObject({ ok: true });
    // Enabling creates no directory: an empty `.ai/providers/<id>/` would claim
    // settings exist for the provider when none were written.
    expect(exists('.ai/providers')).toBe(false);

    await runSync();
    expect(exists('.test/agents/reviewer.md')).toBe(true);

    expect(await disableProvider(fileSystem, root, 'claude')).toMatchObject({ ok: true });
    await runSync();

    expect(exists('.test/agents/reviewer.md')).toBe(false);
    expect(exists('.ai/agents/reviewer.md')).toBe(true);
  });
});

describe('not initialized', () => {
  it('reports a clear error when .ai is missing', async () => {
    const outcome = await runSync();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics[0]?.code).toBe('NOT_INITIALIZED');
  });
});

describe('manifest recovery', () => {
  it('refuses to modify existing output when the manifest is unreadable', async () => {
    seedProject();
    await runSync();
    write(MANIFEST_PATH, 'not json');

    const outcome = await runSync();

    // With no ownership record, every target looks untracked, so AI Config
    // blocks rather than overwriting files it can no longer prove it owns.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toContain('MANIFEST_UNREADABLE');
    expect(outcome.diagnostics.map((d) => d.code)).toContain('UNTRACKED_TARGET_EXISTS');
  });
});
