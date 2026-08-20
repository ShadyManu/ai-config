import type { AiConfiguration, AiInstruction, Diagnostic, ProviderId } from '@aiconfig/core';
import { GENERATED_INSTRUCTIONS_HEADER, normalizeGeneratedText } from '@aiconfig/core';

export const AGENTS_MD_PATH = 'AGENTS.md';

export interface AgentsMarkdown {
  readonly path: string;
  readonly content: string;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Renders the root `AGENTS.md` read by both Codex and OpenCode.
 *
 * Shared rather than implemented twice: both providers must receive
 * byte-identical content, and the synchronization planner treats a mismatch as
 * a hard error. Sharing the renderer makes that identity structural instead of
 * something two independent implementations happen to agree on.
 *
 * `provider` only tags the diagnostics — the rendered bytes never depend on it.
 */
export const renderAgentsMarkdown = (
  configuration: AiConfiguration,
  provider: ProviderId,
  providerName: string,
): AgentsMarkdown => {
  const sections: string[] = [GENERATED_INSTRUCTIONS_HEADER];
  const diagnostics: Diagnostic[] = [];

  for (const instruction of configuration.instructions) {
    sections.push(renderInstruction(instruction));

    if (instruction.applyTo.length > 0) {
      // AGENTS.md has no frontmatter and no glob scoping. The scope is stated
      // in prose so it is not lost, but the model applies the instruction
      // unconditionally, which is a genuine reduction in fidelity.
      diagnostics.push({
        code: 'INSTRUCTION_SCOPE_NOT_SUPPORTED',
        severity: 'warning',
        message: `${providerName} has no path-scoped instructions. '${instruction.name}' will apply to all files; its intended scope (${instruction.applyTo.join(', ')}) is recorded in ${AGENTS_MD_PATH} as prose only.`,
        source: instruction.sourcePath,
        provider,
        capability: 'lossy',
      });
    }
  }

  return {
    path: AGENTS_MD_PATH,
    content: normalizeGeneratedText(sections.join('\n\n')),
    diagnostics,
  };
};

const renderInstruction = (instruction: AiInstruction): string => {
  const lines = [`## ${instruction.name}`, ''];

  if (instruction.description !== undefined) {
    lines.push(instruction.description, '');
  }

  if (instruction.applyTo.length > 0) {
    lines.push(
      `Applies to: ${instruction.applyTo.map((pattern) => `\`${pattern}\``).join(', ')}`,
      '',
    );
  }

  lines.push(instruction.body);
  return lines.join('\n');
};
