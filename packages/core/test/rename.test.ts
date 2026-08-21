import { describe, expect, it } from 'vitest';

import type { SourceKind } from '../src/domain/configuration.js';
import { discoverConfiguration } from '../src/parse/discover.js';
import { alignArtifactName, readNameMismatch, renameArtifact } from '../src/scaffold/rename.js';
import { MemoryFileSystem } from '../src/testing/memory-file-system.js';

/**
 * Renaming a canonical artifact.
 *
 * A name lives in two places — the path and the frontmatter — and until this
 * existed, changing either one produced `NAME_MISMATCH`, dropped the artifact
 * from the configuration, and left the author to rename the file, the directory
 * and every override by hand. Each case below therefore ends by re-reading the
 * project and asserting it reads clean under the new name.
 */

const CONFIG = 'schema: 1\nproviders:\n  enabled: [claude, codex, copilot, opencode]\n';

const seeded = (): MemoryFileSystem => {
  const fileSystem = new MemoryFileSystem();
  fileSystem.set('.ai/config.yaml', CONFIG);
  fileSystem.set('.ai/agents/reviewer.md', '---\ndescription: Reviews\n---\n\nYou review.\n');
  fileSystem.set('.ai/commands/ship.md', '---\nname: ship\ndescription: Ships\n---\n\nShip it.\n');
  fileSystem.set(
    '.ai/instructions/general.md',
    '---\nname: general\ndescription: Rules\n---\n\nBe careful.\n',
  );
  fileSystem.set(
    '.ai/skills/scouts/SKILL.md',
    '---\nname: scouts\ndescription: Scouts a change.\n---\n\nSteps.\n',
  );
  fileSystem.set('.ai/skills/scouts/references/checklist.md', '# Checklist\n');
  fileSystem.set('.ai/skills/scouts/scripts/run.sh', 'echo hi\n');
  return fileSystem;
};

const withOverrides = (fileSystem: MemoryFileSystem): MemoryFileSystem => {
  fileSystem.set('.ai/providers/claude/skills/scouts.yaml', 'schema: 1\noptions:\n  model: opus\n');
  fileSystem.set(
    '.ai/providers/codex/skills/scouts.yaml',
    'schema: 1\noptions:\n  policy:\n    allow_implicit_invocation: false\n',
  );
  return fileSystem;
};

const reread = async (fileSystem: MemoryFileSystem) =>
  discoverConfiguration(fileSystem, fileSystem.root);

const codes = async (fileSystem: MemoryFileSystem): Promise<readonly string[]> =>
  (await reread(fileSystem)).diagnostics.map((diagnostic) => diagnostic.code);

