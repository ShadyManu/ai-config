import { beforeEach, describe, expect, it } from 'vitest';

import type { AiConfiguration } from '../src/domain/configuration.js';
import type { Manifest } from '../src/manifest/manifest.js';
import { MANIFEST_PATH, readManifest } from '../src/manifest/manifest.js';
import { sha256 } from '../src/manifest/hash.js';
import type { WritablePlan } from '../src/plan/plan.js';
import { write } from '../src/sync/writer.js';
import { MemoryFileSystem } from '../src/testing/memory-file-system.js';

const EMPTY_CONFIGURATION: AiConfiguration = {
  instructions: [],
  agents: [],
  skills: [],
  commands: [],
};

const manifestOf = (entries: readonly { path: string; hash: string }[]): Manifest => ({
  version: 1,
  entries: entries.map((entry) => ({
    path: entry.path,
    providers: ['claude'],
    source: null,
    hash: entry.hash,
  })),
});

/** `onDisk` is what the plan observed there, which the writer re-verifies. */
const updateAction = (path: string, value: string, onDisk: string) => ({
  kind: 'update' as const,
  path,
  providers: ['claude'],
  source: null,
  content: { kind: 'text' as const, value },
  hash: sha256(value),
  expected: sha256(onDisk),
});

const restoreAction = (path: string, value: string) => {
  return {
    kind: 'restore' as const,
    path,
    providers: ['claude'],
    source: null,
    content: { kind: 'text' as const, value },
    hash: sha256(value),
    // A restore targets a path the plan found empty.
    expected: undefined,
  };
};

const createAction = (path: string, value: string) => ({
  kind: 'create' as const,
  path,
  providers: ['claude'],
  source: null,
  content: { kind: 'text' as const, value },
  hash: sha256(value),
});

let fileSystem: MemoryFileSystem;

beforeEach(() => {
  fileSystem = new MemoryFileSystem();
});

const currentManifest = async () => (await readManifest(fileSystem, fileSystem.root)).manifest;

