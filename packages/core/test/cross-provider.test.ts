import { describe, expect, it } from 'vitest';

import type { ForeignIntake, GeneratedFile, ProviderAdapter } from '../src/adapter/adapter.js';
import { compile } from '../src/compile/compile.js';
import type { AiConfiguration } from '../src/domain/configuration.js';
import type { Diagnostic } from '../src/domain/diagnostic.js';
import type { ProviderId } from '../src/domain/provider.js';

const EMPTY: AiConfiguration = { instructions: [], agents: [], skills: [], commands: [] };

/**
 * Stub adapters rather than the real ones: this file tests core's matching
 * rule, and core must stay provider-agnostic. The real four-provider case is
 * covered in `@aiconfig/providers`, which is the only package that may depend
 * on every adapter.
 */
const adapterOf = (
  id: ProviderId,
  paths: readonly string[],
  alsoReads: readonly ForeignIntake[] = [],
): ProviderAdapter => {
  const files: GeneratedFile[] = paths.map((path) => ({
    path,
    source: { kind: 'skill', name: 'demo' },
    content: { kind: 'text', value: 'content' },
  }));

  return {
    id,
    displayName: `${id} adapter`,
    targetRoots: [],
    alsoReads,
    compile: () => ({ files, diagnostics: [] }),
  };
};

const READS_CLAUDE_SKILLS: ForeignIntake = {
  path: '.claude/skills',
  code: 'SKILL_DISCOVERY_OVERLAP',
  consequence: 'Consequence sentence.',
};

const overlaps = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  diagnostics.filter((diagnostic) => diagnostic.code === 'SKILL_DISCOVERY_OVERLAP');

describe('compile: cross-provider discovery', () => {
  it('reports one diagnostic when another provider generates into a declared intake', () => {
    const result = compile(EMPTY, [
      adapterOf('claude', ['.claude/skills/demo/SKILL.md', '.claude/skills/demo/notes.md']),
      adapterOf('copilot', ['.github/skills/demo/SKILL.md'], [READS_CLAUDE_SKILLS]),
    ]);

    const reported = overlaps(result.diagnostics);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.severity).toBe('warning');
    // Attributed to the consuming provider, so its status reflects the hazard.
    expect(reported[0]?.provider).toBe('copilot');
    // Pointed at the file that decides the enabled set, which is the only
    // place an author can act on it.
    expect(reported[0]?.source).toBe('.ai/config.yaml');
    expect(reported[0]?.message).toContain('.claude/skills');
    expect(reported[0]?.message).toContain('claude adapter');
    expect(reported[0]?.message).toContain('Consequence sentence.');
  });

  it('names the canonical sources involved rather than the generated files', () => {
    const result = compile(EMPTY, [
      adapterOf('claude', ['.claude/skills/demo/SKILL.md', '.claude/skills/demo/notes.md']),
      adapterOf('copilot', [], [READS_CLAUDE_SKILLS]),
    ]);

    // Two files, one canonical skill: the author thinks in canonical items.
    expect(overlaps(result.diagnostics)[0]?.message).toContain('(skills/demo)');
  });

  it('stays silent when the declaring provider owns everything under the intake', () => {
    const result = compile(EMPTY, [
      adapterOf('copilot', ['.claude/skills/demo/SKILL.md'], [READS_CLAUDE_SKILLS]),
    ]);

    expect(overlaps(result.diagnostics)).toEqual([]);
  });

  it('stays silent when the intake is empty', () => {
    const result = compile(EMPTY, [
      adapterOf('claude', ['.claude/agents/reviewer.md']),
      adapterOf('copilot', ['.github/skills/demo/SKILL.md'], [READS_CLAUDE_SKILLS]),
    ]);

    expect(overlaps(result.diagnostics)).toEqual([]);
  });

  it('excludes a co-owned artifact from the consuming provider it belongs to', () => {
    const shared: ForeignIntake = {
      path: '.agents/skills',
      code: 'SKILL_DISCOVERY_OVERLAP',
      consequence: 'Discovered from several roots.',
    };

    // Two adapters produce byte-identical files there, so both own the root. A
    // third provider that also reads it is the only one that should hear it.
    const result = compile(EMPTY, [
      adapterOf('codex', ['.agents/skills/demo/SKILL.md']),
      adapterOf('opencode', ['.agents/skills/demo/SKILL.md'], [shared]),
      adapterOf('copilot', [], [shared]),
    ]);

    const reported = overlaps(result.diagnostics);
    expect(reported.map((diagnostic) => diagnostic.provider)).toEqual(['copilot']);
    expect(reported[0]?.message).toContain('codex adapter and opencode adapter');
  });

  it('matches whole path segments only', () => {
    const result = compile(EMPTY, [
      adapterOf('claude', ['.claude/skills-extra/demo.md']),
      adapterOf('copilot', [], [READS_CLAUDE_SKILLS]),
    ]);

    expect(overlaps(result.diagnostics)).toEqual([]);
  });

  it('matches an intake that names a file exactly', () => {
    const exact = '.agents/skills/demo/SKILL.md';
    const result = compile(EMPTY, [
      adapterOf('codex', [exact]),
      adapterOf(
        'copilot',
        [],
        [{ path: exact, code: 'SKILL_DISCOVERY_OVERLAP', consequence: 'Discovered twice.' }],
      ),
    ]);

    expect(overlaps(result.diagnostics)).toHaveLength(1);
  });

  it('reports nothing for adapters that declare no intake', () => {
    const result = compile(EMPTY, [
      adapterOf('claude', ['.claude/skills/demo/SKILL.md']),
      adapterOf('codex', ['.agents/skills/demo/SKILL.md']),
    ]);

    expect(overlaps(result.diagnostics)).toEqual([]);
  });

  it('is deterministic across repeated compilations and adapter orderings', () => {
    const claude = adapterOf('claude', ['.claude/skills/demo/SKILL.md']);
    const copilot = adapterOf('copilot', [], [READS_CLAUDE_SKILLS]);
    const opencode = adapterOf('opencode', [], [READS_CLAUDE_SKILLS]);

    const first = compile(EMPTY, [claude, copilot, opencode]);
    const second = compile(EMPTY, [opencode, claude, copilot]);

    expect(overlaps(second.diagnostics)).toEqual(overlaps(first.diagnostics));
    expect(overlaps(first.diagnostics).map((diagnostic) => diagnostic.provider)).toEqual([
      'copilot',
      'opencode',
    ]);
  });
});
