import type { FileContent } from '../adapter/adapter.js';
import type { CompiledArtifact } from '../compile/compile.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import { compareStrings } from '../domain/ordering.js';
import type { Manifest, ManifestEntry } from '../manifest/manifest.js';
import { manifestIndex } from '../manifest/manifest.js';
import type { WorkingTreeSnapshot } from '../probe/probe.js';

export type DriftPolicy = 'block' | 'overwrite';

export type BlockedReason = 'drift' | 'untracked' | 'orphan-modified';

export type PlanActionKind = 'create' | 'restore' | 'update' | 'unchanged' | 'delete' | 'blocked';

/** The state reported by `aiconfig status`, derived from the action. */
export type FileState = 'synced' | 'stale' | 'missing' | 'orphaned' | 'drift' | 'conflict';

interface PlanActionBase {
  readonly path: string;
  /**
   * Provider identifiers that own the path.
   *
   * Plain strings, not `ProviderId`: a `delete` action can come from a manifest
   * written by a newer AI Config that knows a provider this build does not.
   */
  readonly providers: readonly string[];
  readonly source: string | null;
  readonly ownership?: 'managed' | 'external';
  readonly extension?: string | null;
  readonly executable?: boolean;
}

export interface WriteAction extends PlanActionBase {
  readonly kind: 'create' | 'restore' | 'update';
  readonly content: FileContent;
  readonly hash: string;
  /**
   * The hash the snapshot observed at this path, or `undefined` if nothing was
   * there — re-verified immediately before the file is replaced.
   *
   * Planning reads the working tree once and writes it later, and an editor can
   * save into that gap. Carrying the observed state with the action is what lets
   * the writer notice, rather than overwriting an edit the plan never saw.
   */
  readonly expected?: string | undefined;
}

export interface UnchangedAction extends PlanActionBase {
  readonly kind: 'unchanged';
  readonly hash: string;
}

export interface DeleteAction extends PlanActionBase {
  readonly kind: 'delete';
  /** The hash the manifest recorded, re-verified immediately before removal. */
  readonly hash: string;
}

export interface BlockedAction extends PlanActionBase {
  readonly kind: 'blocked';
  readonly reason: BlockedReason;
}

export type PlanAction = WriteAction | UnchangedAction | DeleteAction | BlockedAction;

export interface SyncPlan {
  readonly actions: readonly PlanAction[];
  /** The manifest the plan was computed against. */
  readonly currentManifest: Manifest;
}

/** A plan proven to contain no blocked actions. Only this can be written. */
export interface WritablePlan {
  readonly actions: readonly Exclude<PlanAction, BlockedAction>[];
  /** The manifest a fully applied plan would leave behind. */
  readonly nextManifest: Manifest;
  /** The manifest before this plan, for recovering from a partial write. */
  readonly currentManifest: Manifest;
}

export const stateOf = (action: PlanAction): FileState => {
  switch (action.kind) {
    case 'create':
    case 'restore':
      return 'missing';
    case 'update':
      return 'stale';
    case 'unchanged':
      return 'synced';
    case 'delete':
      return 'orphaned';
    case 'blocked':
      return action.reason === 'untracked' ? 'conflict' : 'drift';
  }
};

/** Every path the planner needs to know about, for {@link probe}. */
export const pathsToProbe = (
  artifacts: readonly CompiledArtifact[],
  manifest: Manifest,
): readonly string[] =>
  [...new Set([...artifacts.map((a) => a.path), ...manifest.entries.map((e) => e.path)])].sort();

/**
 * Decides what synchronization would do.
 *
 * Pure: every filesystem fact arrives through `snapshot`. Actions are the
 * single source of truth, so `aiconfig status` and `aiconfig sync` cannot
 * disagree about what would happen.
 */
export const plan = (
  artifacts: readonly CompiledArtifact[],
  manifest: Manifest,
  snapshot: WorkingTreeSnapshot,
  options: { readonly onDrift: DriftPolicy } = { onDrift: 'block' },
): SyncPlan => {
  const recorded = manifestIndex(manifest);
  const desired = new Set(artifacts.map((artifact) => artifact.path));
  const actions: PlanAction[] = [];

  for (const artifact of artifacts) {
    actions.push(planArtifact(artifact, recorded.get(artifact.path), snapshot, options.onDrift));
  }

  for (const entry of manifest.entries) {
    if (desired.has(entry.path)) {
      continue;
    }
    actions.push(planOrphan(entry, snapshot));
  }

  return {
    actions: actions.sort((a, b) => compareStrings(a.path, b.path)),
    currentManifest: manifest,
  };
};

