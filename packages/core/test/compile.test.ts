import { describe, expect, it } from 'vitest';

import type { CompileResult, GeneratedFile, ProviderAdapter } from '../src/adapter/adapter.js';
import { compile } from '../src/compile/compile.js';
import type { AiConfiguration } from '../src/domain/configuration.js';
import type { ProviderId } from '../src/domain/provider.js';

const EMPTY: AiConfiguration = { instructions: [], agents: [], skills: [], commands: [] };

const WITH_SKILL: AiConfiguration = {
  ...EMPTY,
  skills: [
    {
      name: 'demo',
      description: 'A demo skill',
      sourcePath: '.ai/skills/demo',
      entrypointText: ['---', 'name: demo', 'description: A demo skill', '---', '', 'Body.'].join(
        '\n',
      ),
      entrypointKeys: ['name', 'description'],
      files: [
        { relativePath: 'SKILL.md', sha256: 'sha256:aaa', size: 10, executable: false },
        { relativePath: 'scripts/run.sh', sha256: 'sha256:bbb', size: 20, executable: true },
      ],
    },
  ],
};

/** An adapter that returns whatever files the test hands it. */
const adapterOf = (
  id: ProviderId,
  files: readonly GeneratedFile[],
  diagnostics: CompileResult['diagnostics'] = [],
): ProviderAdapter => ({
  id,
  displayName: `${id} adapter`,
  targetRoots: [],
  compile: () => ({ files, diagnostics }),
});

const textFile = (path: string, value = 'content'): GeneratedFile => ({
  path,
  source: null,
  content: { kind: 'text', value },
});

const codes = (result: { diagnostics: readonly { code: string }[] }): readonly string[] =>
  result.diagnostics.map((diagnostic) => diagnostic.code);

describe('compile: path safety', () => {
  it.each([
    ['../escape.md', 'parent traversal'],
    ['/etc/passwd', 'absolute path'],
    ['C:/Windows/system.ini', 'Windows drive path'],
    ['a/../../escape.md', 'traversal in the middle'],
    ['.claude\\agents\\a.md', 'backslash separators'],
    ['', 'empty path'],
  ])('rejects an adapter that returns %s (%s)', (badPath) => {
    const result = compile(EMPTY, [adapterOf('claude', [textFile(badPath)])]);

    expect(codes(result)).toEqual(['UNSAFE_OUTPUT_PATH']);
    expect(result.artifacts).toEqual([]);
  });

  it('rejects output inside the canonical .ai directory', () => {
    for (const path of ['.ai', '.ai/config.yaml', '.ai/agents/x.md', '.ai/.generated.json']) {
      const result = compile(EMPTY, [adapterOf('claude', [textFile(path)])]);
      expect(codes(result), path).toEqual(['UNSAFE_OUTPUT_PATH']);
      expect(result.artifacts, path).toEqual([]);
    }
  });

  it('keeps safe files from an adapter that also returned an unsafe one', () => {
    const result = compile(EMPTY, [
      adapterOf('claude', [textFile('../escape.md'), textFile('.claude/ok.md')]),
    ]);

    expect(codes(result)).toEqual(['UNSAFE_OUTPUT_PATH']);
    expect(result.artifacts.map((artifact) => artifact.path)).toEqual(['.claude/ok.md']);
  });
});

