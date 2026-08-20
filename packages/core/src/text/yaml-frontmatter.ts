/**
 * A value that can be written into YAML frontmatter or an override document.
 *
 * Nested maps and lists are included because provider-native fields need them —
 * Claude Code `hooks`, OpenCode `permission`, Copilot `mcp-servers` — and a
 * flat-only renderer would force each adapter to hand-roll indentation.
 */
export type FrontmatterValue =
  string | number | boolean | readonly FrontmatterValue[] | FrontmatterMap;

export interface FrontmatterMap {
  readonly [key: string]: FrontmatterValue;
}

/** An ordered field. The caller controls key order, so output is stable. */
export type FrontmatterField = readonly [key: string, value: FrontmatterValue];

// Plain (unquoted) YAML scalars are only safe when they cannot be mistaken for
// structure or for another type. Anything outside this shape is quoted.
//
// `*`, `,`, `#`, `@` and quote characters are excluded even where a particular
// position would be legal: `*` is an alias indicator, `,` separates entries in
// flow context, and `#` starts a comment. Excluding them outright means glob
// patterns are always quoted, which also matches how every provider's
// documentation writes them.
const SAFE_PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 _./()+-]*$/;

// Anything a YAML 1.2 core-schema parser would read back as a non-string:
// booleans, null, decimals, exponents, hexadecimal, octal, binary, and the
// special floats. `0x1F` unquoted would round-trip as the number 31.
const LOOKS_LIKE_OTHER_TYPE =
  /^(true|false|yes|no|on|off|null|~|[-+]?(\.inf|\.nan)|[-+]?0[xX][0-9a-fA-F_]+|[-+]?0[oO][0-7_]+|[-+]?0[bB][01_]+|[-+]?[0-9][0-9_]*(\.[0-9_]*)?([eE][-+]?[0-9]+)?|[-+]?\.[0-9_]+([eE][-+]?[0-9]+)?)$/i;

const renderScalar = (value: string): string => {
  if (
    value.length > 0 &&
    !value.endsWith(' ') &&
    !value.includes(' #') &&
    SAFE_PLAIN_SCALAR.test(value) &&
    !LOOKS_LIKE_OTHER_TYPE.test(value)
  ) {
    return value;
  }
  // A JSON string literal is almost a valid YAML double-quoted scalar, and its
  // escaping rules are fully specified, which keeps output deterministic.
  return escapeForYaml(JSON.stringify(value));
};

/**
 * Escapes the characters JSON leaves literal but YAML cannot carry.
 *
 * `JSON.stringify` escapes only below U+0020. YAML 1.2's printable set excludes
 * U+007F–U+0084 and U+0086–U+009F outright, and U+0085, U+2028 and U+2029 are
 * line breaks to a YAML 1.1 parser — so a description containing one would
 * silently fold into a space on round-trip.
 */
const escapeForYaml = (json: string): string => {
  let result = '';
  for (const character of json) {
    const code = character.codePointAt(0) ?? 0;
    const mustEscape = (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    result += mustEscape ? `\\u${code.toString(16).padStart(4, '0')}` : character;
  }
  return result;
};

const isList = (value: FrontmatterValue): value is readonly FrontmatterValue[] =>
  Array.isArray(value);

const renderInlineScalar = (value: string | number | boolean): string =>
  typeof value === 'string' ? renderScalar(value) : String(value);

/**
 * Keys are escaped by the same rules as values.
 *
 * A nested map's keys are user data, not identifiers: an OpenCode permission
 * map is keyed by glob patterns, and `*: ask` would be read as an alias rather
 * than a key. Field names declared by adapters are plain identifiers, so they
 * pass through unquoted.
 */
const renderKey = (key: string): string => renderScalar(key);

/**
 * Renders one `key: value` entry, recursing into nested maps and lists.
 *
 * Block style throughout rather than flow style: a nested `permission` map or a
 * `hooks` object is what the providers' own documentation shows, and block
 * style keeps a generated file diffable line by line.
 */
const renderEntry = (key: string, value: FrontmatterValue, indent: string): readonly string[] => {
  if (typeof value !== 'object') {
    return [`${indent}${renderKey(key)}: ${renderInlineScalar(value)}`];
  }
  if (isList(value)) {
    if (value.length === 0) {
      return [`${indent}${renderKey(key)}: []`];
    }
    return [
      `${indent}${renderKey(key)}:`,
      ...value.flatMap((item) => renderSequenceItem(item, `${indent}  `)),
    ];
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return [`${indent}${renderKey(key)}: {}`];
  }
  return [
    `${indent}${renderKey(key)}:`,
    ...entries.flatMap(([child, childValue]) => renderEntry(child, childValue, `${indent}  `)),
  ];
};

/**
 * Renders one `- item` of a sequence.
 *
 * A mapping item is rendered at the child indent and then has its first line's
 * leading whitespace replaced by the sequence dash, which is how YAML expresses
 * a mapping inside a sequence without an extra level of nesting.
 */
const renderSequenceItem = (value: FrontmatterValue, indent: string): readonly string[] => {
  if (typeof value !== 'object') {
    return [`${indent}- ${renderInlineScalar(value)}`];
  }

  const lines = isList(value)
    ? value.length === 0
      ? [`${indent}  []`]
      : value.flatMap((item) => renderSequenceItem(item, `${indent}  `))
    : Object.entries(value).length === 0
      ? [`${indent}  {}`]
      : Object.entries(value).flatMap(([child, childValue]) =>
          renderEntry(child, childValue, `${indent}  `),
        );

  const [first, ...rest] = lines;
  if (first === undefined) {
    return [`${indent}- {}`];
  }
  return [`${indent}- ${first.slice(indent.length + 2)}`, ...rest];
};

/**
 * Renders ordered fields as YAML block entries, without delimiters.
 *
 * Shared by frontmatter rendering and by provider override documents, so both
 * escape and indent identically.
 */
export const renderYamlEntries = (
  fields: readonly FrontmatterField[],
  indent = '',
): readonly string[] => fields.flatMap(([key, value]) => renderEntry(key, value, indent));

/**
 * Renders YAML frontmatter from ordered fields.
 *
 * Deliberately generic: it takes key/value pairs and knows nothing about which
 * provider uses which key names. Each adapter decides its own field names and
 * order; this only turns them into bytes.
 *
 * Returns the block including both `---` delimiters and a trailing newline, or
 * an empty string when there are no fields.
 */
export const renderFrontmatter = (fields: readonly FrontmatterField[]): string => {
  if (fields.length === 0) {
    return '';
  }

  return `${['---', ...renderYamlEntries(fields), '---'].join('\n')}\n`;
};

/**
 * Renders a Markdown document with optional frontmatter and a normalized body.
 */
export const renderMarkdownDocument = (
  fields: readonly FrontmatterField[],
  body: string,
): string => {
  const frontmatter = renderFrontmatter(fields);
  const trimmedBody = body.trim();

  if (frontmatter.length === 0) {
    return trimmedBody.length === 0 ? '' : `${trimmedBody}\n`;
  }
  if (trimmedBody.length === 0) {
    return frontmatter;
  }
  return `${frontmatter}\n${trimmedBody}\n`;
};

/**
 * Appends provider fields to a validated frontmatter block without rewriting
 * canonical bytes or unknown canonical keys.
 */
export const spliceFrontmatter = (text: string, lines: readonly string[]): string => {
  const source = text.split('\n');
  const closing = source.indexOf('---', 1);
  if (closing === -1) {
    return text;
  }
  return [...source.slice(0, closing), ...lines, ...source.slice(closing)].join('\n');
};
