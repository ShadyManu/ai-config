import type {
  AiConfiguration,
  AiSkill,
  Diagnostic,
  GeneratedFile,
  ProviderArtifactOverride,
  ProviderOverlay,
} from '@aiconfig/core';
import {
  SKILL_ENTRYPOINT,
  orderedOptionFields,
  overrideFor,
  renderYamlEntries,
  skillArtifacts,
  spliceFrontmatter,
} from '@aiconfig/core';

import { CLAUDE_SKILL_OVERRIDE } from './overrides.js';
import { CLAUDE_PROVIDER_ID } from './provider.js';

export const SKILLS_DIRECTORY = '.claude/skills';

export interface CompiledSkills {
  readonly files: readonly GeneratedFile[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Mirrors canonical skills into `.claude/skills/`.
 *
 * Every file is copied byte-for-byte, with one exception: when a skill carries
 * a Claude override, `SKILL.md` is regenerated so Claude-only fields reach
 * Claude Code without being pushed into the other providers' copies. Even then
 * the canonical bytes are preserved — the override lines are appended at the
 * end of the existing frontmatter block and the body is untouched — so the
 * generated file differs from the canonical one by exactly those lines.
 */
export const compileSkills = (
  configuration: AiConfiguration,
  overlay?: ProviderOverlay,
): CompiledSkills => {
  const diagnostics: Diagnostic[] = [];
  const replaced = new Map<string, GeneratedFile>();

  for (const skill of configuration.skills) {
    const override = overrideFor(overlay, 'skill', skill.name);
    if (override === undefined) {
      continue;
    }
    const entrypoint = renderEntrypoint(skill, override, diagnostics);
    if (entrypoint !== undefined) {
      replaced.set(`${SKILLS_DIRECTORY}/${skill.name}/${SKILL_ENTRYPOINT}`, entrypoint);
    }
  }

  const files = skillArtifacts(configuration, SKILLS_DIRECTORY).map(
    (artifact) => replaced.get(artifact.path) ?? artifact,
  );

  return { files, diagnostics };
};

const renderEntrypoint = (
  skill: AiSkill,
  override: ProviderArtifactOverride,
  diagnostics: Diagnostic[],
): GeneratedFile | undefined => {
  const fields = orderedOptionFields(CLAUDE_SKILL_OVERRIDE, override.options);

  // A key the canonical file already sets would be written twice into one
  // mapping. Which of the two a parser keeps is not something to guess at, and
  // silently dropping either would lose something the author wrote.
  const canonical = new Set(skill.entrypointKeys);
  const colliding = fields.map(([key]) => key).filter((key) => canonical.has(key));
  if (colliding.length > 0) {
    diagnostics.push({
      code: 'OVERRIDE_CANONICAL_FIELD',
      severity: 'error',
      provider: CLAUDE_PROVIDER_ID,
      source: override.sourcePath,
      message: `${colliding.join(', ')} already ${colliding.length === 1 ? 'appears' : 'appear'} in ${skill.sourcePath}/${SKILL_ENTRYPOINT}. Set the value in one place: remove it from the override, or from the canonical skill.`,
    });
    return undefined;
  }

  if (fields.length === 0) {
    return undefined;
  }

  return {
    path: `${SKILLS_DIRECTORY}/${skill.name}/${SKILL_ENTRYPOINT}`,
    source: { kind: 'skill', name: skill.name },
    content: {
      kind: 'text',
      value: spliceFrontmatter(skill.entrypointText, renderYamlEntries(fields)),
    },
  };
};
