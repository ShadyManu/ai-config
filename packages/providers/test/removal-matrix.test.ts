import { describe, expect, it } from 'vitest';

import type { ProviderId, SourceKind } from '@aiconfig/core';
import { CONFIG_PATH, PROVIDER_IDS, analyze, clean, removeArtifact, sync } from '@aiconfig/core';
import { MemoryFileSystem } from '@aiconfig/core/testing';

import { createDefaultAdapters } from '../src/index.js';

/**
 * Removing an artifact, on every kind, through both routes a person has.
 *
 * The two routes are not variations of one another. Deleting from the view runs
 * `removeArtifact`, which takes the overrides with it; deleting the file in an
 * editor takes only the file, because `.ai/` is the author's directory and
 * editing it by hand is a supported way to work. Both have to end somewhere
 * usable, and one kind behaving differently from another is exactly the failure
 * a per-kind check catches and a single example does not.
 *
 * The invariant that matters most is the last one: whatever else is wrong,
 * removing the generated files must remain possible. A repository where every
 * remedy is refused has no supported way back.
 */

const adapters = createDefaultAdapters();
const ALL: readonly ProviderId[] = [...PROVIDER_IDS].sort();
const CONFIG = `schema: 1\nproviders:\n  enabled:\n${ALL.map((id) => `    - ${id}\n`).join('')}`;

const KINDS: readonly SourceKind[] = ['instruction', 'agent', 'skill', 'command'];

const NAME: Readonly<Record<SourceKind, string>> = {
  instruction: 'backend',
  agent: 'reviewer',
  skill: 'review',
  command: 'ship',
};

/** The file an author would delete in an editor. */
const CANONICAL: Readonly<Record<SourceKind, string>> = {
  instruction: '.ai/instructions/backend.md',
  agent: '.ai/agents/reviewer.md',
  skill: '.ai/skills/review/SKILL.md',
  command: '.ai/commands/ship.md',
};

/** One valid option per provider and kind, for the pairs that declare a schema. */
const OPTION: Readonly<Record<ProviderId, Partial<Record<SourceKind, string>>>> = {
  claude: { agent: 'model: sonnet', skill: 'model: sonnet', command: 'model: sonnet' },
  codex: { agent: 'model: gpt-5.5', skill: 'allowImplicitInvocation: false' },
  copilot: {
    instruction: 'excludeAgent: code-review',
    agent: 'model: gpt-5.5',
    command: 'model: gpt-5.5',
  },
  opencode: { agent: 'temperature: 0.1', command: 'model: anthropic/claude-sonnet-4' },
};

/** Driven from the adapters, so a new override schema joins this automatically. */
const providersConfiguring = (kind: SourceKind): readonly ProviderId[] =>
  adapters
    .filter((adapter) => (adapter.overrides ?? []).some((schema) => schema.kind === kind))
    .map((adapter) => adapter.id);

const seed = (kind: SourceKind): MemoryFileSystem => {
  const fileSystem = new MemoryFileSystem();
  fileSystem.set(CONFIG_PATH, CONFIG);

  switch (kind) {
    case 'instruction':
      fileSystem.set(
        CANONICAL.instruction,
        '---\ndescription: Backend rules\napplyTo:\n  - "backend/**"\n---\n\nUse ports.\n',
      );
      break;
    case 'agent':
      fileSystem.set(CANONICAL.agent, '---\ndescription: Reviews changes\n---\n\nYou review.\n');
      break;
    case 'command':
      fileSystem.set(CANONICAL.command, '---\ndescription: Ships it\n---\n\nShip it.\n');
      break;
    case 'skill':
      fileSystem.set(
        CANONICAL.skill,
        '---\nname: review\ndescription: Reviews a change\n---\n\nSteps.\n',
      );
      fileSystem.set('.ai/skills/review/references/checklist.md', '# Checklist\n');
      break;
  }

  for (const provider of providersConfiguring(kind)) {
    const option = OPTION[provider][kind];
    if (option === undefined) {
      continue;
    }
    fileSystem.set(
      `.ai/providers/${provider}/${kind}s/${NAME[kind]}.yaml`,
      `schema: 1\noptions:\n  ${option}\n`,
    );
  }

  return fileSystem;
};

/** Everything outside `.ai/`, which is everything AI Config generated. */
const generated = (fileSystem: MemoryFileSystem): readonly string[] =>
  fileSystem.paths().filter((entry) => !entry.startsWith('.ai/'));

