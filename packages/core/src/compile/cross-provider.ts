import type { ProviderAdapter } from '../adapter/adapter.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import { compareStrings } from '../domain/ordering.js';
import type { ProviderId } from '../domain/provider.js';
import { CONFIG_PATH } from '../parse/config.js';

/**
 * The part of a compiled artifact this check needs.
 *
 * Narrower than `CompiledArtifact` on purpose: it keeps the dependency
 * one-directional, and it documents that the check reads ownership and
 * provenance only — never content.
 */
export interface OwnedPath {
  readonly path: string;
  readonly providers: readonly ProviderId[];
  /** Canonical origin, `<kind>/<name>`, or `null` for an aggregate. */
  readonly source: string | null;
}

/** How many canonical sources a message names before it summarizes. */
const MAX_NAMED_SOURCES = 3;

/**
 * Reports where one enabled provider will consume another's generated output.
 *
 * This cannot live in an adapter — `compile` cannot see which other providers
 * are enabled — and the facts it needs are provider-specific, which cannot live
 * in core. So the facts arrive as adapter-declared data and only the matching
 * happens here.
 *
 * The diagnostic points at `.ai/config.yaml`: the hazard is caused by the
 * enabled provider combination, not by any canonical item, and that file is
 * where the combination is decided.
 */
export const crossProviderDiagnostics = (
  adapters: readonly ProviderAdapter[],
  artifacts: readonly OwnedPath[],
): readonly Diagnostic[] => {
  const displayNames = new Map(adapters.map((adapter) => [adapter.id, adapter.displayName]));
  const diagnostics: Diagnostic[] = [];

  for (const adapter of [...adapters].sort((a, b) => compareStrings(a.id, b.id))) {
    for (const intake of adapter.alsoReads ?? []) {
      const owners = new Set<ProviderId>();
      const sources = new Set<string>();

      for (const artifact of artifacts) {
        // An artifact the consuming provider owns is not foreign to it, even
        // when it sits under a declared intake.
        if (!isWithin(artifact.path, intake.path) || artifact.providers.includes(adapter.id)) {
          continue;
        }
        for (const provider of artifact.providers) {
          owners.add(provider);
        }
        if (artifact.source !== null) {
          sources.add(artifact.source);
        }
      }

      if (owners.size === 0) {
        continue;
      }

      const ownerNames = [...owners]
        .sort(compareStrings)
        .map((id) => displayNames.get(id) ?? id)
        .join(' and ');

      diagnostics.push({
        code: intake.code,
        severity: 'warning',
        message: `${adapter.displayName} also reads '${intake.path}', which AI Config generates for ${ownerNames}${describeSources(sources)}. ${intake.consequence}`,
        source: CONFIG_PATH,
        provider: adapter.id,
      });
    }
  }

  return diagnostics;
};

/**
 * Segment-aware prefix match.
 *
 * A plain `startsWith` would report `.agents/skills-extra/x.md` as living under
 * `.agents/skills`, which is a different directory.
 */
const isWithin = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/** Names the canonical items involved, so the warning is actionable. */
const describeSources = (sources: ReadonlySet<string>): string => {
  if (sources.size === 0) {
    return '';
  }

  const sorted = [...sources].sort(compareStrings);
  if (sorted.length <= MAX_NAMED_SOURCES) {
    return ` (${sorted.join(', ')})`;
  }

  const remaining = sorted.length - MAX_NAMED_SOURCES;
  return ` (${sorted.slice(0, MAX_NAMED_SOURCES).join(', ')}, and ${String(remaining)} more)`;
};
