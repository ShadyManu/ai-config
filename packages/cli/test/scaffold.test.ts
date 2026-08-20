import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/index.js';
import type { OutputStreams } from '../src/output.js';

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiconfig-scaffold-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const capture = (): { streams: OutputStreams; stdout: () => string; stderr: () => string } => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    streams: { out: (text) => out.push(text), err: (text) => err.push(text) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
};

const run = async (args: readonly string[]) => {
  const captured = capture();
  const code = await runCli([...args, '--cwd', root], { streams: captured.streams });
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
};

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');

const exists = (relativePath: string): boolean =>
  fs.existsSync(path.join(root, ...relativePath.split('/')));

const initialize = async (providers = 'claude,codex,copilot,opencode') =>
  run(['init', '--providers', providers]);

describe('aiconfig rules', () => {
  it('reprints exactly what init wrote, so redirecting it refreshes the file', async () => {
    await initialize('claude,codex,copilot,opencode');

    const result = await run(['rules']);

    expect(result.code).toBe(0);
    // The documented way to refresh the reference after an upgrade is
    // 'aiconfig rules > .ai/generation-rules.md', which only holds while the
    // two renderings agree. Compared without the final newline because the
    // stream adds that on printing, and the capture used here does not.
    const written = read('.ai/generation-rules.md');
    expect(result.stdout).toBe(written.trimEnd());
    expect(written.endsWith('\n')).toBe(true);
  });

  it('states what each provider generates and what it accepts', async () => {
    await initialize('claude');

    const result = await run(['rules']);

    expect(result.stdout).toContain('.claude/agents/<name>.md');
    expect(result.stdout).toContain('permissionMode');
  });
});

describe('aiconfig init --providers', () => {
  it('enables only the requested providers', async () => {
    const result = await initialize('claude,opencode');

    expect(result.code).toBe(0);
    expect(read('.ai/config.yaml')).toContain('- claude');
    expect(read('.ai/config.yaml')).toContain('- opencode');
    expect(read('.ai/config.yaml')).not.toContain('- codex');
    expect(exists('.ai/providers')).toBe(false);
  });

  it('creates the provider directory with the first override written into it', async () => {
    await initialize('claude');
    await run(['add', 'agent', 'coder', '--description', 'Writes code']);
    expect(exists('.ai/providers')).toBe(false);

    const result = await run([
      'override',
      'create',
      'claude',
      'agent',
      'coder',
      '--set',
      'model=sonnet',
    ]);

    expect(result.code).toBe(0);
    expect(exists('.ai/providers/claude/agents/coder.yaml')).toBe(true);
  });

  it('creates no override file', async () => {
    await initialize('claude');
    expect(exists('.ai/providers/claude/overlay.yaml')).toBe(false);
    expect(exists('.ai/providers/claude/agents')).toBe(false);
  });

  it('rejects an unknown provider', async () => {
    const result = await run(['init', '--providers', 'cursor']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Unknown provider');
  });
});

describe('aiconfig add', () => {
  beforeEach(async () => {
    await initialize();
  });

  it('creates each canonical artifact', async () => {
    expect((await run(['add', 'instruction', 'style', '--description', 'Style rules'])).code).toBe(
      0,
    );
    expect((await run(['add', 'agent', 'coder', '--description', 'Writes code'])).code).toBe(0);
    expect((await run(['add', 'skill', 'review', '--description', 'Reviews'])).code).toBe(0);
    expect((await run(['add', 'command', 'ship', '--description', 'Ships it'])).code).toBe(0);

    expect(exists('.ai/instructions/style.md')).toBe(true);
    expect(exists('.ai/agents/coder.md')).toBe(true);
    expect(exists('.ai/skills/review/SKILL.md')).toBe(true);
    expect(exists('.ai/commands/ship.md')).toBe(true);

    // Whatever the scaffolder writes must pass the validator it will be read by.
    expect((await run(['validate'])).code).toBe(0);
  });

  it('records repeated --apply-to globs on an instruction', async () => {
    await run([
      'add',
      'instruction',
      'backend',
      '--description',
      'Backend rules',
      '--apply-to',
      'backend/**',
      '--apply-to',
      'services/**/*.ts',
    ]);

    expect(read('.ai/instructions/backend.md')).toContain('  - "backend/**"');
    expect(read('.ai/instructions/backend.md')).toContain('  - "services/**/*.ts"');
  });

  it('creates only the requested skill directories', async () => {
    await run([
      'add',
      'skill',
      'review',
      '--description',
      'Reviews',
      '--with',
      'references,scripts',
    ]);

    expect(exists('.ai/skills/review/references')).toBe(true);
    expect(exists('.ai/skills/review/scripts')).toBe(true);
    expect(exists('.ai/skills/review/assets')).toBe(false);
  });

  it('requires a description for everything but an instruction', async () => {
    const result = await run(['add', 'agent', 'coder']);
    expect(result.code).not.toBe(0);
    expect(exists('.ai/agents/coder.md')).toBe(false);
  });

  it('rejects --apply-to on a kind that has no scoping', async () => {
    const result = await run([
      'add',
      'agent',
      'coder',
      '--description',
      'x',
      '--apply-to',
      'src/**',
    ]);
    expect(result.code).not.toBe(0);
    expect(exists('.ai/agents/coder.md')).toBe(false);
  });

  it('refuses to overwrite an existing artifact', async () => {
    await run(['add', 'agent', 'coder', '--description', 'Writes code']);
    const before = read('.ai/agents/coder.md');

    const result = await run(['add', 'agent', 'coder', '--description', 'Different']);

    expect(result.code).not.toBe(0);
    expect(read('.ai/agents/coder.md')).toBe(before);
  });

  it('reports a fixed --json shape', async () => {
    const result = await run(['add', 'agent', 'coder', '--description', 'Writes code', '--json']);
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: 'add agent',
      ok: true,
      created: ['.ai/agents/coder.md'],
      diagnostics: [],
    });
  });
});

