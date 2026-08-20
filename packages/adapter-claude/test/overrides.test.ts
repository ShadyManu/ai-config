import { describe, expect, it } from 'vitest';

import type { AiConfiguration, ProviderOverlay } from '@aiconfig/core';

import { claudeAdapter } from '../src/index.js';

const SKILL_TEXT = [
  '---',
  'name: review',
  'description: Reviews a change',
  'allowed-tools: Read Grep',
  '---',
  '',
  '# Review',
  '',
  'Do the thing.',
  '',
].join('\n');

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
  skills: [
    {
      name: 'review',
      description: 'Reviews a change',
      sourcePath: '.ai/skills/review',
      entrypointText: SKILL_TEXT,
      entrypointKeys: ['name', 'description', 'allowed-tools'],
      files: [
        { relativePath: 'SKILL.md', sha256: 'sha256:a', size: 1, executable: false },
        { relativePath: 'references/x.md', sha256: 'sha256:b', size: 1, executable: false },
      ],
    },
  ],
  commands: [
    {
      name: 'ship',
      description: 'Ships it',
      body: 'Ship $ARGUMENTS.',
      sourcePath: '.ai/commands/ship.md',
    },
  ],
};

const overlay = (
  kind: 'agent' | 'skill' | 'command',
  id: string,
  options: Record<string, unknown>,
): ProviderOverlay => ({
  provider: 'claude',
  extensions: [],
  orphanedOverrides: [],
  overrides: [
    {
      kind,
      id,
      options: options as ProviderOverlay['overrides'][number]['options'],
      sourcePath: `.ai/providers/claude/${kind}s/${id}.yaml`,
    },
  ],
});

const fileAt = (path: string, result: ReturnType<typeof claudeAdapter.compile>): string => {
  const file = result.files.find((candidate) => candidate.path === path);
  if (file?.content.kind !== 'text') {
    throw new Error(`No generated text at ${path}`);
  }
  return file.content.value;
};

describe('Claude agent overrides', () => {
  it('adds provider fields after the canonical identity, in schema order', () => {
    const result = claudeAdapter.compile(
      CONFIGURATION,
      overlay('agent', 'coder', {
        model: 'sonnet',
        tools: ['Read', 'Grep'],
        permissionMode: 'plan',
        maxTurns: 8,
      }),
    );

    expect(fileAt('.claude/agents/coder.md', result)).toBe(
      [
        '---',
        'name: coder',
        'description: Writes code',
        'tools:',
        '  - Read',
        '  - Grep',
        'model: sonnet',
        'permissionMode: plan',
        'maxTurns: 8',
        '---',
        '',
        'Be careful.',
        '',
      ].join('\n'),
    );
  });

  it('renders nested hooks as block YAML', () => {
    const result = claudeAdapter.compile(
      CONFIGURATION,
      overlay('agent', 'coder', {
        hooks: { PreToolUse: [{ matcher: 'Bash', command: 'echo hi' }] },
      }),
    );

    expect(fileAt('.claude/agents/coder.md', result)).toContain(
      ['hooks:', '  PreToolUse:', '    - matcher: Bash', '      command: echo hi'].join('\n'),
    );
  });

  it('leaves the canonical output untouched without an override', () => {
    const result = claudeAdapter.compile(CONFIGURATION);
    expect(fileAt('.claude/agents/coder.md', result)).toBe(
      ['---', 'name: coder', 'description: Writes code', '---', '', 'Be careful.', ''].join('\n'),
    );
  });
});

