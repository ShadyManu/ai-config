import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MANIFEST_PATH } from '@aiconfig/core';
import type { ProviderAdapter } from '@aiconfig/core';
import { exampleRepositoryRoot } from '@aiconfig/core/testing';

import { EXIT_USAGE, runCli } from '../src/index.js';
import type { OutputStreams } from '../src/output.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

interface Captured {
  readonly streams: OutputStreams;
  stdout: () => string;
  stderr: () => string;
}

const capture = (): Captured => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    streams: { out: (text) => out.push(text), err: (text) => err.push(text) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
};

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiconfig-cli-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/** Copies the checked-in example so tests never write into the repository. */
const seedFromExample = (): void => {
  fs.cpSync(path.join(exampleRepositoryRoot(testDirectory), '.ai'), path.join(root, '.ai'), {
    recursive: true,
    // Never seed a manifest. Synchronizing the example during manual
    // development leaves one behind, and copying it in would make every test
    // start from a repository where AI Config already claims to own its
    // generated files — turning an untracked target into drift.
    filter: (source) => path.basename(source) !== path.basename(MANIFEST_PATH),
  });
};

const run = async (args: readonly string[], captured = capture()) => {
  const code = await runCli([...args, '--cwd', root], { streams: captured.streams });
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
};

const runWithAdapters = async (
  args: readonly string[],
  adapters: readonly ProviderAdapter[],
  captured = capture(),
) => {
  const code = await runCli([...args, '--cwd', root], {
    streams: captured.streams,
    adapters,
  });
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
};

const exists = (relativePath: string): boolean =>
  fs.existsSync(path.join(root, ...relativePath.split('/')));

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, ...relativePath.split('/')), 'utf8');

const write = (relativePath: string, content: string): void => {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

/** Every non-dotfile under `.ai/`, with its contents. */
const snapshotAiDirectory = (): Record<string, string> => {
  const base = path.join(root, '.ai');
  const files: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const nested = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(nested, relative);
      } else if (entry.isFile() && !entry.name.startsWith('.')) {
        files[relative] = fs.readFileSync(nested, 'utf8');
      }
    }
  };
  if (fs.existsSync(base)) {
    walk(base, '');
  }
  return files;
};

