import { describe, expect, it } from 'vitest';

import type { CompiledArtifact } from '../src/compile/compile.js';
import type { Manifest } from '../src/manifest/manifest.js';
import type { DriftPolicy, FileState, PlanActionKind } from '../src/plan/plan.js';
import { plan, stateOf, toWritablePlan } from '../src/plan/plan.js';
import type { WorkingTreeSnapshot } from '../src/probe/probe.js';

/**
 * The planner decides whether a file is written, deleted or refused, so a gap
 * in it is a gap in the ownership guarantees. `plan.test.ts` covers the cases
 * one at a time; this file enumerates the whole input space instead, so a rule
 * that only holds for the combinations someone thought to write down fails
 * here.
 *
 * Three inputs decide an action — desired output, recorded ownership, and what
 * is on disk — plus the drift policy. Each is reduced to the distinctions the
 * planner can actually observe:
 *
 * - `desired`: absent, or wanted with content `d`;
 * - `manifest`: absent, recorded as `d`, or recorded as something else (`m`);
 * - `disk`: absent, or holding `d`, `m` or an unrelated `x`;
 * - `policy`: `block` or `overwrite`.
 *
 * That is 2 × 3 × 4 × 2 = 48 combinations, and the table below states every
 * one. The expectations are written from `docs/architecture.md` — the action
 * table and the drift policy section — not from reading the implementation.
 */

const FILE = '.claude/agents/reviewer.md';
const PROVIDERS = ['claude'] as const;
const SOURCE = 'agents/reviewer';

/** The three contents a case can refer to, and their hashes. */
const HASH = { d: 'sha256:desired', m: 'sha256:manifest', x: 'sha256:foreign' } as const;

type Content = keyof typeof HASH;
type Presence = Content | 'absent';

const artifacts = (desired: boolean): readonly CompiledArtifact[] =>
  desired
    ? [
        {
          path: FILE,
          providers: PROVIDERS,
          source: SOURCE,
          hash: HASH.d,
          content: { kind: 'text', value: 'desired content' },
        },
      ]
    : [];

const manifestOf = (recorded: Presence): Manifest => ({
  version: 1,
  entries:
    recorded === 'absent'
      ? []
      : [{ path: FILE, providers: PROVIDERS, source: SOURCE, hash: HASH[recorded] }],
});

const snapshotOf = (disk: Presence): WorkingTreeSnapshot =>
  new Map([
    [
      FILE,
      disk === 'absent' ? { exists: false, hash: undefined } : { exists: true, hash: HASH[disk] },
    ],
  ]);

/** What the planner must do, for one drift policy. */
interface Outcome {
  readonly kind: PlanActionKind;
  readonly state: FileState;
  readonly reason?: 'drift' | 'untracked' | 'orphan-modified';
}

interface Row {
  /** `true` when a provider still generates this path. */
  readonly desired: boolean;
  readonly manifest: Presence;
  readonly disk: Presence;
  /** Expected outcome under `onDrift: 'block'`. */
  readonly block: Outcome | 'no action';
  /** Expected outcome under `onDrift: 'overwrite'`. */
  readonly overwrite: Outcome | 'no action';
}

const CREATE: Outcome = { kind: 'create', state: 'missing' };
const RESTORE: Outcome = { kind: 'restore', state: 'missing' };
const UPDATE: Outcome = { kind: 'update', state: 'stale' };
const UNCHANGED: Outcome = { kind: 'unchanged', state: 'synced' };
const DELETE: Outcome = { kind: 'delete', state: 'orphaned' };
const DRIFT: Outcome = { kind: 'blocked', state: 'drift', reason: 'drift' };
const UNTRACKED: Outcome = { kind: 'blocked', state: 'conflict', reason: 'untracked' };
const ORPHAN: Outcome = { kind: 'blocked', state: 'drift', reason: 'orphan-modified' };

