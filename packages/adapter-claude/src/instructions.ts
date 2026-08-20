import type {
  AiConfiguration,
  AiInstruction,
  FrontmatterField,
  GeneratedFile,
} from '@aiconfig/core';
import { renderMarkdownDocument } from '@aiconfig/core';

export const RULES_DIRECTORY = '.claude/rules';

/**
 * Compiles instructions into `.claude/rules/`.
 *
 * `.claude/rules/` rather than `CLAUDE.md` for two reasons: it gives one
 * generated file per canonical instruction, so ownership and drift detection
 * stay precise, and it leaves any hand-written `CLAUDE.md` alone. Rules without
 * a `paths` field load with the same priority as `.claude/CLAUDE.md`, so
 * unscoped instructions lose nothing.
 */
export const compileInstructions = (configuration: AiConfiguration): readonly GeneratedFile[] => {
  return configuration.instructions.map((instruction) => {
    const fields: FrontmatterField[] = [];

    // Claude Code's `paths` is the direct equivalent of canonical `applyTo`,
    // and is the only frontmatter field documented for a rules file.
    if (instruction.applyTo.length > 0) {
      fields.push(['paths', instruction.applyTo]);
    }

    return {
      path: `${RULES_DIRECTORY}/${instruction.name}.md`,
      source: { kind: 'instruction', name: instruction.name },
      content: {
        kind: 'text',
        value: renderMarkdownDocument(fields, renderBody(instruction)),
      },
    };
  });
};

/**
 * Carries the canonical description into the body.
 *
 * `paths` is the only frontmatter field Claude Code documents for a rules file,
 * so emitting `description` would rely on undocumented tolerance. Discarding
 * the text instead would lose something the author wrote deliberately, so it
 * becomes the opening paragraph — the same treatment `adapter-copilot` gives
 * `.github/instructions/*.instructions.md`, where no `description` field is
 * documented either.
 *
 * If Anthropic documents a `description` field for rules, this reverts to
 * frontmatter with the citation recorded in `docs/providers/claude.md`.
 */
const renderBody = (instruction: AiInstruction): string =>
  instruction.description === undefined
    ? instruction.body
    : `${instruction.description}\n\n${instruction.body}`;
