import { checkGeneratedPath } from '../path/safe-path.js';

export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const NAME_MAX_LENGTH = 64;

export type NameCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Validates a canonical name.
 *
 * This rule is AI Config's own portability contract, not a mirror of any
 * provider's rules: a name accepted here is accepted by every provider, and it
 * does not change if a provider relaxes its own constraints.
 */
export const checkName = (name: string): NameCheck => {
  if (name.length === 0) {
    return { ok: false, reason: 'name is empty' };
  }
  if (name.length > NAME_MAX_LENGTH) {
    return { ok: false, reason: `name is longer than ${String(NAME_MAX_LENGTH)} characters` };
  }
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: 'name must be lowercase alphanumeric segments separated by single hyphens',
    };
  }

  // A valid-looking name still has to survive becoming a filename on every
  // supported platform, so it is checked against the same rules as generated
  // paths rather than trusting the pattern above.
  const asPath = checkGeneratedPath(`${name}.md`);
  if (!asPath.ok) {
    return { ok: false, reason: asPath.reason };
  }

  return { ok: true };
};

/** Derives a canonical name from a `.md` filename. */
export const nameFromFilename = (filename: string): string =>
  filename.endsWith('.md') ? filename.slice(0, -'.md'.length) : filename;
