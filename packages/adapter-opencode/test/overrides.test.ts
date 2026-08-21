import { describe, expect, it } from 'vitest';

import type { AiConfiguration, ProviderOverlay, SourceKind } from '@aiconfig/core';
import { validateOverrideDocument } from '@aiconfig/core';

import { opencodeAdapter } from '../src/index.js';
import { OPENCODE_AGENT_OVERRIDE } from '../src/overrides.js';

const CONFIGURATION: AiConfiguration = {
  instructions: [],
  agents: [
    {
      name: 'coder',
      description: 'Writes code',
      body: 'Be careful.',
      sourcePath: '.ai/agents/coder.md',
    },
  ],
  skills: [],
  commands: [
    { name: 'ship', description: 'Ships it', body: 'Ship it.', sourcePath: '.ai/commands/ship.md' },
  ],
};

const overlay = (
  kind: SourceKind,
  id: string,
  options: Record<string, unknown>,
): ProviderOverlay => ({
  provider: 'opencode',
  extensions: [],
  orphanedOverrides: [],
  overrides: [
    {
      kind,
      id,
      options: options as ProviderOverlay['overrides'][number]['options'],
      sourcePath: `.ai/providers/opencode/${kind}s/${id}.yaml`,
    },
  ],
});

const fileAt = (path: string, result: ReturnType<typeof opencodeAdapter.compile>): string => {
  const file = result.files.find((candidate) => candidate.path === path);
  if (file?.content.kind !== 'text') {
    throw new Error(`No generated text at ${path}`);
  }
  return file.content.value;
};

describe('OpenCode agent overrides', () => {
  it('uses the field names the current documentation gives', () => {
    const result = opencodeAdapter.compile(
      CONFIGURATION,
      overlay('agent', 'coder', { top_p: 0.9, steps: 20, temperature: 0.1 }),
    );

    const value = fileAt('.opencode/agents/coder.md', result);
    expect(value).toContain('top_p: 0.9');
    expect(value).toContain('steps: 20');
    // The deprecated spellings must not appear in generated output.
    expect(value).not.toContain('topP');
    expect(value).not.toContain('maxSteps');
  });

  it('renders the permission map as block YAML', () => {
    const result = opencodeAdapter.compile(
      CONFIGURATION,
      overlay('agent', 'coder', { permission: { edit: 'deny', bash: { '*': 'ask' } } }),
    );

    expect(fileAt('.opencode/agents/coder.md', result)).toContain(
      ['permission:', '  edit: deny', '  bash:', '    "*": ask'].join('\n'),
    );
  });

  it('emits mode: subagent by default and lets an override replace it', () => {
    expect(fileAt('.opencode/agents/coder.md', opencodeAdapter.compile(CONFIGURATION))).toContain(
      'mode: subagent',
    );

    const overridden = fileAt(
      '.opencode/agents/coder.md',
      opencodeAdapter.compile(CONFIGURATION, overlay('agent', 'coder', { mode: 'primary' })),
    );
    expect(overridden).toContain('mode: primary');
    expect(overridden).not.toContain('mode: subagent');
  });

  it('never emits a name field, which OpenCode takes from the filename', () => {
    const result = opencodeAdapter.compile(
      CONFIGURATION,
      overlay('agent', 'coder', { model: 'anthropic/claude-sonnet-4-20250514' }),
    );
    expect(fileAt('.opencode/agents/coder.md', result)).not.toContain('name:');
  });
});

describe('OpenCode command overrides', () => {
  it('adds agent, model and subtask after the canonical description', () => {
    const result = opencodeAdapter.compile(
      CONFIGURATION,
      overlay('command', 'ship', { agent: 'build', subtask: true }),
    );

    expect(fileAt('.opencode/commands/ship.md', result)).toBe(
      [
        '---',
        'description: Ships it',
        'agent: build',
        'subtask: true',
        '---',
        '',
        'Ship it.',
        '',
      ].join('\n'),
    );
  });
});

