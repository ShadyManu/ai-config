import type { FileSystem } from '../fs/file-system.js';
import { sha256 } from '../manifest/hash.js';
import { resolveWithinRoot } from '../path/safe-path.js';

export interface WorkingTreeFile {
  readonly exists: boolean;
  readonly hash: string | undefined;
}

/** What the working tree currently holds, for a bounded set of paths. */
export type WorkingTreeSnapshot = ReadonlyMap<string, WorkingTreeFile>;

/**
 * Reads the current state of exactly the given paths.
 *
 * This is the I/O stage that lets the planner be pure. Bounding it to a known
 * path set is also what keeps synchronization cheap: AI Config never walks a
 * provider directory, only the files it already knows about.
 */
export const probe = async (
  fileSystem: FileSystem,
  root: string,
  paths: Iterable<string>,
): Promise<WorkingTreeSnapshot> => {
  const unique = [...new Set(paths)].sort();

  const entries = await Promise.all(
    unique.map(async (relativePath): Promise<readonly [string, WorkingTreeFile]> => {
      const content = await fileSystem.readFile(resolveWithinRoot(root, relativePath));
      if (content === undefined) {
        return [relativePath, { exists: false, hash: undefined }];
      }
      return [relativePath, { exists: true, hash: sha256(content) }];
    }),
  );

  return new Map(entries);
};
