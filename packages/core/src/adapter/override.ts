import type { AiConfiguration, SourceKind } from '../domain/configuration.js';
import { sourceDirectory } from '../domain/configuration.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import { compareStrings } from '../domain/ordering.js';
import { hasErrors } from '../domain/diagnostic.js';
import type { ProviderId } from '../domain/provider.js';
import { isPlainObject } from '../parse/yaml.js';
import type {
  FrontmatterField,
  FrontmatterMap,
  FrontmatterValue,
} from '../text/yaml-frontmatter.js';

/** The `schema:` value every provider override document must declare. */
export const OVERRIDE_SCHEMA_VERSION = 1;

export type OverrideFieldType =
  | { readonly kind: 'string' }
  | { readonly kind: 'boolean' }
  | {
      readonly kind: 'number';
      readonly min?: number;
      readonly max?: number;
      readonly integer?: boolean;
    }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'enum-or-map'; readonly values: readonly string[] }
  | { readonly kind: 'string-list' }
  | { readonly kind: 'string-or-string-list' }
  | { readonly kind: 'string-map' }
  | {
      readonly kind: 'map';
      /**
       * Lets a guided flow offer a simple `key: value` form for a field whose
       * full shape is richer. Declared by the adapter so no user interface has
       * to know a provider's key names.
       */
      readonly shorthand?: { readonly keys: readonly string[]; readonly values: readonly string[] };
    }
  | { readonly kind: 'list' }
  | {
      readonly kind: 'map-list';
      readonly fields?: Readonly<Record<string, 'string' | 'boolean'>>;
      readonly required?: readonly string[];
    };

export interface OverrideField {
  /**
   * The provider's own field name. May be dotted to address a nested key, as in
   * `policy.allow_implicit_invocation`; the document itself stays properly
   * nested YAML.
   */
  readonly name: string;
  readonly type: OverrideFieldType;
  readonly description: string;
  /** First-party documentation URL this field was taken from. */
  readonly documentation: string;
  /** What the provider does when the field is absent. */
  readonly defaultNote?: string;
  /** Free-form values a guided flow may offer as suggestions. */
  readonly suggestions?: readonly string[];
}

/** A field a provider once documented and no longer recommends. */
export interface DeprecatedOverrideField {
  readonly name: string;
  readonly reason: string;
}

/** What an override attaches to, in the terms a schema is allowed to inspect. */
export interface OverrideTarget {
  readonly kind: SourceKind;
  readonly name: string;
  /** Canonical `applyTo` globs. Empty for kinds that have none. */
  readonly applyTo: readonly string[];
}

export interface ProviderOverrideSchema {
  readonly kind: SourceKind;
  readonly fields: readonly OverrideField[];
  /** Canonical keys this override may never redefine. */
  readonly reserved: readonly string[];
  readonly deprecated?: readonly DeprecatedOverrideField[];
  /**
   * Why this artifact cannot carry an override, if it cannot.
   *
   * Lets a provider refuse a specific artifact rather than a whole kind — a
   * Copilot instruction override is only representable when the instruction is
   * path-scoped, because an unscoped one is aggregated into a file that has no
   * frontmatter at all.
   */
  unavailableReason?: (target: OverrideTarget) => string | undefined;
}

/** The repository-relative path of a provider override source file. */
export const overridePath = (provider: ProviderId, kind: SourceKind, id: string): string =>
  `.ai/providers/${provider}/${sourceDirectory(kind)}/${id}.yaml`;

/** Every canonical artifact an override could attach to, in a stable order. */
export const overrideTargets = (configuration: AiConfiguration): readonly OverrideTarget[] => [
  ...configuration.instructions.map((item) => ({
    kind: 'instruction' as const,
    name: item.name,
    applyTo: item.applyTo,
  })),
  ...configuration.agents.map((item) => ({
    kind: 'agent' as const,
    name: item.name,
    applyTo: [],
  })),
  ...configuration.skills.map((item) => ({
    kind: 'skill' as const,
    name: item.name,
    applyTo: [],
  })),
  ...configuration.commands.map((item) => ({
    kind: 'command' as const,
    name: item.name,
    applyTo: [],
  })),
];

