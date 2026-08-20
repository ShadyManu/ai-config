import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { AiConfiguration } from '@aiconfig/core';
import {
  compileFixture,
  exampleRepositoryRoot,
  readGoldenTree,
  shouldUpdateFixtures,
  writeGoldenTree,
} from '@aiconfig/core/testing';

import { AGENT_BODY_MAX_LENGTH, copilotAdapter } from '../src/index.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const expectedDirectory = path.join(testDirectory, 'fixtures', 'expected');

const compile = async () => compileFixture(exampleRepositoryRoot(testDirectory), copilotAdapter);

const EMPTY: AiConfiguration = { instructions: [], agents: [], skills: [], commands: [] };

describe('CopilotAdapter', () => {
  it('generates exactly the expected provider tree', async () => {
    const result = await compile();

    if (shouldUpdateFixtures()) {
      writeGoldenTree(expectedDirectory, result.files);
    }

    expect(Object.fromEntries(result.files)).toEqual(
      Object.fromEntries(readGoldenTree(expectedDirectory)),
    );
  });

  it('sends unscoped instructions to the repository-wide file', async () => {
    const result = await compile();
    const repositoryWide = result.files.get('.github/copilot-instructions.md');
    expect(repositoryWide).toBeDefined();
    expect(repositoryWide).toContain('## general');
    // Scoped instructions belong in their own file, not this one.
    expect(repositoryWide).not.toContain('## backend');
  });

  it('sends scoped instructions to path-specific files with applyTo', async () => {
    const result = await compile();
    const scoped = result.files.get('.github/instructions/backend.instructions.md');
    expect(scoped).toBeDefined();
    // Copilot expects a single comma-separated string, not a YAML list.
    expect(scoped).toContain('applyTo: "backend/**,services/**/*.ts"');
  });

  it('keeps the description as prose for compatibility across Copilot surfaces', async () => {
    const result = await compile();
    const scoped = result.files.get('.github/instructions/backend.instructions.md');
    // Dropping it would silently discard text the author wrote.
    expect(scoped).toContain('Backend development rules');
    expect(scoped).not.toContain('description:');
  });

  it('omits the description paragraph when the instruction has none', () => {
    const result = copilotAdapter.compile({
      ...EMPTY,
      instructions: [
        {
          name: 'backend',
          description: undefined,
          applyTo: ['backend/**'],
          body: 'Rule.',
          sourcePath: '.ai/instructions/backend.md',
        },
      ],
    });

    const file = result.files[0];
    expect(file?.content.kind === 'text' && file.content.value).toBe(
      '---\napplyTo: "backend/**"\n---\n\nRule.\n',
    );
  });

  it('writes only into .github/', async () => {
    const result = await compile();
    for (const generatedPath of result.files.keys()) {
      expect(generatedPath.startsWith('.github/'), generatedPath).toBe(true);
    }
  });

  it('generates agents with the .agent.md extension', async () => {
    const result = await compile();
    expect(result.files.has('.github/agents/reviewer.agent.md')).toBe(true);
  });

  it('warns that commands reach fewer surfaces', async () => {
    const result = await compile();
    expect(result.files.has('.github/prompts/fix-bug.prompt.md')).toBe(true);

    const diagnostic = result.diagnostics.find(
      (candidate) => candidate.code === 'COMMAND_LIMITED_SURFACE',
    );
    expect(diagnostic?.severity).toBe('warning');
    expect(diagnostic?.message).toContain('cloud agent');
    // GitHub qualifies the feature itself, and dropping that qualification
    // would overstate how stable the generated target is.
    expect(diagnostic?.message).toContain('public preview');
  });

  it('maps every command to an explicit prompt file', () => {
    const result = copilotAdapter.compile({
      ...EMPTY,
      commands: [
        {
          name: 'summarize',
          description: 'Summarize the diff',
          body: 'Summarize.',
          sourcePath: '.ai/commands/summarize.md',
        },
      ],
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'COMMAND_LIMITED_SURFACE',
    ]);
    expect(result.files.map((file) => file.path)).toEqual(['.github/prompts/summarize.prompt.md']);
  });

  it('reports no scope warning, because applyTo maps natively', async () => {
    const result = await compile();
    expect(result.diagnostics.filter((d) => d.code === 'INSTRUCTION_SCOPE_NOT_SUPPORTED')).toEqual(
      [],
    );
  });

  it('rejects an agent body beyond the documented Copilot limit', () => {
    const result = copilotAdapter.compile({
      ...EMPTY,
      agents: [
        {
          name: 'verbose',
          description: 'Too long',
          body: 'x'.repeat(AGENT_BODY_MAX_LENGTH + 1),
          sourcePath: '.ai/agents/verbose.md',
        },
      ],
    });

    const diagnostic = result.diagnostics.find((d) => d.code === 'AGENT_BODY_TOO_LONG');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.provider).toBe('copilot');
    // A file Copilot would reject must not be produced.
    expect(result.files).toEqual([]);
  });

  it('accepts an agent body exactly at the limit', () => {
    const result = copilotAdapter.compile({
      ...EMPTY,
      agents: [
        {
          name: 'exact',
          description: 'At the limit',
          body: 'x'.repeat(AGENT_BODY_MAX_LENGTH),
          sourcePath: '.ai/agents/exact.md',
        },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.files).toHaveLength(1);
  });

  it('omits the repository-wide file when every instruction is scoped', () => {
    const result = copilotAdapter.compile({
      ...EMPTY,
      instructions: [
        {
          name: 'backend',
          description: undefined,
          applyTo: ['backend/**'],
          body: 'Rule.',
          sourcePath: '.ai/instructions/backend.md',
        },
      ],
    });

    expect(result.files.map((file) => file.path)).toEqual([
      '.github/instructions/backend.instructions.md',
    ]);
  });

  it('rejects a glob containing a comma rather than emitting a broken pattern', () => {
    // Copilot separates patterns with commas, so `src/**/*.{ts,tsx}` would be
    // split into two patterns that match nothing.
    const result = copilotAdapter.compile({
      ...EMPTY,
      instructions: [
        {
          name: 'frontend',
          description: undefined,
          applyTo: ['src/**/*.{ts,tsx}'],
          body: 'Rule.',
          sourcePath: '.ai/instructions/frontend.md',
        },
      ],
    });

    const diagnostic = result.diagnostics.find((d) => d.code === 'INVALID_APPLY_TO');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('src/**/*.{ts,tsx}');
    expect(result.files).toEqual([]);
  });

  it('joins multiple comma-free globs the way Copilot documents', () => {
    const result = copilotAdapter.compile({
      ...EMPTY,
      instructions: [
        {
          name: 'frontend',
          description: undefined,
          applyTo: ['src/**/*.ts', 'src/**/*.tsx'],
          body: 'Rule.',
          sourcePath: '.ai/instructions/frontend.md',
        },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    const file = result.files[0];
    expect(file?.content.kind === 'text' && file.content.value).toContain(
      'applyTo: "src/**/*.ts,src/**/*.tsx"',
    );
  });

  it('is deterministic across repeated compilations', async () => {
    const first = await compile();
    const second = await compile();
    expect([...second.files]).toEqual([...first.files]);
  });
});
