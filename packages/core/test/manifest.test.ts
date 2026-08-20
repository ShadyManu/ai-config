import { describe, expect, it } from 'vitest';

import {
  MANIFEST_PATH,
  MANIFEST_VERSION,
  readManifest,
  serializeManifest,
} from '../src/manifest/manifest.js';
import { sha256 } from '../src/manifest/hash.js';
import { MemoryFileSystem } from '../src/testing/memory-file-system.js';

const read = async (content: string) => {
  const fileSystem = new MemoryFileSystem();
  fileSystem.set(MANIFEST_PATH, content);
  return readManifest(fileSystem, fileSystem.root);
};

describe('sha256', () => {
  it('produces a stable prefixed digest', () => {
    expect(sha256('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes strings and buffers identically', () => {
    expect(sha256('abc')).toBe(sha256(Buffer.from('abc', 'utf8')));
  });
});

describe('readManifest', () => {
  it('returns an empty manifest when the file is absent', async () => {
    const fileSystem = new MemoryFileSystem();
    const result = await readManifest(fileSystem, fileSystem.root);
    expect(result.manifest.entries).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('reads a valid manifest and sorts entries by path', async () => {
    const result = await read(
      JSON.stringify({
        version: 1,
        entries: [
          { path: 'b.md', providers: ['codex'], source: null, hash: 'sha256:b' },
          { path: 'a.md', providers: ['claude'], source: 'agents/a', hash: 'sha256:a' },
        ],
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['a.md', 'b.md']);
  });

  it('accepts provider identifiers it does not recognise', async () => {
    // Forward compatibility: a manifest from a newer AI Config must stay
    // readable, or AI Config would believe it owns nothing.
    const result = await read(
      JSON.stringify({
        version: 1,
        entries: [{ path: 'a.md', providers: ['future-provider'], source: null, hash: 'sha256:a' }],
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest.entries[0]?.providers).toEqual(['future-provider']);
  });

  it.each([
    ['not json at all', 'invalid JSON'],
    ['[]', 'not an object'],
    ['{"entries": []}', 'missing version'],
    ['{"version": 1}', 'missing entries'],
    [
      '{"version": 1, "entries": [{"path": "../escape.md", "providers": [], "source": null, "hash": "x"}]}',
      'unsafe path',
    ],
    ['{"version": 1, "entries": [{"path": "a.md"}]}', 'incomplete entry'],
  ])('degrades to an empty manifest with a warning for %s', async (content) => {
    const result = await read(content);
    expect(result.manifest.entries).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['MANIFEST_UNREADABLE']);
    expect(result.diagnostics[0]?.severity).toBe('warning');
  });

  it('errors rather than warns on a future manifest version', async () => {
    const result = await read(JSON.stringify({ version: MANIFEST_VERSION + 1, entries: [] }));
    expect(result.diagnostics.map((d) => d.code)).toEqual(['UNSUPPORTED_MANIFEST_VERSION']);
    expect(result.diagnostics[0]?.severity).toBe('error');
  });
});

describe('serializeManifest', () => {
  it('is deterministic regardless of input order', () => {
    const a = serializeManifest({
      version: 1,
      entries: [
        { path: 'b.md', providers: ['opencode', 'codex'], source: null, hash: 'sha256:b' },
        { path: 'a.md', providers: ['claude'], source: 'agents/a', hash: 'sha256:a' },
      ],
    });
    const b = serializeManifest({
      version: 1,
      entries: [
        { path: 'a.md', providers: ['claude'], source: 'agents/a', hash: 'sha256:a' },
        { path: 'b.md', providers: ['codex', 'opencode'], source: null, hash: 'sha256:b' },
      ],
    });

    expect(a).toBe(b);
  });

  it('ends with exactly one newline', () => {
    const text = serializeManifest({ version: 1, entries: [] });
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('round-trips through readManifest', async () => {
    const manifest = {
      version: 1,
      entries: [
        {
          path: '.claude/agents/reviewer.md',
          providers: ['claude'],
          source: 'agents/reviewer',
          hash: 'sha256:x',
        },
      ],
    };
    const result = await read(serializeManifest(manifest));
    expect(result.manifest).toEqual({
      version: 1,
      entries: [
        { ...manifest.entries[0], ownership: 'managed', extension: null, executable: false },
      ],
    });
  });
});
