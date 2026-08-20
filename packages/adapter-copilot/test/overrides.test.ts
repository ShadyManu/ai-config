import { describe, expect, it } from 'vitest';

import type { AiConfiguration, ProviderOverlay, SourceKind } from '@aiconfig/core';

import { COPILOT_INSTRUCTION_OVERRIDE, copilotAdapter } from '../src/index.js';

const CONFIGURATION: AiConfiguration = {
  instructions: [
    {
      name: 'backend',
      description: 'Backend rules',
      applyTo: ['backend/**'],
      body: 'Use ports.',
      sourcePath: '.ai/instructions/backend.md',
    },
    {
      name: 'general',
      description: undefined,
      applyTo: [],
      body: 'Be careful.',
      sourcePath: '.ai/instructions/general.md',
    },
  ],
  agents: [
    {
      name: 'coder',
      description: 'Writes code',
      body: 'Be careful.',
      sourcePath: '.ai/agents/coder.md',
    },
  ],
  skills: [
    {
      name: 'review',
      description: 'Reviews changes',
      sourcePath: '.ai/skills/review',
      entrypointText: '---\nname: review\ndescription: Reviews changes\n---\n\nReview.\n',
      entrypointKeys: ['name', 'description'],
      files: [{ relativePath: 'SKILL.md', sha256: 'sha256:a', size: 1, executable: false }],
    },
  ],
  commands: [
    { name: 'ship', description: 'Ships it', body: 'Ship it.', sourcePath: '.ai/commands/ship.md' },
  ],
};

const overlay = (
  kind: SourceKind,
  id: string,
  options: Record<string, unknown>,
): ProviderOverlay => ({
  provider: 'copilot',
  extensions: [],
  orphanedOverrides: [],
  overrides: [
    {
      kind,
      id,
      options: options as ProviderOverlay['overrides'][number]['options'],
      sourcePath: `.ai/providers/copilot/${kind}s/${id}.yaml`,
    },
  ],
});

const fileAt = (path: string, result: ReturnType<typeof copilotAdapter.compile>): string => {
  const file = result.files.find((candidate) => candidate.path === path);
  if (file?.content.kind !== 'text') {
    throw new Error(`No generated text at ${path}`);
  }
  return file.content.value;
};

describe('Copilot instruction overrides', () => {
  it('adds excludeAgent after the canonical applyTo', () => {
    const result = copilotAdapter.compile(
      CONFIGURATION,
      overlay('instruction', 'backend', { excludeAgent: 'code-review' }),
    );

    expect(fileAt('.github/instructions/backend.instructions.md', result)).toBe(
      [
        '---',
        'applyTo: "backend/**"',
        'excludeAgent: code-review',
        '---',
        '',
        'Backend rules',
        '',
        'Use ports.',
        '',
      ].join('\n'),
    );
  });

  it('is unavailable for an unscoped instruction, which has no frontmatter to carry it', () => {
    // An unscoped instruction is aggregated into `.github/copilot-instructions.md`,
    // and GitHub documents no frontmatter for that file at all.
    expect(
      COPILOT_INSTRUCTION_OVERRIDE.unavailableReason?.({
        kind: 'instruction',
        name: 'general',
        applyTo: [],
      }),
    ).toContain("Add 'applyTo' to 'general'");
    expect(
      COPILOT_INSTRUCTION_OVERRIDE.unavailableReason?.({
        kind: 'instruction',
        name: 'backend',
        applyTo: ['backend/**'],
      }),
    ).toBeUndefined();
  });
});

describe('Copilot agent overrides', () => {
  it('adds the documented agent fields in schema order', () => {
    const result = copilotAdapter.compile(
      CONFIGURATION,
      overlay('agent', 'coder', {
        target: 'vscode',
        tools: ['read', 'edit'],
        'user-invocable': false,
      }),
    );

    expect(fileAt('.github/agents/coder.agent.md', result)).toBe(
      [
        '---',
        'name: coder',
        'description: Writes code',
        'target: vscode',
        'tools:',
        '  - read',
        '  - edit',
        'user-invocable: false',
        '---',
        '',
        'Be careful.',
        '',
      ].join('\n'),
    );
  });

  it('records infer as retired rather than accepting it', () => {
    const agent = copilotAdapter.overrides?.find((schema) => schema.kind === 'agent');
    expect(agent?.fields.some((field) => field.name === 'infer')).toBe(false);
    expect(agent?.deprecated?.map((entry) => entry.name)).toEqual(['infer']);
  });

  it('renders VS Code model priorities, structured handoffs, and cloud string metadata', () => {
    const result = copilotAdapter.compile(
      CONFIGURATION,
      overlay('agent', 'coder', {
        model: ['GPT-5.6', 'Claude Sonnet 5'],
        metadata: { owner: 'platform' },
        handoffs: [
          {
            label: 'Review',
            agent: 'reviewer',
            prompt: 'Review the implementation.',
            send: false,
            model: 'GPT-5.6 (copilot)',
          },
        ],
      }),
    );

    const value = fileAt('.github/agents/coder.agent.md', result);
    expect(value).toContain('model:\n  - GPT-5.6\n  - Claude Sonnet 5');
    expect(value).toContain('metadata:\n  owner: platform');
    expect(value).toContain('handoffs:\n  - label: Review\n    agent: reviewer');
    expect(value).toContain('send: false');
  });
});

describe('Copilot skill overrides', () => {
  it('appends Copilot-only fields while preserving canonical SKILL.md fields', () => {
    const result = copilotAdapter.compile(
      CONFIGURATION,
      overlay('skill', 'review', {
        'argument-hint': '[pull-request]',
        'user-invocable': true,
        'disable-model-invocation': false,
        context: 'fork',
      }),
    );

    expect(fileAt('.github/skills/review/SKILL.md', result)).toBe(
      [
        '---',
        'name: review',
        'description: Reviews changes',
        'argument-hint: "[pull-request]"',
        'user-invocable: true',
        'disable-model-invocation: false',
        'context: fork',
        '---',
        '',
        'Review.',
        '',
      ].join('\n'),
    );
  });
});

describe('Copilot command overrides', () => {
  it('adds prompt-file fields after the canonical description', () => {
    const result = copilotAdapter.compile(
      CONFIGURATION,
      overlay('command', 'ship', { agent: 'plan', model: 'gpt-5.5' }),
    );

    expect(fileAt('.github/prompts/ship.prompt.md', result)).toBe(
      [
        '---',
        'description: Ships it',
        'agent: plan',
        'model: gpt-5.5',
        '---',
        '',
        'Ship it.',
        '',
      ].join('\n'),
    );
  });
});

describe('Copilot override schemas', () => {
  it('declares instruction, agent, skill, and command schemas', () => {
    expect(copilotAdapter.overrides?.map((schema) => schema.kind).sort()).toEqual([
      'agent',
      'command',
      'instruction',
      'skill',
    ]);
  });

  it('documents every field with a first-party source', () => {
    for (const schema of copilotAdapter.overrides ?? []) {
      for (const field of schema.fields) {
        expect(field.documentation).toMatch(
          /^https:\/\/(docs\.github\.com|code\.visualstudio\.com)\//,
        );
      }
    }
  });
});
