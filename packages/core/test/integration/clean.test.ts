import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AiConfiguration, CompileResult, ProviderAdapter } from '../../src/index.js';
import {
  NodeFileSystem,
  clean,
  readManifest,
  renderMarkdownDocument,
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
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiconfig-clean-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const write = (relativePath: string, content: string): void => {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const exists = (relativePath: string): boolean =>
  fs.existsSync(path.join(root, ...relativePath.split('/')));

const seedProject = (): void => {
  write('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: [claude]\n');
  for (const name of ['alpha', 'beta']) {
    write(`.ai/agents/${name}.md`, `---\ndescription: Agent ${name}\n---\n\nBody of ${name}.\n`);
  }
};

describe('clean', () => {
  it('removes every generated file', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    expect(exists('.test/agents/alpha.md')).toBe(true);

    const outcome = await clean(fileSystem, root, adapters);

    expect(outcome.ok).toBe(true);
    expect(exists('.test/agents/alpha.md')).toBe(false);
    expect(exists('.test/agents/beta.md')).toBe(false);
  });

  it('leaves the canonical sources untouched, so the project can be rebuilt', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);

    await clean(fileSystem, root, adapters);

    expect(exists('.ai/config.yaml')).toBe(true);
    expect(exists('.ai/agents/alpha.md')).toBe(true);

    const rebuilt = await sync(fileSystem, root, adapters);
    expect(rebuilt.ok).toBe(true);
    expect(exists('.test/agents/alpha.md')).toBe(true);
  });

  it('gives up ownership of everything it removed', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);

    await clean(fileSystem, root, adapters);

    const manifest = await readManifest(fileSystem, root);
    expect(manifest.manifest.entries).toEqual([]);
  });

  it('never removes a file it did not generate', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    write('.test/agents/handwritten.md', 'mine');

    await clean(fileSystem, root, adapters);

    expect(exists('.test/agents/handwritten.md')).toBe(true);
  });

  it('refuses to delete a generated file that was edited, and keeps it', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    write('.test/agents/alpha.md', 'edited by hand');

    const outcome = await clean(fileSystem, root, adapters);

    expect(outcome.ok).toBe(false);
    expect(exists('.test/agents/alpha.md')).toBe(true);
  });

  it('deletes an edited generated file once a forced sync has reclaimed it', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    write('.test/agents/alpha.md', 'edited by hand');

    await sync(fileSystem, root, adapters, { force: true });
    const outcome = await clean(fileSystem, root, adapters);

    expect(outcome.ok).toBe(true);
    expect(exists('.test/agents/alpha.md')).toBe(false);
  });

  it('removes the directories its deletions left empty', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    expect(exists('.test/agents')).toBe(true);

    await clean(fileSystem, root, adapters);

    // Both the directory the files were in and the parent it was the only
    // occupant of: an empty '.test/agents' is as much leftover as the files.
    expect(exists('.test/agents')).toBe(false);
    expect(exists('.test')).toBe(false);
  });

  it('keeps a directory that still holds a file it did not generate', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    write('.test/agents/handwritten.md', 'mine');

    await clean(fileSystem, root, adapters);

    expect(exists('.test/agents')).toBe(true);
    expect(exists('.test/agents/handwritten.md')).toBe(true);
  });

  it('never removes the canonical directory', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);

    await clean(fileSystem, root, adapters);

    expect(exists('.ai')).toBe(true);
    expect(exists('.ai/agents')).toBe(true);
  });

  it('is a no-op on a project that was never synchronized', async () => {
    seedProject();

    const outcome = await clean(fileSystem, root, adapters);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.result.summary.deleted).toBe(0);
  });

  it('still runs when the canonical sources no longer validate', async () => {
    // This is the state somebody reaches for it in. Removal reads the
    // manifest, not `.ai/`, so an invalid source says nothing about whether a
    // generated file may be deleted — and refusing here left a repository with
    // `sync` blocked and no supported way back.
    seedProject();
    await sync(fileSystem, root, adapters);
    expect(exists('.test/agents/alpha.md')).toBe(true);

    write('.ai/agents/broken.md', '---\n- not a mapping\n---\n\nBody.\n');

    const outcome = await clean(fileSystem, root, adapters);

    expect(outcome.ok).toBe(true);
    expect(exists('.test/agents/alpha.md')).toBe(false);
    expect(exists('.test/agents/beta.md')).toBe(false);
    // The invalid source is the author's file and is left exactly where it is.
    expect(exists('.ai/agents/broken.md')).toBe(true);
  });

  it('still refuses when a generated path no longer resolves where it says', async () => {
    // The one class of error that does bear on removal: the manifest records
    // paths, so a generated directory that has become a symbolic link would
    // have its target unlinked instead.
    seedProject();
    await sync(fileSystem, root, adapters);

    const generated = path.join(root, '.test', 'agents');
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiconfig-outside-'));
    await fsp.rm(generated, { recursive: true, force: true });
    try {
      fs.symlinkSync(outside, generated, 'dir');
    } catch {
      // Unprivileged Windows cannot create one; the check itself is covered by
      // the containment suite.
      return;
    }

    const outcome = await clean(fileSystem, root, adapters);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.diagnostics.map((d) => d.code)).toContain(
      'UNSAFE_OUTPUT_PATH',
    );
    await fsp.rm(outside, { recursive: true, force: true });
  });
});
