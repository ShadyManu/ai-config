import * as path from 'node:path';

import { AI_DIRECTORY } from '@aiconfig/core';

/**
 * The glob the `.ai/` watcher listens on.
 *
 * `.ai/` itself is listed alongside its contents because deleting the directory
 * is reported as a single event for the directory — the files that disappeared
 * with it are not enumerated — and that event is what tells the extension the
 * workspace is no longer initialized. VS Code's matcher happens to accept
 * `.ai/**` for the directory too (its `**` matches zero segments), but that is
 * not part of the documented glob semantics, so it is not relied on.
 */
export const WATCHED_GLOB = `{${AI_DIRECTORY},${AI_DIRECTORY}/**}`;

/**
 * Whether a filesystem event under `.ai/` should trigger a refresh.
 *
 * Events are filtered by identity rather than by timing: everything AI Config
 * writes under `.ai/` is dot-prefixed — the manifest and the staging files that
 * atomic writes create — and discovery ignores dotfiles, so this can never hide
 * a real source file. Suppressing events for a period after a write would
 * instead drop genuine edits made during that window.
 *
 * `.ai/` itself is dot-prefixed too and is the one exception: it is the only
 * event a recursive delete produces, and dropping it would leave the sidebar,
 * the status bar and the diagnostics describing a configuration that no longer
 * exists until the next manual refresh.
 */
export const isRelevantChange = (root: string, changedPath: string): boolean => {
  if (path.relative(root, changedPath) === AI_DIRECTORY) {
    return true;
  }
  return !path.basename(changedPath).startsWith('.');
};
