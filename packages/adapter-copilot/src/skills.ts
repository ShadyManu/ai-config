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

import { COPILOT_SKILL_OVERRIDE } from './overrides.js';

const COPILOT_PROVIDER_ID = 'copilot';
export const SKILLS_DIRECTORY = '.github/skills';

export interface CompiledSkills {
  readonly files: readonly GeneratedFile[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Mirrors skills and adds only Copilot-specific fields to SKILL.md. */
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

  return {
    files: skillArtifacts(configuration, SKILLS_DIRECTORY).map(
      (artifact) => replaced.get(artifact.path) ?? artifact,
    ),
    diagnostics,
  };
};

const renderEntrypoint = (
  skill: AiSkill,
  override: ProviderArtifactOverride,
  diagnostics: Diagnostic[],
): GeneratedFile | undefined => {
  const fields = orderedOptionFields(COPILOT_SKILL_OVERRIDE, override.options);
  const canonical = new Set(skill.entrypointKeys);
  const colliding = fields.map(([key]) => key).filter((key) => canonical.has(key));

  if (colliding.length > 0) {
    diagnostics.push({
      code: 'OVERRIDE_CANONICAL_FIELD',
      severity: 'error',
      provider: COPILOT_PROVIDER_ID,
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
