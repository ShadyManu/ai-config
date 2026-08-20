import type { SourceKind } from '../domain/configuration.js';
import { sourceDirectory } from '../domain/configuration.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import type { FileSystem } from '../fs/file-system.js';
import { compareStrings } from '../domain/ordering.js';
import { AI_DIRECTORY } from '../parse/discover.js';
import { checkName } from '../parse/name.js';
import { resolveWithinRoot } from '../path/safe-path.js';

export type RemovalOutcome =
  | { readonly ok: true; readonly removed: readonly string[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

const PROVIDERS_ROOT = `${AI_DIRECTORY}/providers`;

/** Guards against a pathological skill tree, as the reader does when collecting one. */
const MAX_DEPTH = 16;

/**
 * Removes one canonical artifact and every override that refined it.
 *
 * Deleting the canonical file alone leaves an override under `.ai/providers/`
 * refining nothing, which is reported as `OVERRIDE_TARGET_MISSING` on every run
 * until someone removes it by hand. The two belong to one intent, so they are
 * removed in one operation.
 *
 * Generated provider output is deliberately not touched here. It becomes an
 * orphan the moment the canonical source is gone, and removing an orphan is the
 * planner's job — it verifies each file still holds the bytes AI Config wrote
 * before deleting it. Reaching around that would delete a generated file
 * somebody had since edited.
 *
 * Idempotent: an artifact that is already absent is not an error. The caller
 * asked for it to be gone, and it is.
 */
export const removeArtifact = async (
  fileSystem: FileSystem,
  root: string,
  kind: SourceKind,
  name: string,
): Promise<RemovalOutcome> => {
  const directory = sourceDirectory(kind);
  const canonical = `${AI_DIRECTORY}/${directory}/${name}`;

  const nameCheck = checkName(name);
  if (!nameCheck.ok) {
    // A name is also a path segment. Refusing it here keeps a crafted one from
    // reaching the path guard as an exception.
    return {
      ok: false,
      diagnostics: [
        {
          code: 'INVALID_NAME',
          severity: 'error',
          message: `Invalid name '${name}': ${nameCheck.reason}.`,
          source: canonical,
        },
      ],
    };
  }

  const removed: string[] = [];

  if (kind === 'skill') {
    await removeTree(fileSystem, root, canonical, removed);
  } else {
    await removeFile(fileSystem, root, `${canonical}.md`, removed);
  }

  await removeOverridesFor(fileSystem, root, directory, name, removed);

  return { ok: true, removed: removed.sort(compareStrings) };
};

/**
 * Removes override files that no longer refine anything, and prunes what that
 * empties.
 *
 * The one place a synchronization removes a file under `.ai/`. It never creates
 * or modifies one, and it removes only an override whose canonical artifact is
 * gone — a file that can no longer affect any provider's output, and that no
 * supported operation can create in that state, since an override is written
 * against an artifact that exists.
 *
 * This is what makes the rule uniform: when an artifact goes, everything it
 * produced goes with it, whether the artifact was removed from the view or
 * deleted in an editor. The generated files were already treated that way; an
 * override left behind was the exception.
 *
 * `paths` comes from overlay discovery rather than from scanning here, so the
 * only files considered are the ones that were read, parsed, and found to have
 * no target.
 */
export const removeOrphanedOverrides = async (
  fileSystem: FileSystem,
  root: string,
  paths: readonly string[],
): Promise<readonly string[]> => {
  const removed: string[] = [];

  for (const path of [...paths].sort(compareStrings)) {
    if (!path.startsWith(`${PROVIDERS_ROOT}/`)) {
      // Defence in depth: only ever files under `.ai/providers/`.
      continue;
    }
    await removeFile(fileSystem, root, path, removed);
    await deleteIfEmpty(fileSystem, root, parentOf(path));
    await deleteIfEmpty(fileSystem, root, parentOf(parentOf(path)));
  }

  if (removed.length > 0) {
    await deleteIfEmpty(fileSystem, root, PROVIDERS_ROOT);
  }

  return removed;
};

const parentOf = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index === -1 ? '.' : path.slice(0, index);
};

const removeFile = async (
  fileSystem: FileSystem,
  root: string,
  relativePath: string,
  removed: string[],
): Promise<void> => {
  const absolute = resolveWithinRoot(root, relativePath);
  if (!(await fileSystem.exists(absolute))) {
    return;
  }
  await fileSystem.deleteFile(absolute);
  removed.push(relativePath);
};

/**
 * Removes a skill directory and everything in it.
 *
 * Depth-first, so `deleteEmptyDirectory` only ever sees a directory whose
 * children are already gone. A symbolic link is unlinked rather than followed:
 * `deleteFile` removes the link itself, so a target outside the repository is
 * never reached.
 */
const removeTree = async (
  fileSystem: FileSystem,
  root: string,
  relativePath: string,
  removed: string[],
  depth = 0,
): Promise<void> => {
  const absolute = resolveWithinRoot(root, relativePath);
  if (!(await fileSystem.exists(absolute)) || depth > MAX_DEPTH) {
    return;
  }

  for (const entry of await fileSystem.readDirectory(absolute)) {
    const child = `${relativePath}/${entry.name}`;
    if (entry.kind === 'directory') {
      await removeTree(fileSystem, root, child, removed, depth + 1);
    } else {
      await removeFile(fileSystem, root, child, removed);
    }
  }

  await deleteIfEmpty(fileSystem, root, relativePath);
};

/**
 * Removes the artifact's override in every provider directory, then prunes
 * whatever that emptied.
 *
 * The provider directories are read rather than taken from the registered
 * provider list: a directory left behind by a provider this build does not know
 * still holds an override for an artifact that no longer exists, and leaving it
 * reproduces exactly the error this function exists to prevent.
 *
 * Pruning stops as soon as a directory still holds something. `init` creates no
 * provider directories on purpose, so that the tree shows what is actually
 * configured; an empty one left behind after the last override was removed
 * would say the opposite.
 */
const removeOverridesFor = async (
  fileSystem: FileSystem,
  root: string,
  directory: string,
  name: string,
  removed: string[],
): Promise<void> => {
  const providersRoot = resolveWithinRoot(root, PROVIDERS_ROOT);
  if (!(await fileSystem.exists(providersRoot))) {
    return;
  }

  for (const entry of await fileSystem.readDirectory(providersRoot)) {
    if (entry.kind !== 'directory') {
      continue;
    }
    const kindDirectory = `${PROVIDERS_ROOT}/${entry.name}/${directory}`;
    await removeFile(fileSystem, root, `${kindDirectory}/${name}.yaml`, removed);
    await deleteIfEmpty(fileSystem, root, kindDirectory);
    await deleteIfEmpty(fileSystem, root, `${PROVIDERS_ROOT}/${entry.name}`);
  }

  await deleteIfEmpty(fileSystem, root, PROVIDERS_ROOT);
};

/**
 * Emptiness stands in for ownership, as it does when the writer prunes
 * generated directories: `deleteEmptyDirectory` refuses one that still holds a
 * file, so anything the author put there survives. Failure is ignored — tidying
 * is not worth failing a removal that already succeeded.
 */
const deleteIfEmpty = async (
  fileSystem: FileSystem,
  root: string,
  relativePath: string,
): Promise<void> => {
  try {
    await fileSystem.deleteEmptyDirectory(resolveWithinRoot(root, relativePath));
  } catch {
    return;
  }
};