describe('compile: skill references', () => {
  it('resolves a copy reference to the hash recorded during parsing', () => {
    const result = compile(WITH_SKILL, [
      adapterOf('claude', [
        {
          path: '.claude/skills/demo/SKILL.md',
          source: { kind: 'skill', name: 'demo' },
          content: { kind: 'copy', ref: { skill: 'demo', relativePath: 'SKILL.md' } },
        },
      ]),
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts[0]?.hash).toBe('sha256:aaa');
  });

  it('rejects a reference to a skill file that was never parsed', () => {
    const result = compile(WITH_SKILL, [
      adapterOf('claude', [
        {
          path: '.claude/skills/demo/absent.md',
          source: { kind: 'skill', name: 'demo' },
          content: { kind: 'copy', ref: { skill: 'demo', relativePath: '../../../etc/passwd' } },
        },
      ]),
    ]);

    expect(codes(result)).toEqual(['UNKNOWN_SKILL_FILE']);
    expect(result.artifacts).toEqual([]);
  });

  it('rejects a reference to an unknown skill', () => {
    const result = compile(WITH_SKILL, [
      adapterOf('claude', [
        {
          path: '.claude/skills/other/SKILL.md',
          source: { kind: 'skill', name: 'other' },
          content: { kind: 'copy', ref: { skill: 'other', relativePath: 'SKILL.md' } },
        },
      ]),
    ]);

    expect(codes(result)).toEqual(['UNKNOWN_SKILL_FILE']);
  });
});

describe('compile: ownership', () => {
  it('attributes each file to the adapter that produced it', () => {
    const result = compile(EMPTY, [
      adapterOf('claude', [textFile('.claude/a.md')]),
      adapterOf('codex', [textFile('.codex/b.md')]),
    ]);

    const byPath = new Map(result.artifacts.map((a) => [a.path, a.providers]));
    expect(byPath.get('.claude/a.md')).toEqual(['claude']);
    expect(byPath.get('.codex/b.md')).toEqual(['codex']);
  });

  it('records shared ownership when two adapters produce identical content', () => {
    const result = compile(EMPTY, [
      adapterOf('codex', [textFile('AGENTS.md', 'same')]),
      adapterOf('opencode', [textFile('AGENTS.md', 'same')]),
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.providers).toEqual(['codex', 'opencode']);
  });

  it('reports a conflict when two adapters disagree about the same path', () => {
    const result = compile(EMPTY, [
      adapterOf('codex', [textFile('AGENTS.md', 'one')]),
      adapterOf('opencode', [textFile('AGENTS.md', 'two')]),
    ]);

    expect(codes(result)).toEqual(['OUTPUT_PATH_CONFLICT']);
    // Never last-writer-wins: the first adapter's content stands and the error
    // blocks the sync.
    expect(result.artifacts[0]?.providers).toEqual(['codex']);
  });

  it('is independent of the order adapters are supplied in', () => {
    const forwards = compile(EMPTY, [
      adapterOf('opencode', [textFile('AGENTS.md', 'same')]),
      adapterOf('codex', [textFile('AGENTS.md', 'same')]),
    ]);
    const backwards = compile(EMPTY, [
      adapterOf('codex', [textFile('AGENTS.md', 'same')]),
      adapterOf('opencode', [textFile('AGENTS.md', 'same')]),
    ]);

    expect(forwards.artifacts).toEqual(backwards.artifacts);
  });

  it('sorts artifacts by path', () => {
    const result = compile(EMPTY, [
      adapterOf('claude', [textFile('.claude/z.md'), textFile('.claude/a.md')]),
    ]);

    expect(result.artifacts.map((a) => a.path)).toEqual(['.claude/a.md', '.claude/z.md']);
  });
});

describe('compile: adapter failure', () => {
  it('discards the files of an adapter that reported an error', () => {
    const result = compile(EMPTY, [
      adapterOf(
        'claude',
        [textFile('.claude/a.md')],
        [{ code: 'AGENT_BODY_TOO_LONG', severity: 'error', message: 'too long' }],
      ),
    ]);

    expect(result.artifacts).toEqual([]);
    expect(codes(result)).toEqual(['AGENT_BODY_TOO_LONG']);
  });

  it('keeps files from an adapter that only reported warnings', () => {
    const result = compile(EMPTY, [
      adapterOf(
        'claude',
        [textFile('.claude/a.md')],
        [{ code: 'COMMAND_LIMITED_SURFACE', severity: 'warning', message: 'partial' }],
      ),
    ]);

    expect(result.artifacts).toHaveLength(1);
  });

  it('converts a thrown exception into a diagnostic instead of crashing', () => {
    const broken: ProviderAdapter = {
      id: 'claude',
      displayName: 'Broken',
      targetRoots: [],
      compile: () => {
        throw new Error('adapter blew up');
      },
    };

    const result = compile(EMPTY, [broken]);

    expect(codes(result)).toEqual(['ADAPTER_INTERNAL_ERROR']);
    expect(result.diagnostics[0]?.message).toContain('adapter blew up');
    expect(result.artifacts).toEqual([]);
  });

  it('still compiles other adapters when one fails', () => {
    const broken: ProviderAdapter = {
      id: 'claude',
      displayName: 'Broken',
      targetRoots: [],
      compile: () => {
        throw new Error('boom');
      },
    };

    const result = compile(EMPTY, [broken, adapterOf('codex', [textFile('.codex/a.md')])]);

    expect(result.artifacts.map((a) => a.path)).toEqual(['.codex/a.md']);
    expect(codes(result)).toContain('ADAPTER_INTERNAL_ERROR');
  });
});
