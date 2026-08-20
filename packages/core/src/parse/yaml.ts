import { parseDocument } from 'yaml';

export interface YamlPosition {
  readonly line: number;
  readonly column: number;
}

export type YamlResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string; readonly position: YamlPosition | undefined };

/**
 * Parses YAML into plain data.
 *
 * Configuration is never executed as code. The core schema resolves only
 * standard tags, so a document cannot construct arbitrary objects.
 *
 * `toJS` is inside the try block because that — not `parseDocument` — is where
 * the library throws on excessive alias expansion, so a billion-laughs document
 * must be caught here or it escapes the whole pipeline as an exception.
 */
export const parseYaml = (text: string, lineOffset = 0): YamlResult => {
  try {
    const document = parseDocument(text, {
      schema: 'core',
      version: '1.2',
      prettyErrors: false,
    });

    const failure = document.errors[0];
    if (failure !== undefined) {
      return { ok: false, reason: failure.message, position: positionOf(failure, lineOffset) };
    }

    // An unresolved custom tag is only a warning to the library, which would
    // silently coerce it to a plain scalar. Discarding a field the author wrote
    // deliberately is exactly what this project forbids, so it is an error.
    const warning = document.warnings[0];
    if (warning !== undefined) {
      return { ok: false, reason: warning.message, position: positionOf(warning, lineOffset) };
    }

    return { ok: true, value: document.toJS() as unknown };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'could not parse YAML',
      position: undefined,
    };
  }
};

const positionOf = (
  problem: {
    readonly linePos?: readonly [{ line: number; col: number }, ...unknown[]] | undefined;
  },
  lineOffset: number,
): YamlPosition | undefined => {
  const linePos = problem.linePos?.[0];
  return linePos === undefined
    ? undefined
    : { line: linePos.line + lineOffset, column: linePos.col };
};

/**
 * Narrows a parsed value to a YAML or JSON mapping.
 *
 * Requires an actual object literal rather than merely `typeof 'object'`: the
 * `yaml` parser resolves a timestamp scalar to a `Date`, which would otherwise
 * be treated as a mapping and silently flatten to no keys at all.
 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
