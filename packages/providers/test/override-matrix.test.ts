import { describe, expect, it } from 'vitest';

import type {
  AiConfiguration,
  Diagnostic,
  FrontmatterMap,
  FrontmatterValue,
  OverrideField,
  OverrideFieldType,
  ProviderAdapter,
  ProviderOverlay,
  ProviderOverrideSchema,
  SourceKind,
  ProviderId,
} from '@aiconfig/core';
import {
  OVERRIDE_SCHEMA_VERSION,
  compile,
  orderedOptionFields,
  overridePath,
  validateOverrideDocument,
} from '@aiconfig/core';

import { createDefaultAdapters } from '../src/index.js';
import {
  adapterFor,
  agent,
  command,
  configurationOf,
  instruction,
  skill,
} from './helpers/canonical.js';

/**
 * Every provider override, exercised field by field.
 *
 * The per-adapter override tests assert the interesting cases by hand, which
 * means a field added to a schema is covered only if someone remembers to write
 * a test for it. This file drives itself from the declarations instead: it
 * enumerates every schema, every field and every enum value the four adapters
 * declare, and checks each one accepts what it says it accepts, refuses what it
 * says it refuses, and actually reaches the generated file.
 *
 * The consequence is that a new field is covered the moment it is declared, and
 * a field declared with a type it cannot really carry fails here rather than in
 * a user's repository.
 */

const KINDS: readonly SourceKind[] = ['instruction', 'agent', 'skill', 'command'];

const adapters = createDefaultAdapters();
const PROVIDERS: readonly ProviderId[] = [...adapters.map((adapter) => adapter.id)].sort();

/**
 * Where an override is supported, from the table in `README.md` and
 * `docs/user-guide.md`. Written out rather than read from the adapters: the
 * point is that the two agree.
 */
const SUPPORTED: Readonly<Record<ProviderId, Readonly<Record<SourceKind, boolean>>>> = {
  claude: { instruction: false, agent: true, skill: true, command: true },
  codex: { instruction: false, agent: true, skill: true, command: false },
  copilot: { instruction: true, agent: true, skill: true, command: true },
  opencode: { instruction: false, agent: true, skill: false, command: true },
};

/** The canonical artifact each kind is tested against. */
const ARTIFACT_NAME: Readonly<Record<SourceKind, string>> = {
  instruction: 'backend',
  agent: 'reviewer',
  skill: 'code-review',
  command: 'fix-bug',
};

/** The generated file an override for this provider and kind lands in. */
const TARGET_FILE: Readonly<Record<ProviderId, Partial<Record<SourceKind, string>>>> = {
  claude: {
    agent: '.claude/agents/reviewer.md',
    skill: '.claude/skills/code-review/SKILL.md',
    command: '.claude/commands/fix-bug.md',
  },
  codex: {
    agent: '.codex/agents/reviewer.toml',
    skill: '.agents/skills/code-review/agents/openai.yaml',
  },
  copilot: {
    instruction: '.github/instructions/backend.instructions.md',
    agent: '.github/agents/reviewer.agent.md',
    skill: '.github/skills/code-review/SKILL.md',
    command: '.github/prompts/fix-bug.prompt.md',
  },
  opencode: {
    agent: '.opencode/agents/reviewer.md',
    command: '.opencode/commands/fix-bug.md',
  },
};

/** A configuration holding exactly the artifact an override attaches to. */
const configurationFor = (kind: SourceKind): AiConfiguration => {
  switch (kind) {
    // Scoped, because Copilot's instruction override is only representable on a
    // path-scoped instruction — an unscoped one is aggregated into a file with
    // no frontmatter.
    case 'instruction':
      return configurationOf({
        instructions: [instruction(ARTIFACT_NAME.instruction, ['src/**'])],
      });
    case 'agent':
      return configurationOf({ agents: [agent(ARTIFACT_NAME.agent)] });
    case 'skill':
      return configurationOf({ skills: [skill(ARTIFACT_NAME.skill)] });
    case 'command':
      return configurationOf({ commands: [command(ARTIFACT_NAME.command)] });
  }
};

const schemasOf = (adapter: ProviderAdapter): readonly ProviderOverrideSchema[] =>
  adapter.overrides ?? [];

const schemaFor = (provider: ProviderId, kind: SourceKind): ProviderOverrideSchema | undefined =>
  schemasOf(adapterFor(provider)).find((candidate) => candidate.kind === kind);