describe('aiconfig override', () => {
  beforeEach(async () => {
    await initialize();
    await run(['add', 'agent', 'coder', '--description', 'Writes code']);
  });

  it('creates an override from --set pairs, coercing each declared type', async () => {
    const result = await run([
      'override',
      'create',
      'claude',
      'agent',
      'coder',
      '--set',
      'model=sonnet',
      '--set',
      'maxTurns=8',
      '--set',
      'background=true',
      '--set',
      'tools=Read,Grep',
    ]);

    expect(result.code).toBe(0);
    expect(read('.ai/providers/claude/agents/coder.yaml')).toBe(
      [
        'schema: 1',
        'options:',
        '  tools:',
        '    - Read',
        '    - Grep',
        '  model: sonnet',
        '  maxTurns: 8',
        '  background: true',
        '',
      ].join('\n'),
    );
    expect((await run(['validate'])).code).toBe(0);
  });

  it('creates an override for every supported provider and artifact pair', async () => {
    await run(['add', 'skill', 'review', '--description', 'Reviews']);
    await run(['add', 'command', 'ship', '--description', 'Ships it']);
    await run([
      'add',
      'instruction',
      'backend',
      '--description',
      'Backend',
      '--apply-to',
      'backend/**',
    ]);

    const pairs: readonly (readonly [string, string, string, string])[] = [
      ['copilot', 'instruction', 'backend', 'excludeAgent=code-review'],
      ['claude', 'agent', 'coder', 'model=sonnet'],
      ['codex', 'agent', 'coder', 'sandbox_mode=read-only'],
      ['copilot', 'agent', 'coder', 'target=vscode'],
      ['opencode', 'agent', 'coder', 'mode=subagent'],
      ['claude', 'skill', 'review', 'disable-model-invocation=true'],
      ['codex', 'skill', 'review', 'policy.allow_implicit_invocation=false'],
      ['copilot', 'skill', 'review', 'context=fork'],
      ['claude', 'command', 'ship', 'model=haiku'],
      ['copilot', 'command', 'ship', 'agent=plan'],
      ['opencode', 'command', 'ship', 'subtask=true'],
    ];

    for (const [provider, kind, id, set] of pairs) {
      const result = await run(['override', 'create', provider, kind, id, '--set', set]);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(exists(`.ai/providers/${provider}/${kind}s/${id}.yaml`)).toBe(true);
    }

    expect((await run(['validate'])).code).toBe(0);
    expect((await run(['sync'])).code).toBe(0);
  });

  it('refuses a provider and artifact pair with no supported options', async () => {
    await run(['add', 'skill', 'review', '--description', 'Reviews']);

    for (const [provider, kind, id] of [
      ['claude', 'instruction', 'backend'],
      ['codex', 'command', 'ship'],
      ['opencode', 'skill', 'review'],
    ] as const) {
      const result = await run(['override', 'create', provider, kind, id, '--set', 'x=y']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('no provider-specific options');
    }
  });

  it('refuses an unscoped instruction for Copilot with the documented reason', async () => {
    await run(['add', 'instruction', 'general', '--description', 'General']);

    const result = await run([
      'override',
      'create',
      'copilot',
      'instruction',
      'general',
      '--set',
      'excludeAgent=code-review',
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Add 'applyTo'");
  });

  it('rejects a value that contradicts a declared type', async () => {
    const result = await run([
      'override',
      'create',
      'claude',
      'agent',
      'coder',
      '--set',
      'maxTurns=many',
    ]);
    expect(result.code).not.toBe(0);
    expect(exists('.ai/providers/claude/agents/coder.yaml')).toBe(false);
  });

  it('accepts a field it does not know, so a new provider field is usable', async () => {
    const result = await run([
      'override',
      'create',
      'claude',
      'agent',
      'coder',
      '--set',
      'reasoningMode=deep',
    ]);
    expect(result.code).toBe(0);
    expect(read('.ai/providers/claude/agents/coder.yaml')).toContain('reasoningMode: deep');
  });

  it('accepts an enum value it does not recognize, so a new provider value is usable', async () => {
    const result = await run([
      'override',
      'create',
      'claude',
      'agent',
      'coder',
      '--set',
      'permissionMode=telepathy',
    ]);
    expect(result.code).toBe(0);
    expect(exists('.ai/providers/claude/agents/coder.yaml')).toBe(true);
  });

  it('rejects a canonical field', async () => {
    const result = await run([
      'override',
      'create',
      'claude',
      'agent',
      'coder',
      '--set',
      'description=nope',
    ]);
    expect(result.code).not.toBe(0);
    // Named for what it is rather than as an unknown field: the document
    // validator owns this check now, and it knows the difference.
    expect(result.stderr).toContain('Edit the canonical file instead.');
    expect(exists('.ai/providers/claude/agents/coder.yaml')).toBe(false);
  });

  it('directs a structured field to the file rather than inventing a syntax', async () => {
    const result = await run([
      'override',
      'create',
      'claude',
      'agent',
      'coder',
      '--set',
      'hooks=something',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('structured field');
  });

  it('refuses a missing canonical artifact', async () => {
    const result = await run([
      'override',
      'create',
      'claude',
      'agent',
      'ghost',
      '--set',
      'model=x',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("No canonical agent named 'ghost'");
  });

  it('never overwrites an existing override without --force', async () => {
    await run(['override', 'create', 'claude', 'agent', 'coder', '--set', 'model=sonnet']);

    const refused = await run([
      'override',
      'create',
      'claude',
      'agent',
      'coder',
      '--set',
      'model=opus',
    ]);
    expect(refused.code).not.toBe(0);
    expect(read('.ai/providers/claude/agents/coder.yaml')).toContain('model: sonnet');

    const forced = await run([
      'override',
      'create',
      'claude',
      'agent',
      'coder',
      '--set',
      'model=opus',
      '--force',
    ]);
    expect(forced.code).toBe(0);
    expect(read('.ai/providers/claude/agents/coder.yaml')).toContain('model: opus');
  });

  it('lists and removes overrides', async () => {
    await run(['override', 'create', 'claude', 'agent', 'coder', '--set', 'model=sonnet']);

    const listed = await run(['override', 'list']);
    expect(listed.stdout).toContain('.ai/providers/claude/agents/coder.yaml');

    const filtered = await run(['override', 'list', 'codex']);
    expect(filtered.stdout).toContain('No provider overrides are configured.');

    expect((await run(['override', 'remove', 'claude', 'agent', 'coder'])).code).toBe(0);
    expect(exists('.ai/providers/claude/agents/coder.yaml')).toBe(false);
    // Removing an override never touches the canonical artifact.
    expect(exists('.ai/agents/coder.md')).toBe(true);
  });

  it('reports usage for a malformed invocation', async () => {
    expect((await run(['override', 'create', 'claude', 'agent'])).code).toBe(2);
    expect((await run(['add', 'widget', 'x'])).code).toBe(2);
  });
});
