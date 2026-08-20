import type { ProviderOverrideSchema } from '@aiconfig/core';

const AGENTS_DOC = 'https://opencode.ai/docs/agents/';
const COMMANDS_DOC = 'https://opencode.ai/docs/commands/';

/**
 * Permission keys OpenCode documents.
 *
 * Offered as a shorthand `key: allow | ask | deny` map by guided flows. The
 * field still validates the full documented shape, because a subset of these
 * keys also accepts a glob-pattern map, which is written by hand.
 */
const PERMISSION_KEYS = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'lsp',
  'skill',
  'todowrite',
  'webfetch',
  'websearch',
  'question',
  'doom_loop',
] as const;

export const OPENCODE_AGENT_OVERRIDE: ProviderOverrideSchema = {
  kind: 'agent',
  reserved: ['name', 'description', 'prompt', 'body'],
  deprecated: [
    {
      name: 'tools',
      reason:
        "OpenCode documents 'tools' as deprecated and directs new configuration at 'permission'. Use permission instead.",
    },
  ],
  fields: [
    {
      name: 'mode',
      type: { kind: 'enum', values: ['primary', 'subagent', 'all'] },
      description:
        'How the agent can be used. AI Config emits subagent, which is what the canonical concept means.',
      documentation: AGENTS_DOC,
      defaultNote: 'subagent, emitted by AI Config',
    },
    {
      name: 'model',
      type: { kind: 'string' },
      description: 'Model override, in provider/model-id form.',
      documentation: AGENTS_DOC,
      defaultNote: 'the global model setting',
      suggestions: ['anthropic/claude-sonnet-4-20250514', 'openai/gpt-5.5'],
    },
    {
      name: 'temperature',
      type: { kind: 'number', min: 0, max: 1 },
      description: 'Response randomness, from 0.0 to 1.0.',
      documentation: AGENTS_DOC,
      defaultNote: 'model-specific',
    },
    {
      name: 'top_p',
      type: { kind: 'number', min: 0, max: 1 },
      description: 'Nucleus sampling cutoff, from 0.0 to 1.0.',
      documentation: AGENTS_DOC,
    },
    {
      name: 'steps',
      type: { kind: 'number', min: 1, integer: true },
      description: 'Maximum agentic iterations before the agent replies with text only.',
      documentation: AGENTS_DOC,
      defaultNote: 'unlimited',
    },
    {
      name: 'disable',
      type: { kind: 'boolean' },
      description: 'Set true to disable the agent without deleting it.',
      documentation: AGENTS_DOC,
    },
    {
      name: 'hidden',
      type: { kind: 'boolean' },
      description: 'Hide the subagent from @ autocomplete.',
      documentation: AGENTS_DOC,
    },
    {
      name: 'color',
      type: { kind: 'string' },
      description: 'Display colour: a hex value such as #FF5733, or a theme colour name.',
      documentation: AGENTS_DOC,
      suggestions: ['primary', 'secondary', 'accent', 'success', 'warning', 'error', 'info'],
    },
    {
      name: 'permission',
      type: { kind: 'map', shorthand: { keys: PERMISSION_KEYS, values: ['allow', 'ask', 'deny'] } },
      description:
        'Per-tool permissions. Each key accepts allow, ask or deny; read, edit, glob, grep, list, bash, task, external_directory, lsp and skill also accept a glob-pattern map.',
      documentation: AGENTS_DOC,
    },
  ],
};

export const OPENCODE_COMMAND_OVERRIDE: ProviderOverrideSchema = {
  kind: 'command',
  reserved: ['name', 'description', 'template', 'prompt', 'body'],
  fields: [
    {
      name: 'agent',
      type: { kind: 'string' },
      description: 'Which agent executes the command.',
      documentation: COMMANDS_DOC,
      defaultNote: 'the current agent',
    },
    {
      name: 'model',
      type: { kind: 'string' },
      description: 'Model override for this command, in provider/model-id form.',
      documentation: COMMANDS_DOC,
      defaultNote: 'the default model',
    },
    {
      name: 'subtask',
      type: { kind: 'boolean' },
      description: 'Force the command to run through a subagent.',
      documentation: COMMANDS_DOC,
    },
  ],
};

export const OPENCODE_OVERRIDES: readonly ProviderOverrideSchema[] = [
  OPENCODE_AGENT_OVERRIDE,
  OPENCODE_COMMAND_OVERRIDE,
];