/** A value the field must accept. */
const validValue = (type: OverrideFieldType): FrontmatterValue => {
  switch (type.kind) {
    case 'string':
      return 'sample value';
    case 'boolean':
      return true;
    case 'number': {
      const base = type.min ?? type.max ?? 1;
      return type.integer === true ? Math.ceil(base) : base;
    }
    case 'enum':
      return type.values[0]!;
    case 'enum-or-map':
      return type.values[0]!;
    case 'string-list':
      return ['first'];
    case 'string-or-string-list':
      return ['first', 'second'];
    case 'map':
      return { sample: 'value' };
    case 'string-map':
      return { sample: 'value' };
    case 'list':
      return ['item'];
    case 'map-list':
      return [
        Object.fromEntries(
          (type.required ?? ['sample']).map((name) => [
            name,
            type.fields?.[name] === 'boolean' ? true : 'value',
          ]),
        ),
      ];
  }
};

/** A value of a shape the field cannot carry, which must be refused. */
const invalidValue = (type: OverrideFieldType): unknown => {
  switch (type.kind) {
    case 'string':
      return 42;
    case 'boolean':
      return 'true';
    case 'number':
      return 'ten';
    // An unrecognized enum *string* is written through with a warning; a
    // non-string is refused outright.
    case 'enum':
      return 42;
    case 'enum-or-map':
      return 42;
    case 'string-list':
      return 42;
    case 'string-or-string-list':
      return [42];
    case 'map':
      return ['not a mapping'];
    case 'string-map':
      return { not: 42 };
    case 'list':
      return { not: 'a list' };
    case 'map-list':
      return ['not a mapping'];
  }
};

/** Builds a nested document from a possibly dotted field name. */
const nest = (name: string, value: unknown): Record<string, unknown> => {
  const segments = name.split('.');
  return segments.reduceRight<Record<string, unknown>>(
    (accumulator, segment, index) =>
      index === segments.length - 1 ? { [segment]: value } : { [segment]: accumulator },
    {},
  );
};

const merge = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> => {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing) &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      merge(existing as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }
    target[key] = value;
  }
  return target;
};

const documentOf = (options: Record<string, unknown>): unknown => ({
  schema: OVERRIDE_SCHEMA_VERSION,
  options,
});

const validate = (
  provider: ProviderId,
  schema: ProviderOverrideSchema,
  options: Record<string, unknown>,
) =>
  validateOverrideDocument(documentOf(options), schema, {
    provider,
    sourcePath: overridePath(provider, schema.kind, ARTIFACT_NAME[schema.kind]),
  });

const errors = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  diagnostics.filter((diagnostic) => diagnostic.severity === 'error');

const codes = (diagnostics: readonly Diagnostic[]): readonly string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

const isMap = (value: FrontmatterValue | undefined): value is FrontmatterMap =>
  typeof value === 'object' && !Array.isArray(value);

const isList = (value: FrontmatterValue): value is readonly FrontmatterValue[] =>
  Array.isArray(value);

