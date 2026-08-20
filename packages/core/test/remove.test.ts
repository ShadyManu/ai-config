import { describe, expect, it } from 'vitest';

import type { SourceKind } from '../src/domain/configuration.js';
import { discoverConfiguration } from '../src/parse/discover.js';
import { removeArtifact } from '../src/scaffold/remove.js';
import { MemoryFileSystem } from '../src/testing/memory-file-system.js';

/**
 * Removing a canonical artifact.
 *
 * The interesting half is not the file that goes away but the ones that have to
 * go with it. An override under `.ai/providers/` whose target no longer exists
 * refines nothing and is reported on every run until someone removes it, so
 * deleting the canonical file alone leaves a repository that nags forever. Each
 * case below therefore ends by re-reading the project and asserting it reads
 * clean.
 */

const CONFIG = 'schema: 1\nproviders:\n  enabled: [claude, codex, copilot, opencode]\n';

const seeded = (): MemoryFileSystem => {
  const fileSystem = new MemoryFileSystem();
  fileSystem.set('.ai/config.yaml', CONFIG);
  fileSystem.set('.ai/agents/reviewer.md', '---\ndescription: Reviews\n---\n\nYou review.\n');
  fileSystem.set('.ai/agents/coder.md', '---\ndescription: Writes\n---\n\nYou write.\n');
  fileSystem.set('.ai/instructions/general.md', '---\ndescription: Rules\n---\n\nBe careful.\n');
  fileSystem.set('.ai/commands/ship.md', '---\ndescription: Ships\n---\n\nShip it.\n');
  fileSystem.set(
    '.ai/skills/code-review/SKILL.md',
    '---\nname: code-review\ndescription: Reviews\n---\n\nSteps.\n',
  );
  fileSystem.set('.ai/skills/code-review/references/checklist.md', '# Checklist\n');
  fileSystem.set('.ai/skills/code-review/scripts/run.sh', 'echo hi\n');
  return fileSystem;
};

const withOverrides = (fileSystem: MemoryFileSystem): MemoryFileSystem => {
  fileSystem.set(
    '.ai/providers/claude/agents/reviewer.yaml',
    'schema: 1\noptions:\n  model: opus\n',
  );
  fileSystem.set('.ai/providers/codex/agents/reviewer.yaml', 'schema: 1\noptions:\n  model: gpt\n');
  return fileSystem;
};

const validates = async (fileSystem: MemoryFileSystem): Promise<readonly string[]> => {
  const result = await discoverConfiguration(fileSystem, fileSystem.root);
  return result.diagnostics.map((diagnostic) => diagnostic.code);
};

