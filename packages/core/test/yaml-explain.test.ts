import { describe, expect, it } from 'vitest';

import { frontmatterMessage, parseFrontmatter } from '../src/parse/frontmatter.js';
import { parseConfig } from '../src/parse/config.js';
import { parseYaml } from '../src/parse/yaml.js';

/**
 * The parser names the symptom; these name the cause.
 *
 * "Unexpected scalar at node end" is what the `yaml` library says about a
 * quoted value containing the same quote, and it is what an author was left
 * with: correct-looking frontmatter, an error pointing several characters past
 * the mistake, and nothing saying which character was wrong. Every scaffolded
 * artifact ships with `description: "TODO: ..."` already quoted, so pasting a
 * sentence containing a quotation mark into it is the most likely way to break
 * a canonical file at all.
 */

const failure = (text: string) => {
  const result = parseFrontmatter(text);
  if (result.ok) {
    throw new Error('Expected the frontmatter to fail parsing.');
  }
  return result;
};

const document = (...frontmatter: readonly string[]): string =>
  ['---', ...frontmatter, '---', '', 'Body.', ''].join('\n');

describe('explaining why frontmatter did not parse', () => {
  it('names the inner double quote that ended a quoted value early', () => {
    const result = failure(
      document('name: scout', 'description: "TODO: Say "hello" to the user."'),
    );

    expect(result.code).toBe('FRONTMATTER_INVALID_YAML');
    expect(result.explanation).toBe(
      `The value of 'description' is wrapped in double quotes, and the double quote at line 3, column 25 ends it early. Escape every double quote inside the value as \\", or wrap the whole value in single quotes instead.`,
    );
    // The parser's own wording survives: it is what a search engine matches.
    expect(frontmatterMessage(result)).toContain(result.reason);
    expect(frontmatterMessage(result)).toContain(result.explanation ?? '');
  });

  it('names the inner single quote, with the remedy single quoting actually takes', () => {
    const result = failure(document('name: scout', "description: 'It's a trap'"));

    expect(result.explanation).toContain('the single quote at line 3, column 17 ends it early');
    expect(result.explanation).toContain("Double it as ''");
  });

  it('explains an unquoted value that contains a colon', () => {
    const result = failure(document('name: scout', 'description: TODO: describe it'));

    expect(result.explanation).toContain("The value of 'description' is unquoted");
    expect(result.explanation).toContain('nested key');
  });

  it('explains a tab used as indentation, which is invisible in the editor', () => {
    const result = failure(document('name: scout', '\tdescription: x'));

    expect(result.explanation).toContain('does not allow tabs for indentation');
    expect(result.explanation).toContain('line 3, column 1');
  });

  it('explains a quote that is opened and never closed', () => {
    const result = failure(document('name: scout', 'description: "unterminated'));

    expect(result.explanation).toContain('never closed');
  });

  it('points at the line the mistake is on, not at the start of the block', () => {
    const result = failure(document('name: scout', 'description: ok', 'other: "a "b" c"'));

    expect(result.line).toBe(4);
    expect(result.explanation).toContain("The value of 'other'");
  });

  it('leaves a quoted value alone when the quote only closes at the end', () => {
    // The line parses; the failure is elsewhere. Explaining this one would be a
    // confident wrong answer, which is worse than the parser's vague right one.
    const result = failure(document('name: scout', 'description: "fine"', 'other: [1, 2'));

    expect(result.explanation ?? '').not.toContain("value of 'description'");
  });

  it('ignores a trailing comment after a correctly closed value', () => {
    const result = failure(document('name: scout', 'description: "fine" # a note', 'x: [1, 2'));

    expect(result.explanation ?? '').not.toContain("value of 'description'");
  });

  it('says nothing extra when the source gives it nothing to say', () => {
    const result = parseYaml('a: [1, 2');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.explanation).toBeUndefined();
  });

  it('parses a correctly escaped value rather than explaining it', () => {
    const result = parseFrontmatter(
      document('name: scout', 'description: "Say \\"hello\\" to the user."'),
    );

    expect(result.ok && result.document.frontmatter['description']).toBe(
      'Say "hello" to the user.',
    );
  });
});

describe('explaining why .ai/config.yaml did not parse', () => {
  it('carries the same explanation, because the mistake is the same one', () => {
    const result = parseConfig(['schema: 1', 'providers: "clau"de"', ''].join('\n'), ['claude']);

    expect(result.diagnostics[0]?.code).toBe('CONFIG_INVALID_YAML');
    expect(result.diagnostics[0]?.message).toContain('ends it early');
  });
});
