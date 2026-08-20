import { describe, expect, it } from 'vitest';

import type { ProviderId } from '@aiconfig/core';
import {
  CONFIG_PATH,
  MANIFEST_PATH,
  PROVIDER_IDS,
  analyze,
  readManifest,
  sync,
} from '@aiconfig/core';
import { MemoryFileSystem } from '@aiconfig/core/testing';

import { createDefaultAdapters } from '../src/index.js';

/**
 * Enabling and disabling providers, across every combination.
 *
 * The property under test is that history does not matter: after switching a
 * project to a set of providers, its generated output must be byte-identical
 * to a project that had only ever used that set. That covers, in one
 * statement, every case a user can actually reach — output removed for a
 * provider turned off, output restored for one turned back on, files shared
 * between two providers surviving when only one of them leaves, and a manifest
 * that keeps describing reality throughout.
 *
 * With four providers there are sixteen states and 256 transitions between
 * them, so they are all run rather than sampled. The in-memory filesystem
 * keeps that affordable; filesystem-specific behaviour — atomic replacement,
 * symbolic links, permissions — is covered by the integration tests in
 * `@aiconfig/core`, which run against a real temporary directory.
 */

const adapters = createDefaultAdapters();

const ALL: readonly ProviderId[] = [...PROVIDER_IDS].sort();

const SUBSETS: readonly (readonly ProviderId[])[] = Array.from(
  { length: 1 << ALL.length },
  (_unused, mask) => ALL.filter((_provider, index) => (mask & (1 << index)) !== 0),
);

const name = (subset: readonly ProviderId[]): string =>
  subset.length === 0 ? 'none' : subset.join('+');

const configFor = (providers: readonly ProviderId[]): string =>
  providers.length === 0
    ? 'schema: 1\nproviders:\n  enabled: []\n'
    : `schema: 1\nproviders:\n  enabled:\n${providers.map((provider) => `  - ${provider}\n`).join('')}`;

/** Canonical sources every case starts from: one of each artifact kind. */
const SOURCES: Readonly<Record<string, string>> = {
  '.ai/instructions/general.md':
    '---\ndescription: Project-wide rules\n---\n\nRun the tests before proposing a change.\n',
  '.ai/instructions/backend.md':
    '---\ndescription: Backend rules\napplyTo:\n  - "backend/**"\n---\n\nUse a repository type.\n',
  '.ai/agents/reviewer.md': '---\ndescription: Reviews changes\n---\n\nYou review code.\n',
  '.ai/commands/fix-bug.md':
    '---\ndescription: Fixes a failing test\n---\n\nReproduce, then fix.\n',
  '.ai/skills/code-review/SKILL.md':
    '---\nname: code-review\ndescription: Reviews a change against the checklist\n---\n\nWork through the checklist.\n',
  '.ai/skills/code-review/references/checklist.md': '# Checklist\n\n- Correctness\n',
  // Every provider accepts an agent override, so each one has something under
  // `.ai/providers/` that disabling it must not remove.
  '.ai/providers/claude/agents/reviewer.yaml': 'schema: 1\noptions:\n  model: sonnet\n',
  '.ai/providers/codex/agents/reviewer.yaml': 'schema: 1\noptions:\n  model: gpt-5.5\n',
  '.ai/providers/copilot/agents/reviewer.yaml': 'schema: 1\noptions:\n  model: gpt-5.5\n',
  '.ai/providers/opencode/agents/reviewer.yaml': 'schema: 1\noptions:\n  temperature: 0.1\n',
};

const seed = (providers: readonly ProviderId[]): MemoryFileSystem => {
  const fileSystem = new MemoryFileSystem();
  for (const [path, content] of Object.entries(SOURCES)) {
    fileSystem.set(path, content);
  }
  fileSystem.set(CONFIG_PATH, configFor(providers));
  return fileSystem;
};