const MATRIX: readonly Row[] = [
  // Desired, never recorded. Anything already at the path belongs to someone
  // else, and no policy adopts it — that is the rule that protects a
  // hand-written AGENTS.md.
  { desired: true, manifest: 'absent', disk: 'absent', block: CREATE, overwrite: CREATE },
  { desired: true, manifest: 'absent', disk: 'd', block: UNTRACKED, overwrite: UNTRACKED },
  { desired: true, manifest: 'absent', disk: 'm', block: UNTRACKED, overwrite: UNTRACKED },
  { desired: true, manifest: 'absent', disk: 'x', block: UNTRACKED, overwrite: UNTRACKED },

  // Desired and recorded as the content it should have.
  { desired: true, manifest: 'd', disk: 'absent', block: RESTORE, overwrite: RESTORE },
  { desired: true, manifest: 'd', disk: 'd', block: UNCHANGED, overwrite: UNCHANGED },
  { desired: true, manifest: 'd', disk: 'm', block: DRIFT, overwrite: UPDATE },
  { desired: true, manifest: 'd', disk: 'x', block: DRIFT, overwrite: UPDATE },

  // Desired, recorded, but the canonical source has changed since: the
  // manifest still holds the previous content.
  { desired: true, manifest: 'm', disk: 'absent', block: RESTORE, overwrite: RESTORE },
  // On disk is the content that is wanted, but not the content AI Config
  // wrote — someone edited the file into its future state. That is still an
  // edit AI Config did not make, so it is drift.
  { desired: true, manifest: 'm', disk: 'd', block: DRIFT, overwrite: UPDATE },
  // Untouched since the last sync, and now out of date: the ordinary update.
  { desired: true, manifest: 'm', disk: 'm', block: UPDATE, overwrite: UPDATE },
  { desired: true, manifest: 'm', disk: 'x', block: DRIFT, overwrite: UPDATE },

  // Not desired and not recorded: not AI Config's file, whatever is there.
  {
    desired: false,
    manifest: 'absent',
    disk: 'absent',
    block: 'no action',
    overwrite: 'no action',
  },
  { desired: false, manifest: 'absent', disk: 'd', block: 'no action', overwrite: 'no action' },
  { desired: false, manifest: 'absent', disk: 'm', block: 'no action', overwrite: 'no action' },
  { desired: false, manifest: 'absent', disk: 'x', block: 'no action', overwrite: 'no action' },

  // Orphans: recorded, no longer generated. Deleted only when the bytes are
  // still the ones AI Config wrote, and the drift policy deliberately does not
  // reach here — deleting a modified orphan is unrecoverable.
  { desired: false, manifest: 'd', disk: 'absent', block: DELETE, overwrite: DELETE },
  { desired: false, manifest: 'd', disk: 'd', block: DELETE, overwrite: DELETE },
  { desired: false, manifest: 'd', disk: 'm', block: ORPHAN, overwrite: ORPHAN },
  { desired: false, manifest: 'd', disk: 'x', block: ORPHAN, overwrite: ORPHAN },

  { desired: false, manifest: 'm', disk: 'absent', block: DELETE, overwrite: DELETE },
  { desired: false, manifest: 'm', disk: 'd', block: ORPHAN, overwrite: ORPHAN },
  { desired: false, manifest: 'm', disk: 'm', block: DELETE, overwrite: DELETE },
  { desired: false, manifest: 'm', disk: 'x', block: ORPHAN, overwrite: ORPHAN },
];

const POLICIES: readonly DriftPolicy[] = ['block', 'overwrite'];

const label = (row: Row, policy: DriftPolicy): string =>
  `${row.desired ? 'desired' : 'not desired'}, manifest ${row.manifest}, disk ${row.disk}, ${policy}`;

describe('planner truth table', () => {
  it('covers every combination of desired output, ownership and disk state exactly once', () => {
    const keys = MATRIX.map((row) => `${String(row.desired)}|${row.manifest}|${row.disk}`);
    expect(new Set(keys).size).toBe(keys.length);

    const expected: string[] = [];
    for (const desired of [true, false]) {
      for (const recorded of ['absent', 'd', 'm'] as const) {
        for (const disk of ['absent', 'd', 'm', 'x'] as const) {
          expected.push(`${String(desired)}|${recorded}|${disk}`);
        }
      }
    }
    expect([...keys].sort()).toEqual(expected.sort());
  });

  for (const row of MATRIX) {
    for (const policy of POLICIES) {
      const expectation = policy === 'block' ? row.block : row.overwrite;

      it(`${label(row, policy)} → ${expectation === 'no action' ? 'no action' : expectation.kind}`, () => {
        const result = plan(
          artifacts(row.desired),
          manifestOf(row.manifest),
          snapshotOf(row.disk),
          { onDrift: policy },
        );

        if (expectation === 'no action') {
          expect(result.actions).toEqual([]);
          return;
        }

        expect(result.actions).toHaveLength(1);
        const action = result.actions[0]!;
        expect(action.kind).toBe(expectation.kind);
        expect(stateOf(action)).toBe(expectation.state);
        if (action.kind === 'blocked') {
          expect(action.reason).toBe(expectation.reason);
        }

        // Ownership and provenance travel with the action whatever it is, so
        // the manifest a completed plan leaves behind is never guessed at.
        expect(action.path).toBe(FILE);
        expect(action.providers).toEqual(PROVIDERS);
        expect(action.source).toBe(SOURCE);
      });
    }
  }
});

