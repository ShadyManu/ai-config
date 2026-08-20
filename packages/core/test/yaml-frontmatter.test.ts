import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from '../src/parse/frontmatter.js';
import { renderFrontmatter, renderMarkdownDocument } from '../src/text/yaml-frontmatter.js';
import type { FrontmatterValue } from '../src/text/yaml-frontmatter.js';

/** Renders a single field and reads it back, to prove the value survives. */
const roundTrip = (key: string, value: FrontmatterValue): unknown => {
  const document = renderMarkdownDocument([[key, value]], 'Body.');
  const parsed = parseFrontmatter(document);
  if (!parsed.ok) {
    throw new Error(`rendered frontmatter did not parse: ${parsed.reason}`);
  }
  return parsed.document.frontmatter[key];
};

describe('renderFrontmatter', () => {
  it('returns an empty string when there are no fields', () => {
    expect(renderFrontmatter([])).toBe('');
  });

  it('preserves the caller-supplied key order', () => {
    expect(
      renderFrontmatter([
        ['zebra', 'z'],
        ['alpha', 'a'],
      ]),
    ).toBe('---\nzebra: z\nalpha: a\n---\n');
  });

  it('renders lists one item per line', () => {
    expect(renderFrontmatter([['paths', ['a/b', 'c/d']]])).toBe(
      '---\npaths:\n  - a/b\n  - c/d\n---\n',
    );
  });

  it('renders an empty list explicitly', () => {
    expect(renderFrontmatter([['paths', []]])).toBe('---\npaths: []\n---\n');
  });

  it('renders booleans and numbers unquoted', () => {
    expect(renderFrontmatter([['enabled', true]])).toBe('---\nenabled: true\n---\n');
    expect(renderFrontmatter([['count', 3]])).toBe('---\ncount: 3\n---\n');
  });
});

describe('scalar quoting', () => {
  it('leaves ordinary prose unquoted', () => {
    expect(renderFrontmatter([['description', 'Reviews code for correctness']])).toContain(
      'description: Reviews code for correctness\n',
    );
  });

  it.each([
    ['glob with a leading star', '**/*.ts'],
    ['glob with an embedded star', 'backend/**'],
    ['comma-separated globs', 'a/**,b/**'],
    ['colon', 'note: this'],
    ['leading hash', '#tag'],
    ['leading quote', '"quoted"'],
    ['leading ampersand', '&anchor'],
    ['leading asterisk', '*alias'],
    ['trailing space', 'ends with '],
    ['inline comment marker', 'text # not a comment'],
    ['empty string', ''],
    ['newline', 'line one\nline two'],
    ['backslash', 'a\\b'],
  ])('round-trips %s as a string', (_label, value) => {
    expect(roundTrip('description', value)).toBe(value);
  });

  it.each([
    ['true'],
    ['false'],
    ['yes'],
    ['no'],
    ['on'],
    ['off'],
    ['null'],
    ['~'],
    ['42'],
    ['-7'],
    ['3.14'],
    ['1e10'],
    ['.inf'],
    ['.nan'],
    // Without quoting, a YAML 1.2 core-schema parser reads these as integers.
    ['0x1F'],
    ['0o17'],
    ['0b1010'],
  ])('quotes %s so it reads back as a string, not another type', (value) => {
    expect(roundTrip('description', value)).toBe(value);
    expect(typeof roundTrip('description', value)).toBe('string');
  });

  it('round-trips list items that look like other types', () => {
    expect(roundTrip('paths', ['**/*.ts', 'true', '0x1F'])).toEqual(['**/*.ts', 'true', '0x1F']);
  });
});