/** Reads a possibly nested option back out of the validated result. */
const readOption = (
  options: FrontmatterMap | undefined,
  name: string,
): FrontmatterValue | undefined => {
  let current: FrontmatterValue | undefined = options;
  for (const segment of name.split('.')) {
    if (!isMap(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

describe('override support matrix', () => {
  for (const provider of PROVIDERS) {
    for (const kind of KINDS) {
      const supported = SUPPORTED[provider][kind];

      it(`${provider} ${supported ? 'declares' : 'declares no'} ${kind} override schema`, () => {
        expect(schemaFor(provider, kind) !== undefined).toBe(supported);
      });
    }
  }

  it('declares each kind at most once per provider', () => {
    for (const adapter of adapters) {
      const declared = schemasOf(adapter).map((schema) => schema.kind);
      expect(new Set(declared).size, adapter.id).toBe(declared.length);
    }
  });

  it('gives every declared field a unique name, a description and a documentation link', () => {
    for (const adapter of adapters) {
      for (const schema of schemasOf(adapter)) {
        const names = schema.fields.map((field) => field.name);
        expect(new Set(names).size, `${adapter.id} ${schema.kind}`).toBe(names.length);

        for (const field of schema.fields) {
          const where = `${adapter.id} ${schema.kind} ${field.name}`;
          expect(field.description.length, where).toBeGreaterThan(0);
          expect(field.documentation.startsWith('https://'), where).toBe(true);
          // A field the canonical artifact owns cannot also be a provider
          // setting; declaring both would make the same key mean two things.
          expect(schema.reserved, where).not.toContain(field.name);
        }
      }
    }
  });
});

describe('override fields: every declared field, on every schema', () => {
  for (const provider of PROVIDERS) {
    for (const schema of schemasOf(adapterFor(provider))) {
      for (const field of schema.fields) {
        const where = `${provider} ${schema.kind} ${field.name}`;

        it(`accepts a well-typed value: ${where}`, () => {
          const result = validate(provider, schema, nest(field.name, validValue(field.type)));

          expect(errors(result.diagnostics), where).toEqual([]);
          expect(readOption(result.options, field.name), where).toEqual(validValue(field.type));
        });

        it(`refuses a value of the wrong shape: ${where}`, () => {
          const result = validate(provider, schema, nest(field.name, invalidValue(field.type)));

          expect(codes(result.diagnostics), where).toContain('OVERRIDE_VALUE_INVALID');
          // Nothing partial is compiled: one bad value invalidates the document
          // rather than silently dropping the field.
          expect(result.options, where).toBeUndefined();
        });
      }
    }
  }
});

describe('override fields: enumerations', () => {
  const enumFields = (): readonly {
    provider: ProviderId;
    schema: ProviderOverrideSchema;
    field: OverrideField;
    values: readonly string[];
  }[] =>
    PROVIDERS.flatMap((provider) =>
      schemasOf(adapterFor(provider)).flatMap((schema) =>
        schema.fields
          .filter((field) => field.type.kind === 'enum')
          .map((field) => ({
            provider,
            schema,
            field,
            values: field.type.kind === 'enum' ? field.type.values : [],
          })),
      ),
    );

  it('accepts every value it declares, on every enumeration', () => {
    for (const { provider, schema, field, values } of enumFields()) {
      expect(values.length, `${provider} ${schema.kind} ${field.name}`).toBeGreaterThan(0);

      for (const value of values) {
        const result = validate(provider, schema, nest(field.name, value));
        const where = `${provider} ${schema.kind} ${field.name}=${value}`;

        expect(result.diagnostics, where).toEqual([]);
        expect(readOption(result.options, field.name), where).toBe(value);
      }
    }
  });

  it('warns about a value it does not know but still writes it through', () => {
    // A provider can add an accepted value between AI Config releases. The
    // value has to reach the file, or the new value would be unusable until AI
    // Config ships.
    for (const { provider, schema, field } of enumFields()) {
      const result = validate(provider, schema, nest(field.name, 'a-value-from-a-later-release'));
      const where = `${provider} ${schema.kind} ${field.name}`;

      expect(codes(result.diagnostics), where).toEqual(['OVERRIDE_UNRECOGNIZED_VALUE']);
      expect(result.diagnostics[0]?.severity, where).toBe('warning');
      expect(readOption(result.options, field.name), where).toBe('a-value-from-a-later-release');
    }
  });

  it('declares unique, non-empty values', () => {
    for (const { provider, schema, field, values } of enumFields()) {
      const where = `${provider} ${schema.kind} ${field.name}`;
      expect(new Set(values).size, where).toBe(values.length);
      expect(
        values.every((value) => value.length > 0 && value.trim() === value),
        where,
      ).toBe(true);
    }
  });
});

describe('override fields: numeric ranges', () => {
  const numberFields = () =>
    PROVIDERS.flatMap((provider) =>
      schemasOf(adapterFor(provider)).flatMap((schema) =>
        schema.fields
          .filter((field) => field.type.kind === 'number')
          .map((field) => ({ provider, schema, field })),
      ),
    );

  it('accepts the declared bounds and refuses everything outside them', () => {
    for (const { provider, schema, field } of numberFields()) {
      if (field.type.kind !== 'number') {
        continue;
      }
      const { min, max, integer } = field.type;
      const where = `${provider} ${schema.kind} ${field.name}`;

      if (min !== undefined) {
        expect(
          errors(validate(provider, schema, nest(field.name, min)).diagnostics),
          where,
        ).toEqual([]);
        expect(
          codes(validate(provider, schema, nest(field.name, min - 1)).diagnostics),
          `${where} below minimum`,
        ).toContain('OVERRIDE_VALUE_INVALID');
      }

      if (max !== undefined) {
        expect(
          errors(validate(provider, schema, nest(field.name, max)).diagnostics),
          where,
        ).toEqual([]);
        expect(
          codes(validate(provider, schema, nest(field.name, max + 1)).diagnostics),
          `${where} above maximum`,
        ).toContain('OVERRIDE_VALUE_INVALID');
      }

      if (integer === true) {
        const fractional = (min ?? 0) + 0.5;
        if (max === undefined || fractional <= max) {
          expect(
            codes(validate(provider, schema, nest(field.name, fractional)).diagnostics),
            `${where} fractional`,
          ).toContain('OVERRIDE_VALUE_INVALID');
        }
      }
    }
  });
});

describe('override fields: lists and strings', () => {
  it('accepts either form wherever a string-or-string-list is declared', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        for (const field of schema.fields.filter(
          (entry) => entry.type.kind === 'string-or-string-list',
        )) {
          for (const value of ['one', ['one', 'two']]) {
            const result = validate(provider, schema, nest(field.name, value));
            const where = `${provider} ${schema.kind} ${field.name}`;
            expect(errors(result.diagnostics), where).toEqual([]);
            expect(readOption(result.options, field.name), where).toEqual(value);
          }
        }
      }
    }
  });

  it('refuses an empty string list rather than emitting an empty key', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        for (const field of schema.fields.filter((entry) => entry.type.kind === 'string-list')) {
          const result = validate(provider, schema, nest(field.name, []));
          expect(codes(result.diagnostics), `${provider} ${schema.kind} ${field.name}`).toContain(
            'OVERRIDE_VALUE_INVALID',
          );
        }
      }
    }
  });

  it('accepts a lone string wherever a string list is declared', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        for (const field of schema.fields.filter((entry) => entry.type.kind === 'string-list')) {
          const result = validate(provider, schema, nest(field.name, 'only-one'));
          const where = `${provider} ${schema.kind} ${field.name}`;

          expect(errors(result.diagnostics), where).toEqual([]);
          expect(readOption(result.options, field.name), where).toEqual(['only-one']);
        }
      }
    }
  });

  it('refuses a blank string wherever a string is declared', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        for (const field of schema.fields.filter((entry) => entry.type.kind === 'string')) {
          const result = validate(provider, schema, nest(field.name, '   '));
          expect(codes(result.diagnostics), `${provider} ${schema.kind} ${field.name}`).toContain(
            'OVERRIDE_VALUE_INVALID',
          );
        }
      }
    }
  });
});

