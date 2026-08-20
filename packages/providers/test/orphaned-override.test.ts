import { describe, expect, it } from 'vitest';

import { CONFIG_PATH, analyze, clean, sync } from '@aiconfig/core';
import { MemoryFileSystem } from '@aiconfig/core/testing';

import { createDefaultAdapters } from '../src/index.js';

/**
 * A canonical file deleted by hand, with its provider override left behind.
 *
 * Everything under `.ai/` is the author's, so editing it directly is a
 * supported way to work — and deleting a `.md` file is the obvious way to
 * remove an artifact. Doing so leaves the override at
 * `.ai/providers/<provider>/<kind>/<name>.yaml` pointing at nothing.
 *
 * An override refines an artifact and means nothing without it, so the next
 * synchronization removes it, exactly as it removes the files that artifact
 * generated. That is the one thing a synchronization removes under `.ai/`; it
 * still never creates or modifies anything there.
 *
 * Two guarantees have to hold together, and these tests hold both: an override
 * whose artifact is gone is removed, and an override belonging to a *disabled*
 * provider is not — the second is kept deliberately so re-enabling restores the
 * settings exactly.
 */

const adapters = createDefaultAdapters();

const CONFIG = 'schema: 1\nproviders:\n  enabled:\n    - claude\n    - codex\n';
const AGENT = '.ai/agents/reviewer.md';
const OVERRIDE = '.ai/providers/claude/agents/reviewer.yaml';
const GENERATED = '.claude/agents/reviewer.md';

const project = (): MemoryFileSystem => {
  const fileSystem = new MemoryFileSystem();
  fileSystem.set(CONFIG_PATH, CONFIG);
  fileSystem.set(AGENT, '---\ndescription: Reviews changes\n---\n\nYou review code.\n');
  fileSystem.set(OVERRIDE, 'schema: 1\noptions:\n  model: sonnet\n');
  return fileSystem;
};

/** A synchronized project, with the canonical agent then deleted by hand. */
const orphaned = async (): Promise<MemoryFileSystem> => {
  const fileSystem = project();

  const first = await sync(fileSystem, fileSystem.root, adapters, {});
  expect(first.ok, 'the project should synchronize before anything is deleted').toBe(true);
  expect(fileSystem.has(GENERATED)).toBe(true);

  await fileSystem.deleteFile(`${fileSystem.root}/${AGENT}`);
  return fileSystem;
};

describe('a canonical artifact deleted by hand', () => {
  it('reports the orphaned override without blocking anything', async () => {
    const fileSystem = await orphaned();

    const outcome = await analyze(fileSystem, fileSystem.root, adapters);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const reported = outcome.analysis.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'OVERRIDE_TARGET_MISSING',
    );
    expect(reported).toHaveLength(1);
    // Informational: nothing is wrong and nothing is lost. The message says
    // what happens next rather than asking anyone to act.
    expect(reported[0]?.severity).toBe('info');
    expect(reported[0]?.message).toContain('removed by the next synchronization');
    expect(reported[0]?.source).toBe(OVERRIDE);
    // Analysis reads and reports; it never removes.
    expect(fileSystem.has(OVERRIDE)).toBe(true);
    // Nothing else is wrong, so nothing else may be refused.
    expect(
      outcome.analysis.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
    ).toEqual([]);
  });

  it('removes the override along with what the artifact had generated', async () => {
    // An override cannot outlive what it refines. The generated files were
    // always treated that way; the override used to be the exception.
    const fileSystem = await orphaned();

    const outcome = await sync(fileSystem, fileSystem.root, adapters, {});

    expect(outcome.ok).toBe(true);
    expect(fileSystem.has(GENERATED)).toBe(false);
    expect(fileSystem.has('AGENTS.md')).toBe(false);
    expect(fileSystem.has(OVERRIDE)).toBe(false);
    expect(outcome.ok && outcome.result.removedOverrides).toEqual([OVERRIDE]);
    // The directories that removal emptied go too, `.ai/providers/` included.
    expect(fileSystem.paths().filter((entry) => entry.startsWith('.ai/providers'))).toEqual([]);
  });

  it('names nothing removed when a dry run reports the same state', async () => {
    // `--dry-run` is provably side-effect free, and that has to include this.
    const fileSystem = await orphaned();

    const outcome = await sync(fileSystem, fileSystem.root, adapters, { dryRun: true });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.result.removedOverrides).toEqual([]);
    expect(fileSystem.has(OVERRIDE)).toBe(true);
    expect(fileSystem.has(GENERATED)).toBe(true);
  });

  it('never touches an override belonging to a disabled provider', async () => {
    // Two guarantees meet here, and the wrong one winning would be silent data
    // loss. A disabled provider's overrides are kept so re-enabling restores
    // the settings exactly; an orphaned override is removed. Overlays are read
    // only for enabled providers, so a disabled one is never even considered —
    // its artifact is irrelevant to the question.
    const fileSystem = project();
    fileSystem.set(
      '.ai/providers/opencode/agents/reviewer.yaml',
      'schema: 1\noptions:\n  temperature: 0.1\n',
    );
    fileSystem.set(
      '.ai/providers/opencode/agents/ghost.yaml',
      'schema: 1\noptions:\n  temperature: 0.2\n',
    );

    expect((await sync(fileSystem, fileSystem.root, adapters, {})).ok).toBe(true);

    // `opencode` is not in the enabled set, so neither file is inspected, and
    // the one with no artifact at all survives alongside the other.
    expect(fileSystem.has('.ai/providers/opencode/agents/reviewer.yaml')).toBe(true);
    expect(fileSystem.has('.ai/providers/opencode/agents/ghost.yaml')).toBe(true);
  });

  it('still allows Delete Generated Files', async () => {
    // The escape hatch has to work in exactly the state someone would reach for
    // it, which is when something looks broken. It removes generated files
    // only: `.ai/` is not its business.
    const fileSystem = await orphaned();

    const outcome = await clean(fileSystem, fileSystem.root, adapters);

    expect(outcome.ok).toBe(true);
    expect(fileSystem.has(GENERATED)).toBe(false);
    expect(fileSystem.has(OVERRIDE)).toBe(true);
    expect(fileSystem.has(CONFIG_PATH)).toBe(true);
  });

  it('returns to a clean project once the override is removed too', async () => {
    const fileSystem = await orphaned();
    await sync(fileSystem, fileSystem.root, adapters, {});

    await fileSystem.deleteFile(`${fileSystem.root}/${OVERRIDE}`);
    const outcome = await analyze(fileSystem, fileSystem.root, adapters);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.analysis.diagnostics).toEqual([]);
  });

  it('keeps every other artifact compiling while the orphan is reported', async () => {
    const fileSystem = await orphaned();
    fileSystem.set('.ai/agents/coder.md', '---\ndescription: Writes\n---\n\nYou write code.\n');

    const outcome = await sync(fileSystem, fileSystem.root, adapters, {});

    expect(outcome.ok).toBe(true);
    expect(fileSystem.has('.claude/agents/coder.md')).toBe(true);
    expect(fileSystem.has('.codex/agents/coder.toml')).toBe(true);
  });
});
