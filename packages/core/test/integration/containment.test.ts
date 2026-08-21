import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AiConfiguration,
  CompileResult,
  DirectoryEntry,
  FileStat,
  FileSystem,
  ProviderAdapter,
} from '../../src/index.js';
import { NodeFileSystem, analyze, clean, renderMarkdownDocument, sync } from '../../src/index.js';
import { checkGeneratedPathsContained } from '../../src/path/containment.js';

class TestAdapter implements ProviderAdapter {
  public readonly id = 'claude' as const;
  public readonly displayName = 'Test Provider';
  public readonly targetRoots = ['.test/agents'];

  public compile(configuration: AiConfiguration): CompileResult {
    return {
      files: configuration.agents.map((agent) => ({
        path: `.test/agents/${agent.name}.md`,
        source: { kind: 'agent' as const, name: agent.name },
        content: {
          kind: 'text' as const,
          value: renderMarkdownDocument([['description', agent.description]], agent.body),
        },
      })),
      diagnostics: [],
    };
  }
}

/** Records every path read, so a test can prove one was never opened. */
class RecordingFileSystem implements FileSystem {
  public readonly reads: string[] = [];
  private readonly inner = new NodeFileSystem();

  public readFile(target: string): Promise<Buffer | undefined> {
    this.reads.push(target);
    return this.inner.readFile(target);
  }
  public readDirectory(target: string): Promise<readonly DirectoryEntry[]> {
    return this.inner.readDirectory(target);
  }
  public stat(target: string): Promise<FileStat | undefined> {
    return this.inner.stat(target);
  }
  public exists(target: string): Promise<boolean> {
    return this.inner.exists(target);
  }
  public realPath(target: string): Promise<string | undefined> {
    return this.inner.realPath(target);
  }
  public createDirectory(target: string): Promise<void> {
    return this.inner.createDirectory(target);
  }
  public writeFileAtomic(
    target: string,
    content: Buffer,
    options?: { executable?: boolean; exclusive?: boolean },
  ): Promise<void> {
    return this.inner.writeFileAtomic(target, content, options);
  }
  public rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to);
  }
  public deleteFile(target: string): Promise<void> {
    return this.inner.deleteFile(target);
  }
  public deleteEmptyDirectory(target: string): Promise<void> {
    return this.inner.deleteEmptyDirectory(target);
  }
}

const adapters: readonly ProviderAdapter[] = [new TestAdapter()];
const fileSystem = new NodeFileSystem();

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiconfig-containment-'));
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'aiconfig-outside-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

const write = (relativePath: string, content: string): void => {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const seedProject = (): void => {
  write('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: [claude]\n');
  write('.ai/agents/reviewer.md', '---\ndescription: Reviews code\n---\n\nYou review code.\n');
};

/**
 * Creating a directory symlink on Windows needs elevation or Developer Mode, so
 * these run only where the platform allows it. The behaviour they cover is
 * POSIX-relevant in any case.
 */
const canCreateSymlinks = (): boolean => {
  const probeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiconfig-symlink-probe-'));
  try {
    fs.symlinkSync(os.tmpdir(), path.join(probeDirectory, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDirectory, { recursive: true, force: true });
  }
};

const symlinks = canCreateSymlinks();

/**
 * Replaces the generated tree with a symlink to `target`, keeping the bytes AI
 * Config wrote so the manifest still recognizes them.
 *
 * This is the shape a repository can arrive in by being cloned: the manifest
 * records paths, and a committed symlink decides what those paths resolve to.
 */
const redirectGeneratedTree = (target: string): void => {
  const bytes = fs.readFileSync(path.join(root, '.test', 'agents', 'reviewer.md'));
  fs.mkdirSync(path.join(target, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(target, 'agents', 'reviewer.md'), bytes);
  fs.rmSync(path.join(root, '.test'), { recursive: true, force: true });
  fs.symlinkSync(target, path.join(root, '.test'), 'dir');
};

describe.skipIf(!symlinks)('removal through a redirected path', () => {
  it('refuses to delete through a symlinked output directory', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    redirectGeneratedTree(outside);

    const outcome = await clean(fileSystem, root, adapters);

    // The manifest hash still matches the external file, so nothing but the
    // containment check stands between `clean` and unlinking it.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toContain('UNSAFE_OUTPUT_PATH');
    expect(fs.existsSync(path.join(outside, 'agents', 'reviewer.md'))).toBe(true);
  });
});

describe.skipIf(!symlinks)('redirection that stays inside the repository', () => {
  it('refuses a generated path redirected onto unrelated files', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    // Still under the root, so "does it stay inside the repository" is
    // satisfied — while the output lands on files that have nothing to do with
    // this provider.
    const elsewhere = path.join(root, 'src');
    fs.mkdirSync(elsewhere, { recursive: true });
    redirectGeneratedTree(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'agents', 'reviewer.md'), 'source code', 'utf8');

    const outcome = await sync(fileSystem, root, adapters, { force: true });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toContain('UNSAFE_OUTPUT_PATH');
    expect(fs.readFileSync(path.join(elsewhere, 'agents', 'reviewer.md'), 'utf8')).toBe(
      'source code',
    );
  });

  it('refuses a generated path redirected into the canonical directory', async () => {
    seedProject();
    await sync(fileSystem, root, adapters);
    const canonical = fs.readFileSync(path.join(root, '.ai', 'agents', 'reviewer.md'), 'utf8');
    redirectGeneratedTree(path.join(root, '.ai'));

    const outcome = await sync(fileSystem, root, adapters, { force: true });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toContain('UNSAFE_OUTPUT_PATH');
    // The sources a synchronization is generated from survive it.
    expect(fs.readFileSync(path.join(root, '.ai', 'agents', 'reviewer.md'), 'utf8')).toBe(
      canonical,
    );
  });

  it('leaves a repository under a symlinked parent alone', async () => {
    // '~/dev -> /mnt/data/dev' is an ordinary arrangement. Containment is
    // anchored to the real root, so only links *below* it are redirection.
    const linkedRoot = path.join(outside, 'linked-root');
    fs.symlinkSync(root, linkedRoot, 'dir');
    seedProject();

    const outcome = await sync(fileSystem, linkedRoot, adapters);

    expect(outcome.ok).toBe(true);
    expect(fs.existsSync(path.join(root, '.test', 'agents', 'reviewer.md'))).toBe(true);
  });
});

