import type { ProviderAdapter } from '../adapter/adapter.js';
import type { CompiledArtifact } from '../compile/compile.js';
import { compile } from '../compile/compile.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import { countBySeverity, hasErrors, sortDiagnostics } from '../domain/diagnostic.js';
import type { ProviderId } from '../domain/provider.js';
import type { FileSystem } from '../fs/file-system.js';
import { readManifest } from '../manifest/manifest.js';
import { checkGeneratedPathsContained } from '../path/containment.js';
import type { DriftPolicy, PlanAction, SyncPlan } from '../plan/plan.js';
import { pathsToProbe, plan, stateOf, toWritablePlan } from '../plan/plan.js';
import { probe } from '../probe/probe.js';
import type { LoadedProject } from './project.js';
import { removeOrphanedOverrides } from '../scaffold/remove.js';
import { activeAdapters, loadProject } from './project.js';
import type { WriteSummary } from './writer.js';
import { write } from './writer.js';

export type ProviderStatus =
  'synced' | 'pending' | 'drift' | 'conflict' | 'warning' | 'error' | 'disabled';

export interface ProviderReport {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly fileCount: number;
  readonly status: ProviderStatus;
  readonly actions: readonly PlanAction[];
}

export interface AnalysisResult {
  readonly project: LoadedProject;
  readonly artifacts: readonly CompiledArtifact[];
  readonly plan: SyncPlan;
  /** Every registered provider, including disabled ones. */
  readonly providers: readonly ProviderReport[];
  readonly diagnostics: readonly Diagnostic[];
}

export type AnalyzeOutcome =
  | { readonly ok: true; readonly analysis: AnalysisResult }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface AnalyzeOptions {
  readonly onDrift?: DriftPolicy;
}

/**
 * Runs the whole read-only half of the pipeline: load, compile, probe, plan.
 *
 * `sync`, `status` and `validate` all build on this, which is what keeps them
 * from disagreeing about the state of the repository.
 */
export const analyze = async (
  fileSystem: FileSystem,
  root: string,
  adapters: readonly ProviderAdapter[],
  options: AnalyzeOptions = {},
): Promise<AnalyzeOutcome> => {
  const loaded = await loadProject(fileSystem, root, adapters);
  if (!loaded.ok) {
    return { ok: false, diagnostics: sortDiagnostics(loaded.diagnostics) };
  }

  const project = loaded.project;
  const active = activeAdapters(project, adapters);
  const compilation = compile(project.configuration, active, project.overlays);

  const manifestResult = await readManifest(fileSystem, root);

  const paths = pathsToProbe(compilation.artifacts, manifestResult.manifest);

  // Confirmed against real paths, because a symbolic link would let a write
  // resolve somewhere else entirely even though the path is lexically safe.
  const containment = await checkGeneratedPathsContained(fileSystem, root, paths);

  const diagnostics = [
    ...project.diagnostics,
    ...compilation.diagnostics,
    ...manifestResult.diagnostics,
    ...containment,
  ];

  // A path that failed containment is not probed either. Reading it would
  // follow the very link the check just refused, so the boundary would hold for
  // writes and leak for reads — and an unreadable target would turn a clean
  // diagnostic into an exception.
  const snapshot = await probe(fileSystem, root, containedPaths(paths, containment));

  const syncPlan = plan(compilation.artifacts, manifestResult.manifest, snapshot, {
    onDrift: options.onDrift ?? 'block',
  });

  return {
    ok: true,
    analysis: {
      project,
      artifacts: compilation.artifacts,
      plan: syncPlan,
      providers: buildProviderReports(
        adapters,
        project,
        compilation.artifacts,
        syncPlan,
        diagnostics,
      ),
      // Sorted once at the boundary so consumers never observe production order.
      diagnostics: sortDiagnostics(diagnostics),
    },
  };
};

/**
 * The subset of `paths` that containment cleared.
 *
 * A diagnostic without a source names no single path — the root itself could
 * not be resolved — so nothing is probed in that case.
 */
const containedPaths = (
  paths: readonly string[],
  containment: readonly Diagnostic[],
): readonly string[] => {
  if (containment.length === 0) {
    return paths;
  }
  if (containment.some((diagnostic) => diagnostic.source === undefined)) {
    return [];
  }
  const refused = new Set(containment.map((diagnostic) => diagnostic.source));
  return paths.filter((candidate) => !refused.has(candidate));
};

