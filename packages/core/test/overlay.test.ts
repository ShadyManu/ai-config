import { describe, expect, it } from 'vitest';

import { discoverOverlay } from '../src/overlay/overlay.js';
import type { ProviderExtensionDefinition } from '../src/adapter/adapter.js';
import { MemoryFileSystem } from '../src/testing/memory-file-system.js';

const envelope = (extensions: string[]) =>
  `schema: 1\nprovider: codex\nextensions:\n${extensions.map((id) => `  - ${id}`).join('\n')}\n`;

describe('provider overlays', () => {
  it('discovers only the requested provider overlay deterministically', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/codex/overlay.yaml', envelope(['b', 'a']));
    for (const id of ['a', 'b'])
      fs.set(
        `.ai/providers/codex/extensions/${id}.yaml`,
        `schema: 1\ntype: codex.fixture-extension\ntarget:\n  kind: skill\n  id: review\nspec:\n  allowImplicitInvocation: false\n`,
      );
    fs.set('.ai/providers/claude/overlay.yaml', envelope(['wrong']));
    const result = await discoverOverlay(fs, fs.root, 'codex', { extensions: definitions });
    expect(result.diagnostics).toEqual([]);
    expect(result.overlay.extensions.map((extension) => extension.id)).toEqual(['a', 'b']);
  });

  it('reports missing extension documents and invalid extension schemas', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/codex/overlay.yaml', envelope(['missing', 'bad']));
    fs.set('.ai/providers/codex/extensions/bad.yaml', 'schema: 2\ntype: codex.fixture-extension\n');
    const result = await discoverOverlay(fs, fs.root, 'codex', { extensions: definitions });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'OVERLAY_EXTENSION_MISSING',
      'OVERLAY_INVALID',
    ]);
  });

  it('rejects missing, escaped, and orphan provider assets', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/codex/overlay.yaml', envelope(['policy']));
    fs.set(
      '.ai/providers/codex/extensions/policy.yaml',
      'schema: 1\ntype: codex.fixture-extension\ntarget:\n  kind: skill\n  id: review\nassets:\n  - missing.txt\n  - ../escape.txt\nspec:\n  allowImplicitInvocation: false\n',
    );
    fs.set('.ai/providers/codex/assets/policy/orphan.txt', 'opaque');
    const result = await discoverOverlay(fs, fs.root, 'codex', { extensions: definitions });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'OVERLAY_ASSET_MISSING',
      'OVERLAY_ASSET_UNSAFE',
      'OVERLAY_ASSET_UNREFERENCED',
    ]);
  });

  it('records contained referenced assets in deterministic extension order', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/codex/overlay.yaml', envelope(['policy']));
    fs.set(
      '.ai/providers/codex/extensions/policy.yaml',
      'schema: 1\ntype: codex.fixture-extension\ntarget:\n  kind: skill\n  id: review\nassets:\n  - templates/policy.txt\n  - notices/readme.txt\nspec:\n  allowImplicitInvocation: false\n',
    );
    fs.set('.ai/providers/codex/assets/policy/templates/policy.txt', 'policy');
    fs.set('.ai/providers/codex/assets/policy/notices/readme.txt', 'notice');

    const result = await discoverOverlay(fs, fs.root, 'codex', { extensions: definitions });
    expect(result.diagnostics).toEqual([]);
    expect(result.overlay.extensions[0]?.assets).toEqual([
      '.ai/providers/codex/assets/policy/notices/readme.txt',
      '.ai/providers/codex/assets/policy/templates/policy.txt',
    ]);
  });

  it('refuses an extension type the provider does not register', async () => {
    // An overlay names its own type, so a typo — or a document copied from
    // another provider — would otherwise be applied as if it were understood.
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/codex/overlay.yaml', envelope(['policy']));
    fs.set(
      '.ai/providers/codex/extensions/policy.yaml',
      'schema: 1\ntype: claude.fixture-extension\ntarget:\n  kind: skill\n  id: review\nspec:\n  allowImplicitInvocation: false\n',
    );

    const result = await discoverOverlay(fs, fs.root, 'codex', { extensions: definitions });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'OVERLAY_EXTENSION_UNSUPPORTED',
    ]);
    expect(result.overlay.extensions).toEqual([]);
  });

  it('refuses an extension aimed at an artifact kind it does not target', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/codex/overlay.yaml', envelope(['policy']));
    fs.set(
      '.ai/providers/codex/extensions/policy.yaml',
      'schema: 1\ntype: codex.fixture-extension\ntarget:\n  kind: agent\n  id: reviewer\nspec:\n  allowImplicitInvocation: false\n',
    );

    const result = await discoverOverlay(fs, fs.root, 'codex', { extensions: definitions });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'OVERLAY_TARGET_INVALID',
    ]);
    expect(result.overlay.extensions).toEqual([]);
  });

  it('reports every overlay problem as an error against the document that caused it', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/codex/overlay.yaml', envelope(['wrong-type', 'wrong-target']));
    fs.set(
      '.ai/providers/codex/extensions/wrong-type.yaml',
      'schema: 1\ntype: claude.fixture-extension\ntarget:\n  kind: skill\n  id: review\nspec: {}\n',
    );
    fs.set(
      '.ai/providers/codex/extensions/wrong-target.yaml',
      'schema: 1\ntype: codex.fixture-extension\ntarget:\n  kind: command\n  id: ship\nspec: {}\n',
    );

    const result = await discoverOverlay(fs, fs.root, 'codex', { extensions: definitions });
    expect(result.diagnostics.map((diagnostic) => diagnostic.source)).toEqual([
      '.ai/providers/codex/extensions/wrong-type.yaml',
      '.ai/providers/codex/extensions/wrong-target.yaml',
    ]);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.severity).toBe('error');
      expect(diagnostic.provider).toBe('codex');
    }
  });
});
// A made-up extension type: no adapter registers one in v1, and this suite
// covers the generic envelope machinery rather than any provider's schema.
const definitions: readonly ProviderExtensionDefinition[] = [
  {
    id: 'codex.fixture-extension',
    provider: 'codex',
    targetKinds: ['skill'],
    ownedOutputPaths: [],
    executable: false,
  },
];
