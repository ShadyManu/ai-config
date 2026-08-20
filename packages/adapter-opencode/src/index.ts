import type {
  AiConfiguration,
  CompileResult,
  Diagnostic,
  ForeignIntake,
  FrontmatterField,
  GeneratedFile,
  ProviderAdapter,
  ProviderOverlay,
  ProviderOverrideSchema,
} from '@aiconfig/core';
import {
  orderedOptionFields,
  overrideFor,
  renderMarkdownDocument,
  skillArtifacts,
} from '@aiconfig/core';
import { AGENTS_MD_PATH, renderAgentsMarkdown } from '@aiconfig/agents-md';

import {
  OPENCODE_AGENT_OVERRIDE,
  OPENCODE_COMMAND_OVERRIDE,
  OPENCODE_OVERRIDES,
} from './overrides.js';

export const OPENCODE_PROVIDER_ID = 'opencode';

export const AGENTS_DIRECTORY = '.opencode/agents';
export const COMMANDS_DIRECTORY = '.opencode/commands';
export const SKILLS_DIRECTORY = '.opencode/skills';

export {
  OPENCODE_AGENT_OVERRIDE,
  OPENCODE_COMMAND_OVERRIDE,
  OPENCODE_OVERRIDES,
} from './overrides.js';

// Skill roots OpenCode reads that another adapter owns. Spelled out literally
// rather than imported: an adapter may not depend on another adapter.
const CLAUDE_SKILLS_ROOT = '.claude/skills';
const SHARED_SKILLS_ROOT = '.agents/skills';

const SKILL_OVERLAP_CONSEQUENCE =
  'OpenCode scans .opencode/skills, .claude/skills and .agents/skills, so those skills are discovered from more than one root. OpenCode documents no resolution for a skill name that appears in several, so which copy wins is undefined.';

/**
 * OpenCode adapter.
 *
 * See `docs/providers/opencode.md`. Agents, commands and skills map natively;
 * scoped instructions cannot be expressed, so they warn.
 *
 * `opencode.json` is deliberately never generated or modified: it is user-owned
 * configuration for models, providers, permissions and MCP servers, none of
 * which has a canonical equivalent, so taking ownership would mean overwriting
 * unrelated settings.
 */
export class OpenCodeAdapter implements ProviderAdapter {
  public readonly id = OPENCODE_PROVIDER_ID;
  public readonly displayName = 'OpenCode';

  /** `opencode.json` is deliberately absent: it is never generated. */
  public readonly targetRoots: readonly string[] = [
    AGENTS_MD_PATH,
    AGENTS_DIRECTORY,
    COMMANDS_DIRECTORY,
    SKILLS_DIRECTORY,
  ];

  /**
   * OpenCode scans `.claude/skills` and `.agents/skills` alongside its own
   * skills directory, so enabling Claude Code or Codex beside it means the same
   * skill is discovered from several roots.
   *
   * No intake is declared for `AGENTS.md`: OpenCode owns that file, jointly
   * with Codex when both are enabled, so it is not foreign to this provider.
   */
  public readonly alsoReads: readonly ForeignIntake[] = [
    {
      path: CLAUDE_SKILLS_ROOT,
      code: 'SKILL_DISCOVERY_OVERLAP',
      consequence: SKILL_OVERLAP_CONSEQUENCE,
    },
    {
      path: SHARED_SKILLS_ROOT,
      code: 'SKILL_DISCOVERY_OVERLAP',
      consequence: SKILL_OVERLAP_CONSEQUENCE,
    },
  ];

  /**
   * No instruction or skill override is declared. OpenCode reads instructions
   * from `AGENTS.md`, which takes no frontmatter, and recognizes five stable
   * Agent Skills fields. Unknown fields are ignored; the canonical experimental
   * `allowed-tools` field is preserved and reported as unsupported.
   */
  public readonly overrides: readonly ProviderOverrideSchema[] = OPENCODE_OVERRIDES;

