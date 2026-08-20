import type {
  AiConfiguration,
  CompileResult,
  Diagnostic,
  FrontmatterField,
  GeneratedFile,
  ProviderAdapter,
  ProviderOverlay,
  ProviderOverrideSchema,
} from '@aiconfig/core';
import {
  SKILL_ENTRYPOINT,
  orderedOptionFields,
  overrideFor,
  renderMarkdownDocument,
  skillArtifacts,
} from '@aiconfig/core';
import { AGENTS_MD_PATH, renderAgentsMarkdown } from '@aiconfig/agents-md';

import { CODEX_AGENT_OVERRIDE, CODEX_OVERRIDES, CODEX_SKILL_OVERRIDE } from './overrides.js';
import { SKILL_POLICY_FILE, renderSidecar, renderSkillPolicy } from './skill-policy.js';
import { renderToml } from './toml.js';

export const CODEX_PROVIDER_ID = 'codex';

export const CODEX_AGENTS_DIRECTORY = '.codex/agents';
export const CODEX_SKILLS_DIRECTORY = '.agents/skills';

export { CODEX_AGENT_OVERRIDE, CODEX_OVERRIDES, CODEX_SKILL_OVERRIDE } from './overrides.js';

/**
 * OpenAI Codex adapter.
 *
 * See `docs/providers/codex.md`. One mapping is lossy and warns: scoped
 * instructions, because Codex has no glob scoping. Commands become skills,
 * which is lossless — Codex documents a per-skill control for implicit
 * selection — but reports informationally, because the invocation syntax
 * changes.
 */
export class CodexAdapter implements ProviderAdapter {
  public readonly id = CODEX_PROVIDER_ID;
  public readonly displayName = 'Codex';

  public readonly targetRoots: readonly string[] = [
    AGENTS_MD_PATH,
    CODEX_AGENTS_DIRECTORY,
    CODEX_SKILLS_DIRECTORY,
  ];

  /**
   * No instruction or command override is declared. Codex reads instructions
   * from `AGENTS.md`, which takes no frontmatter, and has no repository-scoped
   * command mechanism at all — its custom prompts are documented as deprecated
   * and are user-scoped.
   */
  public readonly overrides: readonly ProviderOverrideSchema[] = CODEX_OVERRIDES;

  public compile(configuration: AiConfiguration, overlay?: ProviderOverlay): CompileResult {
    const files: GeneratedFile[] = [];
    const diagnostics: Diagnostic[] = [];

    if (configuration.instructions.length > 0) {
      const agentsMarkdown = renderAgentsMarkdown(configuration, this.id, this.displayName);
      files.push({
        path: agentsMarkdown.path,
        // AGENTS.md aggregates every instruction, so it has no single source.
        source: null,
        content: { kind: 'text', value: agentsMarkdown.content },
      });
      diagnostics.push(...agentsMarkdown.diagnostics);
    }

    files.push(...compileAgents(configuration, overlay));
    files.push(...skillArtifacts(configuration, CODEX_SKILLS_DIRECTORY));
    files.push(...compileSkillSidecars(configuration, overlay));

    const commands = compileCommands(configuration, this.displayName);
    files.push(...commands.files);
    diagnostics.push(...commands.diagnostics);

    return { files, diagnostics };
  }
}

export const codexAdapter = new CodexAdapter();

const compileAgents = (
  configuration: AiConfiguration,
  overlay?: ProviderOverlay,
): readonly GeneratedFile[] => {
  return configuration.agents.map((agent) => {
    const override = overrideFor(overlay, 'agent', agent.name);
    const options =
      override === undefined ? [] : orderedOptionFields(CODEX_AGENT_OVERRIDE, override.options);

    return {
      path: `${CODEX_AGENTS_DIRECTORY}/${agent.name}.toml`,
      source: { kind: 'agent' as const, name: agent.name },
      content: {
        kind: 'text' as const,
        // Codex takes agent identity from the `name` field, not the filename.
        value: renderToml([
          { key: 'name', value: agent.name },
          { key: 'description', value: agent.description },
          { key: 'developer_instructions', value: agent.body.trim(), multiline: true },
          ...options.map(([key, value]) => ({ key, value })),
        ]),
      },
    };
  });
};

/**
 * Writes `agents/openai.yaml` beside a canonical skill that carries an override.
 *
 * Only ever generated for a skill the user configured. A canonical skill is
 * otherwise copied byte-for-byte, and generating an unrequested file inside one
 * would claim ownership of a path inside a user-authored tree.
 */
const compileSkillSidecars = (
  configuration: AiConfiguration,
  overlay?: ProviderOverlay,
): readonly GeneratedFile[] => {
  const files: GeneratedFile[] = [];

  for (const skill of configuration.skills) {
    const override = overrideFor(overlay, 'skill', skill.name);
    if (override === undefined) {
      continue;
    }
    const fields: readonly FrontmatterField[] = orderedOptionFields(
      CODEX_SKILL_OVERRIDE,
      override.options,
    );
    if (fields.length === 0) {
      continue;
    }
    files.push({
      path: `${CODEX_SKILLS_DIRECTORY}/${skill.name}/${SKILL_POLICY_FILE}`,
      source: { kind: 'skill', name: skill.name },
      content: { kind: 'text', value: renderSidecar(fields) },
    });
  }

  return files;
};

interface CompiledCommands {
  readonly files: readonly GeneratedFile[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Converts commands into Codex skills.
 *
 * Codex documents no repository-scoped command or prompt directory, and its
 * user-scoped custom prompts are formally deprecated in favour of skills, so
 * this targets the mechanism OpenAI points at rather than working around a
 * missing one.
 *
 * The conversion is not lossy. A canonical command is meant to be invoked
 * explicitly, and a Codex skill can otherwise also be selected implicitly from
 * prompt context — but Codex documents a per-skill control for exactly that,
 * and it is always emitted. What remains is informational: the invocation
 * syntax changes to `$name`, and the artifact lands in the skills namespace.
 */
const compileCommands = (
  configuration: AiConfiguration,
  providerName: string,
): CompiledCommands => {
  const files: GeneratedFile[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const command of configuration.commands) {
    const skillDirectory = `${CODEX_SKILLS_DIRECTORY}/${command.name}`;

    files.push({
      path: `${skillDirectory}/${SKILL_ENTRYPOINT}`,
      source: { kind: 'command', name: command.name },
      content: {
        kind: 'text',
        value: renderMarkdownDocument(
          [
            ['name', command.name],
            ['description', command.description],
          ],
          command.body,
        ),
      },
    });

    files.push({
      path: `${skillDirectory}/${SKILL_POLICY_FILE}`,
      source: { kind: 'command', name: command.name },
      content: { kind: 'text', value: renderSkillPolicy() },
    });

    diagnostics.push({
      code: 'COMMAND_CONVERTED_TO_SKILL',
      severity: 'info',
      message: `${providerName} has no repository-scoped commands, so '${command.name}' is generated as a skill, invoked with $${command.name} rather than /${command.name}. Implicit selection is disabled through ${SKILL_POLICY_FILE}, so it stays developer-invoked.`,
      source: command.sourcePath,
      provider: CODEX_PROVIDER_ID,
      capability: 'exact',
    });
  }

  return { files, diagnostics };
};