export interface OverrideValidation {
  /** Validated options in the schema's declared field order, or `undefined`. */
  readonly options: FrontmatterMap | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

interface ValidationContext {
  readonly provider: ProviderId;
  readonly sourcePath: string;
}

const issue = (
  context: ValidationContext,
  code: Diagnostic['code'],
  message: string,
): Diagnostic => ({
  code,
  severity: 'error',
  message,
  source: context.sourcePath,
  provider: context.provider,
});

const note = (
  context: ValidationContext,
  code: Diagnostic['code'],
  message: string,
): Diagnostic => ({
  code,
  severity: 'info',
  message,
  source: context.sourcePath,
  provider: context.provider,
});

/**
 * An unrecognized field is reported but still written through to the provider
 * file unchanged.
 *
 * Providers add frontmatter fields on their own release cadence, and AI Config
 * cannot ship a schema update the same day. Refusing an unknown field would
 * turn every such addition into a hard error for projects that adopt it, so the
 * field travels through and the author is told it was not recognized.
 */
const warn = (
  context: ValidationContext,
  code: Diagnostic['code'],
  message: string,
): Diagnostic => ({
  code,
  severity: 'warning',
  message,
  source: context.sourcePath,
  provider: context.provider,
});

/** An option AI Config does not recognize, carried through to the output. */
interface PassthroughOption {
  readonly segments: readonly string[];
  readonly value: FrontmatterValue;
}

/**
 * Narrows an arbitrary parsed YAML value to what frontmatter can represent.
 *
 * Override documents are untrusted input, so anything a YAML parser can produce
 * that the writer would serialize unpredictably — null, a Date, a non-finite
 * number — is rejected here rather than reaching the generated file.
 */
const toFrontmatterValue = (value: unknown): FrontmatterValue | undefined => {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items: FrontmatterValue[] = [];
    for (const item of value) {
      const converted = toFrontmatterValue(item);
      if (converted === undefined) {
        return undefined;
      }
      items.push(converted);
    }
    return items;
  }
  if (isPlainObject(value)) {
    const map: Record<string, FrontmatterValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toFrontmatterValue(item);
      if (converted === undefined) {
        return undefined;
      }
      map[key] = converted;
    }
    return map;
  }
  return undefined;
};

const NOTHING_SET =
  'No provider settings are set yet, so this override has no effect. Uncomment a setting and give it a value.';

/**
 * Validates one override document against a provider's declared schema.
 *
 * Generic on purpose: core owns the envelope, the type system and the
 * diagnostics, while every field name, enum and range comes from the adapter.
 * That is what keeps the CLI, the editor wizards and compilation from drifting
 * apart — there is only one declaration to read.
 */