const planArtifact = (
  artifact: CompiledArtifact,
  entry: ManifestEntry | undefined,
  snapshot: WorkingTreeSnapshot,
  onDrift: DriftPolicy,
): PlanAction => {
  const base = {
    path: artifact.path,
    providers: artifact.providers,
    source: artifact.source,
    ownership: artifact.ownership ?? 'managed',
    extension: artifact.extension ?? null,
    executable: artifact.executable ?? false,
  };
  const actual = snapshot.get(artifact.path) ?? { exists: false, hash: undefined };
  const exists = actual.exists;

  if (entry === undefined) {
    if (exists) {
      // AI Config did not create this file, so it does not own it. Overwriting
      // is unrecoverable — there is no canonical copy to restore from — which
      // is why no flag bypasses this.
      return { ...base, kind: 'blocked', reason: 'untracked' };
    }
    return { ...base, kind: 'create', content: artifact.content, hash: artifact.hash };
  }

  if (!exists) {
    return { ...base, kind: 'restore', content: artifact.content, hash: artifact.hash };
  }

  const expected = actual.hash;

  const drifted = actual.hash !== entry.hash;
  if (drifted && onDrift === 'block') {
    return { ...base, kind: 'blocked', reason: 'drift' };
  }

  if (!drifted && actual.hash === artifact.hash) {
    return { ...base, kind: 'unchanged', hash: artifact.hash };
  }

  return { ...base, kind: 'update', content: artifact.content, hash: artifact.hash, expected };
};

/**
 * Plans removal of a file nothing produces any more.
 *
 * Deletion is only safe for bytes AI Config can prove it wrote. If the file
 * has been edited since, removing it would destroy work with no warning — and
 * unlike a drifted file that is still desired, there is no canonical source to
 * restore from afterwards.
 *
 * The drift policy deliberately does not apply here. Overwriting drift is
 * recoverable because the canonical source regenerates the file; deleting a
 * modified orphan is not recoverable at all, so no flag enables it.
 */
const planOrphan = (entry: ManifestEntry, snapshot: WorkingTreeSnapshot): PlanAction => {
  const base = {
    path: entry.path,
    providers: entry.providers,
    source: entry.source,
    ownership: entry.ownership ?? ('managed' as const),
    extension: entry.extension ?? null,
    executable: entry.executable ?? false,
  };
  const actual = snapshot.get(entry.path);

  if (actual?.exists !== true) {
    // Already gone: drop the manifest entry without touching the filesystem.
    return { ...base, kind: 'delete', hash: entry.hash };
  }

  if (actual.hash !== entry.hash) {
    return { ...base, kind: 'blocked', reason: 'orphan-modified' };
  }

  return { ...base, kind: 'delete', hash: entry.hash };
};

export const blockedActions = (syncPlan: SyncPlan): readonly BlockedAction[] =>
  syncPlan.actions.filter((action): action is BlockedAction => action.kind === 'blocked');

/**
 * Narrows a plan to one that can be written, or reports why it cannot.
 *
 * The `WritablePlan` type is what makes "the writer never sees a blocked
 * action" a compiler-checked invariant instead of a convention.
 */
export const toWritablePlan = (
  syncPlan: SyncPlan,
):
  | { readonly ok: true; readonly plan: WritablePlan }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] } => {
  const blocked = blockedActions(syncPlan);
  if (blocked.length > 0) {
    return { ok: false, diagnostics: blocked.map(describeBlocked) };
  }

  const actions = syncPlan.actions.filter(
    (action): action is Exclude<PlanAction, BlockedAction> => action.kind !== 'blocked',
  );

  return {
    ok: true,
    plan: {
      actions,
      nextManifest: {
        version: syncPlan.currentManifest.version,
        entries: manifestEntriesFor(actions),
      },
      currentManifest: syncPlan.currentManifest,
    },
  };
};

/** The manifest entries a fully applied plan would leave behind. */
export const manifestEntriesFor = (
  actions: readonly Exclude<PlanAction, BlockedAction>[],
): readonly ManifestEntry[] =>
  actions
    .filter((action): action is WriteAction | UnchangedAction => action.kind !== 'delete')
    .map((action) => ({
      path: action.path,
      providers: [...action.providers].sort(),
      source: action.source,
      hash: action.hash,
      ownership: action.ownership ?? 'managed',
      extension: action.extension ?? null,
      executable: action.executable ?? false,
    }));

const describeBlocked = (action: BlockedAction): Diagnostic => {
  switch (action.reason) {
    case 'drift':
      return {
        code: 'DRIFT_BLOCKS_WRITE',
        severity: 'error',
        message: `'${action.path}' has been modified since the last AI Config sync. Review the change, then synchronize again with the drift override to replace it with the generated version.`,
        source: action.path,
      };

    case 'orphan-modified':
      return {
        code: 'ORPHAN_MODIFIED',
        severity: 'error',
        message: `'${action.path}' is no longer generated by any provider, but it has been modified since AI Config wrote it, so it will not be deleted. Move anything worth keeping out of the file, then delete it.`,
        source: action.path,
      };

    case 'untracked':
      return {
        code: 'UNTRACKED_TARGET_EXISTS',
        severity: 'error',
        message: `'${action.path}' already exists and was not created by AI Config, so it will not be overwritten. Move its content into '.ai/' and delete the file, then run sync again.`,
        source: action.path,
      };
  }
};
