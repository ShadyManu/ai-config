import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  compileFixture,
  exampleRepositoryRoot,
  readGoldenTree,
  shouldUpdateFixtures,
  writeGoldenTree,
} from '@aiconfig/core/testing';

import { opencodeAdapter } from '../src/index.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const expectedDirectory = path.join(testDirectory, 'fixtures', 'expected');

const compile = async () => compileFixture(exampleRepositoryRoot(testDirectory), opencodeAdapter);

describe('OpenCodeAdapter', () => {
  it('generates exactly the expected provider tree', async () => {
    const result = await compile();

    if (shouldUpdateFixtures()) {
      writeGoldenTree(expectedDirectory, result.files);
    }

    expect(Object.fromEntries(result.files)).toEqual(
      Object.fromEntries(readGoldenTree(expectedDirectory)),
    );
  });

  it('uses the plural directory names OpenCode documents', async () => {
    const result = await compile();
    expect(result.files.has('.opencode/agents/reviewer.md')).toBe(true);
    expect(result.files.has('.opencode/commands/fix-bug.md')).toBe(true);
    expect(result.files.has('.opencode/skills/code-review/SKILL.md')).toBe(true);
  });

  it('marks agents as subagents and omits name, which OpenCode takes from the filename', async () => {
    const result = await compile();
    const agent = result.files.get('.opencode/agents/reviewer.md');
    expect(agent).toContain('mode: subagent');
    expect(agent).not.toContain('name:');
  });

  it('generates commands natively without a warning', async () => {
    const result = await compile();
    expect(result.files.has('.opencode/commands/fix-bug.md')).toBe(true);
    expect(result.diagnostics.filter((d) => d.code.startsWith('COMMAND_'))).toEqual([]);
  });

  it('maps every command to an explicit native command file', () => {
    const result = opencodeAdapter.compile({
      instructions: [],
      agents: [],
      skills: [],
      commands: [
        {
          name: 'summarize',
          description: 'Summarize the diff',
          body: 'Summarize.',
          sourcePath: '.ai/commands/summarize.md',
        },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.files.map((file) => file.path)).toEqual(['.opencode/commands/summarize.md']);
  });

  it('passes argument placeholders through untranslated', async () => {
    const result = await compile();
    expect(result.files.get('.opencode/commands/fix-bug.md')).toContain('$ARGUMENTS');
  });

  it('warns that scoped instructions cannot be expressed', async () => {
    const result = await compile();
    const diagnostic = result.diagnostics.find(
      (candidate) => candidate.code === 'INSTRUCTION_SCOPE_NOT_SUPPORTED',
    );
    expect(diagnostic?.severity).toBe('warning');
    expect(diagnostic?.provider).toBe('opencode');
  });

  it('warns when OpenCode ignores canonical allowed-tools without rewriting the skill', () => {
    const entrypointText =
      '---\nname: guarded\ndescription: Uses approved tools\nallowed-tools: Read\n---\n\nSteps.\n';
    const result = opencodeAdapter.compile({
      instructions: [],
      agents: [],
      commands: [],
      skills: [
        {
          name: 'guarded',
          description: 'Uses approved tools',
          sourcePath: '.ai/skills/guarded',
          entrypointText,
          entrypointKeys: ['name', 'description', 'allowed-tools'],
          files: [
            { relativePath: 'SKILL.md', sha256: 'sha256:guarded', size: 1, executable: false },
          ],
        },
      ],
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'SKILL_ALLOWED_TOOLS_UNSUPPORTED',
        severity: 'warning',
        provider: 'opencode',
        source: '.ai/skills/guarded/SKILL.md',
      }),
    ]);
    expect(result.files[0]?.content).toEqual({
      kind: 'copy',
      ref: { skill: 'guarded', relativePath: 'SKILL.md' },
    });
  });

  it('never generates or modifies opencode.json', async () => {
    const result = await compile();
    expect([...result.files.keys()].some((p) => p.endsWith('opencode.json'))).toBe(false);
  });

  it('is deterministic across repeated compilations', async () => {
    const first = await compile();
    const second = await compile();
    expect([...second.files]).toEqual([...first.files]);
  });
});
