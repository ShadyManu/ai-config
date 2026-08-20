import { describe, expect, it } from 'vitest';

import { isPlainObject, isStringArray } from '../src/parse/yaml.js';

describe('isPlainObject', () => {
  it('accepts a mapping', () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject({})).toBe(true);
  });

  it('accepts an object with no prototype, which JSON.parse can produce', () => {
    expect(isPlainObject(Object.create(null) as object)).toBe(true);
  });

  it('rejects null, arrays and scalars', () => {
    for (const value of [null, undefined, [], [1], 'x', 1, true]) {
      expect(isPlainObject(value)).toBe(false);
    }
  });

  it('rejects a host object rather than treating it as an empty mapping', () => {
    // The `yaml` parser resolves a timestamp scalar to a Date. Accepting it
    // here would flatten it to no keys and lose the value silently.
    expect(isPlainObject(new Date(0))).toBe(false);
    expect(isPlainObject(/re/)).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
  });
});

describe('isStringArray', () => {
  it('accepts a list of strings, including an empty one', () => {
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(['a', 'b'])).toBe(true);
  });

  it('rejects a mixed or non-array value', () => {
    expect(isStringArray(['a', 1])).toBe(false);
    expect(isStringArray('a')).toBe(false);
  });
});
