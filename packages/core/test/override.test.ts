import { describe, expect, it } from 'vitest';

import type { ProviderOverrideSchema } from '../src/adapter/override.js';
import {
  OVERRIDE_SCHEMA_VERSION,
  orderedOptionFields,
  overridePath,
  overrideTargets,
  validateOverrideDocument,
} from '../src/adapter/override.js';
import type { AiConfiguration } from '../src/domain/configuration.js';

const CONTEXT = { provider: 'claude' as const, sourcePath: '.ai/providers/claude/agents/x.yaml' };

const SCHEMA: ProviderOverrideSchema = {
  kind: 'agent',
  reserved: ['name', 'description', 'prompt'],
  deprecated: [{ name: 'legacy', reason: 'It was replaced by permission.' }],
  fields: [
    {
      name: 'model',
      type: { kind: 'string' },
      description: 'Model.',
      documentation: 'https://example.invalid',
    },
    {
      name: 'effort',
      type: { kind: 'enum', values: ['low', 'high'] },
      description: 'Effort.',
      documentation: 'https://example.invalid',
    },
    {
      name: 'maxTurns',
      type: { kind: 'number', min: 1, max: 10, integer: true },
      description: 'Turns.',
      documentation: 'https://example.invalid',
    },
    {
      name: 'background',
      type: { kind: 'boolean' },
      description: 'Background.',
      documentation: 'https://example.invalid',
    },
    {
      name: 'tools',
      type: { kind: 'string-list' },
      description: 'Tools.',
      documentation: 'https://example.invalid',
    },
    {
      name: 'hooks',
      type: { kind: 'map' },
      description: 'Hooks.',
      documentation: 'https://example.invalid',
    },
    {
      name: 'nested.leaf',
      type: { kind: 'boolean' },
      description: 'Nested.',
      documentation: 'https://example.invalid',
    },
  ],
};

const validate = (options: unknown, schema: ProviderOverrideSchema = SCHEMA) =>
  validateOverrideDocument({ schema: OVERRIDE_SCHEMA_VERSION, options }, schema, CONTEXT);

const codes = (result: ReturnType<typeof validate>): readonly string[] =>
  result.diagnostics.map((diagnostic) => diagnostic.code);

describe('override envelope', () => {
  it('accepts a well-formed document', () => {
    const result = validate({ model: 'sonnet', effort: 'high', maxTurns: 4, background: true });
    expect(result.diagnostics).toEqual([]);
    expect(result.options).toEqual({
      model: 'sonnet',
      effort: 'high',
      maxTurns: 4,
      background: true,
    });
  });

  it('rejects a document that is not a mapping', () => {
    const result = validateOverrideDocument('nope', SCHEMA, CONTEXT);
    expect(codes(result)).toEqual(['OVERRIDE_INVALID']);
  });

  it('requires the declared schema version', () => {
    const result = validateOverrideDocument({ schema: 2, options: {} }, SCHEMA, CONTEXT);
    expect(codes(result)).toContain('OVERRIDE_INVALID');
  });

  it('rejects keys outside schema and options', () => {
    const result = validateOverrideDocument(
      { schema: 1, provider: 'claude', options: {} },
      SCHEMA,
      CONTEXT,
    );
    expect(result.diagnostics[0]?.message).toContain("Unknown key 'provider'");
  });

  it('requires options to be a mapping when it is present', () => {
    expect(codes(validate([1, 2]))).toEqual(['OVERRIDE_INVALID']);
  });

  it('reports an override with nothing set without making it invalid', () => {
    // The state a freshly scaffolded template is in: every setting is still
    // commented out, so `options` parses as empty.
    for (const document of [
      { schema: 1 },
      { schema: 1, options: null },
      { schema: 1, options: {} },
    ]) {
      const result = validateOverrideDocument(document, SCHEMA, CONTEXT);
      expect(codes(result)).toEqual(['OVERRIDE_EMPTY']);
      expect(result.diagnostics[0]?.severity).toBe('info');
      expect(result.options).toEqual({});
    }
  });
});

