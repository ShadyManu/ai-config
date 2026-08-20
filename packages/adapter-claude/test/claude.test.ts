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

import { claudeAdapter } from '../src/index.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const expectedDirectory = path.join(testDirectory, 'fixtures', 'expected');

const EMPTY: AiConfiguration = { instructions: [], agents: [], skills: [], commands: [] };

describe('ClaudeAdapter', () => {
  it('generates exactly the expected provider tree', async () => {
    const result = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);

    if (shouldUpdateFixtures()) {
      writeGoldenTree(expectedDirectory, result.files);
    }

    const expected = readGoldenTree(expectedDirectory);
    expect(Object.fromEntries(result.files)).toEqual(Object.fromEntries(expected));
  });

  it('reports no compatibility diagnostics for the default command semantic', async () => {
    const result = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);
    expect(result.diagnostics).toEqual([]);
  });

  it('disables model invocation for a developer-invoked command', async () => {
    const result = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);
    const command = result.files.get('.claude/commands/fix-bug.md');

    // Documented as valid in a command file, and correct under either reading
    // of the provider's ambiguity: it either enforces the intent or is inert.
    expect(command).toContain('disable-model-invocation: true');
  });

  it('emits a model-invocation guard for every command', () => {
    const result = claudeAdapter.compile({
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

    expect(result.diagnostics).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.content).toEqual({
      kind: 'text',
      value:
        '---\ndescription: Summarize the diff\ndisable-model-invocation: true\n---\n\nSummarize.\n',
    });
  });

  it('writes only into .claude/', async () => {
    const result = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);
    for (const generatedPath of result.files.keys()) {
      expect(generatedPath.startsWith('.claude/'), generatedPath).toBe(true);
    }
  });

  it('maps applyTo onto the paths frontmatter field', async () => {
    const result = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);
    const backend = result.files.get('.claude/rules/backend.md');
    expect(backend).toBeDefined();
    expect(backend).toContain('paths:');
    // Globs are quoted: `*` is a YAML alias indicator, and every provider's
    // documentation writes them quoted too.
    expect(backend).toContain('- "backend/**"');
  });

  it('omits paths for an unscoped instruction so it loads unconditionally', async () => {
    const result = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);
    const general = result.files.get('.claude/rules/general.md');
    expect(general).toBeDefined();
    expect(general).not.toContain('paths:');
  });

  it('emits no description frontmatter, the one field rules do not document', async () => {
    // `paths` is the only frontmatter field Claude Code documents for a rules
    // file. Emitting a second one would rely on tolerance rather than
    // documentation, which is what this project refuses to do.
    const result = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);

    for (const [generatedPath, content] of result.files) {
      if (!generatedPath.startsWith('.claude/rules/')) {
        continue;
      }
      expect(content, generatedPath).not.toContain('description:');
    }
  });

  it('carries an instruction description into the body rather than discarding it', async () => {
    const result = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);

    const backend = result.files.get('.claude/rules/backend.md');
    expect(backend).toContain('Backend development rules');
    // Above the instruction text, so it reads as the summary it is.
    expect(backend?.indexOf('Backend development rules')).toBeLessThan(
      backend?.indexOf('- Validate every request body') ?? -1,
    );
  });

  it('produces no frontmatter at all for an unscoped instruction', async () => {
    // A rules file needs frontmatter only to carry `paths`. Without it the
    // delimiters would introduce an empty block for no reason.
    const result = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);
    const general = result.files.get('.claude/rules/general.md');

    expect(general?.startsWith('---')).toBe(false);
    expect(general?.startsWith('Project-wide engineering guidelines')).toBe(true);
  });

  it('emits the body alone when an instruction has neither description nor applyTo', () => {
    const result = claudeAdapter.compile({
      ...EMPTY,
      instructions: [
        {
          name: 'plain',
          description: undefined,
          applyTo: [],
          body: 'Rule.',
          sourcePath: '.ai/instructions/plain.md',
        },
      ],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.content).toEqual({ kind: 'text', value: 'Rule.\n' });
  });

  it('copies skill files byte-for-byte, including supporting files', async () => {
    const result = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);
    expect(result.files.has('.claude/skills/code-review/SKILL.md')).toBe(true);
    expect(result.files.has('.claude/skills/code-review/references/checklist.md')).toBe(true);

    const original = readGoldenTree(
      path.join(exampleRepositoryRoot(testDirectory), '.ai', 'skills', 'code-review'),
    );
    expect(result.files.get('.claude/skills/code-review/SKILL.md')).toBe(original.get('SKILL.md'));
    expect(result.files.get('.claude/skills/code-review/references/checklist.md')).toBe(
      original.get('references/checklist.md'),
    );
  });

  it('is deterministic across repeated compilations', async () => {
    const first = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);
    const second = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);
    expect([...second.files]).toEqual([...first.files]);
  });

  it('ends every generated text file with exactly one newline', async () => {
    const result = await compileFixture(exampleRepositoryRoot(testDirectory), claudeAdapter);
    for (const [generatedPath, content] of result.files) {
      if (generatedPath.includes('/skills/')) {
        continue; // Copied verbatim; the source controls its own trailing bytes.
      }
      expect(content.endsWith('\n'), generatedPath).toBe(true);
      expect(content.endsWith('\n\n'), generatedPath).toBe(false);
    }
  });
});