describe('renaming a skill', () => {
  it('moves the directory, its whole tree, and the name field with it', async () => {
    const fileSystem = seeded();

    const outcome = await renameArtifact(fileSystem, fileSystem.root, 'skill', 'scouts', 'scout');

    expect(outcome.ok && outcome.moved).toEqual([
      { from: '.ai/skills/scouts', to: '.ai/skills/scout' },
    ]);
    expect(fileSystem.get('.ai/skills/scout/SKILL.md')).toBe(
      '---\nname: scout\ndescription: Scouts a change.\n---\n\nSteps.\n',
    );
    // Supporting files travel with the directory rather than being re-created.
    expect(fileSystem.get('.ai/skills/scout/references/checklist.md')).toBe('# Checklist\n');
    expect(fileSystem.get('.ai/skills/scout/scripts/run.sh')).toBe('echo hi\n');
    expect(fileSystem.has('.ai/skills/scouts/SKILL.md')).toBe(false);

    const configuration = await reread(fileSystem);
    expect(configuration.diagnostics).toEqual([]);
    expect(configuration.configuration.skills.map((skill) => skill.name)).toEqual(['scout']);
  });

  it('takes every provider override with it, so none is left refining nothing', async () => {
    const fileSystem = withOverrides(seeded());

    const outcome = await renameArtifact(fileSystem, fileSystem.root, 'skill', 'scouts', 'scout');

    expect(outcome.ok && outcome.moved.map((move) => move.to)).toEqual([
      '.ai/skills/scout',
      '.ai/providers/claude/skills/scout.yaml',
      '.ai/providers/codex/skills/scout.yaml',
    ]);
    expect(fileSystem.get('.ai/providers/claude/skills/scout.yaml')).toBe(
      'schema: 1\noptions:\n  model: opus\n',
    );
    expect(fileSystem.has('.ai/providers/claude/skills/scouts.yaml')).toBe(false);
  });

  it('resolves the mismatch that changing the name field creates', async () => {
    // The reported defect, start to finish: edit `name`, and the project is
    // broken until the directory follows.
    const fileSystem = seeded();
    fileSystem.set(
      '.ai/skills/scouts/SKILL.md',
      '---\nname: scout\ndescription: Scouts a change.\n---\n\nSteps.\n',
    );
    expect(await codes(fileSystem)).toContain('NAME_MISMATCH');

    const mismatch = await readNameMismatch(
      fileSystem,
      fileSystem.root,
      '.ai/skills/scouts/SKILL.md',
    );
    expect(mismatch).toEqual({
      kind: 'skill',
      pathName: 'scouts',
      declaredName: 'scout',
      sourcePath: '.ai/skills/scouts/SKILL.md',
    });

    await renameArtifact(fileSystem, fileSystem.root, 'skill', 'scouts', 'scout');

    expect(await codes(fileSystem)).toEqual([]);
  });

  it('resolves the mismatch that renaming the directory creates, the other way', async () => {
    const fileSystem = seeded();
    // What renaming the directory in the explorer does: the tree moves and the
    // frontmatter is left behind saying the old name.
    await fileSystem.rename(
      `${fileSystem.root}/.ai/skills/scouts`,
      `${fileSystem.root}/.ai/skills/scout`,
    );
    expect(await codes(fileSystem)).toContain('NAME_MISMATCH');

    // `scouts` is what the frontmatter still says, and is therefore also where
    // every override written for this skill still sits.
    const outcome = await alignArtifactName(
      fileSystem,
      fileSystem.root,
      'skill',
      'scouts',
      'scout',
    );

    expect(outcome.ok && outcome.moved).toEqual([]);
    expect(fileSystem.get('.ai/skills/scout/SKILL.md')).toBe(
      '---\nname: scout\ndescription: Scouts a change.\n---\n\nSteps.\n',
    );
    expect(await codes(fileSystem)).toEqual([]);
  });
});

/**
 * The reported defect: rename the file of an artifact that has an override, and
 * the override is gone.
 *
 * Nothing moved it, so it refined an artifact that no longer existed, and the
 * older synchronization removed it as an orphan — deleting a file the author
 * had written. Completing the rename is still useful, and it has to happen for
 * every kind, not only the one it was noticed on.
 */
