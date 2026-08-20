import { describe, expect, it } from 'vitest';

import type { CompiledArtifact } from '../src/compile/compile.js';
import type { Manifest } from '../src/manifest/manifest.js';
import { plan, stateOf, toWritablePlan } from '../src/plan/plan.js';
import type { WorkingTreeSnapshot } from '../src/probe/probe.js';

const artifact = (path: string, hash: string): CompiledArtifact => ({
  path,
  providers: ['claude'],
  source: 'agents/reviewer',
  hash,
  content: { kind: 'text', value: `content-of-${path}` },
});

const manifest = (entries: readonly { path: string; hash: string }[]): Manifest => ({
  version: 1,
  entries: entries.map((entry) => ({
    path: entry.path,
    providers: ['claude'],
    source: 'agents/reviewer',
    hash: entry.hash,
  })),
});

const snapshot = (files: Record<string, string | null>): WorkingTreeSnapshot =>
  new Map(
    Object.entries(files).map(([path, hash]) => [
      path,
      hash === null ? { exists: false, hash: undefined } : { exists: true, hash },
    ]),
  );

const FILE = '.claude/agents/reviewer.md';

describe('plan', () => {
  it('creates a file that is neither tracked nor present', () => {
    const result = plan([artifact(FILE, 'sha256:a')], manifest([]), snapshot({ [FILE]: null }));
    expect(result.actions[0]?.kind).toBe('create');
    expect(stateOf(result.actions[0]!)).toBe('missing');
  });

  it('restores a tracked file that was deleted', () => {
    const result = plan(
      [artifact(FILE, 'sha256:a')],
      manifest([{ path: FILE, hash: 'sha256:a' }]),
      snapshot({ [FILE]: null }),
    );
    expect(result.actions[0]?.kind).toBe('restore');
    expect(stateOf(result.actions[0]!)).toBe('missing');
  });

  it('reports unchanged when the manifest and disk both match the desired output', () => {
    const result = plan(
      [artifact(FILE, 'sha256:a')],
      manifest([{ path: FILE, hash: 'sha256:a' }]),
      snapshot({ [FILE]: 'sha256:a' }),
    );
    expect(result.actions[0]?.kind).toBe('unchanged');
    expect(stateOf(result.actions[0]!)).toBe('synced');
  });

  it('updates when the source changed but the file matches the manifest', () => {
    const result = plan(
      [artifact(FILE, 'sha256:new')],
      manifest([{ path: FILE, hash: 'sha256:old' }]),
      snapshot({ [FILE]: 'sha256:old' }),
    );
    expect(result.actions[0]?.kind).toBe('update');
    expect(stateOf(result.actions[0]!)).toBe('stale');
  });

  it('blocks on drift by default', () => {
    const result = plan(
      [artifact(FILE, 'sha256:a')],
      manifest([{ path: FILE, hash: 'sha256:a' }]),
      snapshot({ [FILE]: 'sha256:edited-by-hand' }),
    );
    const action = result.actions[0];
    expect(action?.kind).toBe('blocked');
    expect(action?.kind === 'blocked' && action.reason).toBe('drift');
    expect(stateOf(action!)).toBe('drift');
  });

  it('overwrites drift under the overwrite policy', () => {
    const result = plan(
      [artifact(FILE, 'sha256:a')],
      manifest([{ path: FILE, hash: 'sha256:a' }]),
      snapshot({ [FILE]: 'sha256:edited-by-hand' }),
      { onDrift: 'overwrite' },
    );
    expect(result.actions[0]?.kind).toBe('update');
  });

  it('blocks an untracked file that already exists', () => {
    const result = plan(
      [artifact('AGENTS.md', 'sha256:a')],
      manifest([]),
      snapshot({ 'AGENTS.md': 'sha256:handwritten' }),
    );
    const action = result.actions[0];
    expect(action?.kind).toBe('blocked');
    expect(action?.kind === 'blocked' && action.reason).toBe('untracked');
    expect(stateOf(action!)).toBe('conflict');
  });

  it('never overwrites an untracked file, even under the overwrite policy', () => {
    // Overwriting a file AI Config did not create is unrecoverable: there is no
    // canonical copy to restore from.
    const result = plan(
      [artifact('AGENTS.md', 'sha256:a')],
      manifest([]),
      snapshot({ 'AGENTS.md': 'sha256:handwritten' }),
      { onDrift: 'overwrite' },
    );
    const action = result.actions[0];
    expect(action?.kind).toBe('blocked');
    expect(action?.kind === 'blocked' && action.reason).toBe('untracked');
  });

  it('deletes a manifest entry nothing produces any more', () => {
    const result = plan(
      [],
      manifest([{ path: FILE, hash: 'sha256:a' }]),
      snapshot({ [FILE]: 'sha256:a' }),
    );
    expect(result.actions[0]?.kind).toBe('delete');
    expect(stateOf(result.actions[0]!)).toBe('orphaned');
  });

  it('never deletes a file outside the manifest', () => {
    const result = plan([], manifest([]), snapshot({ 'user-owned.md': 'sha256:x' }));
    expect(result.actions).toEqual([]);
  });

  it('orders actions by path deterministically', () => {
    const result = plan(
      [artifact('z.md', 'sha256:z'), artifact('a.md', 'sha256:a')],
      manifest([]),
      snapshot({ 'z.md': null, 'a.md': null }),
    );
    expect(result.actions.map((action) => action.path)).toEqual(['a.md', 'z.md']);
  });
});

describe('toWritablePlan', () => {
  it('refuses a plan containing blocked actions', () => {
    const syncPlan = plan(
      [artifact(FILE, 'sha256:a')],
      manifest([{ path: FILE, hash: 'sha256:a' }]),
      snapshot({ [FILE]: 'sha256:drifted' }),
    );
    const result = toWritablePlan(syncPlan);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.diagnostics.map((d) => d.code)).toEqual(['DRIFT_BLOCKS_WRITE']);
  });

  it('explains how to resolve an untracked conflict', () => {
    const syncPlan = plan(
      [artifact('AGENTS.md', 'sha256:a')],
      manifest([]),
      snapshot({ 'AGENTS.md': 'sha256:x' }),
    );
    const result = toWritablePlan(syncPlan);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.diagnostics[0]?.code).toBe('UNTRACKED_TARGET_EXISTS');
    expect(result.diagnostics[0]?.message).toContain('.ai/');
  });

  it('builds the next manifest from written and unchanged files only', () => {
    const syncPlan = plan(
      [artifact('a.md', 'sha256:a')],
      manifest([{ path: 'gone.md', hash: 'sha256:g' }]),
      snapshot({ 'a.md': null, 'gone.md': 'sha256:g' }),
    );
    const result = toWritablePlan(syncPlan);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.nextManifest.entries.map((entry) => entry.path)).toEqual(['a.md']);
  });
});
