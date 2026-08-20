import type { AiConfiguration } from '../domain/configuration.js';
import type { Diagnostic } from '../domain/diagnostic.js';

/**
 * Canonical validation that spans more than one item.
 *
 * Per-item rules are applied during parsing, where the source position is
 * known. Only cross-cutting rules live here.
 */
export const validateConfiguration = (configuration: AiConfiguration): readonly Diagnostic[] => [
  ...duplicateInvocableNames(configuration),
];

/**
 * A skill and a command must not share a name.
 *
 * Both are invoked under a single `/` namespace by several providers: Claude
 * Code documents that a skill shadows a command of the same name, and a Codex
 * command is converted into a skill, landing in the same directory. Resolving
 * this differently per provider would make the same configuration mean
 * different things, so it is rejected canonically.
 */
const duplicateInvocableNames = (configuration: AiConfiguration): readonly Diagnostic[] => {
  const skillNames = new Set(configuration.skills.map((skill) => skill.name));

  return configuration.commands
    .filter((command) => skillNames.has(command.name))
    .map((command) => ({
      code: 'DUPLICATE_INVOCABLE_NAME',
      severity: 'error' as const,
      message: `'${command.name}' is both a command and a skill. Providers invoke both under the same '/' namespace, and one would shadow the other. Rename one of them.`,
      source: command.sourcePath,
    }));
};