describe('an override follows the file its artifact lives in', () => {
  const CASES: readonly {
    kind: SourceKind;
    directory: string;
    from: string;
    to: string;
    /** How the artifact looks once the author has renamed its file. */
    seed: (fileSystem: MemoryFileSystem) => void;
  }[] = [
    {
      kind: 'agent',
      directory: 'agents',
      from: 'reviewer',
      to: 'auditor',
      // No `name` field, which is how AI Config scaffolds an agent: renaming
      // the file leaves no evidence of the old name anywhere.
      seed: (fileSystem) =>
        fileSystem.set('.ai/agents/auditor.md', '---\ndescription: Reviews\n---\n\nYou review.\n'),
    },
    {
      kind: 'command',
      directory: 'commands',
      from: 'ship',
      to: 'release',
      seed: (fileSystem) =>
        fileSystem.set('.ai/commands/release.md', '---\ndescription: Ships\n---\n\nShip it.\n'),
    },
    {
      kind: 'instruction',
      directory: 'instructions',
      from: 'general',
      to: 'house-rules',
      seed: (fileSystem) =>
        fileSystem.set(
          '.ai/instructions/house-rules.md',
          '---\ndescription: Rules\n---\n\nBe careful.\n',
        ),
    },
    {
      kind: 'skill',
      directory: 'skills',
      from: 'scouts',
      to: 'scout',
      // A skill must declare `name`, so this arrives as a NAME_MISMATCH and the
      // field is realigned — but the overrides are addressed by name either way.
      seed: (fileSystem) =>
        fileSystem.set(
          '.ai/skills/scout/SKILL.md',
          '---\nname: scouts\ndescription: Scouts a change.\n---\n\nSteps.\n',
        ),
    },
  ];

  for (const { kind, directory, from, to, seed } of CASES) {
    it(`moves every ${kind} override to the new name`, async () => {
      const fileSystem = new MemoryFileSystem();
      fileSystem.set('.ai/config.yaml', CONFIG);
      seed(fileSystem);
      fileSystem.set(
        `.ai/providers/claude/${directory}/${from}.yaml`,
        'schema: 1\noptions:\n  model: opus\n',
      );
      fileSystem.set(
        `.ai/providers/codex/${directory}/${from}.yaml`,
        'schema: 1\noptions:\n  model: gpt-5.5\n',
      );

      const outcome = await alignArtifactName(fileSystem, fileSystem.root, kind, from, to);

      expect(outcome.ok && outcome.moved.map((move) => move.to)).toEqual([
        `.ai/providers/claude/${directory}/${to}.yaml`,
        `.ai/providers/codex/${directory}/${to}.yaml`,
      ]);
      expect(fileSystem.get(`.ai/providers/claude/${directory}/${to}.yaml`)).toContain('opus');
      expect(fileSystem.get(`.ai/providers/codex/${directory}/${to}.yaml`)).toContain('gpt-5.5');
      expect(fileSystem.has(`.ai/providers/claude/${directory}/${from}.yaml`)).toBe(false);
      expect(fileSystem.has(`.ai/providers/codex/${directory}/${from}.yaml`)).toBe(false);

      // And the project reads clean afterwards, so nothing is left to be
      // no longer remain orphaned after the explicit rename operation.
      expect(await codes(fileSystem)).toEqual([]);
    });
  }

  it('refuses rather than overwriting an override the new name already has', async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.set('.ai/config.yaml', CONFIG);
    fileSystem.set('.ai/agents/auditor.md', '---\ndescription: Reviews\n---\n\nYou review.\n');
    fileSystem.set(
      '.ai/providers/claude/agents/reviewer.yaml',
      'schema: 1\noptions:\n  model: a\n',
    );
    fileSystem.set('.ai/providers/claude/agents/auditor.yaml', 'schema: 1\noptions:\n  model: b\n');

    const outcome = await alignArtifactName(
      fileSystem,
      fileSystem.root,
      'agent',
      'reviewer',
      'auditor',
    );

    expect(!outcome.ok && outcome.diagnostics.map((entry) => entry.code)).toEqual([
      'RENAME_TARGET_EXISTS',
    ]);
    // Neither file is touched: merging two sets of provider settings is not
    // something this can decide.
    expect(fileSystem.get('.ai/providers/claude/agents/reviewer.yaml')).toContain('model: a');
    expect(fileSystem.get('.ai/providers/claude/agents/auditor.yaml')).toContain('model: b');
  });

  it('leaves an override alone when the name did not actually change', async () => {
    const fileSystem = seeded();
    fileSystem.set(
      '.ai/providers/claude/agents/reviewer.yaml',
      'schema: 1\noptions:\n  model: a\n',
    );

    const outcome = await alignArtifactName(
      fileSystem,
      fileSystem.root,
      'agent',
      'reviewer',
      'reviewer',
    );

    expect(outcome.ok && outcome.moved).toEqual([]);
    expect(fileSystem.get('.ai/providers/claude/agents/reviewer.yaml')).toContain('model: a');
  });
});

describe('renaming a file-based artifact', () => {
  const CASES: readonly { kind: SourceKind; from: string; to: string; path: string }[] = [
    { kind: 'agent', from: 'reviewer', to: 'code-reviewer', path: '.ai/agents' },
    { kind: 'command', from: 'ship', to: 'release', path: '.ai/commands' },
    { kind: 'instruction', from: 'general', to: 'house-rules', path: '.ai/instructions' },
  ];

  for (const { kind, from, to, path } of CASES) {
    it(`renames the ${kind} file and leaves the project valid`, async () => {
      const fileSystem = seeded();
      const before = fileSystem.get(`${path}/${from}.md`);

      const outcome = await renameArtifact(fileSystem, fileSystem.root, kind, from, to);

      expect(outcome.ok && outcome.moved).toEqual([
        { from: `${path}/${from}.md`, to: `${path}/${to}.md` },
      ]);
      expect(fileSystem.has(`${path}/${from}.md`)).toBe(false);
      // The body and every other field are untouched; only `name` can change,
      // and only when the file declares one.
      expect(fileSystem.get(`${path}/${to}.md`)).toBe(
        before?.replace(`name: ${from}`, `name: ${to}`),
      );
      expect(await codes(fileSystem)).toEqual([]);
    });
  }

  it('leaves a file that declares no name alone, because the filename is the name', async () => {
    const fileSystem = seeded();

    await renameArtifact(fileSystem, fileSystem.root, 'agent', 'reviewer', 'code-reviewer');

    expect(fileSystem.get('.ai/agents/code-reviewer.md')).toBe(
      '---\ndescription: Reviews\n---\n\nYou review.\n',
    );
  });
});