describe('override fields: scalar or mapping unions', () => {
  it('accepts both documented forms of every enum-or-map field', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        for (const field of schema.fields.filter((entry) => entry.type.kind === 'enum-or-map')) {
          if (field.type.kind !== 'enum-or-map') {
            continue;
          }
          for (const value of [field.type.values[0]!, { granular: { rules: true } }]) {
            const result = validate(provider, schema, nest(field.name, value));
            const where = `${provider} ${schema.kind} ${field.name}`;
            expect(errors(result.diagnostics), where).toEqual([]);
            expect(readOption(result.options, field.name), where).toEqual(value);
          }
        }
      }
    }
  });
});

describe('override fields: structured mapping lists', () => {
  it('validates documented nested property types while leaving open lists open', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        for (const field of schema.fields.filter((entry) => entry.type.kind === 'map-list')) {
          if (field.type.kind !== 'map-list' || field.type.fields === undefined) {
            continue;
          }
          const [name, expected] = Object.entries(field.type.fields)[0] ?? [];
          if (name === undefined || expected === undefined) {
            continue;
          }
          const valid = validValue(field.type);
          if (!isList(valid) || !isMap(valid[0])) {
            throw new Error(`Invalid test value for ${provider} ${schema.kind} ${field.name}`);
          }
          const invalidItem = {
            ...valid[0],
            [name]: expected === 'string' ? false : 'false',
          };
          const result = validate(provider, schema, nest(field.name, [invalidItem]));

          expect(codes(result.diagnostics), `${provider} ${schema.kind} ${field.name}`).toContain(
            'OVERRIDE_VALUE_INVALID',
          );
          expect(result.options).toBeUndefined();
        }
      }
    }
  });
});

