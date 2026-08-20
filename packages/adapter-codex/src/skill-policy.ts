import type { FrontmatterField } from '@aiconfig/core';
import { renderYamlEntries } from '@aiconfig/core';

/**
 * The configuration sidecar Codex reads from inside a skill directory.
 *
 * Codex documents `agents/openai.yaml` with three optional sections —
 * `interface`, `policy` and `dependencies` — and no key within them is
 * documented as required.
 *
 * Verified behaviourally against codex-cli 0.145.0 on 2026-08-15: a
 * repository-local skill carrying only a `policy` section is still discovered
 * and still loads on explicit `$name` invocation. Note the scope — plugin
 * submission and package validation may impose stricter `interface`
 * requirements than repository-local skills under `.agents/skills` do.
 */
export const SKILL_POLICY_FILE = 'agents/openai.yaml';

/** Renders the sidecar for a command that may not be selected implicitly. */
export const renderSkillPolicy = (): string =>
  renderSidecar([['policy', { allow_implicit_invocation: false }]]);

/** Renders the sidecar from validated override options. */
export const renderSidecar = (fields: readonly FrontmatterField[]): string =>
  `${renderYamlEntries(fields).join('\n')}\n`;
