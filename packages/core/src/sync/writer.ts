import type { SkillFileLocation } from '../compile/content.js';
import { indexSkillFiles, resolveContent } from '../compile/content.js';
import type { AiConfiguration } from '../domain/configuration.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import type { FileSystem } from '../fs/file-system.js';
import { sha256 } from '../manifest/hash.js';
import { AI_DIRECTORY } from '../parse/discover.js';
import type { Manifest, ManifestEntry } from '../manifest/manifest.js';
import { MANIFEST_PATH, serializeManifest } from '../manifest/manifest.js';
import { resolveWithinRoot } from '../path/safe-path.js';
import type { PlanAction, WritablePlan, WriteAction } from '../plan/plan.js';

export interface WriteSummary {
  readonly written: number;
  readonly deleted: number;
  readonly unchanged: number;
}

export interface WriteResult {
  readonly summary: WriteSummary;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Applies a plan to disk.
 *
 * Accepts only a {@link WritablePlan}, so blocked actions cannot reach here.
 *
 * If a write fails partway, the manifest still describes the working tree
 * accurately: files that were written get their new hash, files that were not
 * reached keep the hash they already had. Recording a new hash for a file that
 * was never written would make the next sync report drift on a file nobody
 * touched, and only the drift override could clear it.
 *
 * Every mutation re-verifies the state the plan was made against, immediately
 * before changing it. Planning reads the working tree and writes it back a
 * moment later; an editor saving into that gap would otherwise lose the edit
 * without a word, which is precisely what drift protection exists to prevent.
 *
 * A partial failure is reported as a diagnostic; it is not thrown — including a
 * failure to record ownership, which leaves files on disk that the manifest does
 * not claim and so needs saying out loud.
 */
export const write = async (
  fileSystem: FileSystem,
  root: string,
  writablePlan: WritablePlan,
  configuration: AiConfiguration,
): Promise<WriteResult> => {
  const skillFiles: ReadonlyMap<string, SkillFileLocation> = indexSkillFiles(configuration);
  const diagnostics: Diagnostic[] = [];
  const completed: ManifestEntry[] = [];
  const previous = new Map(
    writablePlan.currentManifest.entries.map((entry) => [entry.path, entry] as const),
  );

  const emptied = new Set<string>();

  let written = 0;
  let deleted = 0;
  let unchanged = 0;
  let failedAt = -1;

  for (const [index, action] of writablePlan.actions.entries()) {
    const absolute = resolveWithinRoot(root, action.path);

    try {
      switch (action.kind) {
        case 'create':
        case 'restore':
        case 'update': {
          // `create` is guarded by exclusive creation below instead: it reports
          // the clash from the write itself, without a read that would only
          // widen the window it is closing.
          if (action.kind !== 'create' && !(await stillAsPlanned(fileSystem, absolute, action))) {
            diagnostics.push({
              code: 'TARGET_CHANGED_DURING_SYNC',
              severity: 'error',
              message: `'${action.path}' changed while AI Config was running and was not replaced. Re-run to see its current state.`,
              source: action.path,
            });
            // Ownership survives, so the next run reports drift on the new bytes
            // rather than refusing them as a file AI Config never created.
            const entry = previous.get(action.path);
            if (entry !== undefined) {
              completed.push(entry);
            }
            break;
          }

          const content = await resolveContent(fileSystem, root, action.content, skillFiles);
          await fileSystem.writeFileAtomic(absolute, content.bytes, {
            executable: content.executable,
            // `create` and `restore` both target a path that was absent when the
            // plan was made. Exclusive creation closes the window in which
            // someone else made that file in the meantime: it fails rather than
            // clobbering.
            exclusive: action.kind !== 'update',
          });
          written += 1;
          completed.push(entryFor(action));
          break;
        }

        case 'delete': {
          // The planner checked this against a snapshot; re-check immediately
          // before removing, because deletion is the one irreversible action
          // and the file may have been edited since the snapshot was taken.
          const current = await fileSystem.readFile(absolute);
          if (current !== undefined && sha256(current) !== action.hash) {
            diagnostics.push({
              code: 'ORPHAN_MODIFIED',
              severity: 'error',
              message: `'${action.path}' changed while AI Config was running and was not deleted. Re-run to see its current state.`,
              source: action.path,
            });
            completed.push(orphanEntry(action));
            break;
          }
          await fileSystem.deleteFile(absolute);
          emptied.add(parentOf(action.path));
          deleted += 1;
          break;
        }

        case 'unchanged':
          unchanged += 1;
          completed.push(entryFor(action));
          break;
      }
    } catch (error) {
      failedAt = index;
      diagnostics.push({
        code: 'WRITE_FAILED',
        severity: 'error',
        message: `Could not write '${action.path}': ${error instanceof Error ? error.message : String(error)}`,
        source: action.path,
      });
      break;
    }
  }

  if (failedAt >= 0) {
    completed.push(
      ...(await carryForwardUnreached(fileSystem, root, writablePlan, failedAt, completed)),
    );
  }

  // Built from what actually happened rather than from the intended plan, so a
  // partial pass still leaves an accurate record.
  //
  // Entries for paths this plan never mentions are carried over untouched: a
  // scoped plan — a single-file restore, say — must not drop ownership of the
  // rest of the repository.
  const planned = new Set(writablePlan.actions.map((action) => action.path));
  const untouched = writablePlan.currentManifest.entries.filter(
    (entry) => !planned.has(entry.path),
  );

  const nextManifest: Manifest = {
    version: writablePlan.nextManifest.version,
    entries: [...untouched, ...completed],
  };

  try {
    await writeManifestIfChanged(fileSystem, root, nextManifest);
  } catch (error) {
    diagnostics.push(manifestFailure(error, writablePlan, completed));
  }
  await pruneEmptyDirectories(fileSystem, root, emptied);

  return { summary: { written, deleted, unchanged }, diagnostics };
};

/**
 * Confirms the file is still what the plan was made against.
 *
 * `undefined` on both sides is the `restore` case: the path was absent when the
 * plan was made, and a file that has appeared there since belongs to whoever
 * wrote it.
 */
const stillAsPlanned = async (
  fileSystem: FileSystem,
  absolute: string,
  action: WriteAction,
): Promise<boolean> => {
  const current = await fileSystem.readFile(absolute);
  return (current === undefined ? undefined : sha256(current)) === action.expected;
};

/**
 * Reports a manifest that could not be recorded.
 *
 * The generated files are already on disk; without the manifest, nothing claims
 * them, and the next run reads them as files AI Config never created and
 * refuses to touch. Naming them is what makes that recoverable — deleting the
 * listed files restores a state a plain re-run can take over from.
 */
const manifestFailure = (
  error: unknown,
  writablePlan: WritablePlan,
  completed: readonly ManifestEntry[],
): Diagnostic => {
  const owned = new Set(writablePlan.currentManifest.entries.map((entry) => entry.path));
  const unclaimed = completed
    .map((entry) => entry.path)
    .filter((candidate) => !owned.has(candidate))
    .sort();

  const reason = error instanceof Error ? error.message : String(error);
  const listed =
    unclaimed.length === 0
      ? 'No file changed ownership, so the working tree is unaffected.'
      : `These files were written but are not recorded as generated: ${unclaimed.join(', ')}. Delete them, or fix the problem above and run sync again.`;

  return {
    code: 'MANIFEST_WRITE_FAILED',
    severity: 'error',
    message: `Could not record what was generated in '${MANIFEST_PATH}': ${reason}. ${listed}`,
    source: MANIFEST_PATH,
  };
};

/**
 * Removes directories that the deletions in this pass left empty.
 *
 * Nothing records which directories AI Config created, so emptiness stands in
 * for ownership: `deleteEmptyDirectory` refuses anything still holding a file,
 * which means a directory the author put something in survives untouched.
 * Deepest paths go first, so a parent is reconsidered only once its children
 * are gone and `.codex/agents/` disappearing can take `.codex/` with it.
 *
 * The repository root and `.ai/` are never candidates: the first is not AI
 * Config's to remove, and the second holds the canonical sources.
 */
const pruneEmptyDirectories = async (
  fileSystem: FileSystem,
  root: string,
  emptied: ReadonlySet<string>,
): Promise<void> => {
  const candidates = new Set<string>();
  for (const directory of emptied) {
    let current = directory;
    while (current !== '.' && current !== '' && current !== AI_DIRECTORY) {
      if (current.startsWith(`${AI_DIRECTORY}/`)) {
        break;
      }
      candidates.add(current);
      current = parentOf(current);
    }
  }

  const deepestFirst = [...candidates].sort(
    (a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a),
  );

  for (const directory of deepestFirst) {
    try {
      await fileSystem.deleteEmptyDirectory(resolveWithinRoot(root, directory));
    } catch {
      // Tidying is not worth failing a synchronization that already succeeded.
      return;
    }
  }
};

const parentOf = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index === -1 ? '.' : path.slice(0, index);
};

