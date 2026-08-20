import { describe, expect, it } from 'vitest';

import type { AiConfiguration, ProviderOverlay, SourceKind } from '@aiconfig/core';

import { opencodeAdapter } from '../src/index.js';

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
