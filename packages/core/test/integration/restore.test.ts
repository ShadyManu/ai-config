import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AiConfiguration, CompileResult, ProviderAdapter } from '../../src/index.js';
import {
  NodeFileSystem,
  readManifest,
  renderMarkdownDocument,
  restore,
  sync,
} from '../../src/index.js';

class TestAdapter implements ProviderAdapter {
  public readonly id = 'claude' as const;
  public readonly displayName = 'Test Provider';
  public readonly targetRoots = ['.test/agents'];

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

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiconfig-restore-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const write = (relativePath: string, content: string): void => {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');

const seedProject = (): void => {
  write('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: [claude]\n');
  for (const name of ['alpha', 'beta']) {
    write(`.ai/agents/${name}.md`, `---\ndescription: Agent ${name}\n---\n\nBody of ${name}.\n`);
  }
};

describe('restore', () => {
  it('rewrites only the requested file, leaving other drift alone', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);

    write('.test/agents/alpha.md', 'edited alpha');
    write('.test/agents/beta.md', 'edited beta');

    const outcome = await restore(fileSystem, root, adapters, ['.test/agents/alpha.md']);

    expect(outcome.ok).toBe(true);
    expect(read('.test/agents/alpha.md')).toContain('Body of alpha.');
    // The whole point: a per-file action must not touch its neighbours.
    expect(read('.test/agents/beta.md')).toBe('edited beta');
  });

  it('keeps ownership of every other generated file', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    write('.test/agents/alpha.md', 'edited alpha');

    await restore(fileSystem, root, adapters, ['.test/agents/alpha.md']);

    const manifest = await readManifest(fileSystem, root);
    expect(manifest.manifest.entries.map((entry) => entry.path).sort()).toEqual([
      '.test/agents/alpha.md',
      '.test/agents/beta.md',
    ]);
  });

  it('leaves the restored file synced, not drifted', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    write('.test/agents/alpha.md', 'edited alpha');

    await restore(fileSystem, root, adapters, ['.test/agents/alpha.md']);

    // A following sync must succeed with nothing to do: the restored file now
    // matches both the manifest and the generated content, so it is not drift.
    const outcome = await sync(fileSystem, root, adapters);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.summary).toEqual({ written: 0, deleted: 0, unchanged: 2 });
  });

  it('refuses a path AI Config does not generate', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    write('mine.md', 'hand written');

    const outcome = await restore(fileSystem, root, adapters, ['mine.md']);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics[0]?.code).toBe('UNTRACKED_TARGET_EXISTS');
    expect(read('mine.md')).toBe('hand written');
  });

  it('writes nothing when given no paths', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    write('.test/agents/alpha.md', 'edited alpha');

    const outcome = await restore(fileSystem, root, adapters, []);

    expect(outcome.ok).toBe(true);
    expect(read('.test/agents/alpha.md')).toBe('edited alpha');
  });

  it('does not delete a modified orphan while restoring something else', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);

    write('.test/agents/alpha.md', 'edited alpha');
    write('.test/agents/beta.md', 'edited beta');
    fs.rmSync(path.join(root, '.ai', 'agents', 'beta.md'));

    const outcome = await restore(fileSystem, root, adapters, ['.test/agents/alpha.md']);

    // beta is now a modified orphan, which nothing may delete.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toContain('ORPHAN_MODIFIED');
    expect(read('.test/agents/beta.md')).toBe('edited beta');
  });
});
