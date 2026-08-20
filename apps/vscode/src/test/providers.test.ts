import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { NodeFileSystem, init } from '@aiconfig/core';
import { createDefaultAdapters } from '@aiconfig/providers';

import {
  countProviderSources,
  providerRemovalDetail,
  providerSourceDirectory,
} from '../wizards/providers.js';

const adapters = createDefaultAdapters();
const fileSystem = new NodeFileSystem();

let root = '';

const write = (relativePath: string, content: string): void => {
  const target = nodePath.join(root, ...relativePath.split('/'));
  fs.mkdirSync(nodePath.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

suite('provider sources', () => {
  setup(async () => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'aiconfig-providers-'));
    const outcome = await init(fileSystem, root, {
      providers: ['claude', 'opencode'],
      adapters,
      version: 'test',
    });
    assert.ok(outcome.ok);
  });

  teardown(() => {
    try {
      // Windows can still hold a handle on a just-written file. The directory
      // is a temporary one, so failing to remove it is not a test failure.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Left to the operating system.
    }
  });

  test('an enabled provider that was never customized has no directory at all', async () => {
    // Initializing enables both providers. Neither may have a directory: an
    // empty one under `.ai/providers/` claims settings exist that nobody wrote,
    // and it is what the Remove confirmation would then have to describe.
    assert.equal(fs.existsSync(nodePath.join(root, '.ai', 'providers')), false);
    assert.equal(await countProviderSources(fileSystem, root, 'opencode'), undefined);
  });

  test('counts every file under the provider directory, not only the overrides', async () => {
    write('.ai/providers/opencode/agents/coder.yaml', 'schema: 1\noptions:\n  model: gpt\n');
    write('.ai/providers/opencode/agents/notes.md', 'Why this override exists.\n');
    write('.ai/providers/opencode/extensions/tool/logo.png', 'binary');

    // The whole directory is deleted, so the count that justifies deleting it
    // has to include what an overlay parse would not recognize.
    assert.equal(await countProviderSources(fileSystem, root, 'opencode'), 3);
    assert.equal(await countProviderSources(fileSystem, root, 'claude'), undefined);
  });

  test('an emptied directory is still counted, and reported as empty', async () => {
    fs.mkdirSync(nodePath.join(root, '.ai', 'providers', 'claude'), { recursive: true });

    assert.equal(await countProviderSources(fileSystem, root, 'claude'), 0);
    assert.match(
      providerRemovalDetail('Claude Code', 'claude', 0),
      /Its empty \.ai\/providers\/claude\/ directory is removed as well\./,
    );
  });
});

suite('provider removal confirmation', () => {
  test('names the directory, the count and what survives', () => {
    const detail = providerRemovalDetail('OpenCode', 'opencode', 3);

    assert.match(detail, /Disables OpenCode in \.ai\/config\.yaml/);
    assert.match(detail, /3 files you wrote in \.ai\/providers\/opencode\/ go to the system trash/);
    // Saying what is kept is half the answer to "what does this cost me?".
    assert.match(detail, /another enabled provider also produces is kept/);
    assert.match(detail, /enable OpenCode again to regenerate its files/);
  });

  test('agrees with itself about one file', () => {
    assert.match(
      providerRemovalDetail('OpenCode', 'opencode', 1),
      /1 file you wrote in \.ai\/providers\/opencode\/ goes to the system trash/,
    );
  });

  test('promises nothing about a directory that is not there', () => {
    const detail = providerRemovalDetail('Codex', 'codex', undefined);

    assert.ok(!detail.includes(providerSourceDirectory('codex')), detail);
    assert.match(detail, /deletes every file AI Config generated for it/);
  });
});