describe('override fields: canonical and unknown keys', () => {
  it('refuses every key the canonical artifact owns, on every schema', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        expect(schema.reserved.length, `${provider} ${schema.kind}`).toBeGreaterThan(0);

        for (const key of schema.reserved) {
          const result = validate(provider, schema, { [key]: 'a value' });
          const where = `${provider} ${schema.kind} ${key}`;

          expect(codes(result.diagnostics), where).toContain('OVERRIDE_CANONICAL_FIELD');
          expect(result.options, where).toBeUndefined();
        }
      }
    }
  });

  it('refuses every field a provider has retired, on every schema', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        for (const retired of schema.deprecated ?? []) {
          const result = validate(provider, schema, nest(retired.name, 'a value'));
          const where = `${provider} ${schema.kind} ${retired.name}`;

          expect(codes(result.diagnostics), where).toContain('OVERRIDE_UNKNOWN_FIELD');
          expect(result.diagnostics[0]?.message, where).toContain(retired.reason);
          expect(result.options, where).toBeUndefined();
        }
      }
    }
  });

  it('warns about a field it does not know but still writes it through', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        const result = validate(provider, schema, { 'a-field-from-a-later-release': 'value' });
        const where = `${provider} ${schema.kind}`;

        expect(codes(result.diagnostics), where).toEqual(['OVERRIDE_UNRECOGNIZED_FIELD']);
        expect(result.options?.['a-field-from-a-later-release'], where).toBe('value');
      }
    }
  });
});

describe('override envelope, on every schema', () => {
  it('requires the declared schema version', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        const result = validateOverrideDocument({ schema: 2, options: {} }, schema, {
          provider,
          sourcePath: overridePath(provider, schema.kind, ARTIFACT_NAME[schema.kind]),
        });
        expect(codes(result.diagnostics), `${provider} ${schema.kind}`).toContain(
          'OVERRIDE_INVALID',
        );
      }
    }
  });

  it('refuses any key beyond schema and options', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        const result = validateOverrideDocument(
          { schema: OVERRIDE_SCHEMA_VERSION, options: {}, provider: 'claude' },
          schema,
          {
            provider,
            sourcePath: overridePath(provider, schema.kind, ARTIFACT_NAME[schema.kind]),
          },
        );
        expect(codes(result.diagnostics), `${provider} ${schema.kind}`).toContain(
          'OVERRIDE_INVALID',
        );
      }
    }
  });

  it('reports an override with nothing set as inert rather than invalid', () => {
    // This is the state a freshly scaffolded template is in. Creating one must
    // never make a project fail to synchronize.
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        const result = validate(provider, schema, {});
        const where = `${provider} ${schema.kind}`;

        expect(codes(result.diagnostics), where).toEqual(['OVERRIDE_EMPTY']);
        expect(result.diagnostics[0]?.severity, where).toBe('info');
        expect(result.options, where).toEqual({});
      }
    }
  });
});

describe('override fields: ordering', () => {
  it('emits fields in the declared order whatever order the document uses', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        const reversed: Record<string, unknown> = {};
        for (const field of [...schema.fields].reverse()) {
          merge(reversed, nest(field.name, validValue(field.type)));
        }

        const result = validate(provider, schema, reversed);
        const where = `${provider} ${schema.kind}`;

        expect(errors(result.diagnostics), where).toEqual([]);
        expect(result.options, where).toBeDefined();

        const emitted = orderedOptionFields(schema, result.options!).map(([key]) => key);
        const declared = [...new Set(schema.fields.map((field) => field.name.split('.')[0]!))];

        // Output order is the schema's, not the document's, so two projects
        // that set the same options generate the same bytes.
        expect(emitted, where).toEqual(declared);
      }
    }
  });
});

