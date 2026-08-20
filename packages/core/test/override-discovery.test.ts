import { describe, expect, it } from 'vitest';

import type { ProviderOverrideSchema } from '../src/adapter/override.js';
import type { AiConfiguration } from '../src/domain/configuration.js';
import { discoverOverlay, reportDisabledProviderOverrides } from '../src/overlay/overlay.js';
import { MemoryFileSystem } from '../src/testing/memory-file-system.js';

const AGENT_SCHEMA: ProviderOverrideSchema = {
  kind: 'agent',
  reserved: ['name', 'description'],
  fields: [
    {
      name: 'model',
      type: { kind: 'string' },
      description: 'Model.',
      documentation: 'https://example.invalid',
    },
  ],
};

const INSTRUCTION_SCHEMA: ProviderOverrideSchema = {
  kind: 'instruction',
  reserved: ['applyTo'],
  unavailableReason: (target) =>
    target.applyTo.length > 0 ? undefined : `'${target.name}' is not path-scoped.`,
  fields: [
    {
      name: 'excludeAgent',
      type: { kind: 'enum', values: ['code-review', 'cloud-agent'] },
      description: 'Exclude.',
      documentation: 'https://example.invalid',
    },
  ],
};

const CONFIGURATION: AiConfiguration = {
  instructions: [
    {
      name: 'scoped',
      description: undefined,
      applyTo: ['src/**'],
      body: 'x',
      sourcePath: '.ai/instructions/scoped.md',
    },
    {
      name: 'general',
      description: undefined,
      applyTo: [],
      body: 'x',
      sourcePath: '.ai/instructions/general.md',
    },
  ],
  agents: [{ name: 'coder', description: 'Codes', body: 'b', sourcePath: '.ai/agents/coder.md' }],
  skills: [],
  commands: [],
};

const OPTIONS = {
  overrides: [AGENT_SCHEMA, INSTRUCTION_SCHEMA],
  configuration: CONFIGURATION,
};

