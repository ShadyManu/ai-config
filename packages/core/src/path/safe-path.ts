import * as path from 'node:path';

export type PathCheck =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

// Device names Windows reserves regardless of extension. A canonical item named
// `con` would compile to `.claude/agents/con.md`, which cannot be created on
// Windows, so these are rejected up front rather than failing at write time.
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

const DELETE_CODE_POINT = 0x7f;
const FIRST_PRINTABLE_CODE_POINT = 0x20;

const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < FIRST_PRINTABLE_CODE_POINT || code === DELETE_CODE_POINT) {
      return true;
    }
  }
  return false;
};

/**
 * Validates a repository-relative path produced by an adapter.
 *
 * Treats adapter output as untrusted: adapters build these strings from
 * canonical names, and a name that escaped validation must not be able to
 * escape the repository. Applied centrally to every generated file, so no
 * adapter can opt out.
 */
export const checkGeneratedPath = (raw: string): PathCheck => {
  if (raw.length === 0) {
    return { ok: false, reason: 'path is empty' };
  }
  if (containsControlCharacter(raw)) {
    return { ok: false, reason: 'path contains control characters' };
  }
  if (raw.includes('\\')) {
    return { ok: false, reason: 'path must use POSIX separators' };
  }
  if (raw.startsWith('/')) {
    return { ok: false, reason: 'path must be relative to the repository root' };
  }
  if (/^[a-zA-Z]:/.test(raw)) {
    return { ok: false, reason: 'path must not be a Windows drive path' };
  }
  if (raw.endsWith('/')) {
    return { ok: false, reason: 'path must not end with a separator' };
  }

  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      return { ok: false, reason: 'path contains an empty segment' };
    }
    if (segment === '.' || segment === '..') {
      return { ok: false, reason: `path contains a '${segment}' segment` };
    }
    const stem = segment.split('.')[0] ?? '';
    if (WINDOWS_RESERVED.has(stem.toLowerCase())) {
      return { ok: false, reason: `'${segment}' is a reserved filename on Windows` };
    }
    if (/[<>:"|?*]/.test(segment)) {
      return {
        ok: false,
        reason: `'${segment}' contains a character that is not portable to Windows`,
      };
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return {
        ok: false,
        reason: `'${segment}' ends with a character Windows strips from filenames`,
      };
    }
  }

  return { ok: true, path: segments.join('/') };
};

/**
 * Resolves a validated repository-relative path against the root.
 *
 * Re-checks containment after resolution rather than trusting
 * {@link checkGeneratedPath}: the two use different mechanisms, and a bug in
 * the syntactic check should not by itself permit a write outside the root.
 */
export const resolveWithinRoot = (root: string, relativePath: string): string => {
  const check = checkGeneratedPath(relativePath);
  if (!check.ok) {
    throw new Error(`Refusing to resolve unsafe path '${relativePath}': ${check.reason}`);
  }

  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, check.path);
  const relative = path.relative(absoluteRoot, resolved);

  // Compared against a separator so a legitimate first segment such as
  // `..data` is not mistaken for traversal.
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to resolve path outside the repository root: '${relativePath}'`);
  }

  return resolved;
};

/** Converts a platform-native relative path to the POSIX form used everywhere. */
export const toPosixPath = (relativePath: string): string => relativePath.split(path.sep).join('/');
