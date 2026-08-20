import { parseYaml, isPlainObject } from './yaml.js';

const DELIMITER = '---';

export interface ParsedDocument {
  readonly frontmatter: Record<string, unknown>;
  readonly hasFrontmatter: boolean;
  readonly body: string;
  /** 1-based line where the frontmatter mapping starts, for diagnostics. */
  readonly frontmatterStartLine: number;
}

export type FrontmatterResult =
  | { readonly ok: true; readonly document: ParsedDocument }
  | {
      readonly ok: false;
      readonly code:
        'FRONTMATTER_UNTERMINATED' | 'FRONTMATTER_INVALID_YAML' | 'FRONTMATTER_NOT_A_MAP';
      readonly reason: string;
      readonly line: number | undefined;
      readonly column: number | undefined;
    };

/**
 * Splits YAML frontmatter from a Markdown body.
 *
 * Frontmatter must begin on line 1; a `---` anywhere else is body content, not
 * a delimiter. `text` is expected to already be normalized by
 * {@link decodeSourceText}.
 */
export const parseFrontmatter = (text: string): FrontmatterResult => {
  const lines = text.split('\n');
  if (lines[0] !== DELIMITER) {
    return {
      ok: true,
      document: {
        frontmatter: {},
        hasFrontmatter: false,
        body: text,
        frontmatterStartLine: 1,
      },
    };
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === DELIMITER) {
      closingIndex = index;
      break;
    }
  }

  if (closingIndex === -1) {
    return {
      ok: false,
      code: 'FRONTMATTER_UNTERMINATED',
      reason: `frontmatter opened with '${DELIMITER}' but was never closed`,
      line: 1,
      column: 1,
    };
  }

  const yamlText = lines.slice(1, closingIndex).join('\n');
  const body = lines.slice(closingIndex + 1).join('\n');

  // Line 1 is the opening delimiter, so the mapping itself starts on line 2.
  const parsed = parseYaml(yamlText, 1);
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'FRONTMATTER_INVALID_YAML',
      reason: parsed.reason,
      line: parsed.position?.line ?? 2,
      column: parsed.position?.column,
    };
  }

  // An empty frontmatter block is legitimate and yields no fields.
  if (parsed.value === null || parsed.value === undefined) {
    return {
      ok: true,
      document: { frontmatter: {}, hasFrontmatter: true, body, frontmatterStartLine: 2 },
    };
  }

  if (!isPlainObject(parsed.value)) {
    return {
      ok: false,
      code: 'FRONTMATTER_NOT_A_MAP',
      reason: 'frontmatter must be a YAML mapping of fields',
      line: 2,
      column: 1,
    };
  }

  return {
    ok: true,
    document: {
      frontmatter: parsed.value,
      hasFrontmatter: true,
      body,
      frontmatterStartLine: 2,
    },
  };
};

/** Finds the 1-based line of a top-level frontmatter key, for diagnostics. */
export const findFrontmatterKeyLine = (text: string, key: string): number | undefined => {
  const lines = text.split('\n');
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === DELIMITER) {
      return undefined;
    }
    if (line !== undefined && pattern.test(line)) {
      return index + 1;
    }
  }
  return undefined;
};