describe('override fields: reaching the generated file', () => {
  /**
   * Whether a key opens a line of the generated file: `key:` in YAML
   * frontmatter, `key = ` or a `[key…]` table header in TOML.
   *
   * Prefix comparison rather than a regular expression, because provider field
   * names contain characters — `.` and `-` — that a pattern would have to
   * escape, and getting that wrong makes the check silently weaker.
   */
  const mentions = (text: string, key: string): boolean =>
    text
      .split('\n')
      .some(
        (line) =>
          line.startsWith(`${key}:`) ||
          line.startsWith(`${key} =`) ||
          line.startsWith(`[${key}]`) ||
          line.startsWith(`[${key}.`),
      );

  /** Every declared field of a schema, set to a value it accepts. */
  const everyField = (
    provider: ProviderId,
    schema: ProviderOverrideSchema,
  ): ReadonlyMap<ProviderId, ProviderOverlay> => {
    const options: Record<string, unknown> = {};
    for (const field of schema.fields) {
      merge(options, nest(field.name, validValue(field.type)));
    }

    const validation = validate(provider, schema, options);
    expect(errors(validation.diagnostics), `${provider} ${schema.kind}`).toEqual([]);

    return new Map([
      [
        provider,
        {
          provider,
          extensions: [],
          orphanedOverrides: [],
          overrides: [
            {
              kind: schema.kind,
              id: ARTIFACT_NAME[schema.kind],
              options: validation.options!,
              sourcePath: overridePath(provider, schema.kind, ARTIFACT_NAME[schema.kind]),
            },
          ],
        },
      ],
    ]);
  };

  for (const provider of PROVIDERS) {
    for (const schema of schemasOf(adapterFor(provider))) {
      it(`writes every declared field into the generated file: ${provider} ${schema.kind}`, () => {
        const result = compile(
          configurationFor(schema.kind),
          [adapterFor(provider)],
          everyField(provider, schema),
        );

        expect(errors(result.diagnostics)).toEqual([]);

        const targetPath = TARGET_FILE[provider][schema.kind];
        expect(targetPath, `no target declared for ${provider} ${schema.kind}`).toBeDefined();

        const target = result.artifacts.find((artifact) => artifact.path === targetPath);
        expect(
          target,
          `${provider} ${schema.kind}: ${targetPath!} was not generated`,
        ).toBeDefined();
        expect(target!.content.kind).toBe('text');

        const text = target!.content.kind === 'text' ? target!.content.value : '';
        for (const field of schema.fields) {
          const head = field.name.split('.')[0]!;
          expect(mentions(text, head), `${provider} ${schema.kind}: ${head} missing`).toBe(true);
        }
      });

      it(`changes nothing outside the artifact it targets: ${provider} ${schema.kind}`, () => {
        const configuration = configurationFor(schema.kind);
        const withoutOverride = compile(configuration, [adapterFor(provider)]);
        const withOverride = compile(
          configuration,
          [adapterFor(provider)],
          everyField(provider, schema),
        );

        const targetPath = TARGET_FILE[provider][schema.kind]!;
        const before = new Map(
          withoutOverride.artifacts.map((artifact) => [artifact.path, artifact.hash]),
        );

        for (const artifact of withOverride.artifacts) {
          if (artifact.path === targetPath) {
            continue;
          }
          // An override refines one artifact for one provider. Nothing else it
          // generates may move or change.
          expect(before.get(artifact.path), `${provider} ${schema.kind}: ${artifact.path}`).toBe(
            artifact.hash,
          );
        }
      });
    }
  }
});

describe('override availability per artifact', () => {
  it('refuses a Copilot instruction override on an unscoped instruction only', () => {
    const schema = schemaFor('copilot', 'instruction')!;

    expect(
      schema.unavailableReason?.({ kind: 'instruction', name: 'general', applyTo: [] }),
    ).toBeTypeOf('string');
    expect(
      schema.unavailableReason?.({ kind: 'instruction', name: 'backend', applyTo: ['src/**'] }),
    ).toBeUndefined();
  });

  it('leaves every other declared schema unconditionally available', () => {
    for (const provider of PROVIDERS) {
      for (const schema of schemasOf(adapterFor(provider))) {
        if (provider === 'copilot' && schema.kind === 'instruction') {
          continue;
        }
        const target = {
          kind: schema.kind,
          name: ARTIFACT_NAME[schema.kind],
          applyTo: schema.kind === 'instruction' ? ['src/**'] : [],
        };
        expect(schema.unavailableReason?.(target), `${provider} ${schema.kind}`).toBeUndefined();
      }
    }
  });

  it('states the override path for every supported provider and kind', () => {
    for (const provider of PROVIDERS) {
      for (const kind of KINDS) {
        if (!SUPPORTED[provider][kind]) {
          continue;
        }
        expect(overridePath(provider, kind, ARTIFACT_NAME[kind])).toBe(
          `.ai/providers/${provider}/${kind === 'instruction' ? 'instructions' : `${kind}s`}/${ARTIFACT_NAME[kind]}.yaml`,
        );
      }
    }
  });
});