describe('OpenCode override schemas', () => {
  it('declares agent and command schemas only', () => {
    expect(opencodeAdapter.overrides?.map((schema) => schema.kind).sort()).toEqual([
      'agent',
      'command',
    ]);
  });

  it('records tools as deprecated rather than accepting it', () => {
    const agent = opencodeAdapter.overrides?.find((schema) => schema.kind === 'agent');
    expect(agent?.fields.some((field) => field.name === 'tools')).toBe(false);
    expect(agent?.deprecated?.map((entry) => entry.name)).toEqual(['tools']);
  });

  it('offers a shorthand form for permission so a guided flow can prompt for it', () => {
    const agent = opencodeAdapter.overrides?.find((schema) => schema.kind === 'agent');
    const permission = agent?.fields.find((field) => field.name === 'permission');
    expect(permission?.type.kind === 'map' && permission.type.shorthand?.values).toEqual([
      'allow',
      'ask',
      'deny',
    ]);
  });

  it('constrains temperature and top_p to the documented range', () => {
    const agent = opencodeAdapter.overrides?.find((schema) => schema.kind === 'agent');
    for (const name of ['temperature', 'top_p']) {
      const field = agent?.fields.find((candidate) => candidate.name === name);
      expect(field?.type).toMatchObject({ kind: 'number', min: 0, max: 1 });
    }
  });

  it('documents every field with a first-party source', () => {
    for (const schema of opencodeAdapter.overrides ?? []) {
      for (const field of schema.fields) {
        expect(field.documentation).toMatch(/^https:\/\/opencode\.ai\/docs\//);
      }
    }
  });
});

/**
 * OpenCode documents an open agent configuration: an option it does not define
 * is passed through to the model provider as a model option.
 *
 * So AI Config cannot claim such an option is wrong — but it cannot claim it is
 * right either, because a typo looks exactly the same from here. It says the one
 * thing it knows, that nothing checked the option, and says it as a note rather
 * than a warning. Reporting it as a warning told authors that correct,
 * documented configuration was a mistake, on every single run.
 */
describe('OpenCode agent model options', () => {
  const validate = (options: Record<string, unknown>) =>
    validateOverrideDocument({ schema: 1, options }, OPENCODE_AGENT_OVERRIDE, {
      provider: 'opencode',
      sourcePath: '.ai/providers/opencode/agents/coder.yaml',
    });

  it('declares the pass-through the provider documents, with its source', () => {
    expect(OPENCODE_AGENT_OVERRIDE.passthrough?.documentation).toBe(
      'https://opencode.ai/docs/agents/',
    );
    expect(OPENCODE_AGENT_OVERRIDE.passthrough?.reason).toContain('model option');
  });

  it('accepts an option the schema does not declare, and notes that nothing checked it', () => {
    const result = validate({ somethingNewNextRelease: 3 });

    expect(result.diagnostics.map((entry) => [entry.code, entry.severity])).toEqual([
      ['OVERRIDE_UNRECOGNIZED_FIELD', 'info'],
    ]);
    expect(result.diagnostics[0]?.message).toContain('model option');
    expect(result.options).toEqual({ somethingNewNextRelease: 3 });
  });

  it('notes a top-level task, which OpenCode documents only as permission.task', () => {
    // The field that started this: it looks like an OpenCode agent option and
    // is not one, so a note here is the whole value of still reporting.
    const result = validate({ task: 'anything' });

    expect(result.diagnostics.map((entry) => entry.code)).toEqual(['OVERRIDE_UNRECOGNIZED_FIELD']);
    expect(result.options).toEqual({ task: 'anything' });

    // Nested under `permission`, it is a declared field and passes in silence.
    expect(validate({ permission: { task: { '*': 'deny' } } }).diagnostics).toEqual([]);
  });

  it('writes an undeclared option into the generated agent unchanged', () => {
    const result = opencodeAdapter.compile(
      CONFIGURATION,
      overlay('agent', 'coder', { somethingNewNextRelease: 'yes' }),
    );

    // Quoted by the renderer, as any value YAML would otherwise read as a
    // boolean is: written through does not mean written out verbatim.
    expect(fileAt('.opencode/agents/coder.md', result)).toContain('somethingNewNextRelease: "yes"');
    expect(result.diagnostics).toEqual([]);
  });

  it('declares every model option the documentation shows on an agent', () => {
    // Read from https://opencode.ai/docs/models/, which states these may be set
    // per agent and that the agent config overrides the global one. Declared so
    // a documented option is never reported as one AI Config has not heard of.
    expect(
      OPENCODE_AGENT_OVERRIDE.fields
        .filter((field) => field.documentation.includes('/models/'))
        .map((field) => field.name),
    ).toEqual(['reasoningEffort', 'textVerbosity', 'reasoningSummary', 'thinking', 'include']);
  });

  it('leaves the accepted values of a model option open', () => {
    for (const name of ['reasoningEffort', 'textVerbosity', 'reasoningSummary']) {
      const field = OPENCODE_AGENT_OVERRIDE.fields.find((candidate) => candidate.name === name);
      // Free strings rather than enums: the accepted values belong to the model
      // provider, not to OpenCode, so pinning them here would reject whatever
      // the next model accepts.
      expect(field?.type, name).toEqual({ kind: 'string' });
      expect(field?.suggestions?.length, name).toBeGreaterThan(0);
    }
  });

  it('emits every declared model option beside the fields OpenCode defines', () => {
    const result = opencodeAdapter.compile(
      CONFIGURATION,
      overlay('agent', 'coder', {
        reasoningEffort: 'high',
        textVerbosity: 'low',
        reasoningSummary: 'auto',
        thinking: { type: 'enabled', budgetTokens: 16000 },
        include: ['reasoning.encrypted_content'],
      }),
    );

    const value = fileAt('.opencode/agents/coder.md', result);
    expect(value).toContain('reasoningEffort: high');
    expect(value).toContain('textVerbosity: low');
    expect(value).toContain('reasoningSummary: auto');
    expect(value).toContain('budgetTokens: 16000');
    expect(value).toContain('reasoning.encrypted_content');
    // Declared fields are checked, so none of this is reported.
    expect(result.diagnostics).toEqual([]);
  });

  it('still refuses a canonical field and a retired one', () => {
    // Pass-through widens what is accepted, not what may be redefined.
    expect(validate({ description: 'no' }).diagnostics.map((entry) => entry.code)).toEqual([
      'OVERRIDE_CANONICAL_FIELD',
    ]);
    expect(validate({ tools: { bash: true } }).diagnostics.map((entry) => entry.code)).toEqual([
      'OVERRIDE_UNKNOWN_FIELD',
    ]);
  });

  it('still checks a field it does declare', () => {
    // Pass-through applies to fields the schema does not name. One it does name
    // is validated as strictly as ever, or declaring a field would leave an
    // author worse off than not declaring it.
    expect(validate({ temperature: 4 }).diagnostics.map((entry) => entry.code)).toEqual([
      'OVERRIDE_VALUE_INVALID',
    ]);
  });

  it('emits an undeclared option after the declared ones, in a stable order', () => {
    const result = opencodeAdapter.compile(
      CONFIGURATION,
      overlay('agent', 'coder', { zebra: 1, temperature: 0.1, alpha: 2, mode: 'all' }),
    );

    const value = fileAt('.opencode/agents/coder.md', result);
    const order = ['description', 'mode', 'temperature', 'alpha', 'zebra'].map((key) =>
      value.indexOf(`${key}:`),
    );

    // Declared fields in the schema's order, then everything else sorted.
    // Generated output has to be byte-identical between runs, and the order a
    // YAML mapping happened to be written in is not a stable input.
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
  });

  it('still refuses a value it could not write back out', () => {
    expect(validate({ whatever: null }).diagnostics.map((entry) => entry.code)).toEqual([
      'OVERRIDE_VALUE_INVALID',
    ]);
  });
});

describe('OpenCode command overrides stay closed', () => {
  it('reports an undeclared command field, because OpenCode documents no pass-through', () => {
    const command = opencodeAdapter.overrides?.find((schema) => schema.kind === 'command');
    expect(command?.passthrough).toBeUndefined();

    const result = validateOverrideDocument(
      { schema: 1, options: { unknownThing: 'x' } },
      command!,
      { provider: 'opencode', sourcePath: '.ai/providers/opencode/commands/ship.yaml' },
    );

    // A warning, not a note: OpenCode documents what a command accepts and says
    // nothing about accepting more, so an undeclared field here is a mistake.
    expect(result.diagnostics.map((entry) => [entry.code, entry.severity])).toEqual([
      ['OVERRIDE_UNRECOGNIZED_FIELD', 'warning'],
    ]);
  });
});