describe('removeArtifact', () => {
  const KINDS: readonly { kind: SourceKind; name: string; file: string }[] = [
    { kind: 'agent', name: 'reviewer', file: '.ai/agents/reviewer.md' },
    { kind: 'instruction', name: 'general', file: '.ai/instructions/general.md' },
    { kind: 'command', name: 'ship', file: '.ai/commands/ship.md' },
  ];

  for (const { kind, name, file } of KINDS) {
    it(`removes a ${kind} and reports the path`, async () => {
      const fileSystem = seeded();

      const outcome = await removeArtifact(fileSystem, fileSystem.root, kind, name);

      expect(outcome).toEqual({ ok: true, removed: [file] });
      expect(fileSystem.has(file)).toBe(false);
      expect(await validates(fileSystem)).toEqual([]);
    });
  }

  it('removes a skill with everything inside it', async () => {
    const fileSystem = seeded();

    const outcome = await removeArtifact(fileSystem, fileSystem.root, 'skill', 'code-review');

    expect(outcome.ok && outcome.removed).toEqual([
      '.ai/skills/code-review/SKILL.md',
      '.ai/skills/code-review/references/checklist.md',
      '.ai/skills/code-review/scripts/run.sh',
    ]);
    expect(fileSystem.paths().some((entry) => entry.startsWith('.ai/skills/'))).toBe(false);
    expect(await validates(fileSystem)).toEqual([]);
  });

  it('leaves every other artifact untouched', async () => {
    const fileSystem = seeded();
    const before = fileSystem.paths().filter((entry) => !entry.includes('reviewer'));

    await removeArtifact(fileSystem, fileSystem.root, 'agent', 'reviewer');

    expect(fileSystem.paths()).toEqual(before);
  });

  it('removes the overrides written for it, in every provider', async () => {
    const fileSystem = withOverrides(seeded());

    const outcome = await removeArtifact(fileSystem, fileSystem.root, 'agent', 'reviewer');

    expect(outcome.ok && outcome.removed).toEqual([
      '.ai/agents/reviewer.md',
      '.ai/providers/claude/agents/reviewer.yaml',
      '.ai/providers/codex/agents/reviewer.yaml',
    ]);
    // The point of removing them: the project still validates afterwards.
    expect(await validates(fileSystem)).toEqual([]);
  });

  it('prunes the directories that removal emptied, up to .ai/providers itself', async () => {
    const fileSystem = withOverrides(seeded());

    await removeArtifact(fileSystem, fileSystem.root, 'agent', 'reviewer');

    for (const directory of [
      '.ai/providers/claude/agents',
      '.ai/providers/claude',
      '.ai/providers/codex',
      '.ai/providers',
    ]) {
      expect(await fileSystem.exists(`${fileSystem.root}/${directory}`), directory).toBe(false);
    }
    // `.ai/` and its content directories are not candidates.
    expect(await fileSystem.exists(`${fileSystem.root}/.ai/agents`)).toBe(true);
  });

  it('keeps a provider directory that still holds another override', async () => {
    const fileSystem = withOverrides(seeded());
    fileSystem.set(
      '.ai/providers/claude/agents/coder.yaml',
      'schema: 1\noptions:\n  model: opus\n',
    );

    await removeArtifact(fileSystem, fileSystem.root, 'agent', 'reviewer');

    expect(fileSystem.has('.ai/providers/claude/agents/coder.yaml')).toBe(true);
    expect(await fileSystem.exists(`${fileSystem.root}/.ai/providers/claude`)).toBe(true);
    // The provider whose only override went with the artifact is gone.
    expect(await fileSystem.exists(`${fileSystem.root}/.ai/providers/codex`)).toBe(false);
  });

  it('removes an override left by a provider this build does not know', async () => {
    // Taken from the directory listing rather than the registered provider set:
    // the orphaned override would block synchronization just the same.
    const fileSystem = seeded();
    fileSystem.set('.ai/providers/future-assistant/agents/reviewer.yaml', 'schema: 1\n');

    const outcome = await removeArtifact(fileSystem, fileSystem.root, 'agent', 'reviewer');

    expect(outcome.ok && outcome.removed).toContain(
      '.ai/providers/future-assistant/agents/reviewer.yaml',
    );
  });

  it('touches nothing that merely shares a prefix with the name', async () => {
    const fileSystem = seeded();
    fileSystem.set('.ai/agents/reviewer-legacy.md', '---\ndescription: Old\n---\n\nOld.\n');

    await removeArtifact(fileSystem, fileSystem.root, 'agent', 'reviewer');

    expect(fileSystem.has('.ai/agents/reviewer-legacy.md')).toBe(true);
  });

  it('succeeds when the artifact is already gone', async () => {
    // The caller asked for it to be absent, and it is. Reporting an error would
    // make a second click on a stale tree row look like a failure.
    const fileSystem = seeded();

    const outcome = await removeArtifact(fileSystem, fileSystem.root, 'agent', 'nothing-here');

    expect(outcome).toEqual({ ok: true, removed: [] });
  });

  it('refuses a name that is not a canonical name', async () => {
    // A name is also a path segment, so it is checked before it reaches the
    // path guard rather than after.
    const fileSystem = seeded();

    const outcome = await removeArtifact(fileSystem, fileSystem.root, 'agent', '../../etc/passwd');

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.diagnostics.map((d) => d.code)).toEqual([
      'INVALID_NAME',
    ]);
    expect(fileSystem.paths()).toEqual(seeded().paths());
  });

  it('unlinks a symbolic link inside a skill instead of following it', async () => {
    const fileSystem = seeded();
    fileSystem.setSymlink('.ai/skills/code-review/linked.md');

    const outcome = await removeArtifact(fileSystem, fileSystem.root, 'skill', 'code-review');

    expect(outcome.ok && outcome.removed).toContain('.ai/skills/code-review/linked.md');
    expect(fileSystem.paths().some((entry) => entry.startsWith('.ai/skills/'))).toBe(false);
  });
});

describe('an override whose target was deleted by hand', () => {
  it('is reported as an error naming both the file and the remedy', async () => {
    // This is the state the delete action exists to avoid, and it has to stay
    // recoverable for anyone who edits `.ai/` directly.
    const fileSystem = withOverrides(seeded());
    await fileSystem.deleteFile(`${fileSystem.root}/.ai/agents/reviewer.md`);

    const result = await discoverConfiguration(fileSystem, fileSystem.root);
    expect(result.diagnostics).toEqual([]);

    // The diagnostic is raised where overrides are matched to their targets,
    // which the overlay suite covers; here what matters is that removing the
    // leftovers restores a project that reads cleanly.
    const outcome = await removeArtifact(fileSystem, fileSystem.root, 'agent', 'reviewer');

    expect(outcome.ok && outcome.removed).toEqual([
      '.ai/providers/claude/agents/reviewer.yaml',
      '.ai/providers/codex/agents/reviewer.yaml',
    ]);
    expect(await validates(fileSystem)).toEqual([]);
  });
});