describe('structure injection', () => {
  // A description or body is author-supplied text. It must never be able to
  // introduce a second frontmatter field, close the frontmatter block early, or
  // otherwise change the shape of the generated document.
  it.each([
    ['a second field', 'injection\ndescription: evil'],
    ['a closing delimiter', 'injection\n---\nbody'],
    ['a bare delimiter', '---'],
    ['a comment', '#comment'],
    ['an alias', '*alias'],
    ['an anchor', '&anchor'],
    ['a custom tag', '!!python/object'],
    ['a mapping', 'key: value'],
  ])('cannot inject %s through a description', (_label, description) => {
    const document = renderMarkdownDocument([['description', description]], 'Body text.');
    const parsed = parseFrontmatter(document);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(Object.keys(parsed.document.frontmatter)).toEqual(['description']);
    expect(parsed.document.frontmatter['description']).toBe(description);
    expect(parsed.document.body.trim()).toBe('Body text.');
  });

  it('cannot inject a field through a list item', () => {
    const document = renderMarkdownDocument([['paths', ['a/**', 'evil\ndescription: x']]], 'Body.');
    const parsed = parseFrontmatter(document);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(Object.keys(parsed.document.frontmatter)).toEqual(['paths']);
  });

  it('preserves non-ASCII text exactly', () => {
    expect(roundTrip('description', 'unicode → emoji 🎯 accents éàü')).toBe(
      'unicode → emoji 🎯 accents éàü',
    );
  });
});

describe('renderMarkdownDocument', () => {
  it('separates frontmatter from the body with one blank line', () => {
    expect(renderMarkdownDocument([['description', 'Test']], 'Body.')).toBe(
      '---\ndescription: Test\n---\n\nBody.\n',
    );
  });

  it('emits only the body when there are no fields', () => {
    expect(renderMarkdownDocument([], '  Body.  ')).toBe('Body.\n');
  });

  it('emits only frontmatter when the body is blank', () => {
    expect(renderMarkdownDocument([['description', 'Test']], '   \n  ')).toBe(
      '---\ndescription: Test\n---\n',
    );
  });

  it('ends with exactly one newline', () => {
    const document = renderMarkdownDocument([['description', 'Test']], 'Body.\n\n\n');
    expect(document.endsWith('Body.\n')).toBe(true);
  });

  it('is byte-identical for identical input', () => {
    const first = renderMarkdownDocument([['description', 'Test']], 'Body.');
    const second = renderMarkdownDocument([['description', 'Test']], 'Body.');
    expect(first).toBe(second);
  });
});

describe('nested YAML values', () => {
  it('renders a nested mapping as an indented block', () => {
    expect(renderFrontmatter([['permission', { edit: 'deny', bash: 'ask' }]])).toBe(
      ['---', 'permission:', '  edit: deny', '  bash: ask', '---', ''].join('\n'),
    );
  });

  it('quotes a key that would otherwise be read as YAML structure', () => {
    // An OpenCode permission map is keyed by glob patterns. `*` opens an alias,
    // so an unquoted key would not parse back as a key at all.
    expect(
      renderFrontmatter([['permission', { bash: { '*': 'ask', 'git push *': 'deny' } }]]),
    ).toBe(
      ['---', 'permission:', '  bash:', '    "*": ask', '    "git push *": deny', '---', ''].join(
        '\n',
      ),
    );
  });

  it('quotes a key that a parser would read back as another type', () => {
    expect(renderFrontmatter([['metadata', { true: 'a', '1': 'b' }]])).toContain('"true": a');
  });

  it('renders a sequence of mappings with the dash on the first key', () => {
    expect(
      renderFrontmatter([['hooks', [{ matcher: 'Bash', command: 'echo' }, { matcher: 'Edit' }]]]),
    ).toBe(
      [
        '---',
        'hooks:',
        '  - matcher: Bash',
        '    command: echo',
        '  - matcher: Edit',
        '---',
        '',
      ].join('\n'),
    );
  });

  it('renders empty collections explicitly rather than dropping the key', () => {
    expect(
      renderFrontmatter([
        ['a', []],
        ['b', {}],
      ]),
    ).toBe(['---', 'a: []', 'b: {}', '---', ''].join('\n'));
  });

  it('renders a nested sequence inside a mapping', () => {
    expect(renderFrontmatter([['mcpServers', ['slack', { docs: { command: 'npx' } }]]])).toBe(
      ['---', 'mcpServers:', '  - slack', '  - docs:', '      command: npx', '---', ''].join('\n'),
    );
  });

  it('is byte-identical for identical nested input', () => {
    const value = { a: { b: [1, 2, { c: true }] } };
    expect(renderFrontmatter([['x', value]])).toBe(renderFrontmatter([['x', value]]));
  });
});
