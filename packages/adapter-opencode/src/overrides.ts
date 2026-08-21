import type { ProviderOverrideSchema } from '@aiconfig/core';

const AGENTS_DOC = 'https://opencode.ai/docs/agents/';
const COMMANDS_DOC = 'https://opencode.ai/docs/commands/';
/** Where the model options an agent may carry are documented. */
const MODELS_DOC = 'https://opencode.ai/docs/models/';

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
  /**
   * OpenCode documents an open agent configuration: "Any other options you
   * specify in your agent configuration will be passed through directly to the
   * provider as model options. [...] Check your provider's documentation for
   * available parameters."
   *
   * So the field list below is what AI Config can describe and check, not what
   * OpenCode accepts. A model option nobody has written down yet is ordinary
   * configuration here, not a mistake.
   */
  passthrough: {
    reason:
      'OpenCode passes any agent option it does not define through to the model provider as a model option.',
    documentation: AGENTS_DOC,
  },
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
        'Per-tool permissions. Each key accepts allow, ask or deny; read, edit, glob, grep, list, bash, task, external_directory, lsp and skill also accept a glob-pattern map. Which subagents this agent may invoke is permission.task, not a top-level task field.',
      documentation: AGENTS_DOC,
    },
    // Every model option OpenCode documents as settable on an agent. They are
    // pass-through like any other — OpenCode forwards them to the model
    // provider without interpreting them — but they appear in its own examples,
    // and a documented option must not be reported as one AI Config has never
    // heard of.
    //
    // Typed as free strings and open maps rather than enums: the accepted
    // values belong to the model provider, and OpenCode documents none of them.
    // An enum here would reject whatever the next model accepts.
    {
      name: 'reasoningEffort',
      type: { kind: 'string' },
      description:
        'Model option, forwarded to the model provider. OpenAI reasoning models accept low, medium, high and xhigh; other providers document their own values.',
      documentation: MODELS_DOC,
      defaultNote: "the model provider's own default",
      suggestions: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      name: 'textVerbosity',
      type: { kind: 'string' },
      description:
        'Model option, forwarded to the model provider. OpenAI reasoning models accept low, medium and high.',
      documentation: MODELS_DOC,
      defaultNote: "the model provider's own default",
      suggestions: ['low', 'medium', 'high'],
    },
    {
      name: 'reasoningSummary',
      type: { kind: 'string' },
      description:
        'Model option, forwarded to the model provider. Asks an OpenAI reasoning model for a summary of the reasoning it performed.',
      documentation: MODELS_DOC,
      defaultNote: "the model provider's own default",
      suggestions: ['auto'],
    },
    {
      name: 'thinking',
      type: { kind: 'map' },
      description:
        'Model option, forwarded to the model provider. Anthropic models take a mapping of type and budgetTokens.',
      documentation: MODELS_DOC,
      defaultNote: "the model provider's own default",
    },
    {
      name: 'include',
      type: { kind: 'string-list' },
      description:
        'Model option, forwarded to the model provider. Extra response fields to request, such as reasoning.encrypted_content on OpenAI.',
      documentation: MODELS_DOC,
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
