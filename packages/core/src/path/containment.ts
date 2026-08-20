import * as path from 'node:path';

import type { Diagnostic } from '../domain/diagnostic.js';
import type { FileSystem } from '../fs/file-system.js';
import { resolveWithinRoot } from './safe-path.js';

/**
 * The canonical directory, spelled out rather than imported.
 *
 * `parse/discover.ts` owns `AI_DIRECTORY`, but it imports this module to check
 * its own reads, and closing that cycle for one string is not worth it.
 */
const CANONICAL_DIRECTORY = '.ai';

/**
 * Verifies that a path really lives inside the repository, following symbolic
 * links.
 *
 * `checkGeneratedPath` and `resolveWithinRoot` are lexical: they reject `..`
 * and absolute paths, but they cannot see that `.claude` is a symbolic link
 * pointing somewhere else entirely. Since `mkdir -p` and `rename` follow links,
 * a repository could otherwise direct writes anywhere on the machine simply by
 * committing a symlink — so containment is confirmed against real paths before
 * any read of a canonical directory or any write of generated output.
 */
export const isContained = async (
  fileSystem: FileSystem,
  realRoot: string,
  absolutePath: string,
): Promise<boolean> => {
  // The target itself usually does not exist yet, so walk up to the deepest
  // ancestor that does: that is the directory a write would actually resolve
  // through.
  let current = path.resolve(absolutePath);

  for (;;) {
    const real = await fileSystem.realPath(current);
    if (real !== undefined) {
      return real === realRoot || real.startsWith(`${realRoot}${path.sep}`);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
};

export interface ContainmentCheck {
  readonly realRoot: string;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Checks every repository-relative path, reporting those that escape.
 *
 * Runs before the write stage, so an escaping path blocks the whole
 * synchronization rather than being skipped individually.
 */
export const checkPathsContained = async (
  fileSystem: FileSystem,
  root: string,
  relativePaths: readonly string[],
): Promise<readonly Diagnostic[]> => {
  const realRoot = await fileSystem.realPath(root);
  if (realRoot === undefined) {
    return [rootNotFound(root)];
  }

  const diagnostics: Diagnostic[] = [];

  for (const relativePath of relativePaths) {
    const absolute = resolveWithinRoot(root, relativePath);
    if (!(await isContained(fileSystem, realRoot, absolute))) {
      diagnostics.push({
        code: 'UNSAFE_OUTPUT_PATH',
        severity: 'error',
        message: `'${relativePath}' resolves outside the repository, most likely through a symbolic link. AI Config will not read or write through it.`,
        source: relativePath,
      });
    }
  }

  return diagnostics;
};

/**
 * Checks paths AI Config would generate, which are held to a stricter rule.
 *
 * {@link checkPathsContained} asks only whether a path stays somewhere inside
 * the repository. That is the right question for a canonical *read*, but not
 * for a *write*: `.claude -> .ai` and `.claude -> src` both satisfy it while
 * redirecting generated output onto files AI Config has no business replacing —
 * the canonical sources among them. A generated path must therefore land
 * exactly where it says it does, so any symbolic link along the way is refused
 * whether it leaves the repository or not.
 *
 * Anchored to the *real* root, so a repository that itself lives under a
 * symlinked directory — `~/dev -> /mnt/data/dev`, a common arrangement — is
 * unaffected: only links below the root are redirection.
 */
export const checkGeneratedPathsContained = async (
  fileSystem: FileSystem,
  root: string,
  relativePaths: readonly string[],
): Promise<readonly Diagnostic[]> => {
  const realRoot = await fileSystem.realPath(root);
  if (realRoot === undefined) {
    return [rootNotFound(root)];
  }

  const diagnostics: Diagnostic[] = [];

  for (const relativePath of relativePaths) {
    if (
      relativePath === CANONICAL_DIRECTORY ||
      relativePath.startsWith(`${CANONICAL_DIRECTORY}/`)
    ) {
      diagnostics.push({
        code: 'UNSAFE_OUTPUT_PATH',
        severity: 'error',
        message: `'${relativePath}' is inside '${CANONICAL_DIRECTORY}/', which holds the sources a synchronization is generated from. AI Config never writes there.`,
        source: relativePath,
      });
      continue;
    }

    const message = await redirectionOf(fileSystem, root, realRoot, relativePath);
    if (message !== undefined) {
      diagnostics.push({
        code: 'UNSAFE_OUTPUT_PATH',
        severity: 'error',
        message,
        source: relativePath,
      });
    }
  }

  return diagnostics;
};

/**
 * Describes how a generated path is redirected, or `undefined` if it is not.
 *
 * Compares where the deepest existing ancestor *really* is against where the
 * path says it should be. Any symbolic link in between makes the two differ,
 * which is what catches redirection that stays inside the repository — the case
 * a plain "is it under the root" test cannot see.
 */
const redirectionOf = async (
  fileSystem: FileSystem,
  root: string,
  realRoot: string,
  relativePath: string,
): Promise<string | undefined> => {
  const lexicalRoot = path.resolve(root);
  let current = resolveWithinRoot(root, relativePath);

  for (;;) {
    const real = await fileSystem.realPath(current);
    if (real !== undefined) {
      const expected = path.join(realRoot, path.relative(lexicalRoot, current));
      if (samePath(real, expected)) {
        return undefined;
      }
      if (real === realRoot || real.startsWith(`${realRoot}${path.sep}`)) {
        return `'${relativePath}' is redirected by a symbolic link to another location inside the repository. AI Config writes only where a path says it does.`;
      }
      return `'${relativePath}' resolves outside the repository, most likely through a symbolic link. AI Config will not read or write through it.`;
    }

    const parent = path.dirname(current);
    if (parent === current || current === lexicalRoot) {
      // Walked past the root without finding anything that exists, which
      // `resolveWithinRoot` should already have made impossible.
      return `'${relativePath}' could not be resolved inside the repository.`;
    }
    current = parent;
  }
};

/**
 * Compares two absolute paths for equality.
 *
 * A case-insensitive filesystem reports the on-disk spelling from `realpath`,
 * so a directory created as `.Claude` and generated into as `.claude` would
 * otherwise look redirected. A symbolic link that actually points elsewhere
 * differs by more than case, so ignoring case here costs nothing.
 */
const samePath = (left: string, right: string): boolean =>
  left === right || left.toLowerCase() === right.toLowerCase();

const rootNotFound = (root: string): Diagnostic => ({
  code: 'ROOT_NOT_FOUND',
  severity: 'error',
  message: `The repository root '${root}' could not be resolved.`,
});