const buildProviderReports = (
  adapters: readonly ProviderAdapter[],
  project: LoadedProject,
  artifacts: readonly CompiledArtifact[],
  syncPlan: SyncPlan,
  diagnostics: readonly Diagnostic[],
): readonly ProviderReport[] => {
  const enabled = new Set<ProviderId>(project.enabled);

  return adapters.map((adapter) => {
    // Disabled providers are still reported, so a consumer can tell "turned
    // off" apart from "not installed".
    if (!enabled.has(adapter.id)) {
      return {
        id: adapter.id,
        displayName: adapter.displayName,
        enabled: false,
        fileCount: 0,
        status: 'disabled' as const,
        actions: [],
      };
    }

    const actions = syncPlan.actions.filter((action) => action.providers.includes(adapter.id));
    const providerDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.provider === adapter.id,
    );

    return {
      id: adapter.id,
      displayName: adapter.displayName,
      enabled: true,
      fileCount: artifacts.filter((artifact) => artifact.providers.includes(adapter.id)).length,
      status: providerStatus(actions, providerDiagnostics),
      actions,
    };
  });
};

const providerStatus = (
  actions: readonly PlanAction[],
  diagnostics: readonly Diagnostic[],
): ProviderStatus => {
  if (hasErrors(diagnostics)) {
    return 'error';
  }

  const states = new Set(actions.map(stateOf));
  if (states.has('conflict')) {
    return 'conflict';
  }
  if (states.has('drift')) {
    return 'drift';
  }
  if (states.has('stale') || states.has('missing') || states.has('orphaned')) {
    return 'pending';
  }
  // Only warnings degrade the status. An informational note reports something
  // the author should know — a changed invocation syntax, say — not something
  // that needs attention, and showing it as a warning would make the two
  // indistinguishable.
  if (countBySeverity(diagnostics, 'warning') > 0) {
    return 'warning';
  }
  return 'synced';
};

export interface SyncOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

export interface SyncResult {
  readonly analysis: AnalysisResult;
  readonly summary: WriteSummary;
  readonly applied: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** Override files removed because what they refined no longer exists. */
  readonly removedOverrides: readonly string[];
}

export type SyncOutcome =
  | { readonly ok: true; readonly result: SyncResult }
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
      readonly analysis?: AnalysisResult;
    };

/**
 * Synchronizes `.ai/` into provider configuration.
 *
 * Nothing is written unless the entire pipeline succeeds: a validation error, a
 * failing adapter or any blocked path leaves the working tree untouched.
 */
export const sync = async (
  fileSystem: FileSystem,
  root: string,
  adapters: readonly ProviderAdapter[],
  options: SyncOptions = {},
): Promise<SyncOutcome> => {
  const outcome = await analyze(fileSystem, root, adapters, {
    onDrift: options.force === true ? 'overwrite' : 'block',
  });
  if (!outcome.ok) {
    return { ok: false, diagnostics: outcome.diagnostics };
  }

  const analysis = outcome.analysis;
  if (hasErrors(analysis.diagnostics)) {
    return { ok: false, diagnostics: analysis.diagnostics, analysis };
  }

  const writable = toWritablePlan(analysis.plan);
  if (!writable.ok) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...analysis.diagnostics, ...writable.diagnostics]),
      analysis,
    };
  }

  if (options.dryRun === true) {
    return {
      ok: true,
      result: {
        analysis,
        summary: summarize(analysis.plan),
        applied: false,
        diagnostics: analysis.diagnostics,
        // Reported by the diagnostics above, and removed only when applying.
        removedOverrides: [],
      },
    };
  }

  const result = await write(fileSystem, root, writable.plan, analysis.project.configuration);

  if (result.diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...analysis.diagnostics, ...result.diagnostics]),
      analysis,
    };
  }

  // After the write, and only when actually applying: an override whose
  // artifact is gone refines nothing, and leaving it would make the rule
  // "everything the artifact produced goes with it" true of generated files
  // and false of overrides. Removal is last so a failed write never takes a
  // source file with it.
  const orphaned = [...analysis.project.overlays.values()].flatMap(
    (overlay) => overlay.orphanedOverrides,
  );
  const removedOverrides = await removeOrphanedOverrides(fileSystem, root, orphaned);

  return {
    ok: true,
    result: {
      analysis,
      summary: result.summary,
      applied: true,
      diagnostics: analysis.diagnostics,
      removedOverrides,
    },
  };
};

const summarize = (syncPlan: SyncPlan): WriteSummary => {
  let written = 0;
  let deleted = 0;
  let unchanged = 0;

  for (const action of syncPlan.actions) {
    switch (action.kind) {
      case 'create':
      case 'restore':
      case 'update':
        written += 1;
        break;
      case 'delete':
        deleted += 1;
        break;
      case 'unchanged':
        unchanged += 1;
        break;
      case 'blocked':
        break;
    }
  }

  return { written, deleted, unchanged };
};
