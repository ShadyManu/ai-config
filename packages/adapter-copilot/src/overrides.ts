import type { OverrideTarget, ProviderOverrideSchema } from '@aiconfig/core';

const INSTRUCTIONS_DOC =
  'https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions';
const AGENTS_DOC = 'https://docs.github.com/en/copilot/reference/custom-agents-configuration';
const VSCODE_AGENTS_DOC = 'https://code.visualstudio.com/docs/agent-customization/custom-agents';
const SKILLS_DOC = 'https://code.visualstudio.com/docs/agent-customization/agent-skills';
const PROMPTS_DOC = 'https://code.visualstudio.com/docs/agent-customization/prompt-files';

/**
 * Copilot's one instruction-level setting.
 *
 * Only representable on a path-scoped instruction. An unscoped instruction is
 * aggregated into `.github/copilot-instructions.md`, which GitHub documents
 * with no frontmatter at all, so there is nowhere for the field to go — that is
 * refused explicitly rather than silently dropped.
 */
export const COPILOT_INSTRUCTION_OVERRIDE: ProviderOverrideSchema = {
  kind: 'instruction',
  reserved: ['name', 'description', 'applyTo', 'paths'],
  unavailableReason: (target: OverrideTarget): string | undefined =>
    target.applyTo.length > 0
      ? undefined
      : `GitHub Copilot instruction options apply to '.github/instructions/*.instructions.md', which AI Config generates only for a path-scoped instruction. Add 'applyTo' to '${target.name}', or remove the override.`,
  fields: [
    {
      name: 'excludeAgent',
      type: { kind: 'enum', values: ['code-review', 'cloud-agent'] },
      description:
        'Prevents one Copilot agent from reading the file. Both read it when the field is absent.',
      documentation: INSTRUCTIONS_DOC,
      defaultNote: 'both Copilot code review and Copilot cloud agent read the file',
    },
  ],
};

export const COPILOT_AGENT_OVERRIDE: ProviderOverrideSchema = {
  kind: 'agent',
  // `infer` is documented as retired in favour of the two invocation fields, so
  // it is refused rather than passed through to a field GitHub no longer reads.
  reserved: ['name', 'description', 'prompt', 'body'],
  deprecated: [
    {
      name: 'infer',
      reason:
        "GitHub documents 'infer' as retired. Use disable-model-invocation and user-invocable instead.",
    },
  ],
  fields: [
    {
      name: 'target',
      type: { kind: 'enum', values: ['vscode', 'github-copilot'] },
      description: 'Restrict the agent to one environment.',
      documentation: AGENTS_DOC,
      defaultNote: 'available in both environments',
    },
    {
      name: 'tools',
      type: { kind: 'string-list' },
      description: 'Tool names the custom agent may use.',
      documentation: AGENTS_DOC,
      defaultNote: 'all tools',
    },
    {
      name: 'model',
      type: { kind: 'string-or-string-list' },
      description:
        'Model used when this custom agent executes, or a VS Code priority list tried in order.',
      documentation: VSCODE_AGENTS_DOC,
      defaultNote: 'inherits the default model',
    },
    {
      name: 'disable-model-invocation',
      type: { kind: 'boolean' },
      description:
        'Stop the Copilot cloud agent from selecting this agent automatically from task context.',
      documentation: AGENTS_DOC,
      defaultNote: 'false',
    },
    {
      name: 'user-invocable',
      type: { kind: 'boolean' },
      description: 'Whether a user can select this agent.',
      documentation: AGENTS_DOC,
      defaultNote: 'true',
    },
    {
      name: 'mcp-servers',
      type: { kind: 'map' },
      description: 'Additional MCP servers and tools for this custom agent.',
      documentation: AGENTS_DOC,
    },
    {
      name: 'metadata',
      type: { kind: 'string-map' },
      description: 'Free-form name/value annotations, as strings.',
      documentation: AGENTS_DOC,
    },
    {
      name: 'argument-hint',
      type: { kind: 'string' },
      description: 'Hint shown during autocomplete when a user invokes the agent.',
      documentation: VSCODE_AGENTS_DOC,
    },
    {
      name: 'handoffs',
      type: {
        kind: 'map-list',
        fields: {
          label: 'string',
          agent: 'string',
          prompt: 'string',
          send: 'boolean',
          model: 'string',
        },
        required: ['label', 'agent'],
      },
      description:
        'VS Code handoff actions, with label, agent, prompt, optional send, and optional model fields.',
      documentation: VSCODE_AGENTS_DOC,
    },
    {
      name: 'agents',
      type: { kind: 'string-list' },
      description: 'Agents this agent may delegate to as subagents.',
      documentation: VSCODE_AGENTS_DOC,
    },
    {
      name: 'hooks',
      type: { kind: 'map' },
      description: 'Lifecycle hooks scoped to this custom agent.',
      documentation: VSCODE_AGENTS_DOC,
    },
  ],
};

export const COPILOT_SKILL_OVERRIDE: ProviderOverrideSchema = {
  kind: 'skill',
  reserved: ['name', 'description', 'license', 'metadata', 'compatibility', 'allowed-tools'],
  fields: [
    {
      name: 'argument-hint',
      type: { kind: 'string' },
      description: 'Hint shown in the chat input when the skill is invoked as a slash command.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'user-invocable',
      type: { kind: 'boolean' },
      description: 'Whether the skill appears as a slash command in the chat menu.',
      documentation: SKILLS_DOC,
      defaultNote: 'true',
    },
    {
      name: 'disable-model-invocation',
      type: { kind: 'boolean' },
      description: 'Require manual invocation instead of allowing Copilot to load the skill.',
      documentation: SKILLS_DOC,
      defaultNote: 'false',
    },
    {
      name: 'context',
      type: { kind: 'enum', values: ['fork'] },
      description: 'Run the skill in a dedicated subagent context (experimental).',
      documentation: SKILLS_DOC,
      defaultNote: 'inline',
    },
  ],
};

export const COPILOT_COMMAND_OVERRIDE: ProviderOverrideSchema = {
  kind: 'command',
  reserved: ['name', 'description', 'prompt', 'body'],
  fields: [
    {
      name: 'agent',
      type: { kind: 'string' },
      description: 'Agent used to run the prompt: ask, agent, plan, or a custom agent name.',
      documentation: PROMPTS_DOC,
      defaultNote: 'the current agent, or agent when tools are set',
      suggestions: ['ask', 'agent', 'plan'],
    },
    {
      name: 'model',
      type: { kind: 'string' },
      description: 'Language model used when running the prompt.',
      documentation: PROMPTS_DOC,
      defaultNote: 'the currently selected model',
    },
    {
      name: 'tools',
      type: { kind: 'string-list' },
      description:
        'Tool or tool set names available to this prompt. Use <server>/* for every tool of an MCP server.',
      documentation: PROMPTS_DOC,
    },
    {
      name: 'argument-hint',
      type: { kind: 'string' },
      description: 'Hint text shown in the chat input field.',
      documentation: PROMPTS_DOC,
    },
  ],
};

export const COPILOT_OVERRIDES: readonly ProviderOverrideSchema[] = [
  COPILOT_INSTRUCTION_OVERRIDE,
  COPILOT_AGENT_OVERRIDE,
  COPILOT_SKILL_OVERRIDE,
  COPILOT_COMMAND_OVERRIDE,
];
