import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeFileSystem, renameArtifact } from '../../src/index.js';

/**
 * Renaming against a real filesystem.
 *
 * The unit suite runs against `MemoryFileSystem`, where a directory is only a
 * prefix its files share and moving one is re-keying a map. A real directory
 * rename is a single syscall with platform-specific refusals, and it is the one
 * operation in AI Config that moves the author's own sources rather than
 * generated output — so the guarantees that matter are checked here, on disk.
 */

const fileSystem = new NodeFileSystem();

let root: string;

const write = (relativePath: string, content: string): void => {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');

const exists = (relativePath: string): boolean =>
  fs.existsSync(path.join(root, ...relativePath.split('/')));

const absolute = (relativePath: string): string => path.join(root, ...relativePath.split('/'));

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiconfig-rename-'));
  write('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: [claude]\n');
  write('.ai/skills/scouts/SKILL.md', '---\nname: scouts\ndescription: Scouts.\n---\n\nSteps.\n');
  write('.ai/skills/scouts/references/checklist.md', '# Checklist\n');
  write('.ai/skills/scouts/scripts/nested/deep.txt', 'deep\n');
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('renaming on a real filesystem', () => {
  it('moves a whole skill tree in one step, contents intact', async () => {
    const outcome = await renameArtifact(fileSystem, root, 'skill', 'scouts', 'scout');

    expect(outcome.ok).toBe(true);
    expect(exists('.ai/skills/scouts')).toBe(false);
    expect(read('.ai/skills/scout/SKILL.md')).toContain('name: scout');
    // Nesting is not flattened and nothing is re-created from a copy.
    expect(read('.ai/skills/scout/scripts/nested/deep.txt')).toBe('deep\n');
  });

  it('preserves the executable bit of a supporting file', async () => {
    // A rename moves the inode. A copy-then-delete would have to reproduce the
    // mode, and getting that wrong ships a skill whose script cannot run.
    const script = absolute('.ai/skills/scouts/scripts/run.sh');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    const before = fs.statSync(script).mode;

    await renameArtifact(fileSystem, root, 'skill', 'scouts', 'scout');

    expect(fs.statSync(absolute('.ai/skills/scout/scripts/run.sh')).mode).toBe(before);
  });

  it('refuses at the filesystem itself when the destination exists', async () => {
    // `renameArtifact` checks first, so this is the guarantee underneath that
    // check rather than the check: on POSIX a plain rename would replace an
    // existing file without a word, and this moves the author's own sources.
    write('.ai/agents/one.md', '---\ndescription: One\n---\n\nBody.\n');
    write('.ai/agents/two.md', '---\ndescription: Two\n---\n\nBody.\n');

    await expect(
      fileSystem.rename(absolute('.ai/agents/one.md'), absolute('.ai/agents/two.md')),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(read('.ai/agents/two.md')).toContain('Two');
  });

  it('reports a source that is not there rather than creating anything', async () => {
    await expect(
      fileSystem.rename(absolute('.ai/agents/missing.md'), absolute('.ai/agents/other.md')),
    ).rejects.toBeInstanceOf(Error);

    expect(exists('.ai/agents/other.md')).toBe(false);
  });

  it('leaves the project untouched when an override blocks the rename', async () => {
    write('.ai/providers/claude/skills/scouts.yaml', 'schema: 1\noptions:\n  model: opus\n');
    write('.ai/providers/claude/skills/scout.yaml', 'schema: 1\noptions:\n  model: haiku\n');

    const outcome = await renameArtifact(fileSystem, root, 'skill', 'scouts', 'scout');

    expect(outcome.ok).toBe(false);
    // Every check runs before the first move, so a blocked override cannot
    // leave the skill renamed and its settings behind.
    expect(exists('.ai/skills/scouts/SKILL.md')).toBe(true);
    expect(exists('.ai/skills/scout')).toBe(false);
    expect(read('.ai/providers/claude/skills/scout.yaml')).toContain('haiku');
  });

  it('moves an override left by a provider this build does not know', async () => {
    // Read from disk rather than from the registered provider list, as removal
    // is: an unknown provider's override is still named after this artifact,
    // and leaving it behind breaks it just as silently.
    write('.ai/providers/future-tool/skills/scouts.yaml', 'schema: 1\noptions:\n  x: 1\n');

    const outcome = await renameArtifact(fileSystem, root, 'skill', 'scouts', 'scout');

    expect(outcome.ok && outcome.moved.map((move) => move.to)).toContain(
      '.ai/providers/future-tool/skills/scout.yaml',
    );
    expect(exists('.ai/providers/future-tool/skills/scouts.yaml')).toBe(false);
  });

  it('renames only the artifact it was asked about', async () => {
    // A prefix match would take `scouts-extra` with it.
    write(
      '.ai/skills/scouts-extra/SKILL.md',
      '---\nname: scouts-extra\ndescription: X.\n---\n\nY.\n',
    );

    await renameArtifact(fileSystem, root, 'skill', 'scouts', 'scout');

    expect(read('.ai/skills/scouts-extra/SKILL.md')).toContain('name: scouts-extra');
  });
});
