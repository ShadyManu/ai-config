import type { OverrideField, ProviderOverrideSchema } from '@aiconfig/core';

const SUBAGENTS_DOC = 'https://code.claude.com/docs/en/sub-agents';
const SKILLS_DOC = 'https://code.claude.com/docs/en/skills#frontmatter-reference';

/**
 * Model values Claude Code names explicitly. Typed as a free string rather than
 * an enum because a full model ID such as `claude-opus-5` is equally valid, so
 * an enum would reject documented input.
 */
const MODEL_SUGGESTIONS = ['sonnet', 'opus', 'haiku', 'fable', 'inherit'] as const;

const EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const CLAUDE_AGENT_OVERRIDE: ProviderOverrideSchema = {
  kind: 'agent',
  reserved: ['name', 'description', 'prompt', 'paths', 'body'],
  fields: [
    {
      name: 'tools',
      type: { kind: 'string-list' },
      description:
        'Allowlist of tools the subagent may use. Inherits every available tool when omitted.',
      documentation: SUBAGENTS_DOC,
      defaultNote: 'inherits all available tools',
    },
    {
      name: 'disallowedTools',
      type: { kind: 'string-list' },
      description: 'Tools removed from the inherited or specified list.',
      documentation: SUBAGENTS_DOC,
    },
    {
      name: 'model',
      type: { kind: 'string' },
      description:
        'Model for this subagent: sonnet, opus, haiku, fable, a full model ID, or inherit.',
      documentation: SUBAGENTS_DOC,
      defaultNote: 'inherit',
      suggestions: MODEL_SUGGESTIONS,
    },
    {
      name: 'permissionMode',
      type: {
        kind: 'enum',
        values: [
          'default',
          'manual',
          'acceptEdits',
          'auto',
          'dontAsk',
          'bypassPermissions',
          'plan',
        ],
      },
      description: 'Permission mode the subagent runs under.',
      documentation: SUBAGENTS_DOC,
      defaultNote: "inherits the parent session's mode",
    },
    {
      name: 'maxTurns',
      type: { kind: 'number', min: 1, integer: true },
      description: 'Maximum number of agentic turns before the subagent stops.',
      documentation: SUBAGENTS_DOC,
      defaultNote: 'unlimited',
    },
    {
      name: 'skills',
      type: { kind: 'string-list' },
      description: "Skills preloaded into the subagent's context at startup.",
      documentation: SUBAGENTS_DOC,
    },
    {
      name: 'memory',
      type: { kind: 'enum', values: ['user', 'project', 'local'] },
      description: 'Persistent memory scope, enabling cross-session learning.',
      documentation: SUBAGENTS_DOC,
    },
    {
      name: 'effort',
      type: { kind: 'enum', values: EFFORT_VALUES },
      description: 'Effort level while this subagent is active.',
      documentation: SUBAGENTS_DOC,
      defaultNote: 'inherits from the session',
    },
    {
      name: 'background',
      type: { kind: 'boolean' },
      description: 'Keep the subagent in the background even when asked to run in the foreground.',
      documentation: SUBAGENTS_DOC,
      defaultNote: 'false',
    },
    {
      name: 'isolation',
      type: { kind: 'enum', values: ['worktree'] },
      description: 'Run the subagent in a temporary git worktree.',
      documentation: SUBAGENTS_DOC,
    },
    {
      name: 'color',
      type: {
        kind: 'enum',
        values: ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'],
      },
      description: 'Display colour in the task list and transcript.',
      documentation: SUBAGENTS_DOC,
    },
    {
      name: 'initialPrompt',
      type: { kind: 'string' },
      description:
        'Auto-submitted as the first user turn when this agent runs as the main session agent.',
      documentation: SUBAGENTS_DOC,
    },
    {
      name: 'mcpServers',
      type: { kind: 'list' },
      description:
        'MCP servers available to this subagent: server names, or inline server definitions.',
      documentation: SUBAGENTS_DOC,
    },
    {
      name: 'hooks',
      type: { kind: 'map' },
      description: 'Lifecycle hooks scoped to this subagent (PreToolUse, PostToolUse, Stop).',
      documentation: SUBAGENTS_DOC,
    },
  ],
};

/**
 * Claude Code-only `SKILL.md` fields.
 *
 * The six Agent Skills spec fields — `name`, `description`, `license`,
 * `metadata`, `compatibility`, `allowed-tools` — are deliberately absent and
 * reserved. Every provider reads the same canonical `SKILL.md`, which AI Config
 * copies verbatim, so a portable field belongs there once rather than in one
 * provider's override. What is left is the set that only Claude Code acts on,
 * and putting one of those in the canonical file would push a Claude-only key
 * into the other three providers' copies.
 */
