import type { ProviderAdapter } from '../adapter/adapter.js';
import type { FileSystem } from '../fs/file-system.js';
import { MANIFEST_PATH } from '../manifest/manifest.js';
import { resolveWithinRoot } from '../path/safe-path.js';

/**
 * Provider locations that already exist in a repository AI Config does not
 * track.
 *
 * Ownership is provable only through the manifest. Without it, a file
 * under a provider directory may have been written by the user, by the provider
 * itself, or by an earlier AI Config installation whose manifest was deleted,
 * and nothing on disk tells those apart. Content cannot decide it either: a
 * file identical to what AI Config would generate may still be the user's, so
 * matching bytes is never treated as evidence of ownership.
 *
 * The result therefore says only "these exist". Callers warn; nothing here or
 * downstream deletes, overwrites, adopts or reclaims any of it.
 */
export const findExistingProviderTargets = async (
  fileSystem: FileSystem,
  root: string,
  adapters: readonly ProviderAdapter[],
): Promise<readonly string[]> => {
  if (await fileSystem.exists(resolveWithinRoot(root, MANIFEST_PATH))) {
    // Ownership is knowable here, so the planner's own conflict reporting —
    // which can distinguish generated from untracked — is the right answer.
    return [];
  }

  const candidates = [...new Set(adapters.flatMap((adapter) => adapter.targetRoots))].sort();

  const found = await Promise.all(
    candidates.map(async (candidate) =>
      (await fileSystem.exists(resolveWithinRoot(root, candidate))) ? candidate : undefined,
    ),
  );

  return found.filter((entry): entry is string => entry !== undefined);
};
