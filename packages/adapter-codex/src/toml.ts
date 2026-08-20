import type { FrontmatterMap, FrontmatterValue } from '@aiconfig/core';

/**
 * Minimal TOML serialization.
 *
 * Codex agent files are the only TOML AI Config produces. This lives in
 * `adapter-codex` rather than core: TOML is a Codex concern.
 */

const ESCAPES = new Map<string, string>([
  ['\\', '\\\\'],
  ['\b', '\\b'],
  ['\t', '\\t'],
  ['\n', '\\n'],
  ['\f', '\\f'],
  ['\r', '\\r'],
]);

const escapeCharacter = (character: string): string => {
  const escape = ESCAPES.get(character);
  if (escape !== undefined) {
    return escape;
  }
  const code = character.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) {
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return character;
};

/** Serializes a value as a TOML basic string, on one line. */
export const tomlBasicString = (value: string): string => {
  let result = '"';
  for (const character of value) {
    result += character === '"' ? '\\"' : escapeCharacter(character);
  }
  return `${result}"`;
};

/**
 * Serializes a value as a TOML multi-line basic string.
 *
 * Newlines and single quotes stay literal so agent prompts remain readable in
 * the generated file. TOML only forbids a run of three or more quotes and a
 * quote immediately before the closing delimiter, so only those are escaped.
 *
 * A newline follows the opening delimiter — TOML trims exactly one there — so a
 * prompt beginning with a blank line survives the round trip.
 */
export const tomlMultilineString = (value: string): string => {
  let body = '';
  for (const character of value) {
    body += character === '\n' || character === '"' ? character : escapeCharacter(character);
  }

  // Any run of three or more quotes would close the literal early.
  body = body.replace(/"{3,}/g, (run) => '\\"'.repeat(run.length));

  // A trailing quote would abut the closing delimiter and be misread as part
  // of it. Escaping only that one keeps the rest of the text untouched.
  if (body.endsWith('"') && !body.endsWith('\\"')) {
    body = `${body.slice(0, -1)}\\"`;
  }

  return `"""\n${body}"""`;
};

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

const renderKey = (key: string): string => (BARE_KEY.test(key) ? key : tomlBasicString(key));

const isMap = (value: FrontmatterValue): value is FrontmatterMap =>
  typeof value === 'object' && !Array.isArray(value);

const renderValue = (value: FrontmatterValue): string => {
  if (typeof value === 'string') {
    return tomlBasicString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(renderValue).join(', ')}]`;
  }
  // An inline table, which is the only way to express a mapping nested inside
  // an array in TOML.
  return `{ ${Object.entries(value)
    .map(([key, child]) => `${renderKey(key)} = ${renderValue(child)}`)
    .join(', ')} }`;
};

export interface TomlField {
  readonly key: string;
  readonly value: FrontmatterValue;
  readonly multiline?: boolean;
}

/**
 * Renders TOML key/value pairs in the given order.
 *
 * Mapping values become `[table]` sections after the scalar keys, because a key
 * that follows a table header in TOML belongs to that table rather than to the
 * document — emitting them inline would silently re-parent every later field.
 */
export const renderToml = (fields: readonly TomlField[]): string => {
  const lines: string[] = [];
  const tables: { readonly path: readonly string[]; readonly value: FrontmatterMap }[] = [];

  for (const field of fields) {
    if (isMap(field.value)) {
      tables.push({ path: [field.key], value: field.value });
      continue;
    }
    const rendered =
      field.multiline === true && typeof field.value === 'string'
        ? tomlMultilineString(field.value)
        : renderValue(field.value);
    lines.push(`${renderKey(field.key)} = ${rendered}`);
  }

  for (const table of tables) {
    renderTable(table.path, table.value, lines);
  }

  return `${lines.join('\n')}\n`;
};

const renderTable = (path: readonly string[], value: FrontmatterMap, lines: string[]): void => {
  const entries = Object.entries(value);
  const nested = entries.filter((entry): entry is [string, FrontmatterMap] => isMap(entry[1]));

  lines.push('', `[${path.map(renderKey).join('.')}]`);
  for (const [key, child] of entries) {
    if (!isMap(child)) {
      lines.push(`${renderKey(key)} = ${renderValue(child)}`);
    }
  }
  for (const [key, child] of nested) {
    renderTable([...path, key], child, lines);
  }
};