const overridesLeft = (fileSystem: MemoryFileSystem): readonly string[] =>
  fileSystem.paths().filter((entry) => entry.startsWith('.ai/providers'));

const errorsOf = async (fileSystem: MemoryFileSystem): Promise<readonly string[]> => {
  const outcome = await analyze(fileSystem, fileSystem.root, adapters);
  if (!outcome.ok) {
    return outcome.diagnostics.map((diagnostic) => diagnostic.code);
  }
  return outcome.analysis.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.code);
};

describe('removing an artifact from the view', () => {
  for (const kind of KINDS) {
    it(`leaves nothing behind for a ${kind}`, async () => {
      const fileSystem = seed(kind);
      expect((await sync(fileSystem, fileSystem.root, adapters, {})).ok).toBe(true);
      expect(generated(fileSystem).length, `${kind} should generate something`).toBeGreaterThan(0);
      expect(overridesLeft(fileSystem).length).toBeGreaterThan(0);

      expect((await removeArtifact(fileSystem, fileSystem.root, kind, NAME[kind])).ok).toBe(true);

      expect(await errorsOf(fileSystem), `${kind}: errors after removal`).toEqual([]);
      expect((await sync(fileSystem, fileSystem.root, adapters, {})).ok).toBe(true);
      expect(generated(fileSystem), `${kind}: generated files left behind`).toEqual([]);
      expect(overridesLeft(fileSystem), `${kind}: overrides left behind`).toEqual([]);
    });
  }
});

describe('deleting the canonical file by hand', () => {
  for (const kind of KINDS) {
    it(`keeps the project synchronizable for a ${kind}`, async () => {
      const fileSystem = seed(kind);
      expect((await sync(fileSystem, fileSystem.root, adapters, {})).ok).toBe(true);

      await fileSystem.deleteFile(`${fileSystem.root}/${CANONICAL[kind]}`);
      const errors = await errorsOf(fileSystem);

      if (kind === 'skill') {
        // A directory that no longer holds an entrypoint is not a skill, and
        // that is a genuine authoring problem rather than an inert leftover.
        expect(errors).toEqual(['SKILL_MISSING']);
        return;
      }

      // The orphaned override is reported, and nothing is blocked by it.
      expect(errors, `${kind}: errors after hand-deleting`).toEqual([]);
      expect((await sync(fileSystem, fileSystem.root, adapters, {})).ok).toBe(true);

      // Generated output is gone, while authored overrides remain available
      // for a rename, branch switch, or explicit restoration.
      expect(generated(fileSystem), `${kind}: generated files left behind`).toEqual([]);
      expect(overridesLeft(fileSystem), `${kind}: authored overrides were lost`).toEqual(
        providersConfiguring(kind).map(
          (provider) => `.ai/providers/${provider}/${kind}s/${NAME[kind]}.yaml`,
        ),
      );
    });
  }
});

describe('removing the generated files stays possible', () => {
  for (const kind of KINDS) {
    it(`after a ${kind} was deleted by hand`, async () => {
      const fileSystem = seed(kind);
      expect((await sync(fileSystem, fileSystem.root, adapters, {})).ok).toBe(true);

      await fileSystem.deleteFile(`${fileSystem.root}/${CANONICAL[kind]}`);

      // Whatever analysis makes of the sources, `clean` reads the manifest and
      // must still run: it is the last way back to a working tree.
      const outcome = await clean(fileSystem, fileSystem.root, adapters);

      expect(outcome.ok, `${kind}: clean refused`).toBe(true);
      expect(generated(fileSystem), `${kind}: generated files survived clean`).toEqual([]);
      expect(fileSystem.has(CONFIG_PATH)).toBe(true);
    });
  }

  it('after a skill directory was emptied but left in place', async () => {
    // Deleting the files of a skill in a file manager leaves the directory,
    // which used to be enough to block everything at once.
    const fileSystem = seed('skill');
    expect((await sync(fileSystem, fileSystem.root, adapters, {})).ok).toBe(true);

    await fileSystem.deleteFile(`${fileSystem.root}/${CANONICAL.skill}`);
    await fileSystem.deleteFile(`${fileSystem.root}/.ai/skills/review/references/checklist.md`);

    expect(await errorsOf(fileSystem)).toEqual(['SKILL_MISSING']);
    expect((await clean(fileSystem, fileSystem.root, adapters)).ok).toBe(true);
    expect(generated(fileSystem)).toEqual([]);
  });
});