describe('argument handling', () => {
  it('prints help with no arguments', async () => {
    const result = await runCli([], { streams: capture().streams });
    expect(result).toBe(0);
  });

  it('rejects an unknown command with a usage exit code', async () => {
    const captured = capture();
    const code = await runCli(['deploy'], { streams: captured.streams });
    expect(code).toBe(EXIT_USAGE);
    expect(captured.stderr()).toContain("Unknown command 'deploy'");
  });

  it('rejects a flag that does not apply to the command', async () => {
    const captured = capture();
    const code = await runCli(['status', '--force'], { streams: captured.streams });
    expect(code).toBe(EXIT_USAGE);
    expect(captured.stderr()).toContain("'--force' is not valid for 'aiconfig status'");
  });

  it('reports the version', async () => {
    const captured = capture();
    expect(await runCli(['--version'], { streams: captured.streams })).toBe(0);
    expect(captured.stdout()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('aiconfig init', () => {
  it('creates the canonical structure and reports next steps', async () => {
    const result = await run(['init']);

    expect(result.code).toBe(0);
    expect(exists('.ai/config.yaml')).toBe(true);
    expect(exists('.ai/agents')).toBe(true);
    expect(result.stdout).toContain('aiconfig sync');
  });

  it('enables every built-in provider', async () => {
    await run(['init']);
    const config = read('.ai/config.yaml');
    for (const provider of ['claude', 'codex', 'copilot', 'opencode']) {
      expect(config).toContain(`- ${provider}`);
    }
    expect(config).toContain('# Available providers: claude, codex, copilot, opencode.');
  });

  it('refuses to overwrite an existing .ai directory', async () => {
    await run(['init']);
    const result = await run(['init']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ALREADY_INITIALIZED');
  });
});

describe('aiconfig sync', () => {
  it('generates output for all four providers', async () => {
    seedFromExample();
    const result = await run(['sync']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Synchronized');

    expect(exists('.claude/rules/general.md')).toBe(true);
    expect(exists('.claude/agents/reviewer.md')).toBe(true);
    expect(exists('.claude/commands/fix-bug.md')).toBe(true);
    expect(exists('.claude/skills/code-review/SKILL.md')).toBe(true);

    expect(exists('AGENTS.md')).toBe(true);
    expect(exists('.codex/agents/reviewer.toml')).toBe(true);
    expect(exists('.agents/skills/code-review/SKILL.md')).toBe(true);
    expect(exists('.agents/skills/fix-bug/SKILL.md')).toBe(true);

    expect(exists('.github/copilot-instructions.md')).toBe(true);
    expect(exists('.github/instructions/backend.instructions.md')).toBe(true);
    expect(exists('.github/agents/reviewer.agent.md')).toBe(true);
    expect(exists('.github/prompts/fix-bug.prompt.md')).toBe(true);

    expect(exists('.opencode/agents/reviewer.md')).toBe(true);
    expect(exists('.opencode/commands/fix-bug.md')).toBe(true);
    expect(exists('.opencode/skills/code-review/SKILL.md')).toBe(true);
  });

  it('surfaces compatibility warnings', async () => {
    seedFromExample();
    const result = await run(['sync']);

    expect(result.stdout).toContain('Warnings:');
    expect(result.stdout).toContain('INSTRUCTION_SCOPE_NOT_SUPPORTED');
    expect(result.stdout).toContain('COMMAND_LIMITED_SURFACE');
  });

  it('keeps informational notes out of the sync action report', async () => {
    seedFromExample();
    const result = await run(['sync']);

    // `sync` reports what it did. The Codex command-to-skill conversion is
    // lossless and only changes invocation syntax, so it belongs in the
    // diagnostic-reporting commands rather than here.
    expect(result.stdout).not.toContain('COMMAND_CONVERTED_TO_SKILL');
  });

  it('says nothing about skill roots that several enabled providers read', async () => {
    seedFromExample();
    const result = await run(['sync']);

    // The example enables all four providers, so Copilot and OpenCode both
    // re-discover skills AI Config generated for Claude Code and Codex. Every
    // copy is compiled from the same canonical skill, and both tools
    // deduplicate by name, so nothing about the combination is worth
    // interrupting a synchronization for.
    expect(result.stdout).not.toContain('DISCOVERY_OVERLAP');
  });

  it('reports nothing extra for four providers that it would not report for one', async () => {
    seedFromExample();
    const together = await run(['validate']);

    fs.writeFileSync(
      path.join(root, '.ai', 'config.yaml'),
      ['schema: 1', 'providers:', '  enabled: [opencode]', ''].join('\n'),
      'utf8',
    );
    const alone = await run(['validate']);

    // Whatever the combination costs, it costs it silently: no diagnostic
    // exists because of which other providers happen to be enabled.
    const opencodeLines = (output: string): readonly string[] =>
      output
        .split('\n')
        .filter((line) => line.includes('opencode'))
        .sort();

    expect(opencodeLines(together.stdout)).toEqual(opencodeLines(alone.stdout));
  });

  it('preserves an override whose artifact was deleted', async () => {
    // The CLI and the extension share one compiler, so this is the same code
    // the view runs. What differs is the reporting, and a removal under `.ai/`
    // that was authored by the user must not be deleted by an automatic sync.
    seedFromExample();
    await run(['sync']);
    expect(exists('.ai/providers/claude/agents/reviewer.yaml')).toBe(true);

    fs.rmSync(path.join(root, '.ai', 'agents', 'reviewer.md'));
    const result = await run(['sync']);

    expect(result.code).toBe(0);
    expect(exists('.ai/providers/claude/agents/reviewer.yaml')).toBe(true);
    expect(exists('.claude/agents/reviewer.md')).toBe(false);
  });

  it('reports that removal from a dry run without performing it', async () => {
    seedFromExample();
    await run(['sync']);
    fs.rmSync(path.join(root, '.ai', 'agents', 'reviewer.md'));

    const result = await run(['sync', '--dry-run']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Nothing was modified.');
    expect(exists('.ai/providers/claude/agents/reviewer.yaml')).toBe(true);
  });

  it('does not list an automatic override removal in --json', async () => {
    seedFromExample();
    await run(['sync']);
    fs.rmSync(path.join(root, '.ai', 'agents', 'reviewer.md'));

    const payload = JSON.parse((await run(['sync', '--json'])).stdout) as {
      removedOverrides: string[];
    };

    expect(payload.removedOverrides).toEqual([]);
    expect(exists('.ai/providers/claude/agents/reviewer.yaml')).toBe(true);
  });

  it('writes AGENTS.md once, shared by Codex and OpenCode', async () => {
    seedFromExample();
    await run(['sync']);

    const manifest = JSON.parse(read('.ai/.generated.json')) as {
      entries: { path: string; providers: string[] }[];
    };
    const entry = manifest.entries.find((candidate) => candidate.path === 'AGENTS.md');
    expect(entry?.providers).toEqual(['codex', 'opencode']);
  });

  it('does not modify the filesystem with --dry-run', async () => {
    seedFromExample();
    const result = await run(['sync', '--dry-run']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Nothing was modified.');
    expect(exists('.claude/rules/general.md')).toBe(false);
    expect(exists('.ai/.generated.json')).toBe(false);
  });

  it('identifies executable content in validate, dry-run, and JSON output', async () => {
    fs.mkdirSync(path.join(root, '.ai'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.ai', 'config.yaml'),
      'schema: 1\nproviders:\n  enabled: [claude]\n',
      'utf8',
    );
    const executableAdapter: ProviderAdapter = {
      id: 'claude',
      displayName: 'Executable fixture',
      targetRoots: ['.fixture'],
      compile: () => ({
        files: [
          {
            path: '.fixture/run.sh',
            source: null,
            content: { kind: 'text', value: '#!/bin/sh\necho fixture\n' },
            executable: true,
          },
        ],
        diagnostics: [],
      }),
    };

    const validation = await runWithAdapters(['validate'], [executableAdapter]);
    expect(validation.stdout).toContain('Executable provider content:');

    const dryRun = await runWithAdapters(['sync', '--dry-run'], [executableAdapter]);
    expect(dryRun.stdout).toContain('Executable files to materialize:');
    expect(dryRun.stdout).toContain('.fixture/run.sh');

    const json = JSON.parse(
      (await runWithAdapters(['sync', '--dry-run', '--json'], [executableAdapter])).stdout,
    ) as {
      executableContent: { path: string; executable: boolean }[];
    };
    expect(json.executableContent.some((file) => file.path.endsWith('run.sh'))).toBe(true);
    expect(json.executableContent.every((file) => file.executable)).toBe(true);

    await runWithAdapters(['sync'], [executableAdapter]);
    const status = await runWithAdapters(['status'], [executableAdapter]);
    expect(status.stdout).toContain('Executable provider content:');
    const statusJson = JSON.parse(
      (await runWithAdapters(['status', '--json'], [executableAdapter])).stdout,
    ) as {
      executableContent: { path: string; executable: boolean }[];
    };
    expect(statusJson.executableContent.some((file) => file.path.endsWith('run.sh'))).toBe(true);
  });

  it('is idempotent', async () => {
    seedFromExample();
    await run(['sync']);
    const result = await run(['sync']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Already synchronized.');
  });

  it('emits machine-readable output with --json', async () => {
    seedFromExample();
    const result = await run(['sync', '--json']);

    const payload = JSON.parse(result.stdout) as {
      command: string;
      ok: boolean;
      applied: boolean;
      providers: { id: string; files: number }[];
      diagnostics: { code: string }[];
    };

    expect(payload.command).toBe('sync');
    expect(payload.ok).toBe(true);
    expect(payload.applied).toBe(true);
    expect(payload.providers.map((provider) => provider.id).sort()).toEqual([
      'claude',
      'codex',
      'copilot',
      'opencode',
    ]);
    expect(payload.diagnostics.length).toBeGreaterThan(0);
  });

  it('fails when .ai is missing', async () => {
    const result = await run(['sync']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('NOT_INITIALIZED');
  });
});

describe('aiconfig rename', () => {
  it('moves the skill directory, its overrides and its name field together', async () => {
    seedFromExample();

    const result = await run(['rename', 'skill', 'code-review', 'review']);

    expect(result.code).toBe(0);
    expect(exists('.ai/skills/code-review')).toBe(false);
    expect(exists('.ai/skills/review/SKILL.md')).toBe(true);
    expect(read('.ai/skills/review/SKILL.md')).toContain('name: review');
    // The supporting files travel with the directory.
    expect(exists('.ai/skills/review/references/checklist.md')).toBe(true);
    // The override was named after the skill, so it had to move too.
    expect(exists('.ai/providers/codex/skills/code-review.yaml')).toBe(false);
    expect(exists('.ai/providers/codex/skills/review.yaml')).toBe(true);
    expect(result.stdout).toContain('Run: aiconfig sync');
  });

  it('generates under the new name and leaves nothing behind under the old one', async () => {
    seedFromExample();
    await run(['sync']);
    expect(exists('.claude/skills/code-review/SKILL.md')).toBe(true);

    await run(['rename', 'skill', 'code-review', 'review']);
    const result = await run(['sync']);

    expect(result.code).toBe(0);
    // The old generated files were orphans after the rename, and the planner
    // removes an orphan only after re-verifying it still holds AI Config's own
    // bytes — which is why the rename never touches them itself.
    expect(exists('.claude/skills/code-review')).toBe(false);
    expect(exists('.claude/skills/review/SKILL.md')).toBe(true);
    expect(exists('.opencode/skills/review/SKILL.md')).toBe(true);
  });

  it('refuses to overwrite, and moves nothing when it does', async () => {
    seedFromExample();

    const result = await run(['rename', 'agent', 'reviewer', 'reviewer-2']);
    expect(result.code).toBe(0);

    const blocked = await run(['rename', 'agent', 'reviewer-2', 'reviewer-2']);
    expect(blocked.code).toBe(0);

    write('.ai/agents/taken.md', '---\ndescription: Taken\n---\n\nBody.\n');
    const refused = await run(['rename', 'agent', 'reviewer-2', 'taken']);

    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('RENAME_TARGET_EXISTS');
    expect(exists('.ai/agents/reviewer-2.md')).toBe(true);
    expect(read('.ai/agents/taken.md')).toContain('Taken');
  });

  it('reports a name that does not exist', async () => {
    seedFromExample();

    const result = await run(['rename', 'agent', 'nothing-here', 'something']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('RENAME_SOURCE_MISSING');
  });

  it('checks its arguments before touching anything', async () => {
    seedFromExample();

    const result = await run(['rename', 'skill', 'code-review']);

    expect(result.code).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('Usage: aiconfig rename skill <from> <to>.');
  });
});

describe('aiconfig validate', () => {
  it('counts canonical items and reports warnings', async () => {
    seedFromExample();
    const result = await run(['validate']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('2 instructions');
    expect(result.stdout).toContain('1 agent');
    expect(result.stdout).toContain('1 skill');
    expect(result.stdout).toContain('1 command');
    expect(result.stdout).toContain('Validation passed with');
  });

  it('exits non-zero on warnings with --check', async () => {
    seedFromExample();
    const result = await run(['validate', '--check']);
    expect(result.code).toBe(1);
  });

  it('renders informational notes, which do not fail --check on their own', async () => {
    seedFromExample();
    const result = await run(['validate']);

    expect(result.stdout).toContain('Notes:');
    expect(result.stdout).toContain('COMMAND_CONVERTED_TO_SKILL');
    expect(result.stdout).toContain('note');
  });

  it('reports validation errors with the source file and line', async () => {
    seedFromExample();
    fs.writeFileSync(
      path.join(root, '.ai', 'agents', 'broken.md'),
      '---\ndescription: Broken\ntools: Read\n---\n\nBody.\n',
      'utf8',
    );

    const result = await run(['validate']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('UNKNOWN_FRONTMATTER_KEY');
    expect(result.stdout).toContain('.ai/agents/broken.md:3');
  });

  it('reports a skill and command name collision', async () => {
    seedFromExample();
    fs.mkdirSync(path.join(root, '.ai', 'skills', 'fix-bug'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.ai', 'skills', 'fix-bug', 'SKILL.md'),
      '---\nname: fix-bug\ndescription: Collides with the command\n---\n\nBody.\n',
      'utf8',
    );

    const result = await run(['validate']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('DUPLICATE_INVOCABLE_NAME');
  });
});

describe('aiconfig status', () => {
  it('reports not initialized before init', async () => {
    const result = await run(['status']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Not initialized.');
  });

  it('reports every provider as synced after a sync', async () => {
    seedFromExample();
    await run(['sync']);

    const result = await run(['status']);
    expect(result.code).toBe(0);
    for (const name of ['Claude Code', 'Codex', 'GitHub Copilot', 'OpenCode']) {
      expect(result.stdout).toContain(name);
    }
    expect(result.stdout).not.toContain('drift');
  });

  it('reports drift after a generated file is edited by hand', async () => {
    seedFromExample();
    await run(['sync']);

    fs.writeFileSync(path.join(root, '.claude', 'agents', 'reviewer.md'), 'hand edited', 'utf8');

    const result = await run(['status']);
    expect(result.stdout).toContain('drift');
    expect(result.stdout).toContain('.claude/agents/reviewer.md');
  });

  it('blocks a sync while drift is present, then resolves it with --force', async () => {
    seedFromExample();
    await run(['sync']);
    const target = path.join(root, '.claude', 'agents', 'reviewer.md');
    fs.writeFileSync(target, 'hand edited', 'utf8');

    const blocked = await run(['sync']);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('DRIFT_BLOCKS_WRITE');
    expect(fs.readFileSync(target, 'utf8')).toBe('hand edited');

    const forced = await run(['sync', '--force']);
    expect(forced.code).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toContain('You are a code reviewer.');

    const after = await run(['status']);
    expect(after.stdout).not.toContain('drift');
  });

  it('emits machine-readable state with --json', async () => {
    seedFromExample();
    await run(['sync']);

    const result = await run(['status', '--json']);
    const payload = JSON.parse(result.stdout) as {
      initialized: boolean;
      providers: { id: string; status: string }[];
      files: { path: string; state: string }[];
    };

    expect(payload.initialized).toBe(true);
    // Every generated file is up to date...
    expect(payload.files.every((file) => file.state === 'synced')).toBe(true);
    // ...but three providers carry standing compatibility warnings for this
    // example, and those are reported rather than hidden behind "synced".
    expect(
      Object.fromEntries(payload.providers.map((provider) => [provider.id, provider.status])),
    ).toEqual({
      claude: 'synced',
      codex: 'warning',
      copilot: 'warning',
      opencode: 'warning',
    });
  });
});

describe('exit codes and machine-readable output', () => {
  it('rejects a --cwd that does not exist', async () => {
    const captured = capture();
    const code = await runCli(['init', '--cwd', path.join(root, 'missing')], {
      streams: captured.streams,
    });

    // Otherwise a typo would materialize a .ai/ tree at an arbitrary path.
    expect(code).toBe(EXIT_USAGE);
    expect(captured.stderr()).toContain('No such directory');
    expect(exists('missing')).toBe(false);
  });

  it('exits non-zero from status when the configuration has errors', async () => {
    seedFromExample();
    fs.writeFileSync(
      path.join(root, '.ai', 'agents', 'broken.md'),
      '---\ndescription: Broken\ntools: Read\n---\n\nBody.\n',
      'utf8',
    );

    const result = await run(['status']);
    expect(result.code).toBe(1);
  });

  it('keeps the same --json key set whether the command succeeds or fails', async () => {
    seedFromExample();

    const success = JSON.parse((await run(['status', '--json'])).stdout) as Record<string, unknown>;

    fs.writeFileSync(path.join(root, '.ai', 'config.yaml'), 'version: 99\n', 'utf8');
    const failure = JSON.parse((await run(['status', '--json'])).stdout) as Record<string, unknown>;

    expect(Object.keys(failure).sort()).toEqual(Object.keys(success).sort());
    expect(success['schema']).toBe(1);
    expect(failure['schema']).toBe(1);
  });

  it('reports the same key set from status on an uninitialized repository', async () => {
    const uninitialized = JSON.parse((await run(['status', '--json'])).stdout) as Record<
      string,
      unknown
    >;

    seedFromExample();
    const initialized = JSON.parse((await run(['status', '--json'])).stdout) as Record<
      string,
      unknown
    >;

    expect(Object.keys(uninitialized).sort()).toEqual(Object.keys(initialized).sort());
  });

  it('makes the sync --json ok field agree with the exit code', async () => {
    seedFromExample();
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Hand written\n', 'utf8');

    const result = await run(['sync', '--json']);
    const payload = JSON.parse(result.stdout) as { ok: boolean; summary: unknown };

    expect(payload.ok).toBe(false);
    expect(payload.summary).toBeNull();
    expect(result.code).toBe(1);
  });
});

describe('ownership', () => {
  it('never touches files it does not own', async () => {
    seedFromExample();
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{"mine": true}', 'utf8');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Hand written\n', 'utf8');

    await run(['sync']);

    expect(read('.claude/settings.json')).toBe('{"mine": true}');
    expect(read('CLAUDE.md')).toBe('# Hand written\n');
  });

  it('refuses to overwrite a hand-written AGENTS.md', async () => {
    seedFromExample();
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# My own instructions\n', 'utf8');

    const result = await run(['sync']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('UNTRACKED_TARGET_EXISTS');
    expect(result.stderr).toContain('AGENTS.md');
    expect(read('AGENTS.md')).toBe('# My own instructions\n');
  });

  it('removes generated files for a provider that gets disabled', async () => {
    seedFromExample();
    await run(['sync']);
    expect(exists('.opencode/agents/reviewer.md')).toBe(true);

    const config = read('.ai/config.yaml').replace('    - opencode\n', '');
    fs.writeFileSync(path.join(root, '.ai', 'config.yaml'), config, 'utf8');

    await run(['sync']);

    expect(exists('.opencode/agents/reviewer.md')).toBe(false);
    // AGENTS.md is still owned by Codex, so it stays.
    expect(exists('AGENTS.md')).toBe(true);
  });

  it('owns the Codex invocation-policy sidecar and removes it with its command', async () => {
    seedFromExample();
    await run(['sync']);

    const sidecar = '.agents/skills/fix-bug/agents/openai.yaml';
    expect(exists(sidecar)).toBe(true);

    const manifest = JSON.parse(read('.ai/.generated.json')) as {
      entries: { path: string; providers: string[]; source: string | null }[];
    };
    const entry = manifest.entries.find((candidate) => candidate.path === sidecar);
    // Attributed to the command, not to a skill: that is what makes it
    // disappear when the command does.
    expect(entry?.source).toBe('commands/fix-bug');
    expect(entry?.providers).toEqual(['codex']);

    fs.rmSync(path.join(root, '.ai', 'commands', 'fix-bug.md'));
    await run(['sync']);

    expect(exists(sidecar)).toBe(false);
    expect(exists('.agents/skills/fix-bug/SKILL.md')).toBe(false);
    // The canonical skill is untouched by the command's removal.
    expect(exists('.agents/skills/code-review/SKILL.md')).toBe(true);
  });

  it('records an override-generated skill sidecar in the manifest', async () => {
    seedFromExample();
    await run(['sync']);

    const sidecar = '.agents/skills/code-review/agents/openai.yaml';
    expect(exists(sidecar)).toBe(true);
    const manifest = JSON.parse(read('.ai/.generated.json')) as {
      entries: { path: string; source: string | null; ownership: string; executable: boolean }[];
    };
    expect(manifest.entries.find((entry) => entry.path === sidecar)).toMatchObject({
      source: 'skills/code-review',
      ownership: 'managed',
      executable: false,
    });
  });

  it('never writes under .ai during a sync', async () => {
    seedFromExample();
    const before = snapshotAiDirectory();

    await run(['sync']);

    expect(snapshotAiDirectory()).toEqual(before);
  });

  it('preserves override files for a provider that gets disabled', async () => {
    seedFromExample();
    await run(['sync']);

    write('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled:\n    - claude\n');
    const outcome = await run(['sync']);

    expect(outcome.code).toBe(0);
    expect(exists('.ai/providers/codex/skills/code-review.yaml')).toBe(true);
    expect(exists('.ai/providers/opencode/agents/reviewer.yaml')).toBe(true);
    // The generated output for the disabled providers is removed; only their
    // source configuration is kept.
    expect(exists('.agents/skills/code-review/agents/openai.yaml')).toBe(false);
  });
});