describe('renames that must not happen', () => {
  it('refuses to overwrite an artifact that already has the new name', async () => {
    const fileSystem = seeded();
    fileSystem.set(
      '.ai/skills/scout/SKILL.md',
      '---\nname: scout\ndescription: Another skill.\n---\n\nSteps.\n',
    );

    const outcome = await renameArtifact(fileSystem, fileSystem.root, 'skill', 'scouts', 'scout');

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.diagnostics.map((entry) => entry.code)).toEqual([
      'RENAME_TARGET_EXISTS',
    ]);
    // Nothing moved: the project is exactly as it was.
    expect(fileSystem.get('.ai/skills/scout/SKILL.md')).toContain('Another skill.');
    expect(fileSystem.has('.ai/skills/scouts/SKILL.md')).toBe(true);
  });

  it('refuses when an override would be overwritten, before moving anything', async () => {
    const fileSystem = withOverrides(seeded());
    fileSystem.set(
      '.ai/providers/claude/skills/scout.yaml',
      'schema: 1\noptions:\n  model: haiku\n',
    );

    const outcome = await renameArtifact(fileSystem, fileSystem.root, 'skill', 'scouts', 'scout');

    expect(!outcome.ok && outcome.diagnostics[0]?.code).toBe('RENAME_TARGET_EXISTS');
    // The canonical directory is checked and moved as one unit with its
    // overrides, so a blocked override leaves the skill where it was.
    expect(fileSystem.has('.ai/skills/scouts/SKILL.md')).toBe(true);
    expect(fileSystem.has('.ai/skills/scout/SKILL.md')).toBe(false);
  });

  it('reports a name that is not there rather than inventing one', async () => {
    const fileSystem = seeded();

    const outcome = await renameArtifact(fileSystem, fileSystem.root, 'agent', 'missing', 'other');

    expect(!outcome.ok && outcome.diagnostics.map((entry) => entry.code)).toEqual([
      'RENAME_SOURCE_MISSING',
    ]);
  });

  it('refuses a new name that is not a valid canonical name', async () => {
    const fileSystem = seeded();

    for (const invalid of ['Scout', '../escape', 'scout name', '']) {
      const outcome = await renameArtifact(fileSystem, fileSystem.root, 'skill', 'scouts', invalid);
      expect(!outcome.ok && outcome.diagnostics[0]?.code, invalid).toBe('INVALID_NAME');
      expect(fileSystem.has('.ai/skills/scouts/SKILL.md'), invalid).toBe(true);
    }
  });

  it('is a no-op when the name is already the one asked for', async () => {
    const fileSystem = seeded();

    const outcome = await renameArtifact(fileSystem, fileSystem.root, 'skill', 'scouts', 'scouts');

    expect(outcome.ok && outcome.moved).toEqual([]);
    expect(await codes(fileSystem)).toEqual([]);
  });
});

