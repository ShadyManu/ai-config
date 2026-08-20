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

import { codexAdapter } from '../src/index.js';
import { renderToml, tomlMultilineString } from '../src/toml.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const expectedDirectory = path.join(testDirectory, 'fixtures', 'expected');

const compile = async () => compileFixture(exampleRepositoryRoot(testDirectory), codexAdapter);

describe('CodexAdapter', () => {
  it('generates exactly the expected provider tree', async () => {
    const result = await compile();

    if (shouldUpdateFixtures()) {
      writeGoldenTree(expectedDirectory, result.files);
    }

    expect(Object.fromEntries(result.files)).toEqual(
      Object.fromEntries(readGoldenTree(expectedDirectory)),
    );
  });

  it('concatenates every instruction into the root AGENTS.md', async () => {
    const result = await compile();
    const agentsMarkdown = result.files.get('AGENTS.md');
    expect(agentsMarkdown).toBeDefined();
    expect(agentsMarkdown).toContain('## general');
    expect(agentsMarkdown).toContain('## backend');
  });

  it('records a scoped instruction as prose and warns that scope is lost', async () => {
    const result = await compile();
    expect(result.files.get('AGENTS.md')).toContain('Applies to: `backend/**`');

    const diagnostic = result.diagnostics.find(
      (candidate) => candidate.code === 'INSTRUCTION_SCOPE_NOT_SUPPORTED',
    );
    expect(diagnostic?.severity).toBe('warning');
    expect(diagnostic?.provider).toBe('codex');
    expect(diagnostic?.source).toBe('.ai/instructions/backend.md');
  });

  it('does not warn about unscoped instructions', async () => {
    const result = await compile();
    const scopeWarnings = result.diagnostics.filter(
      (candidate) => candidate.code === 'INSTRUCTION_SCOPE_NOT_SUPPORTED',
    );
    expect(scopeWarnings).toHaveLength(1);
  });

  it('generates agents as TOML with the three required fields', async () => {
    const result = await compile();
    const agent = result.files.get('.codex/agents/reviewer.toml');
    expect(agent).toBeDefined();
    expect(agent).toContain('name = "reviewer"');
    expect(agent).toContain('description = "Reviews changes');
    expect(agent).toContain('developer_instructions = """');
  });

  it('converts commands into skills and reports the changed invocation syntax', async () => {
    const result = await compile();
    expect(result.files.has('.agents/skills/fix-bug/SKILL.md')).toBe(true);

    const diagnostic = result.diagnostics.find(
      (candidate) => candidate.code === 'COMMAND_CONVERTED_TO_SKILL',
    );
    // Informational, not a warning: the sidecar preserves the developer-invoked
    // semantic, so all that changed is how the workflow is invoked.
    expect(diagnostic?.severity).toBe('info');
    expect(diagnostic?.message).toContain('$fix-bug');
  });

  it('disables implicit invocation for a developer-invoked command', async () => {
    const result = await compile();

    const policy = result.files.get('.agents/skills/fix-bug/agents/openai.yaml');
    expect(policy).toBe('policy:\n  allow_implicit_invocation: false\n');
  });

  it('generates a sidecar inside a canonical skill only when one is configured', async () => {
    // A canonical skill is copied byte-for-byte, so a generated file lands
    // inside one only because the user asked for it through
    // `.ai/providers/codex/skills/<id>.yaml`. The example configures
    // `code-review` and leaves every other skill alone.
    const configured = await compile();
    expect(configured.files.get('.agents/skills/code-review/agents/openai.yaml')).toBe(
      'policy:\n  allow_implicit_invocation: false\n',
    );

    const unconfigured = codexAdapter.compile({
      instructions: [],
      agents: [],
      commands: [],
      skills: [
        {
          name: 'code-review',
          description: 'Reviews a change',
          sourcePath: '.ai/skills/code-review',
          entrypointText: '---\nname: code-review\ndescription: Reviews a change\n---\n\nBody.\n',
          entrypointKeys: ['name', 'description'],
          files: [{ relativePath: 'SKILL.md', sha256: 'sha256:aaa', size: 10, executable: false }],
        },
      ],
    });
    for (const file of unconfigured.files) {
      expect(file.path).not.toBe('.agents/skills/code-review/agents/openai.yaml');
    }
  });

  it('always emits the policy sidecar for explicit-only commands', () => {
    const result = codexAdapter.compile({
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

    expect(result.files.map((file) => file.path)).toEqual([
      '.agents/skills/summarize/SKILL.md',
      '.agents/skills/summarize/agents/openai.yaml',
    ]);
    expect(result.diagnostics[0]?.severity).toBe('info');
    expect(result.files[1]?.content).toEqual({
      kind: 'text',
      value: 'policy:\n  allow_implicit_invocation: false\n',
    });
  });

  it('attributes the policy sidecar to the command, so it is cleaned up with it', () => {
    const result = codexAdapter.compile({
      instructions: [],
      agents: [],
      skills: [],
      commands: [
        {
          name: 'deploy',
          description: 'Deploy the service',
          body: 'Deploy.',
          sourcePath: '.ai/commands/deploy.md',
        },
      ],
    });

    const policy = result.files.find((file) => file.path.endsWith('openai.yaml'));
    expect(policy?.source).toEqual({ kind: 'command', name: 'deploy' });
  });

  it('places skills in .agents/skills and copies them verbatim', async () => {
    const result = await compile();
    expect(result.files.has('.agents/skills/code-review/SKILL.md')).toBe(true);
    expect(result.files.has('.agents/skills/code-review/references/checklist.md')).toBe(true);

    const original = readGoldenTree(
      path.join(exampleRepositoryRoot(testDirectory), '.ai', 'skills', 'code-review'),
    );
    expect(result.files.get('.agents/skills/code-review/SKILL.md')).toBe(original.get('SKILL.md'));
  });

  it('is deterministic across repeated compilations', async () => {
    const first = await compile();
    const second = await compile();
    expect([...second.files]).toEqual([...first.files]);
  });
});

describe('TOML serialization', () => {
  it('escapes quotes and backslashes in basic strings', () => {
    expect(renderToml([{ key: 'k', value: 'say "hi"\\now' }])).toBe('k = "say \\"hi\\"\\\\now"\n');
  });

  it('escapes control characters', () => {
    expect(renderToml([{ key: 'k', value: `a${String.fromCharCode(1)}b` }])).toBe(
      'k = "a\\u0001b"\n',
    );
  });

  it('keeps newlines literal in multi-line strings', () => {
    expect(tomlMultilineString('line one\nline two')).toBe('"""\nline one\nline two"""');
  });

  it('leaves single and double quotes literal for readability', () => {
    // TOML permits one or two consecutive quotes inside a multi-line string,
    // so escaping them would only make generated prompts harder to read.
    expect(tomlMultilineString('say "hi" and ""also"" here')).toBe(
      '"""\nsay "hi" and ""also"" here"""',
    );
  });

  it('escapes quote runs that would close the literal early', () => {
    const rendered = tomlMultilineString('before """ after');
    expect(rendered).not.toContain('""" after');
    expect(rendered).toContain('\\"\\"\\"');
  });

  it('escapes a trailing quote so it cannot merge with the delimiter', () => {
    expect(tomlMultilineString('ends with "')).toBe('"""\nends with \\""""');
  });

  it('cannot be escaped by a body that looks like TOML', () => {
    // An agent body is author-supplied text; it must not be able to close the
    // literal and declare further keys.
    const rendered = renderToml([
      { key: 'name', value: 'reviewer' },
      {
        key: 'developer_instructions',
        value: 'escape attempt\n"""\nname = "evil"\ndeveloper_instructions = """',
        multiline: true,
      },
    ]);

    // Exactly one opening and one closing delimiter, and nothing but
    // whitespace after the close: the injected text stayed inside the literal,
    // so it is data rather than further TOML keys.
    expect(rendered.match(/"""/g)).toHaveLength(2);
    expect(rendered.slice(rendered.lastIndexOf('"""') + 3).trim()).toBe('');
  });

  it('never emits an unescaped triple quote inside the body', () => {
    for (const value of ['"', '""', '"""', '""""', 'a"""b', 'trailing ""']) {
      const rendered = tomlMultilineString(value);
      const body = rendered.slice('"""\n'.length, -'"""'.length);
      expect(body.replace(/\\"/g, ''), value).not.toMatch(/"{3,}/);
      expect(body.endsWith('"') && !body.endsWith('\\"'), value).toBe(false);
    }
  });
});