export const CLAUDE_SKILL_OVERRIDE: ProviderOverrideSchema = {
  kind: 'skill',
  reserved: ['name', 'description', 'license', 'metadata', 'compatibility', 'allowed-tools'],
  fields: [
    {
      name: 'when_to_use',
      type: { kind: 'string' },
      description:
        'Extra trigger context appended to the description in the skill listing. Counts toward the 1,536-character listing cap.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'disable-model-invocation',
      type: { kind: 'boolean' },
      description: 'Prevent Claude from loading the skill automatically; you invoke it with /name.',
      documentation: SKILLS_DOC,
      defaultNote: 'false',
    },
    {
      name: 'user-invocable',
      type: { kind: 'boolean' },
      description: 'Set false when only Claude should invoke the skill.',
      documentation: SKILLS_DOC,
      defaultNote: 'true',
    },
    {
      name: 'argument-hint',
      type: { kind: 'string' },
      description: 'Hint shown during autocomplete, for example [issue-number].',
      documentation: SKILLS_DOC,
    },
    {
      name: 'arguments',
      type: { kind: 'string-list' },
      description: 'Named positional arguments for $name substitution in the skill body.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'disallowed-tools',
      type: { kind: 'string-list' },
      description: "Tools removed from Claude's pool while this skill is active.",
      documentation: SKILLS_DOC,
    },
    {
      name: 'model',
      type: { kind: 'string' },
      description: 'Model used while this skill is active, or inherit.',
      documentation: SKILLS_DOC,
      suggestions: MODEL_SUGGESTIONS,
    },
    {
      name: 'effort',
      type: { kind: 'enum', values: EFFORT_VALUES },
      description: 'Effort level while this skill is active.',
      documentation: SKILLS_DOC,
      defaultNote: 'inherits from the session',
    },
    {
      name: 'context',
      type: { kind: 'enum', values: ['fork'] },
      description:
        'Run the skill in an isolated subagent context. Omit this field to run it inline; the only accepted value is fork.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'agent',
      type: { kind: 'string' },
      description: 'Which subagent type to use when context: fork is set.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'background',
      type: { kind: 'boolean' },
      description:
        'Only applies with context: fork. Set false to wait for the forked subagent in the invoking turn.',
      documentation: SKILLS_DOC,
      defaultNote: 'true',
    },
    {
      name: 'paths',
      type: { kind: 'string-list' },
      description: 'Glob patterns limiting when Claude loads this skill automatically.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'shell',
      type: { kind: 'enum', values: ['bash', 'powershell'] },
      description: 'Shell used for inline command execution in this skill.',
      documentation: SKILLS_DOC,
      defaultNote: 'bash',
    },
    {
      name: 'hooks',
      type: { kind: 'map' },
      description: 'Hooks registered when the skill is invoked.',
      documentation: SKILLS_DOC,
    },
  ],
};

/**
 * Claude Code command fields.
 *
 * Command files accept the skill frontmatter set except `name` and `paths`.
 * `disable-model-invocation` and `user-invocable` are reserved on top of that:
 * a canonical command is developer-invoked by definition, the adapter already
 * emits `disable-model-invocation: true`, and letting an override flip either
 * one would quietly contradict the canonical model.
 */
export const CLAUDE_COMMAND_OVERRIDE: ProviderOverrideSchema = {
  kind: 'command',
  reserved: [
    'name',
    'description',
    'prompt',
    'template',
    'paths',
    'disable-model-invocation',
    'user-invocable',
  ],
  fields: [
    {
      name: 'metadata',
      type: { kind: 'string-map' },
      description: 'String metadata accepted from the Agent Skills specification.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'license',
      type: { kind: 'string' },
      description: 'License name or reference accepted by command compatibility syntax.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'compatibility',
      type: { kind: 'string' },
      description: 'Environment requirements accepted by command compatibility syntax.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'argument-hint',
      type: { kind: 'string' },
      description: 'Hint shown during autocomplete, for example [issue-number].',
      documentation: SKILLS_DOC,
    },
    {
      name: 'arguments',
      type: { kind: 'string-list' },
      description: 'Named positional arguments for $name substitution in the command body.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'allowed-tools',
      type: { kind: 'string-list' },
      description: 'Tools pre-approved for the turn that invokes this command.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'disallowed-tools',
      type: { kind: 'string-list' },
      description: "Tools removed from Claude's pool while this command is active.",
      documentation: SKILLS_DOC,
    },
    {
      name: 'model',
      type: { kind: 'string' },
      description: 'Model used while this command is active, or inherit.',
      documentation: SKILLS_DOC,
      suggestions: MODEL_SUGGESTIONS,
    },
    {
      name: 'effort',
      type: { kind: 'enum', values: EFFORT_VALUES },
      description: 'Effort level while this command is active.',
      documentation: SKILLS_DOC,
      defaultNote: 'inherits from the session',
    },
    {
      name: 'context',
      type: { kind: 'enum', values: ['fork'] },
      description:
        'Run the command in an isolated subagent context. Omit this field to run it inline; the only accepted value is fork.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'agent',
      type: { kind: 'string' },
      description: 'Which subagent type to use when context: fork is set.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'background',
      type: { kind: 'boolean' },
      description: 'Only applies with context: fork. Set false to wait for the forked subagent.',
      documentation: SKILLS_DOC,
      defaultNote: 'true',
    },
    {
      name: 'when_to_use',
      type: { kind: 'string' },
      description: 'Extra context shown alongside the description in listings.',
      documentation: SKILLS_DOC,
    },
    {
      name: 'shell',
      type: { kind: 'enum', values: ['bash', 'powershell'] },
      description: 'Shell used for inline command execution in this command.',
      documentation: SKILLS_DOC,
      defaultNote: 'bash',
    },
    {
      name: 'hooks',
      type: { kind: 'map' },
      description: 'Hooks registered when the command is invoked.',
      documentation: SKILLS_DOC,
    },
  ],
};

export const CLAUDE_OVERRIDES: readonly ProviderOverrideSchema[] = [
  CLAUDE_AGENT_OVERRIDE,
  CLAUDE_SKILL_OVERRIDE,
  CLAUDE_COMMAND_OVERRIDE,
];

/** Exposed for the documentation test, which checks every field is documented. */
export const claudeOverrideFields = (): readonly OverrideField[] =>
  CLAUDE_OVERRIDES.flatMap((schema) => schema.fields);