describe('override fields', () => {
  it('warns about an unrecognized field and names the ones it knows', () => {
    const result = validate({ nonsense: 1 });
    expect(codes(result)).toEqual(['OVERRIDE_UNRECOGNIZED_FIELD']);
    expect(result.diagnostics[0]?.severity).toBe('warning');
    expect(result.diagnostics[0]?.message).toContain('model, effort');
  });

  it('writes an unrecognized field through so a new provider field still reaches the output', () => {
    const result = validate({ model: 'sonnet', reasoningMode: 'deep' });
    expect(result.options).toEqual({ model: 'sonnet', reasoningMode: 'deep' });
  });

  it('writes an unrecognized list or mapping through unchanged', () => {
    const result = validate({ future: { nested: [1, 'two', true] } });
    expect(result.options).toEqual({ future: { nested: [1, 'two', true] } });
  });

  it('refuses a value frontmatter cannot represent rather than writing it through', () => {
    const result = validate({ whenever: new Date(0) });
    expect(codes(result)).toEqual(['OVERRIDE_VALUE_INVALID']);
    expect(result.options).toBeUndefined();
  });

  it('rejects a canonical field rather than treating it as unknown', () => {
    for (const key of ['name', 'description', 'prompt']) {
      const result = validate({ [key]: 'x' });
      expect(codes(result)).toEqual(['OVERRIDE_CANONICAL_FIELD']);
      expect(result.diagnostics[0]?.message).toContain('Edit the canonical file instead.');
    }
  });

  it('explains a field the provider deprecated', () => {
    const result = validate({ legacy: true });
    expect(codes(result)).toEqual(['OVERRIDE_UNKNOWN_FIELD']);
    expect(result.diagnostics[0]?.message).toContain('It was replaced by permission.');
  });

  it('warns about an unrecognized enum value and writes it through', () => {
    const result = validate({ effort: 'extreme' });
    expect(codes(result)).toEqual(['OVERRIDE_UNRECOGNIZED_VALUE']);
    expect(result.diagnostics[0]?.severity).toBe('warning');
    expect(result.diagnostics[0]?.message).toContain('Known values: low, high');
    expect(result.options).toEqual({ effort: 'extreme' });
  });

  it('still rejects an enum value that is not a string at all', () => {
    const result = validate({ effort: 3 });
    expect(codes(result)).toEqual(['OVERRIDE_VALUE_INVALID']);
    expect(result.options).toBeUndefined();
  });

  it('enforces numeric type, range and integrality', () => {
    expect(codes(validate({ maxTurns: 'four' }))).toEqual(['OVERRIDE_VALUE_INVALID']);
    expect(codes(validate({ maxTurns: 0 }))).toEqual(['OVERRIDE_VALUE_INVALID']);
    expect(codes(validate({ maxTurns: 11 }))).toEqual(['OVERRIDE_VALUE_INVALID']);
    expect(codes(validate({ maxTurns: 1.5 }))).toEqual(['OVERRIDE_VALUE_INVALID']);
    expect(validate({ maxTurns: 10 }).options).toEqual({ maxTurns: 10 });
  });

  it('enforces boolean type', () => {
    expect(codes(validate({ background: 'true' }))).toEqual(['OVERRIDE_VALUE_INVALID']);
  });

  it('accepts a lone string for a string list and rejects an empty one', () => {
    expect(validate({ tools: 'Read' }).options).toEqual({ tools: ['Read'] });
    expect(codes(validate({ tools: [] }))).toEqual(['OVERRIDE_VALUE_INVALID']);
    expect(codes(validate({ tools: [1] }))).toEqual(['OVERRIDE_VALUE_INVALID']);
  });

  it('accepts an arbitrarily shaped structured field but refuses null leaves', () => {
    const hooks = { PreToolUse: [{ matcher: 'Bash', command: 'echo hi' }] };
    expect(validate({ hooks }).options).toEqual({ hooks });
    expect(codes(validate({ hooks: { PreToolUse: null } }))).toEqual(['OVERRIDE_VALUE_INVALID']);
    expect(codes(validate({ hooks: 'no' }))).toEqual(['OVERRIDE_VALUE_INVALID']);
  });

  it('addresses a nested field by path and keeps the document nested', () => {
    expect(validate({ nested: { leaf: true } }).options).toEqual({ nested: { leaf: true } });
  });

  it('reports an unrecognized key inside a recognized nested field by its full path', () => {
    const result = validate({ nested: { other: true } });
    expect(codes(result)).toEqual(['OVERRIDE_UNRECOGNIZED_FIELD']);
    expect(result.diagnostics[0]?.message).toContain("'nested.other'");
    expect(result.options).toEqual({ nested: { other: true } });
  });

  it('produces no options when anything failed, so nothing partial is compiled', () => {
    const result = validate({ model: 'sonnet', effort: 3 });
    expect(result.options).toBeUndefined();
  });
});

describe('override ordering and paths', () => {
  it('emits an unrecognized field too, after the declared ones and in a stable order', () => {
    // Regression: validation accepted these with a warning but the emitter
    // dropped them, so the field never reached the generated file.
    const result = validate({ model: 'opus', zeta: 1, alpha: 'x' });
    expect(orderedOptionFields(SCHEMA, result.options ?? {}).map(([key]) => key)).toEqual([
      'model',
      'alpha',
      'zeta',
    ]);
  });

  it('emits fields in the schema order regardless of document order', () => {
    const result = validate({ background: true, model: 'opus', effort: 'low' });
    expect(orderedOptionFields(SCHEMA, result.options ?? {}).map(([key]) => key)).toEqual([
      'model',
      'effort',
      'background',
    ]);
  });

  it('maps every kind onto its canonical directory', () => {
    expect(overridePath('claude', 'instruction', 'a')).toBe(
      '.ai/providers/claude/instructions/a.yaml',
    );
    expect(overridePath('codex', 'agent', 'a')).toBe('.ai/providers/codex/agents/a.yaml');
    expect(overridePath('copilot', 'skill', 'a')).toBe('.ai/providers/copilot/skills/a.yaml');
    expect(overridePath('opencode', 'command', 'a')).toBe('.ai/providers/opencode/commands/a.yaml');
  });

  it('exposes applyTo only for instructions, which is what scoping depends on', () => {
    const configuration: AiConfiguration = {
      instructions: [
        {
          name: 'scoped',
          description: undefined,
          applyTo: ['src/**'],
          body: 'x',
          sourcePath: '.ai/instructions/scoped.md',
        },
      ],
      agents: [{ name: 'a', description: 'd', body: 'b', sourcePath: '.ai/agents/a.md' }],
      skills: [],
      commands: [],
    };
    const targets = overrideTargets(configuration);
    expect(targets.find((t) => t.kind === 'instruction')?.applyTo).toEqual(['src/**']);
    expect(targets.find((t) => t.kind === 'agent')?.applyTo).toEqual([]);
  });
});
