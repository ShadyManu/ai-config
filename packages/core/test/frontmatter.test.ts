import { describe, expect, it } from 'vitest';

import { findFrontmatterKeyLine, parseFrontmatter } from '../src/parse/frontmatter.js';
import { decodeSourceText } from '../src/parse/text.js';

const parse = (text: string) => parseFrontmatter(decodeSourceText(Buffer.from(text, 'utf8')));

describe('parseFrontmatter', () => {
  it('splits frontmatter from the body', () => {
    const result = parse('---\ndescription: Test\n---\n\nBody text.\n');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.document.frontmatter).toEqual({ description: 'Test' });
    expect(result.document.body.trim()).toBe('Body text.');
    expect(result.document.hasFrontmatter).toBe(true);
  });

  it('treats a file without frontmatter as all body', () => {
    const result = parse('Just a body.\n');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.document.hasFrontmatter).toBe(false);
    expect(result.document.frontmatter).toEqual({});
    expect(result.document.body).toBe('Just a body.\n');
  });

  it('only treats a delimiter on line 1 as frontmatter', () => {
    const result = parse('Intro\n\n---\ndescription: not frontmatter\n---\n');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.document.hasFrontmatter).toBe(false);
  });

  it('reports unterminated frontmatter', () => {
    const result = parse('---\ndescription: Test\n');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('FRONTMATTER_UNTERMINATED');
  });

  it('reports invalid YAML with a line number', () => {
    const result = parse('---\ndescription: "unterminated\n---\n\nBody\n');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('FRONTMATTER_INVALID_YAML');
    expect(result.line).toBeGreaterThanOrEqual(1);
  });

  it('rejects frontmatter that is not a mapping', () => {
    const result = parse('---\n- one\n- two\n---\n\nBody\n');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe('FRONTMATTER_NOT_A_MAP');
  });

  it('accepts an empty frontmatter block', () => {
    const result = parse('---\n---\n\nBody\n');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.document.hasFrontmatter).toBe(true);
    expect(result.document.frontmatter).toEqual({});
  });

  it('normalizes CRLF line endings before parsing', () => {
    const result = parse('---\r\ndescription: Test\r\n---\r\n\r\nBody.\r\n');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.document.frontmatter).toEqual({ description: 'Test' });
    expect(result.document.body).not.toContain('\r');
  });

  it('strips a UTF-8 byte order mark so line 1 is still the delimiter', () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('---\ndescription: Test\n---\n\nBody.\n', 'utf8'),
    ]);
    const result = parseFrontmatter(decodeSourceText(withBom));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.document.frontmatter).toEqual({ description: 'Test' });
  });

  it('produces plain data rather than executing tags', () => {
    const result = parse('---\nvalue: !!str 42\n---\n\nBody\n');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.document.frontmatter['value']).toBe('42');
  });
});

describe('findFrontmatterKeyLine', () => {
  it('finds the 1-based line of a top-level key', () => {
    const text = '---\ndescription: Test\napplyTo:\n  - src/**\n---\n\nBody\n';
    expect(findFrontmatterKeyLine(text, 'description')).toBe(2);
    expect(findFrontmatterKeyLine(text, 'applyTo')).toBe(3);
  });

  it('returns undefined for a key that is not present', () => {
    expect(findFrontmatterKeyLine('---\ndescription: Test\n---\n', 'missing')).toBeUndefined();
  });
});