describe('reading a name mismatch', () => {
  it('says nothing about a file whose two names agree', async () => {
    const fileSystem = seeded();

    expect(
      await readNameMismatch(fileSystem, fileSystem.root, '.ai/skills/scouts/SKILL.md'),
    ).toBeUndefined();
  });

  it('reads the mismatch from a file-based artifact too', async () => {
    const fileSystem = seeded();
    fileSystem.set('.ai/commands/ship.md', '---\nname: release\ndescription: Ships\n---\n\nGo.\n');

    expect(await readNameMismatch(fileSystem, fileSystem.root, '.ai/commands/ship.md')).toEqual({
      kind: 'command',
      pathName: 'ship',
      declaredName: 'release',
      sourcePath: '.ai/commands/ship.md',
    });
  });

  it('says nothing about a file whose frontmatter does not parse', async () => {
    const fileSystem = seeded();
    // Reported as `FRONTMATTER_INVALID_YAML` by discovery, and nothing here can
    // read a name out of it. Guessing one would rename a directory from a file
    // nobody has managed to parse.
    fileSystem.set(
      '.ai/skills/scouts/SKILL.md',
      '---\nname: "scout\ndescription: Scouts.\n---\n\nSteps.\n',
    );

    expect(
      await readNameMismatch(fileSystem, fileSystem.root, '.ai/skills/scouts/SKILL.md'),
    ).toBeUndefined();
  });

  it('says nothing about a file with no frontmatter at all', async () => {
    const fileSystem = seeded();
    fileSystem.set('.ai/skills/scouts/SKILL.md', '# Just a heading\n');

    expect(
      await readNameMismatch(fileSystem, fileSystem.root, '.ai/skills/scouts/SKILL.md'),
    ).toBeUndefined();
  });

  it('says nothing about a name that is not a string', async () => {
    const fileSystem = seeded();
    fileSystem.set('.ai/skills/scouts/SKILL.md', '---\nname: 42\ndescription: S.\n---\n\nSteps.\n');

    expect(
      await readNameMismatch(fileSystem, fileSystem.root, '.ai/skills/scouts/SKILL.md'),
    ).toBeUndefined();
  });

  it('refuses to interpret a path that is not a canonical artifact', async () => {
    const fileSystem = seeded();

    for (const path of [
      '.claude/skills/scouts/SKILL.md',
      '.ai/providers/claude/skills/scouts.yaml',
      '.ai/skills/scouts/references/checklist.md',
      '.ai/config.yaml',
    ]) {
      expect(await readNameMismatch(fileSystem, fileSystem.root, path), path).toBeUndefined();
    }
  });
});

describe('rewriting the name field', () => {
  it('preserves CRLF line endings and a byte order mark', async () => {
    const fileSystem = new MemoryFileSystem();
    const original = Buffer.from(
      '﻿---\r\nname: scouts\r\ndescription: Scouts.\r\n---\r\n\r\nSteps.\r\n',
      'utf8',
    );
    fileSystem.set('.ai/skills/scout/SKILL.md', original);

    await alignArtifactName(fileSystem, fileSystem.root, 'skill', 'scout', 'scout');

    // Only the one line changed. Re-serializing the frontmatter would have
    // normalized all of this, in a file the author owns.
    expect(fileSystem.get('.ai/skills/scout/SKILL.md')).toBe(
      '﻿---\r\nname: scout\r\ndescription: Scouts.\r\n---\r\n\r\nSteps.\r\n',
    );
  });

  it('rewrites only the name line, leaving every other field where it was', async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.set(
      '.ai/skills/scout/SKILL.md',
      [
        '---',
        'description: Scouts.',
        'name: scouts',
        'license: MIT',
        'metadata:',
        '  author: someone',
        '---',
        '',
        '# Body',
        '',
        'name: not-a-field',
        '',
      ].join('\n'),
    );

    await alignArtifactName(fileSystem, fileSystem.root, 'skill', 'scout', 'scout');

    // Key order is preserved, unmodelled fields survive, and a line in the body
    // that merely looks like the field is untouched.
    expect(fileSystem.get('.ai/skills/scout/SKILL.md')).toBe(
      [
        '---',
        'description: Scouts.',
        'name: scout',
        'license: MIT',
        'metadata:',
        '  author: someone',
        '---',
        '',
        '# Body',
        '',
        'name: not-a-field',
        '',
      ].join('\n'),
    );
  });

  it('leaves a file that has no frontmatter untouched', async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.set('.ai/skills/scout/SKILL.md', '# Just a heading\n');

    const outcome = await alignArtifactName(fileSystem, fileSystem.root, 'skill', 'scout', 'scout');

    // Reported elsewhere as a skill with no frontmatter. Inserting one here
    // would repair a file this operation was never asked to repair.
    expect(outcome.ok).toBe(true);
    expect(fileSystem.get('.ai/skills/scout/SKILL.md')).toBe('# Just a heading\n');
  });

  it('leaves a file whose two names already agree byte-identical', async () => {
    const fileSystem = seeded();
    const before = fileSystem.get('.ai/skills/scouts/SKILL.md');

    await alignArtifactName(fileSystem, fileSystem.root, 'skill', 'scouts', 'scouts');

    expect(fileSystem.get('.ai/skills/scouts/SKILL.md')).toBe(before);
  });

  it('reports a file that is not there rather than creating one', async () => {
    const fileSystem = seeded();

    const outcome = await alignArtifactName(
      fileSystem,
      fileSystem.root,
      'skill',
      'missing',
      'missing',
    );

    expect(!outcome.ok && outcome.diagnostics.map((entry) => entry.code)).toEqual([
      'RENAME_SOURCE_MISSING',
    ]);
  });
});
