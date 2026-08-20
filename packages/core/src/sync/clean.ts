import type { ProviderAdapter } from '../adapter/adapter.js';
import type { DiagnosticCode } from '../domain/codes.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import { sortDiagnostics } from '../domain/diagnostic.js';
import type { FileSystem } from '../fs/file-system.js';
import { EMPTY_MANIFEST } from '../manifest/manifest.js';
import type { DeleteAction } from '../plan/plan.js';
import { analyze } from './sync.js';
import type { WriteSummary } from './writer.js';
import { write } from './writer.js';

export interface CleanResult {
  readonly summary: WriteSummary;
  readonly diagnostics: readonly Diagnostic[];
}

export type CleanOutcome =
  | { readonly ok: true; readonly result: CleanResult }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * The errors that make removal itself unsafe, and the only ones that stop it.
 *
 * Two things have to hold before a file may be deleted: the manifest must be
 * readable, because it is the sole authority on what AI Config owns, and every
 * path must resolve where it says it does, because the manifest records paths
 * rather than the files they lead to.
 *
 * Nothing else qualifies. An invalid `.ai/` says the *sources* are wrong, and
 * removal does not read the sources — it removes what the manifest names, after
 * re-verifying each file still holds the bytes AI Config wrote. Refusing there
 * withdrew the last way out of a broken repository at exactly the moment
 * somebody reached for it: an override refining nothing, or a skill directory
 * with no entrypoint, was enough to make `sync` and `clean` refuse together,
 * leaving no supported way to get back to a working tree.
 *
 * Declared as a closed set so a new safety check has to be added here
 * deliberately rather than inherited by accident.
 */
const REMOVAL_UNSAFE: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  'UNSAFE_OUTPUT_PATH',
  'ROOT_NOT_FOUND',
  'MANIFEST_UNREADABLE',
  'UNSUPPORTED_MANIFEST_VERSION',
]);

/**
 * Removes every file AI Config generated, leaving the canonical `.ai/`
 * directory untouched.
 *
 * The manifest is the sole authority on what may be deleted, so a file AI
 * Config never created is never removed — including provider files the user
 * wrote by hand.
 *
 * A generated file that was edited afterwards is refused rather than deleted:
 * the writer re-verifies each hash immediately before removal, and edits it
 * never made are not AI Config's to discard. A caller that means to drop those
 * edits too runs a forced `sync` first, which returns the files to their
 * generated content and makes this succeed.
 *
 * Deleting is separated from regenerating so the two intents stay distinct: a
 * caller that wants a clean rebuild runs `sync` afterwards, and a caller that
 * wants to stop using AI Config's output does not.
 *
 * A refused path aborts this exactly as it aborts `sync`. The manifest names
 * paths, not the files they resolve to, so a generated directory that has since
 * become a symbolic link would otherwise have its target unlinked — outside the
 * repository, in the worst case. Removal is the one irreversible half of the
 * pipeline, so it is the last place to make an exception for a refused path.
 *
 * An invalid `.ai/` does not abort it, though: see {@link REMOVAL_UNSAFE}.
 */

export const clean = async (
  fileSystem: FileSystem,
  root: string,
  adapters: readonly ProviderAdapter[],
): Promise<CleanOutcome> => {
  const outcome = await analyze(fileSystem, root, adapters, { onDrift: 'overwrite' });
  if (!outcome.ok) {
    return { ok: false, diagnostics: outcome.diagnostics };
  }

  const analysis = outcome.analysis;
  const unsafe = analysis.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error' && REMOVAL_UNSAFE.has(diagnostic.code),
  );
  if (unsafe.length > 0) {
    return { ok: false, diagnostics: unsafe };
  }

  const manifest = analysis.plan.currentManifest;

  const actions: DeleteAction[] = manifest.entries.map((entry) => ({
    kind: 'delete',
    path: entry.path,
    providers: entry.providers,
    source: entry.source,
    hash: entry.hash,
    ...(entry.ownership === undefined ? {} : { ownership: entry.ownership }),
    ...(entry.extension === undefined ? {} : { extension: entry.extension }),
    ...(entry.executable === undefined ? {} : { executable: entry.executable }),
  }));

  const result = await write(
    fileSystem,
    root,
    { actions, nextManifest: EMPTY_MANIFEST, currentManifest: manifest },
    analysis.project.configuration,
  );

  if (result.diagnostics.length > 0) {
    return { ok: false, diagnostics: sortDiagnostics(result.diagnostics) };
  }

  return { ok: true, result: { summary: result.summary, diagnostics: [] } };
};
