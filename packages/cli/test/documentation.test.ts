import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ARTIFACT_KINDS, COMMAND_NAMES, HELP_TEXT, OVERRIDE_ACTIONS } from '../src/args.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

/**
 * Keeps the advertised command surface equal to the real one.
 *
 * Both READMEs present themselves as the complete list of what the CLI can do,
 * and both are the first thing a reader sees — one on npm, one on the
 * repository front page. `rules` shipped without appearing in either, because
 * the only documentation check that existed read `docs/user-guide.md`.
 *
 * The reverse direction matters just as much: documenting a command that was
 * removed sends a reader to an error message.
 */

const READMES: readonly string[] = ['README.md', 'packages/cli/README.md'];

describe('documented command surface', () => {
  for (const readme of READMES) {
    it(`${readme} lists every command the CLI accepts`, () => {
      const text = read(readme);
      expect(COMMAND_NAMES.filter((command) => !text.includes(`aiconfig ${command}`))).toEqual([]);
    });

    it(`${readme} invents no command the CLI does not accept`, () => {
      // A leading `-` is an option rather than a command, so the first
      // character must be a letter.
      const documented = [...read(readme).matchAll(/aiconfig ([a-z][a-z-]*)/g)]
        .map((match) => match[1] ?? '')
        .filter((name) => name.length > 0);
      const known = new Set<string>([...COMMAND_NAMES, ...ARTIFACT_KINDS, ...OVERRIDE_ACTIONS]);

      expect([...new Set(documented)].filter((name) => !known.has(name))).toEqual([]);
    });
  }

  it('lists every command in --help as well', () => {
    // `--help` is the copy a user reaches for when the README is not open.
    expect(COMMAND_NAMES.filter((command) => !HELP_TEXT.includes(command))).toEqual([]);
  });

  it('documents every artifact kind and override action the parser accepts', () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(HELP_TEXT, kind).toContain(`aiconfig add ${kind}`);
    }
    for (const action of OVERRIDE_ACTIONS) {
      expect(HELP_TEXT, action).toContain(`aiconfig override ${action}`);
    }
  });
});
