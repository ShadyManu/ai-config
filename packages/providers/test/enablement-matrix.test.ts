import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { AiConfiguration, ProviderAdapter, ProviderId } from '@aiconfig/core';
import { PROVIDER_IDS, compile } from '@aiconfig/core';
import { discoverFixtureConfiguration, exampleRepositoryRoot } from '@aiconfig/core/testing';

import { createDefaultAdapters } from '../src/index.js';

/**
 * Every enabled-provider combination, compiled.
 *
 * `providers.test.ts` checks the all-four case and the one-provider case. The
 * combinations in between are where the interesting failures live: a provider
 * whose output changes because another one is enabled, an aggregate file
 * claimed by the wrong owner, a cross-provider warning that fires once too
 * often or not at all. There are only sixteen subsets of four providers, so
 * there is no reason to sample them.
 *
 * The invariant that matters most is stated first and holds for all sixteen:
 * enabling a provider never changes what another provider generates.
 * `compile` is what enforces it — an adapter cannot see the enabled set — and
 * this is where that guarantee is checked rather than assumed.
 */

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

const adapters = createDefaultAdapters();

const adapterFor = (provider: ProviderId): ProviderAdapter => {
  const adapter = adapters.find((candidate) => candidate.id === provider);
  if (adapter === undefined) {
    throw new Error(`No adapter registered for '${provider}'.`);
  }
  return adapter;
};

const ALL: readonly ProviderId[] = [...PROVIDER_IDS].sort();

/** Every subset of the registered providers, smallest first. */
const SUBSETS: readonly (readonly ProviderId[])[] = Array.from(
  { length: 1 << ALL.length },
  (_unused, mask) => ALL.filter((_provider, index) => (mask & (1 << index)) !== 0),
).sort((a, b) => a.length - b.length || a.join().localeCompare(b.join()));

const name = (subset: readonly ProviderId[]): string =>
  subset.length === 0 ? 'no provider' : subset.join(' + ');

/** Providers that read the shared root `AGENTS.md`, and therefore co-own it. */
const AGENTS_MD_OWNERS: readonly ProviderId[] = ['codex', 'opencode'];

let fixture: AiConfiguration | undefined;

const configuration = async (): Promise<AiConfiguration> => {
  fixture ??= await discoverFixtureConfiguration(exampleRepositoryRoot(testDirectory));
  return fixture;
};

const compileSubset = async (subset: readonly ProviderId[]) =>
  compile(await configuration(), subset.map(adapterFor));

describe('enabled-provider combinations', () => {
  it('enumerates every subset exactly once', () => {
    expect(SUBSETS).toHaveLength(2 ** ALL.length);
    expect(new Set(SUBSETS.map((subset) => subset.join(','))).size).toBe(SUBSETS.length);
  });

  for (const subset of SUBSETS) {
    it(`generates the union of what each provider generates alone: ${name(subset)}`, async () => {
      const combined = await compileSubset(subset);

      const alone = new Map<string, string>();
      for (const provider of subset) {
        for (const artifact of (await compileSubset([provider])).artifacts) {
          const previous = alone.get(artifact.path);
          // Two providers may share a path only when the bytes agree; that is
          // what makes co-ownership safe, and it is asserted separately below.
          expect(previous === undefined || previous === artifact.hash).toBe(true);
          alone.set(artifact.path, artifact.hash);
        }
      }

      expect(combined.artifacts.map((artifact) => artifact.path)).toEqual([...alone.keys()].sort());

      // The stronger half: not just the same paths, the same bytes. A provider
      // that quietly rendered something differently when another is enabled
      // would pass a path comparison and fail here.
      for (const artifact of combined.artifacts) {
        expect(artifact.hash, `${name(subset)}: ${artifact.path}`).toBe(alone.get(artifact.path));
      }
    });

    it(`attributes ownership to exactly the providers that produce each path: ${name(subset)}`, async () => {
      const combined = await compileSubset(subset);

      for (const artifact of combined.artifacts) {
        const producers: ProviderId[] = [];
        for (const provider of subset) {
          const own = await compileSubset([provider]);
          if (own.artifacts.some((candidate) => candidate.path === artifact.path)) {
            producers.push(provider);
          }
        }
        expect(artifact.providers, `${name(subset)}: ${artifact.path}`).toEqual(producers.sort());
      }
    });

    it(`never reports a conflict or an error: ${name(subset)}`, async () => {
      const combined = await compileSubset(subset);

      // Two adapters writing the same path with different content is an AI
      // Config defect, not a user error, and the combination is the only thing
      // that could trigger it.
      expect(
        combined.diagnostics.filter((diagnostic) => diagnostic.code === 'OUTPUT_PATH_CONFLICT'),
      ).toEqual([]);
      expect(combined.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual(
        [],
      );
    });

    it(`produces no diagnostic that exists only because of the combination: ${name(subset)}`, async () => {
      const combined = await compileSubset(subset);

      const alone: string[] = [];
      for (const provider of subset) {
        for (const diagnostic of (await compileSubset([provider])).diagnostics) {
          alone.push(`${String(diagnostic.provider)} ${diagnostic.code} ${diagnostic.message}`);
        }
      }

      // The counterpart of the invariant above: enabling a provider changes
      // neither what another one generates nor what it reports. Nothing in the
      // compiler looks at the enabled set any more, and this is what keeps it
      // that way — a check that would have failed while skill-discovery
      // overlaps were reported, since those existed only in combination.
      expect(
        combined.diagnostics
          .map(
            (diagnostic) =>
              `${String(diagnostic.provider)} ${diagnostic.code} ${diagnostic.message}`,
          )
          .sort(),
      ).toEqual(alone.sort());
    });

    it(`co-owns the shared AGENTS.md and nothing else: ${name(subset)}`, async () => {
      const combined = await compileSubset(subset);
      const owners = AGENTS_MD_OWNERS.filter((provider) => subset.includes(provider));
      const agentsMarkdown = combined.artifacts.find((artifact) => artifact.path === 'AGENTS.md');

      if (owners.length === 0) {
        expect(agentsMarkdown).toBeUndefined();
      } else {
        expect(agentsMarkdown?.providers).toEqual(owners);
      }

      // Every other generated path belongs to exactly one provider.
      for (const artifact of combined.artifacts) {
        if (artifact.path !== 'AGENTS.md') {
          expect(artifact.providers, artifact.path).toHaveLength(1);
        }
      }
    });

    it(`is independent of the order the adapters are supplied in: ${name(subset)}`, async () => {
      const forwards = await compileSubset(subset);
      const backwards = compile(await configuration(), [...subset].reverse().map(adapterFor));

      expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
    });
  }
});

describe('enabled-provider combinations: boundaries', () => {
  it('generates nothing at all when no provider is enabled', async () => {
    const result = await compileSubset([]);
    expect(result.artifacts).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('adds files monotonically as providers are enabled', async () => {
    // Enabling a provider may only add generated paths. If some combination
    // removed one, disabling a provider would silently orphan a file that a
    // still-enabled provider needs.
    for (const subset of SUBSETS) {
      const paths = new Set((await compileSubset(subset)).artifacts.map((a) => a.path));

      for (const provider of ALL) {
        if (subset.includes(provider)) {
          continue;
        }
        const larger = await compileSubset([...subset, provider].sort());
        const largerPaths = new Set(larger.artifacts.map((a) => a.path));
        for (const existing of paths) {
          expect(largerPaths.has(existing), `${name(subset)} + ${provider}: ${existing}`).toBe(
            true,
          );
        }
      }
    }
  });
});