export const validateOverrideDocument = (
  document: unknown,
  schema: ProviderOverrideSchema,
  context: ValidationContext,
): OverrideValidation => {
  const diagnostics: Diagnostic[] = [];

  if (!isPlainObject(document)) {
    return {
      options: undefined,
      diagnostics: [
        issue(
          context,
          'OVERRIDE_INVALID',
          `${context.sourcePath} must contain a YAML mapping with 'schema' and 'options'.`,
        ),
      ],
    };
  }

  if (document['schema'] !== OVERRIDE_SCHEMA_VERSION) {
    diagnostics.push(
      issue(
        context,
        'OVERRIDE_INVALID',
        `${context.sourcePath} must declare schema: ${String(OVERRIDE_SCHEMA_VERSION)}.`,
      ),
    );
  }

  for (const key of Object.keys(document)) {
    if (key !== 'schema' && key !== 'options') {
      diagnostics.push(
        issue(
          context,
          'OVERRIDE_INVALID',
          `Unknown key '${key}'. A provider override contains only 'schema' and 'options'.`,
        ),
      );
    }
  }

  const rawOptions = document['options'];
  if (rawOptions === undefined || rawOptions === null) {
    // An override with no options is inert rather than broken, and it is the
    // state a scaffolded template is deliberately in until its author fills a
    // setting in — every line still commented out leaves `options` empty. It is
    // reported so it does not go unnoticed, but never as an error: a file the
    // guided flow just created must not make the project invalid.
    diagnostics.push(note(context, 'OVERRIDE_EMPTY', NOTHING_SET));
    return { options: {}, diagnostics };
  }
  if (!isPlainObject(rawOptions)) {
    diagnostics.push(
      issue(context, 'OVERRIDE_INVALID', `'options' must be a mapping of provider fields.`),
    );
    return { options: undefined, diagnostics };
  }

  const before = diagnostics.length;
  const passthrough: PassthroughOption[] = [];
  collectUnknown(rawOptions, [], schema, context, diagnostics, passthrough);

  const options: Record<string, FrontmatterValue> = {};
  for (const field of schema.fields) {
    const segments = field.name.split('.');
    const raw = readPath(rawOptions, segments);
    if (raw === undefined) {
      continue;
    }
    const checked = checkValue(raw, field, context, diagnostics);
    if (checked !== undefined) {
      writePath(options, segments, checked);
    }
  }

  for (const option of passthrough) {
    writePath(options, option.segments, option.value);
  }

  // Only an error invalidates the document. A warning — an unrecognized field
  // written through unchanged — must still produce options, or the override
  // would stop applying the moment a provider adds a field.
  if (hasErrors(diagnostics.slice(before))) {
    return { options: undefined, diagnostics };
  }
  if (Object.keys(options).length === 0) {
    diagnostics.push(note(context, 'OVERRIDE_EMPTY', NOTHING_SET));
  }
  return { options, diagnostics };
};

/**
 * Reports every key in the document that is not a declared field or a prefix
 * of one.
 *
 * Walks rather than compares flat key sets, so `policy: { unknown: true }` is
 * reported at `policy.unknown` and not silently accepted alongside the
 * recognized `policy.allow_implicit_invocation`.
 */
const collectUnknown = (
  node: Record<string, unknown>,
  prefix: readonly string[],
  schema: ProviderOverrideSchema,
  context: ValidationContext,
  diagnostics: Diagnostic[],
  passthrough: PassthroughOption[],
): void => {
  const names = schema.fields.map((field) => field.name);
  const reserved = new Set(schema.reserved);

  for (const key of Object.keys(node)) {
    const segments = [...prefix, key];
    const path = segments.join('.');

    if (prefix.length === 0 && reserved.has(key)) {
      diagnostics.push(
        issue(
          context,
          'OVERRIDE_CANONICAL_FIELD',
          `'${key}' is owned by the canonical artifact and cannot be set in a provider override. Edit the canonical file instead.`,
        ),
      );
      continue;
    }

    if (names.includes(path)) {
      continue;
    }

    const isPrefix = names.some((name) => name.startsWith(`${path}.`));
    const value = node[key];
    if (isPrefix && isPlainObject(value)) {
      collectUnknown(value, segments, schema, context, diagnostics, passthrough);
      continue;
    }

    const deprecated = schema.deprecated?.find((entry) => entry.name === path);
    if (deprecated !== undefined) {
      diagnostics.push(
        issue(
          context,
          'OVERRIDE_UNKNOWN_FIELD',
          `'${path}' is not supported: ${deprecated.reason}`,
        ),
      );
      continue;
    }

    const passed = toFrontmatterValue(value);
    if (passed === undefined) {
      diagnostics.push(
        issue(
          context,
          'OVERRIDE_VALUE_INVALID',
          `'${path}' cannot be written through: a provider option must be a string, number, boolean, list or mapping.`,
        ),
      );
      continue;
    }

    diagnostics.push(
      warn(
        context,
        'OVERRIDE_UNRECOGNIZED_FIELD',
        `'${path}' is not a field AI Config knows for this provider; it is written through to the generated file unchanged. Known fields: ${names.join(', ')}.`,
      ),
    );
    passthrough.push({ segments, value: passed });
  }
};