describe('write', () => {
  it('writes every action and records them all', async () => {
    const plan: WritablePlan = {
      actions: [createAction('a.md', 'A'), createAction('b.md', 'B')],
      nextManifest: manifestOf([
        { path: 'a.md', hash: sha256('A') },
        { path: 'b.md', hash: sha256('B') },
      ]),
      currentManifest: manifestOf([]),
    };

    const result = await write(fileSystem, fileSystem.root, plan, EMPTY_CONFIGURATION);

    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toEqual({ written: 2, deleted: 0, unchanged: 0 });
    expect(fileSystem.get('a.md')).toBe('A');
    expect((await currentManifest()).entries.map((entry) => entry.path)).toEqual(['a.md', 'b.md']);
  });

  it('refuses to create over a file that appeared after planning', async () => {
    // The plan said this path was absent; exclusive creation is what stops the
    // gap between planning and writing from clobbering someone else's file.
    fileSystem.set('a.md', 'written by someone else');

    const plan: WritablePlan = {
      actions: [createAction('a.md', 'A')],
      nextManifest: manifestOf([{ path: 'a.md', hash: sha256('A') }]),
      currentManifest: manifestOf([]),
    };

    const result = await write(fileSystem, fileSystem.root, plan, EMPTY_CONFIGURATION);

    expect(result.diagnostics.map((d) => d.code)).toEqual(['WRITE_FAILED']);
    expect(fileSystem.get('a.md')).toBe('written by someone else');
  });

  it('does not delete a file whose content changed after planning', async () => {
    fileSystem.set('gone.md', 'edited after the snapshot');

    const plan: WritablePlan = {
      actions: [
        {
          kind: 'delete',
          path: 'gone.md',
          providers: ['claude'],
          source: null,
          hash: sha256('what AI Config wrote'),
        },
      ],
      nextManifest: manifestOf([]),
      currentManifest: manifestOf([{ path: 'gone.md', hash: sha256('what AI Config wrote') }]),
    };

    const result = await write(fileSystem, fileSystem.root, plan, EMPTY_CONFIGURATION);

    expect(result.diagnostics.map((d) => d.code)).toEqual(['ORPHAN_MODIFIED']);
    expect(fileSystem.get('gone.md')).toBe('edited after the snapshot');
    // Ownership is retained, so the file is not orphaned into untracked limbo.
    expect((await currentManifest()).entries.map((entry) => entry.path)).toEqual(['gone.md']);
  });

  it('preserves manifest entries for paths the plan never mentions', async () => {
    // A scoped plan — a single-file restore — must not drop ownership of the
    // rest of the repository.
    fileSystem.set('other.md', 'other');

    const plan: WritablePlan = {
      actions: [createAction('a.md', 'A')],
      nextManifest: manifestOf([{ path: 'a.md', hash: sha256('A') }]),
      currentManifest: manifestOf([{ path: 'other.md', hash: sha256('other') }]),
    };

    await write(fileSystem, fileSystem.root, plan, EMPTY_CONFIGURATION);

    expect((await currentManifest()).entries.map((entry) => entry.path)).toEqual([
      'a.md',
      'other.md',
    ]);
  });

  it('does not replace a file that changed after planning', async () => {
    // Planning reads the working tree and writes it back a moment later. An
    // editor saving into that gap must not have its edit silently discarded,
    // which is the whole point of drift protection.
    fileSystem.set('a.md', 'saved while sync was running');

    const plan: WritablePlan = {
      actions: [updateAction('a.md', 'generated', 'what the plan saw')],
      nextManifest: manifestOf([{ path: 'a.md', hash: sha256('generated') }]),
      currentManifest: manifestOf([{ path: 'a.md', hash: sha256('what the plan saw') }]),
    };

    const result = await write(fileSystem, fileSystem.root, plan, EMPTY_CONFIGURATION);

    expect(result.diagnostics.map((d) => d.code)).toEqual(['TARGET_CHANGED_DURING_SYNC']);
    expect(fileSystem.get('a.md')).toBe('saved while sync was running');
    expect(result.summary.written).toBe(0);
    // Ownership is retained, so the next run reports drift rather than refusing
    // the file as one AI Config never created.
    const entries = (await currentManifest()).entries;
    expect(entries.map((entry) => entry.path)).toEqual(['a.md']);
    expect(entries[0]?.hash).toBe(sha256('what the plan saw'));
  });

  it('does not restore over a file that appeared after planning', async () => {
    fileSystem.set('a.md', 'someone else got there first');

    const plan: WritablePlan = {
      actions: [restoreAction('a.md', 'generated')],
      nextManifest: manifestOf([{ path: 'a.md', hash: sha256('generated') }]),
      currentManifest: manifestOf([{ path: 'a.md', hash: sha256('generated') }]),
    };

    const result = await write(fileSystem, fileSystem.root, plan, EMPTY_CONFIGURATION);

    expect(result.diagnostics.map((d) => d.code)).toEqual(['TARGET_CHANGED_DURING_SYNC']);
    expect(fileSystem.get('a.md')).toBe('someone else got there first');
  });

  it('restores a path that is still empty', async () => {
    const plan: WritablePlan = {
      actions: [restoreAction('a.md', 'generated')],
      nextManifest: manifestOf([{ path: 'a.md', hash: sha256('generated') }]),
      currentManifest: manifestOf([{ path: 'a.md', hash: sha256('generated') }]),
    };

    const result = await write(fileSystem, fileSystem.root, plan, EMPTY_CONFIGURATION);

    expect(result.diagnostics).toEqual([]);
    expect(fileSystem.get('a.md')).toBe('generated');
  });

  it('does not rewrite the manifest when nothing changed', async () => {
    const plan: WritablePlan = {
      actions: [],
      nextManifest: manifestOf([]),
      currentManifest: manifestOf([]),
    };

    await write(fileSystem, fileSystem.root, plan, EMPTY_CONFIGURATION);
    const first = fileSystem.get(MANIFEST_PATH);

    await write(fileSystem, fileSystem.root, plan, EMPTY_CONFIGURATION);
    expect(fileSystem.get(MANIFEST_PATH)).toBe(first);
  });
});

