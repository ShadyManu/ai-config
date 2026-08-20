import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DIAGNOSTIC_CODES } from '@aiconfig/core';

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Keeps the diagnostic contract honest in both directions.
 *
 * `DIAGNOSTIC_CODES` is public: consumers match on it in CI and in editor
 * integrations. That makes two failures possible, and neither shows up as a
 * failing test anywhere else, because nothing breaks when a code simply is not
 * there.
 *
 * A code declared but never emitted is a promise the compiler does not keep —
 * `UNKNOWN_SYNC_SETTING` and `INVALID_SYNC_SETTINGS` survived that way until
 * 1.3.0 removed them, and two more followed them. A code emitted but never
 * asserted is a user-facing message no test has ever read; the path safety and
 * skill traversal checks were in that state.
 *
 * This runs over the repository as text rather than through the type system on
 * purpose: the question is whether a code is *used*, which no type can answer.
 */

const SOURCE_DIRECTORIES = ['packages', 'apps'];
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'out', '.vscode-test', 'fixtures']);

/** Where the codes are declared. Reading it would match every code trivially. */
const DECLARATION = path.join('packages', 'core', 'src', 'domain', 'codes.ts');

const typeScriptFiles = (directory: string, collected: string[] = []): string[] => {
  for (const entry of fs.readdirSync(path.join(repositoryRoot, directory), {
    withFileTypes: true,
  })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        typeScriptFiles(relative, collected);
      }
      continue;
    }
    if (entry.name.endsWith('.ts')) {
      collected.push(relative);
    }
  }
  return collected;
};

const isTest = (file: string): boolean =>
  file.endsWith('.test.ts') || file.split(path.sep).includes('test');

const files = SOURCE_DIRECTORIES.flatMap((directory) => typeScriptFiles(directory));

const textOf = (candidates: readonly string[]): string =>
  candidates.map((file) => fs.readFileSync(path.join(repositoryRoot, file), 'utf8')).join('\n');

const productionText = textOf(files.filter((file) => !isTest(file) && file !== DECLARATION));
const testText = textOf(files.filter(isTest));

/** Quoted, so `SKILL_MISSING` is not matched by `SKILL_MISSING_SOMETHING`. */
const isEmitted = (code: string): boolean => productionText.includes(`'${code}'`);

/**
 * Unquoted, because a test may reach a code through a table, a template or a
 * `toContain` on CLI output rather than as a literal.
 */
const isAsserted = (code: string): boolean => testText.includes(code);

describe('diagnostic code contract', () => {
  it('reads the repository it is asserting about', () => {
    // A path change that silently emptied these would make every assertion
    // below vacuous, which is the one way this file could lie.
    expect(files.length).toBeGreaterThan(50);
    expect(productionText.length).toBeGreaterThan(0);
    expect(testText.length).toBeGreaterThan(0);
    expect(DIAGNOSTIC_CODES.length).toBeGreaterThan(0);
  });

  it('declares no code twice', () => {
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(DIAGNOSTIC_CODES.length);
  });

  it('emits every declared code from production code', () => {
    expect(DIAGNOSTIC_CODES.filter((code) => !isEmitted(code))).toEqual([]);
  });

  it('asserts every declared code in at least one test', () => {
    expect(DIAGNOSTIC_CODES.filter((code) => !isAsserted(code))).toEqual([]);
  });

  it('names every code in SCREAMING_SNAKE_CASE', () => {
    expect(DIAGNOSTIC_CODES.filter((code) => !/^[A-Z][A-Z0-9_]*$/.test(code))).toEqual([]);
  });
});
