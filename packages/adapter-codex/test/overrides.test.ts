import { describe, expect, it } from 'vitest';

import type { AiConfiguration, ProviderOverlay, SourceKind } from '@aiconfig/core';

import { codexAdapter } from '../src/index.js';

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
      entrypointText: '---\nname: review\ndescription: Reviews a change\n---\n\nBody.\n',
      entrypointKeys: ['name', 'description'],
      files: [{ relativePath: 'SKILL.md', sha256: 'sha256:a', size: 1, executable: false }],
    },
  ],
  commands: [],
};

const overlay = (
  kind: SourceKind,
  id: string,
  options: Record<string, unknown>,
): ProviderOverlay => ({
  provider: 'codex',
  extensions: [],
  orphanedOverrides: [],
  overrides: [
    {
      kind,
      id,
      options: options as ProviderOverlay['overrides'][number]['options'],
      sourcePath: `.ai/providers/codex/${kind}s/${id}.yaml`,
    },
  ],
});

const fileAt = (path: string, result: ReturnType<typeof codexAdapter.compile>): string => {
  const file = result.files.find((candidate) => candidate.path === path);
  if (file?.content.kind !== 'text') {
    throw new Error(`No generated text at ${path}`);
  }
  return file.content.value;
};

describe('Codex agent overrides', () => {
  it('adds scalar config keys after the canonical ones', () => {
    const result = codexAdapter.compile(
      CONFIGURATION,
      overlay('agent', 'coder', {
        model: 'gpt-5.5',
        model_reasoning_effort: 'high',
        sandbox_mode: 'read-only',
      }),
    );

    const value = fileAt('.codex/agents/coder.toml', result);
    expect(value).toContain('name = "coder"');
    expect(value).toContain('model = "gpt-5.5"');
    expect(value).toContain('model_reasoning_effort = "high"');
    expect(value).toContain('sandbox_mode = "read-only"');
  });

  it('emits a mapping as a TOML table after every scalar key', () => {
    const result = codexAdapter.compile(
      CONFIGURATION,
      overlay('agent', 'coder', {
        model: 'gpt-5.5',
        mcp_servers: { docs: { command: 'npx', args: ['-y', 'server'] } },
      }),
    );

    const value = fileAt('.codex/agents/coder.toml', result);
    // A key written after a table header would belong to that table, so every
    // scalar must precede the first header.
    const header = value.indexOf('[mcp_servers.docs]');
    expect(header).toBeGreaterThan(value.indexOf('model = "gpt-5.5"'));
    expect(value).toContain('command = "npx"');
    expect(value).toContain('args = ["-y", "server"]');
  });
});

describe('Codex skill overrides', () => {
  it('writes the sidecar with nested policy and interface sections', () => {
    const result = codexAdapter.compile(
      CONFIGURATION,
      overlay('skill', 'review', {
        policy: { allow_implicit_invocation: false },
        interface: { display_name: 'Review', brand_color: '#3B82F6' },
      }),
    );

    expect(fileAt('.agents/skills/review/agents/openai.yaml', result)).toBe(
      [
        'policy:',
        '  allow_implicit_invocation: false',
        'interface:',
        '  display_name: Review',
        '  brand_color: "#3B82F6"',
        '',
      ].join('\n'),
    );
  });

  it('writes no sidecar for a skill with no override', () => {
    const result = codexAdapter.compile(CONFIGURATION);
    expect(result.files.some((file) => file.path.endsWith('review/agents/openai.yaml'))).toBe(
      false,
    );
  });

  it('attributes the sidecar to the skill so it is cleaned up with it', () => {
    const result = codexAdapter.compile(
      CONFIGURATION,
      overlay('skill', 'review', { policy: { allow_implicit_invocation: false } }),
    );
    const sidecar = result.files.find((file) => file.path.endsWith('review/agents/openai.yaml'));
    expect(sidecar?.source).toEqual({ kind: 'skill', name: 'review' });
  });
});

describe('Codex override schemas', () => {
  it('declares agent and skill schemas only', () => {
    // No command schema: a canonical command becomes a skill whose one
    // command-relevant control is fixed by explicit-only semantics.
    expect(codexAdapter.overrides?.map((schema) => schema.kind).sort()).toEqual(['agent', 'skill']);
  });

  it('excludes skills.config, which is a machine-dependent path list', () => {
    const agent = codexAdapter.overrides?.find((schema) => schema.kind === 'agent');
    expect(agent?.fields.some((field) => field.name.startsWith('skills'))).toBe(false);
  });

  it('exposes documented tool dependencies without constraining their nested shape', () => {
    const skill = codexAdapter.overrides?.find((schema) => schema.kind === 'skill');
    expect(skill?.fields.find((field) => field.name === 'dependencies.tools')?.type).toEqual({
      kind: 'map-list',
    });
    expect(skill?.reserved).toContain('allowed-tools');
  });

  it('uses current subagent reasoning and sandbox values', () => {
    const agent = codexAdapter.overrides?.find((schema) => schema.kind === 'agent');
    expect(agent?.fields.find((field) => field.name === 'model_reasoning_effort')?.type).toEqual({
      kind: 'enum',
      values: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    });
    expect(agent?.fields.find((field) => field.name === 'sandbox_mode')?.type).toEqual({
      kind: 'enum',
      values: ['read-only', 'workspace-write', 'danger-full-access'],
    });
  });

  it('documents every field with a first-party source', () => {
    for (const schema of codexAdapter.overrides ?? []) {
      for (const field of schema.fields) {
        expect(field.documentation).toMatch(/^https:\/\/learn\.chatgpt\.com\/docs\//);
      }
    }
  });
});
