import { parseDocument } from 'yaml';

import { explainYamlFailure } from './yaml-explain.js';

export interface YamlPosition {
  readonly line: number;
  readonly column: number;
}

export type YamlResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly position: YamlPosition | undefined;
      /**
       * A complete sentence naming the mistake behind `reason`, when one can be
       * derived from the source. The parser's own message is kept as-is in
       * `reason`; this is added after it, never instead of it.
       */
      readonly explanation: string | undefined;
    };

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
      return failed(text, failure, lineOffset);
    }

    // An unresolved custom tag is only a warning to the library, which would
    // silently coerce it to a plain scalar. Discarding a field the author wrote
    // deliberately is exactly what this project forbids, so it is an error.
    const warning = document.warnings[0];
    if (warning !== undefined) {
      return failed(text, warning, lineOffset);
    }

    return { ok: true, value: document.toJS() as unknown };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'could not parse YAML',
      position: undefined,
      explanation: undefined,
    };
  }
};

interface YamlProblem {
  readonly message: string;
  /** Character offsets into the parsed text: `[start, end]`. */
  readonly pos?: readonly [number, number] | undefined;
}

/**
 * The library reports where its state machine stopped, which is rarely where
 * the author's mistake is, so the source line is re-read here to say what is
 * actually wrong with it.
 */
const failed = (text: string, problem: YamlProblem, lineOffset: number): YamlResult => {
  const position = positionOf(problem, text, lineOffset);
  return {
    ok: false,
    reason: problem.message,
    position,
    explanation: explainYamlFailure(
      text,
      position === undefined ? undefined : position.line - lineOffset,
      lineOffset,
    ),
  };
};

/**
 * Converts the failure's character offset into a line and column.
 *
 * Derived here rather than read from the library's own `linePos`, which it
 * fills in only under `prettyErrors`. Turning that on would fold the position
 * into `message` as several lines of quoted source, and a diagnostic message is
 * one line — so the offset, which is always present, is converted instead.
 */
const positionOf = (
  problem: YamlProblem,
  text: string,
  lineOffset: number,
): YamlPosition | undefined => {
  const offset = problem.pos?.[0];
  if (offset === undefined) {
    return undefined;
  }

  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lastBreak = before.lastIndexOf('\n');
  return {
    line: before.split('\n').length + lineOffset,
    column: before.length - lastBreak,
  };
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