describe('write: partial failure', () => {
  /** A filesystem whose nth write fails, to exercise the recovery path. */
  class FailingFileSystem extends MemoryFileSystem {
    private writes = 0;

    public constructor(private readonly failOnWrite: number) {
      super();
    }

    public override writeFileAtomic(
      target: string,
      content: Buffer,
      options?: { executable?: boolean; exclusive?: boolean },
    ): Promise<void> {
      if (!target.endsWith('.generated.json')) {
        this.writes += 1;
        if (this.writes === this.failOnWrite) {
          return Promise.reject(new Error('disk full'));
        }
      }
      return super.writeFileAtomic(target, content, options);
    }
  }

  it('reports the failure and stops', async () => {
    const failing = new FailingFileSystem(2);
    const plan: WritablePlan = {
      actions: [createAction('a.md', 'A'), createAction('b.md', 'B'), createAction('c.md', 'C')],
      nextManifest: manifestOf([
        { path: 'a.md', hash: sha256('A') },
        { path: 'b.md', hash: sha256('B') },
        { path: 'c.md', hash: sha256('C') },
      ]),
      currentManifest: manifestOf([]),
    };

    const result = await write(failing, failing.root, plan, EMPTY_CONFIGURATION);

    expect(result.diagnostics.map((d) => d.code)).toEqual(['WRITE_FAILED']);
    expect(result.diagnostics[0]?.source).toBe('b.md');
    expect(failing.has('a.md')).toBe(true);
    expect(failing.has('c.md')).toBe(false);
  });

  it('records what was written, so the next sync does not see it as untracked', async () => {
    const failing = new FailingFileSystem(2);
    const plan: WritablePlan = {
      actions: [createAction('a.md', 'A'), createAction('b.md', 'B')],
      nextManifest: manifestOf([
        { path: 'a.md', hash: sha256('A') },
        { path: 'b.md', hash: sha256('B') },
      ]),
      currentManifest: manifestOf([]),
    };

    await write(failing, failing.root, plan, EMPTY_CONFIGURATION);

    const manifest = (await readManifest(failing, failing.root)).manifest;
    expect(manifest.entries.map((entry) => entry.path)).toEqual(['a.md']);
    expect(manifest.entries[0]?.hash).toBe(sha256('A'));
  });

  it('reports a manifest it could not record, naming the unclaimed files', async () => {
    // The files are on disk; without the manifest nothing claims them, and the
    // next run reads them as files AI Config never created.
    class FailingManifest extends MemoryFileSystem {
      public override writeFileAtomic(
        target: string,
        content: Buffer,
        options?: { executable?: boolean; exclusive?: boolean },
      ): Promise<void> {
        if (target.endsWith('.generated.json')) {
          return Promise.reject(new Error('disk full'));
        }
        return super.writeFileAtomic(target, content, options);
      }
    }

    const failing = new FailingManifest();
    const plan: WritablePlan = {
      actions: [createAction('a.md', 'A')],
      nextManifest: manifestOf([{ path: 'a.md', hash: sha256('A') }]),
      currentManifest: manifestOf([]),
    };

    const result = await write(failing, failing.root, plan, EMPTY_CONFIGURATION);

    expect(result.diagnostics.map((d) => d.code)).toEqual(['MANIFEST_WRITE_FAILED']);
    expect(result.diagnostics[0]?.message).toContain('a.md');
    expect(result.diagnostics[0]?.message).toContain('disk full');
    expect(failing.get('a.md')).toBe('A');
  });

  it('keeps the previous hash for a file the aborted pass never reached', async () => {
    // Recording the *intended* hash here would make the next sync report drift
    // on a file nobody touched, recoverable only with the drift override.
    const failing = new FailingFileSystem(1);
    failing.set('a.md', 'old A');
    failing.set('b.md', 'old B');

    const plan: WritablePlan = {
      actions: [updateAction('a.md', 'new A', 'old A'), updateAction('b.md', 'new B', 'old B')],
      nextManifest: manifestOf([
        { path: 'a.md', hash: sha256('new A') },
        { path: 'b.md', hash: sha256('new B') },
      ]),
      currentManifest: manifestOf([
        { path: 'a.md', hash: sha256('old A') },
        { path: 'b.md', hash: sha256('old B') },
      ]),
    };

    await write(failing, failing.root, plan, EMPTY_CONFIGURATION);

    const manifest = (await readManifest(failing, failing.root)).manifest;
    const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry.hash]));

    // Neither file was written, so both must still carry their on-disk hash.
    expect(byPath.get('a.md')).toBe(sha256('old A'));
    expect(byPath.get('b.md')).toBe(sha256('old B'));
    expect(failing.get('a.md')).toBe('old A');
    expect(failing.get('b.md')).toBe('old B');
  });
});
