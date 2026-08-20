import type { ProviderAdapter } from '../adapter/adapter.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import { hasErrors, sortDiagnostics } from '../domain/diagnostic.js';
import type { FileSystem } from '../fs/file-system.js';
import { toWritablePlan } from '../plan/plan.js';
import type { AnalysisResult } from './sync.js';
import { analyze } from './sync.js';
import type { WriteSummary } from './writer.js';
import { write } from './writer.js';

export interface RestoreResult {
  readonly analysis: AnalysisResult;
  readonly summary: WriteSummary;
  readonly diagnostics: readonly Diagnostic[];
}

export type RestoreOutcome =
  | { readonly ok: true; readonly result: RestoreResult }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Rewrites specific generated files from the canonical source, discarding
 * whatever is on disk for exactly those paths.
 *
 * Scoped deliberately: a full forced sync would replace every drifted file at
 * once, which is far more than a per-file "restore" action should do. Paths not
 * listed here are left untouched, and their manifest entries are preserved
 * unchanged, so ownership of the rest of the repository is unaffected.
 */
export const restore = async (
  fileSystem: FileSystem,
  root: string,
  adapters: readonly ProviderAdapter[],
  paths: readonly string[],
): Promise<RestoreOutcome> => {
  const targets = new Set(paths);

  const outcome = await analyze(fileSystem, root, adapters, {
    onDrift: 'overwrite',
  });
  if (!outcome.ok) {
    return { ok: false, diagnostics: outcome.diagnostics };
  }

  const analysis = outcome.analysis;
  if (hasErrors(analysis.diagnostics)) {
    return { ok: false, diagnostics: analysis.diagnostics };
  }

  const writable = toWritablePlan(analysis.plan);
  if (!writable.ok) {
    // Under `overwrite`, the only remaining blockers are untracked targets and
    // modified orphans — neither of which a restore may touch.
    return {
      ok: false,
      diagnostics: sortDiagnostics([...analysis.diagnostics, ...writable.diagnostics]),
    };
  }

  const selected = writable.plan.actions.filter(
    (action) => targets.has(action.path) && action.kind !== 'delete',
  );

  const unknown = [...targets].filter(
    (target) => !selected.some((action) => action.path === target),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      diagnostics: unknown.map((path) => ({
        code: 'UNTRACKED_TARGET_EXISTS' as const,
        severity: 'error' as const,
        message: `'${path}' is not a file AI Config generates, so there is nothing to restore.`,
        source: path,
      })),
    };
  }

  const result = await write(
    fileSystem,
    root,
    {
      // Only the selected paths are written. The writer preserves manifest
      // entries for every path this plan does not mention, so ownership of the
      // rest of the repository is untouched.
      actions: selected,
      nextManifest: writable.plan.nextManifest,
      currentManifest: analysis.plan.currentManifest,
    },
    analysis.project.configuration,
  );

  if (result.diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...analysis.diagnostics, ...result.diagnostics]),
    };
  }

  return {
    ok: true,
    result: {
      analysis,
      summary: result.summary,
      diagnostics: analysis.diagnostics,
    },
  };
};
