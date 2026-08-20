import * as fs from 'node:fs';
import * as path from 'node:path';

import { compareStrings } from '../domain/ordering.js';
import { checkGeneratedPath } from '../path/safe-path.js';

/**
 * Reads a checked-in expected-output tree as a path → content map.
 *
 * Provider formats are serialization contracts, so adapter tests compare
 * complete generated output against files a human reviewed, rather than
 * asserting on fragments.
 */
export const readGoldenTree = (directory: string): ReadonlyMap<string, string> => {
  const files = new Map<string, string>();

  if (!fs.existsSync(directory)) {
    return files;
  }

  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const nested = path.join(current, entry.name);
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(nested, relative);
      } else if (entry.isFile()) {
        files.set(relative, fs.readFileSync(nested, 'utf8'));
      }
    }
  };

  walk(directory, '');
  return new Map([...files].sort(([a], [b]) => compareStrings(a, b)));
};

/**
 * Rewrites an expected-output tree from actual output.
 *
 * Enabled only with `UPDATE_FIXTURES=1`, so a fixture never silently updates
 * itself: a change to generated output must be reviewed as a diff.
 */
export const writeGoldenTree = (directory: string, files: ReadonlyMap<string, string>): void => {
  // Only the files the previous tree contained are removed. A recursive delete
  // of a caller-supplied directory would destroy real work if the path were
  // ever wrong.
  for (const relative of readGoldenTree(directory).keys()) {
    fs.rmSync(path.join(directory, ...relative.split('/')), { force: true });
  }

  for (const [relative, content] of files) {
    const check = checkGeneratedPath(relative);
    if (!check.ok) {
      throw new Error(`Refusing to write fixture entry '${relative}': ${check.reason}`);
    }
    const target = path.join(directory, ...check.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
};

export const shouldUpdateFixtures = (): boolean => process.env['UPDATE_FIXTURES'] === '1';
