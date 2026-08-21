import type {
  AiConfiguration,
  AiInstruction,
  CompileResult,
  Diagnostic,
  FrontmatterField,
  GeneratedFile,
  ProviderAdapter,
  ProviderOverlay,
  ProviderOverrideSchema,
} from '@aiconfig/core';
import {
  GENERATED_INSTRUCTIONS_HEADER,
  normalizeGeneratedText,
  orderedOptionFields,
  overrideFor,
  renderMarkdownDocument,
} from '@aiconfig/core';

import {
  COPILOT_AGENT_OVERRIDE,
  COPILOT_COMMAND_OVERRIDE,
  COPILOT_INSTRUCTION_OVERRIDE,
  COPILOT_OVERRIDES,
} from './overrides.js';
import { compileSkills, SKILLS_DIRECTORY } from './skills.js';

export {
  COPILOT_AGENT_OVERRIDE,
  COPILOT_COMMAND_OVERRIDE,
  COPILOT_INSTRUCTION_OVERRIDE,
  COPILOT_OVERRIDES,
  COPILOT_SKILL_OVERRIDE,
} from './overrides.js';

export const COPILOT_PROVIDER_ID = 'copilot';

export const REPOSITORY_INSTRUCTIONS_PATH = '.github/copilot-instructions.md';
export const INSTRUCTIONS_DIRECTORY = '.github/instructions';
export const AGENTS_DIRECTORY = '.github/agents';
export { SKILLS_DIRECTORY } from './skills.js';
export const PROMPTS_DIRECTORY = '.github/prompts';

/**
 * GitHub Copilot documents a 30,000-character maximum for a custom agent body.
 *
 * The limit lives here rather than in core because it is conditional on Copilot
 * being enabled; core carries only unconditional canonical rules.
 */
export const AGENT_BODY_MAX_LENGTH = 30_000;

/**
 * GitHub Copilot adapter.
 *
 * See `docs/providers/copilot.md`. Instructions, agents and skills map
 * natively; commands map structurally but reach fewer surfaces, so they warn.
 */
export class CopilotAdapter implements ProviderAdapter {
  public readonly id = COPILOT_PROVIDER_ID;
  public readonly displayName = 'GitHub Copilot';

  /**
   * Each entry is a specific `.github/` child, never `.github` itself: that
   * directory holds workflows, issue templates and much else that has nothing
   * to do with Copilot.
   */
  public readonly targetRoots: readonly string[] = [
    REPOSITORY_INSTRUCTIONS_PATH,
    AGENTS_DIRECTORY,
    INSTRUCTIONS_DIRECTORY,
    PROMPTS_DIRECTORY,
    SKILLS_DIRECTORY,
  ];

  public readonly overrides: readonly ProviderOverrideSchema[] = COPILOT_OVERRIDES;

  public compile(configuration: AiConfiguration, overlay?: ProviderOverlay): CompileResult {
    const files: GeneratedFile[] = [];
    const diagnostics: Diagnostic[] = [];

    const unscoped = configuration.instructions.filter(
      (instruction) => instruction.applyTo.length === 0,
    );
    const scoped = configuration.instructions.filter(
      (instruction) => instruction.applyTo.length > 0,
    );

    if (unscoped.length > 0) {
      files.push({
        path: REPOSITORY_INSTRUCTIONS_PATH,
        source: null,
        content: { kind: 'text', value: renderRepositoryInstructions(unscoped) },
      });
    }

    for (const instruction of scoped) {
      const comma = instruction.applyTo.find((pattern) => pattern.includes(','));
      if (comma !== undefined) {
        // Copilot separates multiple globs with commas, so a comma inside one
        // pattern — as in the brace expansion `src/**/*.{ts,tsx}` — would be
        // split into two broken patterns that match nothing. Silently emitting
        // that is worse than refusing.
        diagnostics.push({
          code: 'INVALID_APPLY_TO',
          severity: 'error',
          message: `GitHub Copilot separates 'applyTo' patterns with commas, so the pattern '${comma}' in '${instruction.name}' cannot be represented. Split it into separate patterns, for example 'src/**/*.ts' and 'src/**/*.tsx'.`,
          source: instruction.sourcePath,
          provider: COPILOT_PROVIDER_ID,
        });
        continue;
      }

      files.push(renderScopedInstruction(instruction, overlay));
    }

    const agents = compileAgents(configuration, overlay);
    files.push(...agents.files);
    diagnostics.push(...agents.diagnostics);

    const skills = compileSkills(configuration, overlay);
    files.push(...skills.files);
    diagnostics.push(...skills.diagnostics);

    const commands = compileCommands(configuration, overlay);
    files.push(...commands.files);
    diagnostics.push(...commands.diagnostics);

    return { files, diagnostics };
  }
}

export const copilotAdapter = new CopilotAdapter();

/**
 * Unscoped instructions go to the repository-wide file.
 *
 * That file is honoured on more Copilot surfaces than path-specific
 * instructions, so an instruction with no scope reaches the most places by
 * living there. AI Config owns the file in full.
 */