describe('planner truth table: written content', () => {
  it('always writes the desired content and hash, never what is on disk', () => {
    for (const row of MATRIX.filter((candidate) => candidate.desired)) {
      for (const policy of POLICIES) {
        const result = plan(artifacts(true), manifestOf(row.manifest), snapshotOf(row.disk), {
          onDrift: policy,
        });
        const action = result.actions[0]!;
        if (action.kind === 'create' || action.kind === 'restore' || action.kind === 'update') {
          expect(action.hash, label(row, policy)).toBe(HASH.d);
          expect(action.content, label(row, policy)).toEqual({
            kind: 'text',
            value: 'desired content',
          });
        }
      }
    }
  });

  it('carries the observed hash on an update, so the writer can detect a save it never saw', () => {
    // Planning reads the working tree and writes it later; an editor can save
    // into that gap. `expected` is what makes that detectable.
    for (const row of MATRIX.filter((candidate) => candidate.desired)) {
      for (const policy of POLICIES) {
        const result = plan(artifacts(true), manifestOf(row.manifest), snapshotOf(row.disk), {
          onDrift: policy,
        });
        const action = result.actions[0]!;
        if (action.kind === 'update') {
          expect(action.expected, label(row, policy)).toBe(
            row.disk === 'absent' ? undefined : HASH[row.disk],
          );
        }
        if (action.kind === 'create' || action.kind === 'restore') {
          // Nothing was observed at the path, so there is nothing to re-verify.
          expect(action.expected, label(row, policy)).toBeUndefined();
        }
      }
    }
  });

  it('deletes against the recorded hash, so a file that changed first is not removed', () => {
    for (const row of MATRIX.filter((candidate) => !candidate.desired)) {
      const result = plan(artifacts(false), manifestOf(row.manifest), snapshotOf(row.disk));
      const action = result.actions[0];
      if (action?.kind === 'delete') {
        expect(action.hash).toBe(HASH[row.manifest as Content]);
      }
    }
  });
});

describe('planner truth table: writability', () => {
  const CODES = {
    drift: 'DRIFT_BLOCKS_WRITE',
    untracked: 'UNTRACKED_TARGET_EXISTS',
    'orphan-modified': 'ORPHAN_MODIFIED',
  } as const;

  it('refuses every blocked combination with the code that names its remedy', () => {
    for (const row of MATRIX) {
      for (const policy of POLICIES) {
        const expectation = policy === 'block' ? row.block : row.overwrite;
        if (expectation === 'no action' || expectation.kind !== 'blocked') {
          continue;
        }

        const writable = toWritablePlan(
          plan(artifacts(row.desired), manifestOf(row.manifest), snapshotOf(row.disk), {
            onDrift: policy,
          }),
        );

        expect(writable.ok, label(row, policy)).toBe(false);
        if (writable.ok) {
          continue;
        }
        expect(writable.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
          CODES[expectation.reason!],
        ]);
        expect(writable.diagnostics.every((diagnostic) => diagnostic.severity === 'error')).toBe(
          true,
        );
      }
    }
  });

  it('keeps ownership of everything a writable plan writes or leaves alone, and drops what it deletes', () => {
    for (const row of MATRIX) {
      for (const policy of POLICIES) {
        const expectation = policy === 'block' ? row.block : row.overwrite;
        const writable = toWritablePlan(
          plan(artifacts(row.desired), manifestOf(row.manifest), snapshotOf(row.disk), {
            onDrift: policy,
          }),
        );
        if (!writable.ok) {
          continue;
        }

        const paths = writable.plan.nextManifest.entries.map((entry) => entry.path);
        const owned =
          expectation !== 'no action' &&
          (expectation.kind === 'create' ||
            expectation.kind === 'restore' ||
            expectation.kind === 'update' ||
            expectation.kind === 'unchanged');

        expect(paths, label(row, policy)).toEqual(owned ? [FILE] : []);

        if (owned) {
          // The next manifest records the content the plan puts there, which
          // is what makes the following sync see `unchanged` rather than drift.
          expect(writable.plan.nextManifest.entries[0]!.hash).toBe(HASH.d);
        }
      }
    }
  });
});
