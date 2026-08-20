import { describe, expect, it } from 'vitest';

import { analyze } from '../src/sync/sync.js';
import { init } from '../src/sync/init.js';
import { MemoryFileSystem } from '../src/testing/memory-file-system.js';

const options = { providers: ['claude' as const], adapters: [], version: '0.0.0-test' };

describe('init', () => {
  it('creates a starter .ai/ directory', async () => {
    const fileSystem = new MemoryFileSystem();

    const outcome = await init(fileSystem, fileSystem.root, options);

    expect(outcome.ok).toBe(true);
    expect(fileSystem.get('.ai/config.yaml')).toContain('enabled:');
  });

  it('creates a valid, loadable configuration when no provider is selected', async () => {
    const fileSystem = new MemoryFileSystem();

    const outcome = await init(fileSystem, fileSystem.root, {
      ...options,
      providers: [],
    });
    const analysis = await analyze(fileSystem, fileSystem.root, []);

    expect(outcome.ok).toBe(true);
    expect(fileSystem.get('.ai/config.yaml')).toBe(
      '# AI Config canonical configuration.\n' +
        '# Specification: https://github.com/ShadyManu/ai-config/blob/main/docs/specification.md\n' +
        '\n' +
        'schema: 1\n' +
        '\n' +
        'providers:\n' +
        '  enabled: []\n',
    );
    expect(analysis.ok).toBe(true);
    if (analysis.ok) {
      expect(analysis.analysis.project.config.providers).toEqual([]);
      expect(analysis.analysis.diagnostics).toEqual([]);
    }
  });

  it('writes no canonical content of its own', async () => {
    // The four content directories are created empty. Anything inside them
    // would be words AI Config put in the author's mouth, in a directory that
    // is entirely theirs.
    const fileSystem = new MemoryFileSystem();

    await init(fileSystem, fileSystem.root, options);

    expect(fileSystem.paths()).toEqual(['.ai/config.yaml', '.ai/generation-rules.md']);
    for (const directory of ['instructions', 'agents', 'skills', 'commands']) {
      expect(await fileSystem.exists(`${fileSystem.root}/.ai/${directory}`), directory).toBe(true);
    }
  });

  it('refuses an existing .ai/ rather than merging into it', async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.set('.ai/config.yaml', 'already mine');

    const outcome = await init(fileSystem, fileSystem.root, options);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toEqual(['ALREADY_INITIALIZED']);
    expect(fileSystem.get('.ai/config.yaml')).toBe('already mine');
  });

  it('refuses a starter file that appears after the check', async () => {
    /**
     * `.ai/` is absent when init looks, and a file materializes before the
     * write — a second `init`, or an editor restoring a session. Checking once
     * and writing later would replace exactly the file init promises never to
     * touch.
     */
    class RacingFileSystem extends MemoryFileSystem {
      public override exists(): Promise<boolean> {
        return Promise.resolve(false);
      }
    }

    const fileSystem = new RacingFileSystem();
    fileSystem.set('.ai/config.yaml', 'written by the other run');

    const outcome = await init(fileSystem, fileSystem.root, options);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toEqual(['ALREADY_INITIALIZED']);
    expect(fileSystem.get('.ai/config.yaml')).toBe('written by the other run');
  });
});
