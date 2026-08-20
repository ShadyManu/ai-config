import type { ProviderOverrideSchema } from '@aiconfig/core';

const SUBAGENTS_DOC = 'https://learn.chatgpt.com/docs/agent-configuration/subagents';
const CONFIG_DOC = 'https://learn.chatgpt.com/docs/config-file/config-reference';
const SKILLS_DOC = 'https://learn.chatgpt.com/docs/build-skills';

/**
 * Codex custom agent settings.
 *
 * A custom agent file is a configuration layer for the spawned session, and
 * OpenAI documents which `config.toml` keys it may carry. `skills.config` is
 * among them but is not exposed: it is an array of filesystem paths, which does
 * not survive being committed to a repository other people clone, and it
 * configures skills rather than the agent. The `[agents]` block is
 * session-global and therefore not an agent setting at all.
 */
export const CODEX_AGENT_OVERRIDE: ProviderOverrideSchema = {
  kind: 'agent',
  reserved: ['name', 'description', 'developer_instructions', 'prompt', 'body'],
  fields: [
    {
      name: 'model',
      type: { kind: 'string' },
      description: 'Model for sessions spawned from this agent.',
      documentation: SUBAGENTS_DOC,
      defaultNote: "the parent session's model",
      suggestions: ['gpt-5.5'],
    },
    {
      name: 'model_reasoning_effort',
      type: {
        kind: 'enum',
        values: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      description:
        'Reasoning effort for supported models. The max and ultra levels are documented for subagents and remain model-dependent.',
      documentation: SUBAGENTS_DOC,
      defaultNote: "the parent session's effort",
    },
    {
      name: 'model_reasoning_summary',
      type: { kind: 'enum', values: ['auto', 'concise', 'detailed', 'none'] },
      description: 'Reasoning-summary detail, or none to disable summaries.',
      documentation: CONFIG_DOC,
    },
    {
      name: 'model_verbosity',
      type: { kind: 'enum', values: ['low', 'medium', 'high'] },
      description: 'GPT-5 response verbosity for this agent.',
      documentation: CONFIG_DOC,
      defaultNote: "the selected model's preset",
    },
    {
      name: 'personality',
      type: { kind: 'enum', values: ['none', 'friendly', 'pragmatic'] },
      description: 'Communication style when the selected model supports personality.',
      documentation: CONFIG_DOC,
    },
    {
      name: 'sandbox_mode',
      type: {
        kind: 'enum',
        values: ['read-only', 'workspace-write', 'danger-full-access'],
      },
      description: 'Filesystem and network sandbox policy during command execution.',
      documentation: CONFIG_DOC,
      defaultNote: "the parent session's sandbox policy",
    },
    {
      name: 'approval_policy',
      type: { kind: 'enum-or-map', values: ['untrusted', 'on-request', 'never'] },
      description:
        'When Codex pauses for approval. A granular mapping may control individual prompt categories.',
      documentation: CONFIG_DOC,
      defaultNote: "the parent session's approval policy",
    },
    {
      name: 'web_search',
      type: { kind: 'enum', values: ['disabled', 'cached', 'indexed', 'live'] },
      description: 'Web-search mode available to this agent.',
      documentation: CONFIG_DOC,
      defaultNote: "the parent session's search mode",
    },
    {
      name: 'service_tier',
      type: { kind: 'string' },
      description: 'Preferred service tier for new turns, such as fast.',
      documentation: CONFIG_DOC,
      defaultNote: "the selected model's default tier",
      suggestions: ['fast'],
    },
    {
      name: 'tools.view_image',
      type: { kind: 'boolean' },
      description: 'Enable or disable the local-image attachment tool for this agent.',
      documentation: CONFIG_DOC,
    },
    {
      name: 'mcp_servers',
      type: { kind: 'map' },
      description: 'MCP server tables available to this agent, keyed by server id.',
      documentation: CONFIG_DOC,
    },
  ],
};

/**
 * Codex skill settings, written to the `agents/openai.yaml` sidecar.
 *
 * Tool dependency entries remain open mappings because OpenAI documents the
 * current MCP shape while allowing the dependency format to evolve.
 */
export const CODEX_SKILL_OVERRIDE: ProviderOverrideSchema = {
  kind: 'skill',
  reserved: ['name', 'description', 'license', 'metadata', 'compatibility', 'allowed-tools'],
  fields: [
    {
      name: 'policy.allow_implicit_invocation',
      type: { kind: 'boolean' },
      description:
        'Whether Codex may invoke the skill from prompt context. Explicit $name invocation always works.',
      documentation: SKILLS_DOC,
      defaultNote: 'true',
    },
    {
      name: 'interface.display_name',
      type: { kind: 'string' },
      description: 'User-facing name for the skill.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'interface.short_description',
      type: { kind: 'string' },
      description: 'User-facing description for the skill.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'interface.icon_small',
      type: { kind: 'string' },
      description: 'Path to a small logo, relative to the skill directory.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'interface.icon_large',
      type: { kind: 'string' },
      description: 'Path to a large logo, relative to the skill directory.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'interface.brand_color',
      type: { kind: 'string' },
      description: 'Hex colour used when the skill is displayed.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'interface.default_prompt',
      type: { kind: 'string' },
      description: 'Surrounding prompt used when the skill is invoked.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'dependencies.tools',
      type: { kind: 'map-list' },
      description: 'Tool dependencies declared for the skill, as open dependency mappings.',
      documentation: SKILLS_DOC,
    },
  ],
};

/**
 * No command override is declared.
 *
 * A canonical command becomes a Codex skill, and the one command-relevant
 * control the sidecar offers — `policy.allow_implicit_invocation` — is fixed to
 * `false` by the canonical explicit-only semantics. Branding a command with
 * `interface.*` would be skill-app metadata attached to something that is not a
 * skill in the canonical model.
 */
export const CODEX_OVERRIDES: readonly ProviderOverrideSchema[] = [
  CODEX_AGENT_OVERRIDE,
  CODEX_SKILL_OVERRIDE,
];