describe('the canonical directory is never a generated target', () => {
  it('refuses an output path inside .ai/', async () => {
    seedProject();

    const diagnostics = await checkGeneratedPathsContained(fileSystem, root, [
      '.ai/agents/reviewer.md',
      '.test/agents/reviewer.md',
    ]);

    expect(diagnostics.map((d) => d.source)).toEqual(['.ai/agents/reviewer.md']);
    expect(diagnostics[0]?.code).toBe('UNSAFE_OUTPUT_PATH');
  });

  it('refuses every path when the root itself cannot be resolved', async () => {
    // Containment is measured against the resolved root. Without one there is
    // nothing to compare against, so the answer is refusal rather than a guess
    // that every path is fine.
    const missing = path.join(root, 'no-such-directory');

    const diagnostics = await checkGeneratedPathsContained(fileSystem, missing, [
      '.claude/agents/reviewer.md',
    ]);

    expect(diagnostics.map((d) => d.code)).toEqual(['ROOT_NOT_FOUND']);
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[0]?.message).toContain(missing);
  });
});

describe.skipIf(!symlinks)('reads stop at the boundary too', () => {
  it('never opens a path containment refused', async () => {
    seedProject();
    fs.symlinkSync(outside, path.join(root, '.test'), 'dir');
    fs.mkdirSync(path.join(outside, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'agents', 'reviewer.md'), 'external', 'utf8');

    const recording = new RecordingFileSystem();
    const outcome = await analyze(recording, root, adapters);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.analysis.diagnostics.map((d) => d.code)).toContain('UNSAFE_OUTPUT_PATH');
    // Probing a path the check just refused would follow the very link it
    // refused: the boundary would hold for writes and leak for reads.
    const refused = path.join(root, '.test', 'agents', 'reviewer.md');
    expect(recording.reads).not.toContain(refused);
  });

  it('refuses to read provider overlays through a symlinked directory', async () => {
    seedProject();
    fs.mkdirSync(path.join(outside, 'claude'), { recursive: true });
    fs.writeFileSync(
      path.join(outside, 'claude', 'overlay.yaml'),
      'schema: 1\nprovider: claude\nextensions: []\n',
      'utf8',
    );
    fs.symlinkSync(outside, path.join(root, '.ai', 'providers'), 'dir');

    const outcome = await analyze(fileSystem, root, adapters);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.analysis.diagnostics.map((d) => d.code)).toContain('UNSAFE_OUTPUT_PATH');
  });

  it('refuses to read the configuration through a symlinked canonical directory', async () => {
    fs.writeFileSync(
      path.join(outside, 'config.yaml'),
      'schema: 1\nproviders:\n  enabled: [claude]\n',
      'utf8',
    );
    fs.symlinkSync(outside, path.join(root, '.ai'), 'dir');

    const outcome = await analyze(fileSystem, root, adapters);

    // '.ai/config.yaml' decides which providers run, so it is checked before it
    // is opened rather than after.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.diagnostics.map((d) => d.code)).toContain('UNSAFE_OUTPUT_PATH');
  });
});