/**
 * Preserves ownership of files the aborted pass never reached.
 *
 * Their bytes on disk are still the *previous* ones, so the entry recorded is
 * the one from `currentManifest`, not the new hash the plan intended.
 */
const carryForwardUnreached = async (
  fileSystem: FileSystem,
  root: string,
  writablePlan: WritablePlan,
  failedAt: number,
  completed: readonly ManifestEntry[],
): Promise<readonly ManifestEntry[]> => {
  const recorded = new Set(completed.map((entry) => entry.path));
  const previous = new Map(
    writablePlan.currentManifest.entries.map((entry) => [entry.path, entry] as const),
  );
  const carried: ManifestEntry[] = [];

  for (const action of writablePlan.actions.slice(failedAt)) {
    if (recorded.has(action.path)) {
      continue;
    }
    const entry = previous.get(action.path);
    if (entry === undefined) {
      // Never owned before, and not written now: nothing to record.
      continue;
    }
    if (await fileSystem.exists(resolveWithinRoot(root, action.path))) {
      carried.push(entry);
      recorded.add(action.path);
    }
  }

  return carried;
};

const entryFor = (action: Exclude<PlanAction, { kind: 'blocked' | 'delete' }>): ManifestEntry => ({
  path: action.path,
  providers: [...action.providers].sort(),
  source: action.source,
  hash: action.hash,
  ownership: action.ownership ?? 'managed',
  extension: action.extension ?? null,
  executable: action.executable ?? false,
});

const orphanEntry = (action: Extract<PlanAction, { kind: 'delete' }>): ManifestEntry => ({
  path: action.path,
  providers: [...action.providers].sort(),
  source: action.source,
  hash: action.hash,
  ownership: action.ownership ?? 'managed',
  extension: action.extension ?? null,
  executable: action.executable ?? false,
});

/**
 * Writes the manifest only when its bytes changed.
 *
 * The manifest lives inside the watched `.ai/` tree, so rewriting it on a
 * no-op sync would retrigger an editor's file watcher and produce needless
 * version-control churn.
 */
const writeManifestIfChanged = async (
  fileSystem: FileSystem,
  root: string,
  manifest: Manifest,
): Promise<void> => {
  const absolute = resolveWithinRoot(root, MANIFEST_PATH);
  const serialized = Buffer.from(serializeManifest(manifest), 'utf8');
  const existing = await fileSystem.readFile(absolute);

  if (existing?.equals(serialized) === true) {
    return;
  }

  await fileSystem.writeFileAtomic(absolute, serialized);
};