const readPath = (node: Record<string, unknown>, segments: readonly string[]): unknown => {
  let current: unknown = node;
  for (const segment of segments) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

const writePath = (
  target: Record<string, FrontmatterValue>,
  segments: readonly string[],
  value: FrontmatterValue,
): void => {
  const [head, ...rest] = segments;
  if (head === undefined) {
    return;
  }
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const existing = target[head];
  const child: Record<string, FrontmatterValue> =
    existing !== undefined && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, FrontmatterValue>)
      : {};
  target[head] = child;
  writePath(child, rest, value);
};

const checkValue = (
  raw: unknown,
  field: OverrideField,
  context: ValidationContext,
  diagnostics: Diagnostic[],
): FrontmatterValue | undefined => {
  const reject = (expected: string): undefined => {
    diagnostics.push(
      issue(
        context,
        'OVERRIDE_VALUE_INVALID',
        `'${field.name}' ${expected}, but received ${describe(raw)}.`,
      ),
    );
    return undefined;
  };

  switch (field.type.kind) {
    case 'string':
      return typeof raw === 'string' && raw.trim().length > 0
        ? raw
        : reject('must be a non-empty string');

    case 'boolean':
      return typeof raw === 'boolean' ? raw : reject('must be true or false');

    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return reject('must be a number');
      }
      const { min, max, integer } = field.type;
      if (integer === true && !Number.isInteger(raw)) {
        return reject('must be a whole number');
      }
      if (min !== undefined && raw < min) {
        return reject(`must be at least ${String(min)}`);
      }
      if (max !== undefined && raw > max) {
        return reject(`must be at most ${String(max)}`);
      }
      return raw;
    }

    case 'enum': {
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        return reject(`must be one of ${field.type.values.join(', ')}`);
      }
      if (field.type.values.includes(raw)) {
        return raw;
      }
      // A provider can add an accepted value between AI Config releases, and
      // the enum here is a snapshot. Rejecting would make the new value
      // unusable until AI Config ships, so it is reported and written through
      // for the provider itself to accept or refuse. The cost is that a typo
      // is a warning rather than an error.
      diagnostics.push(
        warn(
          context,
          'OVERRIDE_UNRECOGNIZED_VALUE',
          `'${field.name}' is set to '${raw}', which AI Config does not recognize; it is written through unchanged. Known values: ${field.type.values.join(', ')}.`,
        ),
      );
      return raw;
    }

    case 'enum-or-map': {
      if (isPlainObject(raw)) {
        return checkStructured(raw, field, context, diagnostics);
      }
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        return reject(`must be one of ${field.type.values.join(', ')}, or a mapping`);
      }
      if (!field.type.values.includes(raw)) {
        diagnostics.push(
          warn(
            context,
            'OVERRIDE_UNRECOGNIZED_VALUE',
            `'${field.name}' is set to '${raw}', which AI Config does not recognize; it is written through unchanged. Known values: ${field.type.values.join(', ')}.`,
          ),
        );
      }
      return raw;
    }

    case 'string-list': {
      const list = typeof raw === 'string' ? [raw] : raw;
      if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) {
        return reject('must be a string or a list of strings');
      }
      if (list.length === 0) {
        return reject('must not be empty; remove the field instead');
      }
      return list;
    }

    case 'string-or-string-list': {
      if (typeof raw === 'string' && raw.trim().length > 0) {
        return raw;
      }
      if (Array.isArray(raw)) {
        const items: readonly unknown[] = raw;
        const strings: string[] = [];
        for (const item of items) {
          if (typeof item !== 'string' || item.trim().length === 0) {
            return reject('must be a non-empty string or a non-empty list of strings');
          }
          strings.push(item);
        }
        if (strings.length > 0) {
          return strings;
        }
      }
      return reject('must be a non-empty string or a non-empty list of strings');
    }

    case 'string-map':
      return isPlainObject(raw) && Object.values(raw).every((value) => typeof value === 'string')
        ? checkStructured(raw, field, context, diagnostics)
        : reject('must be a mapping from strings to strings');

    case 'map':
      return isPlainObject(raw)
        ? checkStructured(raw, field, context, diagnostics)
        : reject('must be a mapping');

    case 'list':
      return Array.isArray(raw)
        ? checkStructured(raw, field, context, diagnostics)
        : reject('must be a list');

    case 'map-list': {
      if (!Array.isArray(raw)) {
        return reject('must be a list of mappings');
      }
      const items: readonly unknown[] = raw;
      for (const [index, candidate] of items.entries()) {
        if (!isPlainObject(candidate)) {
          return reject('must be a list of mappings');
        }
        const item = candidate;
        for (const required of field.type.required ?? []) {
          if (!(required in item)) {
            return reject(`requires '${required}' in item ${String(index + 1)}`);
          }
        }
        for (const [name, expected] of Object.entries(field.type.fields ?? {})) {
          const value = item[name];
          if (value === undefined) {
            continue;
          }
          if (
            typeof value !== expected ||
            (expected === 'string' && typeof value === 'string' && value.trim().length === 0)
          ) {
            return reject(`requires '${name}' in item ${String(index + 1)} to be ${expected}`);
          }
        }
      }
      return checkStructured(items, field, context, diagnostics);
    }
  }
};

