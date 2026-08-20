import * as path from 'node:path';

import type { FileSystem } from './fs/file-system.js';
import { AI_DIRECTORY } from './parse/discover.js';
import { CONFIG_PATH } from './parse/config.js';

/** Whether `directory` is an initialized AI Config repository root. */
export const isInitialized = async (fileSystem: FileSystem, directory: string): Promise<boolean> =>
  fileSystem.exists(path.join(directory, ...CONFIG_PATH.split('/')));

/**
 * Walks up from `startDirectory` looking for a directory holding `.ai/config.yaml`.
 *
 * Deliberately single-root: "which workspace folder" is an editor concept, and
 * core stays free of it. The VS Code extension maps over its folders and calls
 * this for each.
 */
export const findRepositoryRoot = async (
  fileSystem: FileSystem,
  startDirectory: string,
): Promise<string | undefined> => {
  let current = path.resolve(startDirectory);

  for (;;) {
    if (await isInitialized(fileSystem, current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
};

export { AI_DIRECTORY };
