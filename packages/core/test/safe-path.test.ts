import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkGeneratedPath, resolveWithinRoot, toPosixPath } from '../src/path/safe-path.js';

describe('checkGeneratedPath', () => {
  it('accepts ordinary repository-relative paths', () => {
    for (const value of [
      '.claude/agents/reviewer.md',
      'AGENTS.md',
      '.github/instructions/backend.instructions.md',
      '.agents/skills/create-endpoint/references/api.md',
    ]) {
      expect(checkGeneratedPath(value), value).toEqual({ ok: true, path: value });
    }
  });

  it.each([
    ['', 'empty'],
    ['../outside.md', 'parent traversal'],
    ['a/../../outside.md', 'traversal in the middle'],
    ['./relative.md', 'single-dot segment'],
    ['/etc/passwd', 'absolute POSIX path'],
    ['C:/Windows/system.ini', 'Windows drive path'],
    ['c:relative.md', 'Windows drive-relative path'],
    ['\\\\server\\share\\file.md', 'UNC path'],
    ['.claude\\agents\\reviewer.md', 'backslash separators'],
    ['a//b.md', 'empty segment'],
    ['trailing/', 'trailing separator'],
  ])('rejects %s (%s)', (value) => {
    expect(checkGeneratedPath(value).ok).toBe(false);
  });

  it('rejects paths containing control characters', () => {
    expect(checkGeneratedPath(`a${String.fromCharCode(0)}b.md`).ok).toBe(false);
    expect(checkGeneratedPath(`a${String.fromCharCode(31)}b.md`).ok).toBe(false);
    expect(checkGeneratedPath(`a${String.fromCharCode(127)}b.md`).ok).toBe(false);
  });

  it('rejects Windows reserved device names in any segment', () => {
    for (const value of ['.claude/agents/con.md', 'NUL.md', 'a/PRN/b.md', 'com1.md', 'lpt9.txt']) {
      expect(checkGeneratedPath(value).ok, value).toBe(false);
    }
  });

  it('rejects segments Windows would silently rewrite', () => {
    expect(checkGeneratedPath('a/trailing./b.md').ok).toBe(false);
    expect(checkGeneratedPath('a/trailing /b.md').ok).toBe(false);
  });

  it('rejects characters Windows cannot store in a filename', () => {
    // `a/b:stream.md` is legal on Linux but addresses an NTFS alternate data
    // stream on Windows, so it is refused everywhere rather than behaving
    // differently per platform.
    for (const value of [
      'a/b:stream.md',
      'a/question?.md',
      'a/pipe|.md',
      'a/less<.md',
      'a/greater>.md',
      'a/quote".md',
      'a/star*.md',
    ]) {
      expect(checkGeneratedPath(value).ok, value).toBe(false);
    }
  });

  it('accepts a first segment that merely begins with dots', () => {
    // `..data` is a legitimate name, not traversal.
    expect(checkGeneratedPath('..data/file.md').ok).toBe(true);
  });
});

describe('resolveWithinRoot', () => {
  const root = path.resolve('repo-root');

  it('resolves a safe path under the root', () => {
    expect(resolveWithinRoot(root, '.claude/agents/reviewer.md')).toBe(
      path.join(root, '.claude', 'agents', 'reviewer.md'),
    );
  });

  it('throws rather than resolving outside the root', () => {
    expect(() => resolveWithinRoot(root, '../escape.md')).toThrow(/unsafe path/);
    expect(() => resolveWithinRoot(root, '/etc/passwd')).toThrow(/unsafe path/);
  });

  it('never returns the root itself', () => {
    expect(() => resolveWithinRoot(root, '.')).toThrow();
  });

  it('handles every shape of root path identically', () => {
    const expected = path.join('.claude', 'agents', 'a.md');
    for (const candidate of [root, `${root}${path.sep}`, root.split(path.sep).join('/'), '.']) {
      const resolved = resolveWithinRoot(candidate, '.claude/agents/a.md');
      expect(path.relative(path.resolve(candidate), resolved), candidate).toBe(expected);
    }
  });

  it('rejects a path that escapes after normalization', () => {
    expect(() => resolveWithinRoot(root, '.claude/../../escape.md')).toThrow();
  });

  it('resolves a first segment beginning with dots inside the root', () => {
    const resolved = resolveWithinRoot(root, '..data/file.md');
    expect(path.relative(path.resolve(root), resolved)).toBe(path.join('..data', 'file.md'));
  });
});

describe('toPosixPath', () => {
  it('converts native separators without touching POSIX input', () => {
    expect(toPosixPath(path.join('a', 'b', 'c.md'))).toBe('a/b/c.md');
  });
});
