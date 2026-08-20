import type {
  AiConfiguration,
  CompileResult,
  ProviderAdapter,
  ProviderOverlay,
  ProviderOverrideSchema,
} from '@aiconfig/core';
import { AGENTS_DIRECTORY, compileAgents } from './agents.js';
import { COMMANDS_DIRECTORY, compileCommands } from './commands.js';
import { RULES_DIRECTORY, compileInstructions } from './instructions.js';
import { CLAUDE_OVERRIDES } from './overrides.js';
import { CLAUDE_PROVIDER_ID } from './provider.js';
import { SKILLS_DIRECTORY, compileSkills } from './skills.js';

export { CLAUDE_PROVIDER_ID };
export {
  CLAUDE_AGENT_OVERRIDE,
  CLAUDE_COMMAND_OVERRIDE,
  CLAUDE_OVERRIDES,
  CLAUDE_SKILL_OVERRIDE,
} from './overrides.js';

/**
 * Claude Code adapter.
 *
 * Every canonical capability maps onto a documented Claude Code mechanism; see
 * `docs/providers/claude.md` for the documentation each mapping is derived
 * from. The one thing it cannot guarantee is `invocation: automatic` for a
 * command, because the provider's documentation contradicts itself on that
 * point — that case warns rather than being assumed to work.
 */
export class ClaudeAdapter implements ProviderAdapter {
  public readonly id = CLAUDE_PROVIDER_ID;
  public readonly displayName = 'Claude Code';

  public readonly targetRoots: readonly string[] = [
    AGENTS_DIRECTORY,
    COMMANDS_DIRECTORY,
    RULES_DIRECTORY,
    SKILLS_DIRECTORY,
  ];

  /**
   * No instruction override is declared: `.claude/rules/` documents exactly one
   * frontmatter field, `paths`, and that is the canonical `applyTo`.
   */
  public readonly overrides: readonly ProviderOverrideSchema[] = CLAUDE_OVERRIDES;

  public compile(configuration: AiConfiguration, overlay?: ProviderOverlay): CompileResult {
    const skills = compileSkills(configuration, overlay);

    return {
      files: [
        ...compileInstructions(configuration),
        ...compileAgents(configuration, overlay),
        ...skills.files,
        ...compileCommands(configuration, overlay),
      ],
      diagnostics: skills.diagnostics,
    };
  }
}

export const claudeAdapter = new ClaudeAdapter();