  public compile(configuration: AiConfiguration, overlay?: ProviderOverlay): CompileResult {
    const files: GeneratedFile[] = [];
    const diagnostics: Diagnostic[] = [];

    if (configuration.instructions.length > 0) {
      const agentsMarkdown = renderAgentsMarkdown(configuration, this.id, this.displayName);
      files.push({
        path: agentsMarkdown.path,
        source: null,
        content: { kind: 'text', value: agentsMarkdown.content },
      });
      diagnostics.push(...agentsMarkdown.diagnostics);
    }

    files.push(...compileAgents(configuration, overlay));
    files.push(...skillArtifacts(configuration, SKILLS_DIRECTORY));
    for (const skill of configuration.skills) {
      if (!skill.entrypointKeys.includes('allowed-tools')) {
        continue;
      }
      diagnostics.push({
        code: 'SKILL_ALLOWED_TOOLS_UNSUPPORTED',
        severity: 'warning',
        message: `'${skill.name}' declares the canonical 'allowed-tools' field, which OpenCode currently ignores. Remove the field if OpenCode is the only consumer, or keep it for other providers and do not rely on it to restrict OpenCode tools.`,
        source: `${skill.sourcePath}/SKILL.md`,
        provider: OPENCODE_PROVIDER_ID,
        capability: 'lossy',
      });
    }
    files.push(...compileCommands(configuration, overlay));

    return { files, diagnostics };
  }
}

export const opencodeAdapter = new OpenCodeAdapter();

/**
 * Compiles agents into `.opencode/agents/`.
 *
 * No `name` field is emitted: OpenCode takes the agent name from the filename.
 * `mode: subagent` is what matches the canonical concept — a specialized helper
 * invoked by a primary agent or by mention, rather than a top-level
 * conversational assistant — and an override may replace it.
 */
const compileAgents = (
  configuration: AiConfiguration,
  overlay?: ProviderOverlay,
): readonly GeneratedFile[] =>
  configuration.agents.map((agent) => {
    const override = overrideFor(overlay, 'agent', agent.name);
    const options =
      override === undefined ? [] : orderedOptionFields(OPENCODE_AGENT_OVERRIDE, override.options);
    const fields: FrontmatterField[] = [
      ['description', agent.description],
      ...(options.some(([key]) => key === 'mode') ? [] : ([['mode', 'subagent']] as const)),
      ...options,
    ];

    return {
      path: `${AGENTS_DIRECTORY}/${agent.name}.md`,
      source: { kind: 'agent' as const, name: agent.name },
      content: { kind: 'text' as const, value: renderMarkdownDocument(fields, agent.body) },
    };
  });

/**
 * Compiles commands into `.opencode/commands/`.
 *
 * The markdown body is the command template, matching the JSON `template`
 * field. Argument placeholders pass through untouched — OpenCode's `$ARGUMENTS`
 * and `$1` syntax is its own, and AI Config does not translate placeholders.
 *
 * `invocation: explicit` needs no field: OpenCode documents a command as typed
 * by the user and no mechanism by which the model selects one. That is an
 * absence of documentation rather than a guarantee, and it is recorded as such
 * in `docs/providers/opencode.md`.
 */
const compileCommands = (
  configuration: AiConfiguration,
  overlay?: ProviderOverlay,
): readonly GeneratedFile[] =>
  configuration.commands.map((command) => {
    const override = overrideFor(overlay, 'command', command.name);
    const fields: FrontmatterField[] = [
      ['description', command.description],
      ...(override === undefined
        ? []
        : orderedOptionFields(OPENCODE_COMMAND_OVERRIDE, override.options)),
    ];

    return {
      path: `${COMMANDS_DIRECTORY}/${command.name}.md`,
      source: { kind: 'command' as const, name: command.name },
      content: { kind: 'text' as const, value: renderMarkdownDocument(fields, command.body) },
    };
  });
