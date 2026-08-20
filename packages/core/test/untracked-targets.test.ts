import { describe, expect, it } from 'vitest';

import type { ProviderAdapter } from '../src/adapter/adapter.js';
import { MANIFEST_PATH } from '../src/manifest/manifest.js';
import { findExistingProviderTargets } from '../src/sync/untracked-targets.js';
import { MemoryFileSystem } from '../src/testing/memory-file-system.js';

const adapterOf = (id: ProviderAdapter['id'], targetRoots: readonly string[]): ProviderAdapter => ({
  id,
  displayName: `${id} adapter`,
  targetRoots,
  compile: () => ({ files: [], diagnostics: [] }),
});

const claude = adapterOf('claude', ['.claude/agents', '.claude/skills']);
const copilot = adapterOf('copilot', ['.github/agents', '.github/copilot-instructions.md']);

describe('findExistingProviderTargets', () => {
  it('reports nothing for a repository with no provider files', async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.set('src/index.ts', 'export {};');

    expect(
      await findExistingProviderTargets(fileSystem, fileSystem.root, [claude, copilot]),
    ).toEqual([]);
  });

  it('reports the locations that exist, files and directories alike', async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.set('.claude/skills/review/SKILL.md', '# Review');
    fileSystem.set('.github/copilot-instructions.md', 'Be careful.');

    expect(
      await findExistingProviderTargets(fileSystem, fileSystem.root, [claude, copilot]),
    ).toEqual(['.claude/skills', '.github/copilot-instructions.md']);
  });

  it('reports only the locations of the adapters it is given', async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.set('.claude/agents/reviewer.md', '# Reviewer');
    fileSystem.set('.github/agents/reviewer.agent.md', '# Reviewer');

    expect(await findExistingProviderTargets(fileSystem, fileSystem.root, [claude])).toEqual([
      '.claude/agents',
    ]);
  });

  it('reports each shared location once', async () => {
    const fileSystem = new MemoryFileSystem();
    fileSystem.set('AGENTS.md', '# Agents');

    const codex = adapterOf('codex', ['AGENTS.md']);
    const opencode = adapterOf('opencode', ['AGENTS.md']);

    expect(
      await findExistingProviderTargets(fileSystem, fileSystem.root, [codex, opencode]),
    ).toEqual(['AGENTS.md']);
  });

  it('reports nothing once an ownership manifest exists', async () => {
    // With a manifest, generated and untracked files can be told apart, and the
    // planner does so per path. This function answers the question that only
    // arises before there is any record at all.
    const fileSystem = new MemoryFileSystem();
    fileSystem.set('.claude/agents/reviewer.md', '# Reviewer');
    fileSystem.set(MANIFEST_PATH, '{"version":1,"entries":[]}');

    expect(await findExistingProviderTargets(fileSystem, fileSystem.root, [claude])).toEqual([]);
  });
});
