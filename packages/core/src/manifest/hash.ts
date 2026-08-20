import { createHash } from 'node:crypto';

export const HASH_PREFIX = 'sha256:';

/** Hashes content and returns the prefixed digest stored in the manifest. */
export const sha256 = (content: Buffer | string): string => {
  const digest = createHash('sha256')
    .update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
    .digest('hex');
  return `${HASH_PREFIX}${digest}`;
};