describe('Claude skill overrides', () => {
  it('appends the override to the canonical frontmatter and preserves every canonical byte', () => {
    const result = claudeAdapter.compile(
      CONFIGURATION,
      overlay('skill', 'review', { 'disable-model-invocation': true, effort: 'high' }),
    );

    expect(result.diagnostics).toEqual([]);
    const generated = fileAt('.claude/skills/review/SKILL.md', result);
    expect(generated).toBe(
      [
        '---',
        'name: review',
        'description: Reviews a change',
        'allowed-tools: Read Grep',
        'disable-model-invocation: true',
        'effort: high',
        '---',
        '',
        '# Review',
        '',
        'Do the thing.',
        '',
      ].join('\n'),
    );
    // The canonical document survives intact: removing the added lines gives
    // back exactly the source file.
    expect(
      generated
        .split('\n')
        .filter(
          (line) => !line.startsWith('disable-model-invocation') && !line.startsWith('effort'),
        )
        .join('\n'),
    ).toBe(SKILL_TEXT);
  });

  it('copies the skill byte-for-byte when there is no override', () => {
    const result = claudeAdapter.compile(CONFIGURATION);
    const entry = result.files.find((f) => f.path === '.claude/skills/review/SKILL.md');
    expect(entry?.content.kind).toBe('copy');
  });

  it('leaves supporting files as copies even when SKILL.md is regenerated', () => {
    const result = claudeAdapter.compile(
      CONFIGURATION,
      overlay('skill', 'review', { effort: 'high' }),
    );
    const support = result.files.find((f) => f.path === '.claude/skills/review/references/x.md');
    expect(support?.content.kind).toBe('copy');
  });

  it('refuses a key the canonical skill already sets rather than writing it twice', () => {
    const result = claudeAdapter.compile(
      CONFIGURATION,
      // `allowed-tools` is reserved by the schema, so this uses a field that is
      // valid in principle but already present in the canonical document.
      {
        provider: 'claude',
        extensions: [],
        orphanedOverrides: [],
        overrides: [
          {
            kind: 'skill',
            id: 'review',
            options: { 'disable-model-invocation': true, effort: 'high' },
            sourcePath: '.ai/providers/claude/skills/review.yaml',
          },
        ],
      },
    );
    expect(result.diagnostics).toEqual([]);

    const colliding = claudeAdapter.compile(
      {
        ...CONFIGURATION,
        skills: [
          {
            ...CONFIGURATION.skills[0]!,
            entrypointText: SKILL_TEXT.replace(
              'allowed-tools: Read Grep',
              'allowed-tools: Read Grep\neffort: low',
            ),
            entrypointKeys: ['name', 'description', 'allowed-tools', 'effort'],
          },
        ],
      },
      overlay('skill', 'review', { effort: 'high' }),
    );

    expect(colliding.diagnostics.map((d) => d.code)).toEqual(['OVERRIDE_CANONICAL_FIELD']);
    // The canonical copy is emitted unchanged rather than a document with a
    // duplicate key.
    expect(
      colliding.files.find((f) => f.path === '.claude/skills/review/SKILL.md')?.content.kind,
    ).toBe('copy');
  });
});

describe('Claude command overrides', () => {
  it('keeps the canonical explicit-only marker and appends provider fields', () => {
    const result = claudeAdapter.compile(
      CONFIGURATION,
      overlay('command', 'ship', { model: 'haiku', 'argument-hint': '[environment]' }),
    );

    expect(fileAt('.claude/commands/ship.md', result)).toBe(
      [
        '---',
        'description: Ships it',
        'disable-model-invocation: true',
        'argument-hint: "[environment]"',
        'model: haiku',
        '---',
        '',
        'Ship $ARGUMENTS.',
        '',
      ].join('\n'),
    );
  });
});

describe('Claude override schemas', () => {
  it('declares no instruction schema, because rules only document paths', () => {
    expect(claudeAdapter.overrides?.map((schema) => schema.kind).sort()).toEqual([
      'agent',
      'command',
      'skill',
    ]);
  });

  it('reserves the canonical and spec-portable fields', () => {
    const skill = claudeAdapter.overrides?.find((schema) => schema.kind === 'skill');
    expect(skill?.reserved).toContain('allowed-tools');
    expect(skill?.reserved).toContain('license');
    const command = claudeAdapter.overrides?.find((schema) => schema.kind === 'command');
    expect(command?.reserved).toContain('disable-model-invocation');
  });

  it('documents every field with a first-party source', () => {
    for (const schema of claudeAdapter.overrides ?? []) {
      for (const field of schema.fields) {
        expect(field.description.length).toBeGreaterThan(0);
        expect(field.documentation).toMatch(/^https:\/\/code\.claude\.com\//);
      }
    }
  });
});
