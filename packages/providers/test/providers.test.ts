import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { PROVIDER_IDS, compile } from '@aiconfig/core';
import {
  compileFixture,
  discoverFixtureConfiguration,
  exampleRepositoryRoot,
} from '@aiconfig/core/testing';

import { createDefaultAdapters, defaultProviderIds } from '../src/index.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

describe('createDefaultAdapters', () => {
  it('supplies an adapter for every provider identifier core knows', () => {
    expect(defaultProviderIds()).toEqual([...PROVIDER_IDS].sort());
  });

  it('gives every adapter a unique id and a display name', () => {
    const adapters = createDefaultAdapters();
    expect(new Set(adapters.map((a) => a.id)).size).toBe(adapters.length);
    for (const adapter of adapters) {
      expect(adapter.displayName.length).toBeGreaterThan(0);
    }
  });
});

describe('declared target roots', () => {
  it('covers every path each adapter actually generates', async () => {
    // `targetRoots` is what Initialize checks for pre-existing provider files.
    // It is declared rather than computed, so an adapter that starts writing
    // somewhere new would silently stop being recognized there — unless this
    // fails.
    for (const adapter of createDefaultAdapters()) {
      const result = await compileFixture(exampleRepositoryRoot(testDirectory), adapter);

      expect(adapter.targetRoots.length, adapter.id).toBeGreaterThan(0);

      for (const generatedPath of result.files.keys()) {
        const covered = adapter.targetRoots.some(
          (target) => generatedPath === target || generatedPath.startsWith(`${target}/`),
        );
        expect(covered, `${adapter.id} generates ${generatedPath} outside its target roots`).toBe(
          true,
        );
      }
    }
  });

  it('names specific locations rather than whole shared directories', () => {
    // `.github` holds workflows and issue templates; warning about it during
    // Initialize would fire on almost every repository and mean nothing.
    for (const adapter of createDefaultAdapters()) {
      for (const target of adapter.targetRoots) {
        expect(target, adapter.id).not.toBe('.github');
        expect(target.startsWith('/'), `${adapter.id}: ${target}`).toBe(false);
        expect(target.endsWith('/'), `${adapter.id}: ${target}`).toBe(false);
      }
    }
  });
});

describe('cross-adapter output', () => {
  it('produces no conflicting output when every provider is enabled', async () => {
    const configuration = await discoverFixtureConfiguration(exampleRepositoryRoot(testDirectory));

    const result = compile(configuration, createDefaultAdapters());

    // The one path two adapters both produce is the root AGENTS.md. A conflict
    // here would mean the Codex and OpenCode renderers had diverged.
    expect(result.diagnostics.filter((d) => d.code === 'OUTPUT_PATH_CONFLICT')).toEqual([]);
  });

  it('records shared ownership of AGENTS.md for Codex and OpenCode', async () => {
    const configuration = await discoverFixtureConfiguration(exampleRepositoryRoot(testDirectory));

    const result = compile(configuration, createDefaultAdapters());
    const agentsMarkdown = result.artifacts.find((artifact) => artifact.path === 'AGENTS.md');

    expect(agentsMarkdown).toBeDefined();
    expect(agentsMarkdown?.providers).toEqual(['codex', 'opencode']);
  });

  it('keeps each provider inside its own directory apart from AGENTS.md', async () => {
    const owners: Record<string, string> = {
      claude: '.claude/',
      copilot: '.github/',
      opencode: '.opencode/',
    };

    for (const adapter of createDefaultAdapters()) {
      const prefix = owners[adapter.id];
      if (prefix === undefined) {
        continue; // Codex writes to both .codex/ and the shared .agents/.
      }
      const result = await compileFixture(exampleRepositoryRoot(testDirectory), adapter);
      for (const generatedPath of result.files.keys()) {
        if (generatedPath === 'AGENTS.md') {
          // The one intentionally shared artifact.
          continue;
        }
        expect(generatedPath.startsWith(prefix), `${adapter.id}: ${generatedPath}`).toBe(true);
      }
    }
  });

  it('adds no diagnostic when all four are enabled together', async () => {
    const configuration = await discoverFixtureConfiguration(exampleRepositoryRoot(testDirectory));
    const adapters = createDefaultAdapters();

    const alone = adapters.flatMap((adapter) =>
      compile(configuration, [adapter]).diagnostics.map(
        (diagnostic) => `${String(diagnostic.provider)} ${diagnostic.code}`,
      ),
    );
    const together = compile(configuration, adapters).diagnostics.map(
      (diagnostic) => `${String(diagnostic.provider)} ${diagnostic.code}`,
    );

    // Copilot and OpenCode each scan two skill directories another provider
    // owns, and AI Config used to report that as `SKILL_DISCOVERY_OVERLAP`.
    // Every copy is compiled from the same canonical skill, OpenCode and
    // Copilot both deduplicate by name, and the ambiguity that remains is a
    // defect in those tools rather than something a `.ai/` author can act on.
    // Nothing in the compiler looks at the enabled set now, and this is what
    // holds it to that.
    expect(together.sort()).toEqual(alone.sort());
  });

  it('produces byte-identical AGENTS.md from the Codex and OpenCode adapters', async () => {
    const adapters = createDefaultAdapters().filter(
      (adapter) => adapter.id === 'codex' || adapter.id === 'opencode',
    );
    expect(adapters).toHaveLength(2);

    const rendered = await Promise.all(
      adapters.map(async (adapter) => {
        const result = await compileFixture(exampleRepositoryRoot(testDirectory), adapter);
        return result.files.get('AGENTS.md');
      }),
    );

    expect(rendered[0]).toBeDefined();
    expect(rendered[0]).toBe(rendered[1]);
  });
});