/**
 * Accepts an arbitrarily shaped value as long as every leaf can be written back
 * out. `null` is refused rather than rendered: no provider documents a null for
 * these fields, and emitting one would silently mean something different from
 * omitting the key.
 */
const checkStructured = (
  raw: unknown,
  field: OverrideField,
  context: ValidationContext,
  diagnostics: Diagnostic[],
): FrontmatterValue | undefined => {
  const walk = (value: unknown, path: string): FrontmatterValue | undefined => {
    if (typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : fail(path, 'is not a finite number');
    }
    if (Array.isArray(value)) {
      const items: FrontmatterValue[] = [];
      for (const [index, item] of value.entries()) {
        const checked = walk(item, `${path}[${String(index)}]`);
        if (checked === undefined) {
          return undefined;
        }
        items.push(checked);
      }
      return items;
    }
    if (isPlainObject(value)) {
      const result: Record<string, FrontmatterValue> = {};
      for (const [key, child] of Object.entries(value)) {
        const checked = walk(child, path.length === 0 ? key : `${path}.${key}`);
        if (checked === undefined) {
          return undefined;
        }
        result[key] = checked;
      }
      return result;
    }
    return fail(path, value === null ? 'is null; remove the key instead' : 'is not a YAML value');
  };

  const fail = (path: string, reason: string): undefined => {
    diagnostics.push(
      issue(
        context,
        'OVERRIDE_VALUE_INVALID',
        `'${field.name}${path.length === 0 ? '' : `.${path}`}' ${reason}.`,
      ),
    );
    return undefined;
  };

  return walk(raw, '');
};

const describe = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (isPlainObject(value)) return 'a mapping';
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
};

/** Turns validated options into ordered fields, in the schema's field order. */
export const orderedOptionFields = (
  schema: ProviderOverrideSchema,
  options: FrontmatterMap,
): readonly FrontmatterField[] => {
  const seen = new Set<string>();
  const fields: FrontmatterField[] = [];
  for (const field of schema.fields) {
    const head = field.name.split('.')[0];
    if (head === undefined || seen.has(head)) {
      continue;
    }
    const value = options[head];
    if (value !== undefined) {
      seen.add(head);
      fields.push([head, value]);
    }
  }

  // Keys the schema does not declare were accepted with a warning, so they have
  // to be emitted too — dropping them here would make the warning a lie and
  // silently discard a field the provider may well understand. Sorted so the
  // output stays deterministic whatever order the document used.
  const extra = Object.keys(options)
    .filter((key) => !seen.has(key))
    .sort(compareStrings);
  for (const key of extra) {
    const value = options[key];
    if (value !== undefined) {
      fields.push([key, value]);
    }
  }

  return fields;
};