const runSync = async (fileSystem: MemoryFileSystem): Promise<void> => {
  const outcome = await sync(fileSystem, fileSystem.root, adapters, {});
  if (!outcome.ok) {
    throw new Error(
      `sync failed: ${outcome.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`).join('; ')}`,
    );
  }
};

/** Everything AI Config generated: the working tree minus the canonical sources. */
const generated = (fileSystem: MemoryFileSystem): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const path of fileSystem.paths()) {
    if (path.startsWith('.ai/')) {
      continue;
    }
    files[path] = fileSystem.get(path)!;
  }
  return files;
};

/**
 * The canonical sources, which a synchronization must never touch.
 *
 * `.ai/config.yaml` is excluded because these tests rewrite it themselves to
 * change the enabled set; the manifest because it is the one thing under
 * `.ai/` that AI Config does own.
 */
const canonical = (fileSystem: MemoryFileSystem): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const path of fileSystem.paths()) {
    if (!path.startsWith('.ai/') || path === MANIFEST_PATH || path === CONFIG_PATH) {
      continue;
    }
    files[path] = fileSystem.get(path)!;
  }
  return files;
};

const manifestPaths = async (fileSystem: MemoryFileSystem): Promise<readonly string[]> => {
  const result = await readManifest(fileSystem, fileSystem.root);
  expect(result.diagnostics).toEqual([]);
  return result.manifest.entries.map((entry) => entry.path).sort();
};

/**
 * The output of a project that has only ever used one provider set, for every
 * set. This is the oracle every transition is compared against.
 */
const REFERENCE = new Map<string, Record<string, string>>();

const referenceFor = async (subset: readonly ProviderId[]): Promise<Record<string, string>> => {
  const key = name(subset);
  const existing = REFERENCE.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const fileSystem = seed(subset);
  await runSync(fileSystem);
  const files = generated(fileSystem);
  REFERENCE.set(key, files);
  return files;
};

describe('a fresh project, for every provider combination', () => {
  for (const subset of SUBSETS) {
    it(`synchronizes and stays synchronized: ${name(subset)}`, async () => {
      const fileSystem = seed(subset);
      const sources = canonical(fileSystem);

      await runSync(fileSystem);

      // A synchronization reads `.ai/` and writes provider output. It never
      // writes back into `.ai/`, whatever the enabled set is.
      expect(canonical(fileSystem)).toEqual(sources);

      // The manifest describes exactly what is on disk.
      expect(await manifestPaths(fileSystem)).toEqual(Object.keys(generated(fileSystem)).sort());

      // Running it again changes nothing: every action is `unchanged`.
      const before = generated(fileSystem);
      await runSync(fileSystem);
      expect(generated(fileSystem)).toEqual(before);

      const outcome = await analyze(fileSystem, fileSystem.root, adapters);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.analysis.plan.actions.every((action) => action.kind === 'unchanged')).toBe(
          true,
        );
      }
    });
  }

  it('generates nothing when no provider is enabled', async () => {
    expect(await referenceFor([])).toEqual({});
  });
});

describe('switching provider combinations', () => {
  for (const from of SUBSETS) {
    it(`lands on the same output whatever it started from: ${name(from)} → every combination`, async () => {
      for (const to of SUBSETS) {
        const where = `${name(from)} → ${name(to)}`;

        const fileSystem = seed(from);
        const sources = canonical(fileSystem);

        await runSync(fileSystem);
        expect(generated(fileSystem), `${where}: initial state`).toEqual(await referenceFor(from));

        fileSystem.set(CONFIG_PATH, configFor(to));
        await runSync(fileSystem);

        // The whole point: after the switch the working tree is exactly what a
        // project that had only ever used `to` would hold. Files belonging to
        // providers that left are gone; files shared with one that stayed are
        // still there; nothing is left over and nothing is missing.
        expect(generated(fileSystem), `${where}: after switching`).toEqual(await referenceFor(to));

        // Ownership keeps describing reality, so the next sync is a no-op
        // rather than a rediscovery.
        expect(await manifestPaths(fileSystem), `${where}: manifest`).toEqual(
          Object.keys(await referenceFor(to)).sort(),
        );

        // Disabling a provider never removes its settings: re-enabling it must
        // restore its output exactly, which the return trip below relies on.
        expect(canonical(fileSystem), `${where}: canonical sources`).toEqual(sources);
      }
    });
  }
});

describe('switching back', () => {
  for (const from of SUBSETS) {
    it(`restores the original output when switched back: ${name(from)} → any → ${name(from)}`, async () => {
      for (const to of SUBSETS) {
        const where = `${name(from)} → ${name(to)} → ${name(from)}`;

        const fileSystem = seed(from);
        await runSync(fileSystem);
        const original = generated(fileSystem);

        fileSystem.set(CONFIG_PATH, configFor(to));
        await runSync(fileSystem);

        fileSystem.set(CONFIG_PATH, configFor(from));
        await runSync(fileSystem);

        // Round-tripping through any other combination is lossless: the
        // override files under `.ai/providers/` were kept, so the restored
        // output is byte-identical rather than merely similar.
        expect(generated(fileSystem), where).toEqual(original);
      }
    });
  }
});

describe('switching provider combinations: reported diagnostics', () => {
  it('never reports an error for any combination', async () => {
    for (const subset of SUBSETS) {
      const fileSystem = seed(subset);
      const outcome = await analyze(fileSystem, fileSystem.root, adapters);

      expect(outcome.ok, name(subset)).toBe(true);
      if (!outcome.ok) {
        continue;
      }
      expect(
        outcome.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
        name(subset),
      ).toEqual([]);
    }
  });

  it('reports an override kept for a provider that is turned off, exactly once each', async () => {
    for (const subset of SUBSETS) {
      const fileSystem = seed(subset);
      const outcome = await analyze(fileSystem, fileSystem.root, adapters);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        continue;
      }

      // Every provider has an override file in this project, so every disabled
      // one must say so — and no enabled one may. The diagnostic names the
      // provider through its source directory rather than the `provider`
      // field, because a directory under `.ai/providers/` need not name a
      // registered provider at all.
      const disabled = outcome.analysis.diagnostics
        .filter((diagnostic) => diagnostic.code === 'OVERRIDE_PROVIDER_DISABLED')
        .map((diagnostic) => diagnostic.source);

      expect([...disabled].sort(), name(subset)).toEqual(
        ALL.filter((provider) => !subset.includes(provider)).map(
          (provider) => `.ai/providers/${provider}`,
        ),
      );
    }
  });

  it('reports every registered provider, enabled or not', async () => {
    for (const subset of SUBSETS) {
      const fileSystem = seed(subset);
      const outcome = await analyze(fileSystem, fileSystem.root, adapters);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        continue;
      }

      // A consumer has to be able to tell "turned off" from "not installed".
      expect(outcome.analysis.providers.map((report) => report.id).sort()).toEqual([...ALL]);
      for (const report of outcome.analysis.providers) {
        expect(report.enabled, `${name(subset)}: ${report.id}`).toBe(subset.includes(report.id));
        if (!report.enabled) {
          expect(report.status).toBe('disabled');
          expect(report.fileCount).toBe(0);
          expect(report.actions).toEqual([]);
        }
      }
    }
  });
});
