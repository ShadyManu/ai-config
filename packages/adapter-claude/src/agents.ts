import type {
  AiConfiguration,
  FrontmatterField,
  GeneratedFile,
  ProviderOverlay,
} from '@aiconfig/core';
import { orderedOptionFields, overrideFor, renderMarkdownDocument } from '@aiconfig/core';

import { CLAUDE_AGENT_OVERRIDE } from './overrides.js';

export const AGENTS_DIRECTORY = '.claude/agents';

/**
 * Compiles agents into `.claude/agents/`.
 *
 * `name` and `description` come from the canonical agent and are always first.
 * Everything after them comes from an optional provider override and is
 * emitted in the schema's declared field order, so the generated file does not
 * depend on how the user happened to order keys in their YAML.
 */
export const compileAgents = (
  configuration: AiConfiguration,
  overlay?: ProviderOverlay,
): readonly GeneratedFile[] =>
  configuration.agents.map((agent) => {
    const override = overrideFor(overlay, 'agent', agent.name);
    const fields: FrontmatterField[] = [
      ['name', agent.name],
      ['description', agent.description],
      ...(override === undefined
        ? []
        : orderedOptionFields(CLAUDE_AGENT_OVERRIDE, override.options)),
    ];

    return {
      path: `${AGENTS_DIRECTORY}/${agent.name}.md`,
      source: { kind: 'agent' as const, name: agent.name },
      content: { kind: 'text' as const, value: renderMarkdownDocument(fields, agent.body) },
    };
  });
