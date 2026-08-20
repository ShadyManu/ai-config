import type {
  AiConfiguration,
  FrontmatterField,
  GeneratedFile,
  ProviderOverlay,
} from '@aiconfig/core';
import { orderedOptionFields, overrideFor, renderMarkdownDocument } from '@aiconfig/core';

import { CLAUDE_COMMAND_OVERRIDE } from './overrides.js';

export const COMMANDS_DIRECTORY = '.claude/commands';

/**
 * Compiles commands into `.claude/commands/`.
 *
 * Claude Code has merged custom commands into skills, but `.claude/commands/`
 * remains a documented, supported location, and it keeps generated commands in
 * a namespace separate from generated skills.
 *
 * The location does **not** by itself preserve the canonical
 * developer-invoked-only intent, and this adapter does not claim it does. The
 * documentation states that a command file and a skill "work the same way",
 * while elsewhere listing automatic loading among the features skills add over
 * commands, so whether Claude may select a command file on its own cannot be
 * determined from it. `disable-model-invocation` is what makes the intent
 * enforced rather than assumed, and it is documented as valid in a command
 * file. See `docs/providers/claude.md`.
 */
export const compileCommands = (
  configuration: AiConfiguration,
  overlay?: ProviderOverlay,
): readonly GeneratedFile[] => {
  return configuration.commands.map((command) => {
    const override = overrideFor(overlay, 'command', command.name);
    const fields: FrontmatterField[] = [
      ['description', command.description],
      // Documented for command files: "Files in `.claude/commands/` support the
      // same frontmatter, except `name` and `paths`". Correct under both
      // readings of the ambiguity above — it either enforces the intent or is
      // inert — which is why it can be emitted without resolving the conflict.
      // It is reserved against overrides for the same reason.
      ['disable-model-invocation', true],
      ...(override === undefined
        ? []
        : orderedOptionFields(CLAUDE_COMMAND_OVERRIDE, override.options)),
    ];

    return {
      path: `${COMMANDS_DIRECTORY}/${command.name}.md`,
      source: { kind: 'command' as const, name: command.name },
      content: { kind: 'text' as const, value: renderMarkdownDocument(fields, command.body) },
    };
  });
};