const renderRepositoryInstructions = (instructions: readonly AiInstruction[]): string => {
  const sections = [GENERATED_INSTRUCTIONS_HEADER];

  for (const instruction of instructions) {
    const lines = [`## ${instruction.name}`, ''];
    if (instruction.description !== undefined) {
      lines.push(instruction.description, '');
    }
    lines.push(instruction.body);
    sections.push(lines.join('\n'));
  }

  return normalizeGeneratedText(sections.join('\n\n'));
};

/**
 * Scoped instructions become path-specific instruction files.
 *
 * Copilot expects `applyTo` as a single string, with multiple globs separated
 * by commas — not as a YAML list.
 *
 * VS Code supports `name` and `description` frontmatter, but GitHub's broader
 * repository-instruction documentation does not. AI Config therefore keeps the
 * canonical description in the body so the generated file stays meaningful on
 * every documented Copilot surface.
 */
const renderScopedInstruction = (
  instruction: AiInstruction,
  overlay?: ProviderOverlay,
): GeneratedFile => {
  const body =
    instruction.description === undefined
      ? instruction.body
      : `${instruction.description}\n\n${instruction.body}`;

  const override = overrideFor(overlay, 'instruction', instruction.name);
  const fields: FrontmatterField[] = [
    ['applyTo', instruction.applyTo.join(',')],
    ...(override === undefined
      ? []
      : orderedOptionFields(COPILOT_INSTRUCTION_OVERRIDE, override.options)),
  ];

  return {
    path: `${INSTRUCTIONS_DIRECTORY}/${instruction.name}.instructions.md`,
    source: { kind: 'instruction', name: instruction.name },
    content: { kind: 'text', value: renderMarkdownDocument(fields, body) },
  };
};

interface CompiledGroup {
  readonly files: readonly GeneratedFile[];
  readonly diagnostics: readonly Diagnostic[];
}

const compileAgents = (
  configuration: AiConfiguration,
  overlay?: ProviderOverlay,
): CompiledGroup => {
  const files: GeneratedFile[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const agent of configuration.agents) {
    if (agent.body.length > AGENT_BODY_MAX_LENGTH) {
      // Emitting a file Copilot would reject helps nobody, so this blocks the
      // sync rather than producing invalid output.
      diagnostics.push({
        code: 'AGENT_BODY_TOO_LONG',
        severity: 'error',
        message: `GitHub Copilot limits a custom agent to ${AGENT_BODY_MAX_LENGTH.toLocaleString('en-US')} characters; '${agent.name}' has ${agent.body.length.toLocaleString('en-US')}. Shorten it, or move detail into a skill.`,
        source: agent.sourcePath,
        provider: COPILOT_PROVIDER_ID,
      });
      continue;
    }

    const override = overrideFor(overlay, 'agent', agent.name);
    const fields: FrontmatterField[] = [
      ['name', agent.name],
      ['description', agent.description],
      ...(override === undefined
        ? []
        : orderedOptionFields(COPILOT_AGENT_OVERRIDE, override.options)),
    ];

    files.push({
      path: `${AGENTS_DIRECTORY}/${agent.name}.agent.md`,
      source: { kind: 'agent', name: agent.name },
      content: { kind: 'text', value: renderMarkdownDocument(fields, agent.body) },
    });
  }

  return { files, diagnostics };
};

/**
 * Commands become prompt files.
 *
 * The structural mapping is exact, but prompt files are documented as
 * available only in VS Code, Visual Studio and JetBrains IDEs — not to the
 * cloud agent, code review, or the CLI. That reduction in reach is reported
 * rather than assumed acceptable.
 *
 * GitHub also qualifies the feature itself as "in public preview and subject to
 * change". A provider's own qualification of a target AI Config generates onto
 * belongs in the diagnostic, not only in this repository's research notes.
 */
const compileCommands = (
  configuration: AiConfiguration,
  overlay?: ProviderOverlay,
): CompiledGroup => {
  const files: GeneratedFile[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const command of configuration.commands) {
    const override = overrideFor(overlay, 'command', command.name);
    const fields: FrontmatterField[] = [
      ['description', command.description],
      ...(override === undefined
        ? []
        : orderedOptionFields(COPILOT_COMMAND_OVERRIDE, override.options)),
    ];

    files.push({
      path: `${PROMPTS_DIRECTORY}/${command.name}.prompt.md`,
      source: { kind: 'command', name: command.name },
      content: { kind: 'text', value: renderMarkdownDocument(fields, command.body) },
    });

    diagnostics.push({
      code: 'COMMAND_LIMITED_SURFACE',
      severity: 'warning',
      message: `'${command.name}' is generated as a GitHub Copilot prompt file, which is available only in VS Code, Visual Studio and JetBrains IDEs. It will not be available to the Copilot cloud agent, Copilot code review, or the Copilot CLI. GitHub documents prompt files as in public preview and subject to change.`,
      source: command.sourcePath,
      provider: COPILOT_PROVIDER_ID,
      capability: 'lossy',
    });
  }

  return { files, diagnostics };
};