describe('artifact override discovery', () => {
  it('finds an override with no overlay.yaml present', async () => {
    // The envelope declares provider-only extensions. An override refines a
    // canonical artifact and needs no registration, so requiring the envelope
    // would silently ignore a file the user wrote by hand.
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/claude/agents/coder.yaml', 'schema: 1\noptions:\n  model: opus\n');

    const result = await discoverOverlay(fs, fs.root, 'claude', OPTIONS);

    expect(result.diagnostics).toEqual([]);
    expect(result.overlay.overrides).toEqual([
      {
        kind: 'agent',
        id: 'coder',
        options: { model: 'opus' },
        sourcePath: '.ai/providers/claude/agents/coder.yaml',
      },
    ]);
  });

  it('reads only the requested provider', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/claude/agents/coder.yaml', 'schema: 1\noptions:\n  model: opus\n');
    fs.set('.ai/providers/codex/agents/coder.yaml', 'schema: 1\noptions:\n  model: gpt-5.5\n');

    const result = await discoverOverlay(fs, fs.root, 'claude', OPTIONS);

    expect(result.overlay.overrides.map((override) => override.options)).toEqual([
      { model: 'opus' },
    ]);
  });

  it('reports an override whose canonical artifact does not exist', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/claude/agents/ghost.yaml', 'schema: 1\noptions:\n  model: opus\n');

    const result = await discoverOverlay(fs, fs.root, 'claude', OPTIONS);

    expect(result.diagnostics.map((d) => d.code)).toEqual(['OVERRIDE_TARGET_MISSING']);
    expect(result.overlay.overrides).toEqual([]);
  });

  it('never refuses an override that refines nothing', async () => {
    // None of the three can make the output wrong: the file contributes
    // nothing, so the result is what it would be without it. An error would
    // block `sync` and `clean` alike, and since the override is skipped it has
    // no row in the view either — leaving no way to resolve what is reported.
    //
    // A missing target is informational because it is indistinguishable from a
    // branch where the artifact does not exist, and the file is preserved for
    // exactly that case. The other two can never apply, whatever changes.
    const cases: readonly {
      path: string;
      provider: 'claude' | 'copilot';
      code: string;
      severity: 'info' | 'warning';
    }[] = [
      {
        path: '.ai/providers/claude/agents/ghost.yaml',
        provider: 'claude',
        code: 'OVERRIDE_TARGET_MISSING',
        severity: 'info',
      },
      {
        path: '.ai/providers/claude/commands/ship.yaml',
        provider: 'claude',
        code: 'OVERRIDE_NOT_SUPPORTED',
        severity: 'warning',
      },
      {
        path: '.ai/providers/copilot/instructions/general.yaml',
        provider: 'copilot',
        code: 'OVERRIDE_NOT_APPLICABLE',
        severity: 'warning',
      },
    ];

    for (const testCase of cases) {
      const fs = new MemoryFileSystem();
      fs.set(testCase.path, 'schema: 1\noptions:\n  excludeAgent: code-review\n');

      const result = await discoverOverlay(fs, fs.root, testCase.provider, OPTIONS);

      expect(
        result.diagnostics.map((d) => d.code),
        testCase.code,
      ).toEqual([testCase.code]);
      expect(result.diagnostics[0]?.severity, testCase.code).toBe(testCase.severity);
      expect(result.overlay.overrides, testCase.code).toEqual([]);
    }
  });

  it('collects an orphaned override as a path, so the caller can remove it', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/claude/agents/ghost.yaml', 'schema: 1\noptions:\n  model: opus\n');

    const result = await discoverOverlay(fs, fs.root, 'claude', OPTIONS);

    // Carried as data rather than left to be parsed back out of a message:
    // `sync` removes these, and it needs the paths.
    expect(result.overlay.orphanedOverrides).toEqual(['.ai/providers/claude/agents/ghost.yaml']);
    // The message announces the removal rather than asking anyone to act.
    expect(result.diagnostics[0]?.message).toContain('removed by the next synchronization');
  });

  it('collects nothing when every override has its artifact', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/claude/agents/coder.yaml', 'schema: 1\noptions:\n  model: opus\n');

    const result = await discoverOverlay(fs, fs.root, 'claude', OPTIONS);

    expect(result.overlay.orphanedOverrides).toEqual([]);
  });

  it('reports a kind the provider declares no schema for', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/claude/commands/ship.yaml', 'schema: 1\noptions: {}\n');

    const result = await discoverOverlay(fs, fs.root, 'claude', OPTIONS);

    expect(result.diagnostics.map((d) => d.code)).toEqual(['OVERRIDE_NOT_SUPPORTED']);
  });

  it('refuses an artifact the schema says it cannot configure', async () => {
    const fs = new MemoryFileSystem();
    fs.set(
      '.ai/providers/copilot/instructions/general.yaml',
      'schema: 1\noptions:\n  excludeAgent: code-review\n',
    );

    const result = await discoverOverlay(fs, fs.root, 'copilot', OPTIONS);

    expect(result.diagnostics.map((d) => d.code)).toEqual(['OVERRIDE_NOT_APPLICABLE']);
    expect(result.diagnostics[0]?.message).toContain("'general' is not path-scoped.");
  });

  it('accepts the same override on a path-scoped instruction', async () => {
    const fs = new MemoryFileSystem();
    fs.set(
      '.ai/providers/copilot/instructions/scoped.yaml',
      'schema: 1\noptions:\n  excludeAgent: code-review\n',
    );

    const result = await discoverOverlay(fs, fs.root, 'copilot', OPTIONS);

    expect(result.diagnostics).toEqual([]);
    expect(result.overlay.overrides[0]?.options).toEqual({ excludeAgent: 'code-review' });
  });

  it('reports unparseable YAML with a position', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/claude/agents/coder.yaml', 'schema: 1\noptions:\n  model: [unclosed\n');

    const result = await discoverOverlay(fs, fs.root, 'claude', OPTIONS);

    expect(result.diagnostics.map((d) => d.code)).toEqual(['OVERRIDE_INVALID']);
  });

  it('is deterministic in override order', async () => {
    const fs = new MemoryFileSystem();
    fs.set(
      '.ai/providers/copilot/instructions/scoped.yaml',
      'schema: 1\noptions:\n  excludeAgent: cloud-agent\n',
    );
    fs.set('.ai/providers/copilot/agents/coder.yaml', 'schema: 1\noptions:\n  model: gpt\n');

    const first = await discoverOverlay(fs, fs.root, 'copilot', OPTIONS);
    const second = await discoverOverlay(fs, fs.root, 'copilot', OPTIONS);

    expect(first.overlay.overrides.map((o) => o.sourcePath)).toEqual(
      second.overlay.overrides.map((o) => o.sourcePath),
    );
    // Kinds are walked in canonical order, so an instruction precedes an agent.
    expect(first.overlay.overrides.map((o) => o.kind)).toEqual(['instruction', 'agent']);
  });

  it('ignores dotfiles and non-YAML entries', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/claude/agents/.swp.yaml', 'garbage');
    fs.set('.ai/providers/claude/agents/README.md', 'notes');

    const result = await discoverOverlay(fs, fs.root, 'claude', OPTIONS);

    expect(result.diagnostics).toEqual([]);
    expect(result.overlay.overrides).toEqual([]);
  });
});

describe('disabled provider overrides', () => {
  it('reports that a disabled provider keeps its files without deleting them', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/claude/agents/coder.yaml', 'schema: 1\noptions:\n  model: opus\n');
    fs.set('.ai/providers/codex/agents/coder.yaml', 'schema: 1\noptions:\n  model: gpt-5.5\n');

    const diagnostics = await reportDisabledProviderOverrides(fs, fs.root, ['claude']);

    expect(diagnostics.map((d) => d.code)).toEqual(['OVERRIDE_PROVIDER_DISABLED']);
    expect(diagnostics[0]?.severity).toBe('info');
    expect(diagnostics[0]?.message).toContain('preserved');
    expect(fs.has('.ai/providers/codex/agents/coder.yaml')).toBe(true);
  });

  it('says nothing about a disabled provider that has no overrides', async () => {
    const fs = new MemoryFileSystem();
    await fs.createDirectory(`${fs.root}/.ai/providers/codex`);

    expect(await reportDisabledProviderOverrides(fs, fs.root, ['claude'])).toEqual([]);
  });
});
