import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import type { AiConfiguration, AnalysisResult, ProviderId, ProviderOverlay } from '@aiconfig/core';
import { MANIFEST_VERSION, SUPPORTED_SCHEMA_VERSION } from '@aiconfig/core';
import { createDefaultAdapters } from '@aiconfig/providers';

import {
  AiConfigTreeProvider,
  ITEM_CONTEXT,
  OVERRIDABLE_ITEM_CONTEXT,
  OVERRIDE_CONTEXT,
  commandTargetItem,
  commandTargetOverride,
} from '../tree-view.js';
import { candidatesFor, targetFor } from '../wizards/overrides.js';

const EXTENSION_ID = 'aiconfig.ai-config';
const ROOT = '/workspace';
const adapters = createDefaultAdapters();

const CONFIGURATION: AiConfiguration = {
  instructions: [
    {
      name: 'general',
      description: undefined,
      applyTo: [],
      body: 'Be careful.',
      sourcePath: '.ai/instructions/general.md',
    },
    {
      name: 'backend',
      description: undefined,
      applyTo: ['backend/**'],
      body: 'Use ports.',
      sourcePath: '.ai/instructions/backend.md',
    },
  ],
  agents: [
    { name: 'coder', description: 'Writes code', body: 'b', sourcePath: '.ai/agents/coder.md' },
  ],
  skills: [
    {
      name: 'review',
      description: 'Reviews',
      sourcePath: '.ai/skills/review',
      entrypointText: '---\nname: review\ndescription: Reviews\n---\n\nBody.\n',
      entrypointKeys: ['name', 'description'],
      files: [{ relativePath: 'SKILL.md', sha256: 'sha256:a', size: 1, executable: false }],
    },
  ],
  commands: [
    { name: 'ship', description: 'Ships it', body: 'b', sourcePath: '.ai/commands/ship.md' },
  ],
};

const overlayWith = (
  provider: ProviderId,
  overrides: ProviderOverlay['overrides'],
): [ProviderId, ProviderOverlay] => [
  provider,
  { provider, extensions: [], overrides, orphanedOverrides: [] },
];

const analysis = (
  enabled: readonly ProviderId[],
  overlays: ReadonlyMap<ProviderId, ProviderOverlay> = new Map(),
): AnalysisResult => ({
  project: {
    config: { schema: SUPPORTED_SCHEMA_VERSION, providers: [...enabled] },
    configuration: CONFIGURATION,
    enabled,
    overlays,
    diagnostics: [],
  },
  artifacts: [],
  plan: { actions: [], currentManifest: { version: MANIFEST_VERSION, entries: [] } },
  providers: [],
  diagnostics: [],
});

const tree = (result: AnalysisResult): AiConfigTreeProvider => {
  const provider = new AiConfigTreeProvider();
  provider.setAdapters(adapters);
  provider.update(ROOT, result);
  return provider;
};

const itemsIn = (provider: AiConfigTreeProvider, label: string) => {
  const configuration = provider
    .getChildren()
    .find((node) => node.kind === 'section' && node.label === 'Configuration');
  assert.ok(configuration);
  const category = provider
    .getChildren(configuration)
    .find((node) => node.kind === 'category' && node.label === label);
  assert.ok(category, `${label} should be a category`);
  return provider.getChildren(category);
};

suite('provider override candidates', () => {
  test('offers every provider that has agent options', () => {
    const target = targetFor(CONFIGURATION, 'agent', 'coder');
    assert.ok(target);
    const ids = candidatesFor(adapters, ['claude', 'codex', 'copilot', 'opencode'], target).map(
      (candidate) => candidate.adapter.id,
    );
    assert.deepEqual([...ids].sort(), ['claude', 'codex', 'copilot', 'opencode']);
  });

  test('offers Claude, Codex, and Copilot for a skill', () => {
    const target = targetFor(CONFIGURATION, 'skill', 'review');
    assert.ok(target);
    const ids = candidatesFor(adapters, ['claude', 'codex', 'copilot', 'opencode'], target).map(
      (candidate) => candidate.adapter.id,
    );
    assert.deepEqual([...ids].sort(), ['claude', 'codex', 'copilot']);
  });

  test('offers no provider for an unscoped instruction', () => {
    const target = targetFor(CONFIGURATION, 'instruction', 'general');
    assert.ok(target);
    // Copilot is the only provider with an instruction schema, and it refuses an
    // instruction that is not path-scoped.
    assert.deepEqual(
      candidatesFor(adapters, ['claude', 'codex', 'copilot', 'opencode'], target),
      [],
    );
  });

  test('offers Copilot for a path-scoped instruction', () => {
    const target = targetFor(CONFIGURATION, 'instruction', 'backend');
    assert.ok(target);
    const ids = candidatesFor(adapters, ['claude', 'codex', 'copilot', 'opencode'], target).map(
      (candidate) => candidate.adapter.id,
    );
    assert.deepEqual(ids, ['copilot']);
  });

  test('excludes Codex from commands, whose one control is fixed by canonical semantics', () => {
    const target = targetFor(CONFIGURATION, 'command', 'ship');
    assert.ok(target);
    const ids = candidatesFor(adapters, ['claude', 'codex', 'copilot', 'opencode'], target).map(
      (candidate) => candidate.adapter.id,
    );
    assert.deepEqual([...ids].sort(), ['claude', 'copilot', 'opencode']);
  });

  test('hides a capable provider that is not enabled for the project', () => {
    const target = targetFor(CONFIGURATION, 'agent', 'coder');
    assert.ok(target);
    const ids = candidatesFor(adapters, ['opencode'], target).map(
      (candidate) => candidate.adapter.id,
    );
    assert.deepEqual(ids, ['opencode']);
  });
});

suite('tree view overrides', () => {
  test('marks an artifact overridable only when an enabled provider can configure it', () => {
    const provider = tree(analysis(['claude', 'codex', 'copilot', 'opencode']));

    const [general, backend] = itemsIn(provider, 'Instructions');
    assert.ok(general?.kind === 'item' && backend?.kind === 'item');
    assert.equal(general.overridable, false, 'an unscoped instruction has no provider options');
    assert.equal(backend.overridable, true);

    // Both rows still carry Edit and Delete; only the longer context value
    // additionally matches Add Provider Override.
    assert.equal(provider.getTreeItem(general).contextValue, ITEM_CONTEXT);
    assert.equal(provider.getTreeItem(backend).contextValue, OVERRIDABLE_ITEM_CONTEXT);

    provider.dispose();
  });

  test('offers nothing when no capable provider is enabled', () => {
    // OpenCode is the only enabled provider and has no skill settings.
    const provider = tree(analysis(['opencode']));
    const [review] = itemsIn(provider, 'Skills');
    assert.ok(review?.kind === 'item');
    assert.equal(review.overridable, false);
    provider.dispose();
  });

  test('lists configured overrides as children and stops offering those providers', () => {
    const provider = tree(
      analysis(
        ['claude', 'codex', 'copilot', 'opencode'],
        new Map([
          overlayWith('claude', [
            {
              kind: 'agent',
              id: 'coder',
              options: { model: 'sonnet' },
              sourcePath: '.ai/providers/claude/agents/coder.yaml',
            },
          ]),
          overlayWith('opencode', [
            {
              kind: 'agent',
              id: 'coder',
              options: { temperature: 0.1 },
              sourcePath: '.ai/providers/opencode/agents/coder.yaml',
            },
          ]),
        ]),
      ),
    );

    const [coder] = itemsIn(provider, 'Agents');
    assert.ok(coder?.kind === 'item');
    assert.deepEqual(coder.overrides, ['claude', 'opencode']);
    // Codex and Copilot remain, so the action is still offered.
    assert.equal(coder.overridable, true);

    const children = provider.getChildren(coder);
    assert.equal(children.length, 2);
    const first = children[0];
    assert.ok(first?.kind === 'override');
    const item = provider.getTreeItem(first);
    assert.equal(item.label, 'Claude Code override');
    assert.equal(item.contextValue, OVERRIDE_CONTEXT);
    assert.equal(typeof item.tooltip, 'string');
    assert.match(item.tooltip as string, /still compiled to every enabled provider/);

    provider.dispose();
  });

  test('stops offering the action once every capable provider has an override', () => {
    const provider = tree(
      analysis(
        ['claude'],
        new Map([
          overlayWith('claude', [
            {
              kind: 'agent',
              id: 'coder',
              options: { model: 'sonnet' },
              sourcePath: '.ai/providers/claude/agents/coder.yaml',
            },
          ]),
        ]),
      ),
    );

    const [coder] = itemsIn(provider, 'Agents');
    assert.ok(coder?.kind === 'item');
    assert.equal(coder.overridable, false);
    assert.equal(provider.getTreeItem(coder).contextValue, ITEM_CONTEXT);

    provider.dispose();
  });

  test('resolves command targets from the clicked element', () => {
    const provider = tree(
      analysis(
        ['claude'],
        new Map([
          overlayWith('claude', [
            {
              kind: 'agent',
              id: 'coder',
              options: { model: 'sonnet' },
              sourcePath: '.ai/providers/claude/agents/coder.yaml',
            },
          ]),
        ]),
      ),
    );

    const [coder] = itemsIn(provider, 'Agents');
    assert.ok(coder?.kind === 'item');
    assert.equal(commandTargetItem(coder)?.label, 'coder');
    assert.equal(commandTargetItem(undefined), undefined);

    const override = provider.getChildren(coder)[0];
    assert.equal(commandTargetOverride(override)?.provider, 'claude');
    assert.equal(commandTargetOverride(coder), undefined);

    provider.dispose();
  });

  test('leaves an artifact with no overrides uncollapsible, as before', () => {
    const provider = tree(analysis(['claude']));
    const [coder] = itemsIn(provider, 'Agents');
    assert.ok(coder?.kind === 'item');
    assert.equal(
      provider.getTreeItem(coder).collapsibleState,
      vscode.TreeItemCollapsibleState.None,
    );
    provider.dispose();
  });
});

suite('override command contributions', () => {
  test('registers every guided command', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const registered = await vscode.commands.getCommands(true);
    for (const command of [
      'aiconfig.addInstruction',
      'aiconfig.addAgent',
      'aiconfig.addSkill',
      'aiconfig.addCommand',
      'aiconfig.addOverride',
      'aiconfig.editOverride',
      'aiconfig.removeOverride',
    ]) {
      assert.ok(registered.includes(command), `${command} should be registered`);
    }
  });

  test('gates each override action on the matching context value', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const menus = (
      extension.packageJSON as {
        contributes?: { menus?: Record<string, { command: string; when?: string }[]> };
      }
    ).contributes?.menus?.['view/item/context'];
    assert.ok(menus);

    const addOverride = menus.find((entry) => entry.command === 'aiconfig.addOverride');
    assert.ok(addOverride?.when?.includes(`viewItem == ${OVERRIDABLE_ITEM_CONTEXT}`));
    assert.ok(
      !addOverride?.when?.includes(`viewItem == ${ITEM_CONTEXT} `),
      'Add Provider Override must not be offered on an artifact no provider can configure',
    );

    // Edit and Delete are offered on every artifact row, configurable or not:
    // without them there is no way to remove an artifact from the view at all.
    for (const command of ['aiconfig.editArtifact', 'aiconfig.deleteArtifact']) {
      const entry = menus.find((candidate) => candidate.command === command);
      assert.ok(entry, `${command} should be offered on an artifact row`);
      assert.ok(entry.when?.includes(`viewItem == ${ITEM_CONTEXT}`), command);
      assert.ok(entry.when?.includes(`viewItem == ${OVERRIDABLE_ITEM_CONTEXT}`), command);
    }

    for (const command of ['aiconfig.editOverride', 'aiconfig.removeOverride']) {
      const entry = menus.find((candidate) => candidate.command === command);
      assert.ok(entry?.when?.includes(`viewItem == ${OVERRIDE_CONTEXT}`), command);
    }
  });

  test('keeps the override actions out of the command palette', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const palette = (
      extension.packageJSON as {
        contributes?: { menus?: Record<string, { command: string; when?: string }[]> };
      }
    ).contributes?.menus?.['commandPalette'];
    assert.ok(palette);

    for (const command of [
      'aiconfig.addOverride',
      'aiconfig.editOverride',
      'aiconfig.removeOverride',
    ]) {
      assert.equal(
        palette.find((entry) => entry.command === command)?.when,
        'false',
        `${command} needs a tree target, so it must not be palette-invocable`,
      );
    }
  });

  test('offers the four Add actions from the view title submenu', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const contributes = (
      extension.packageJSON as {
        contributes?: {
          submenus?: { id: string }[];
          menus?: Record<string, { command?: string; submenu?: string }[]>;
        };
      }
    ).contributes;

    assert.ok(contributes?.submenus?.some((entry) => entry.id === 'aiconfig.add'));
    assert.ok(
      contributes?.menus?.['view/title']?.some((entry) => entry.submenu === 'aiconfig.add'),
    );
    // Alphabetical, matching the order the tree lists the same four kinds in.
    assert.deepEqual(
      contributes?.menus?.['aiconfig.add']?.map((entry) => entry.command),
      ['aiconfig.addAgent', 'aiconfig.addCommand', 'aiconfig.addInstruction', 'aiconfig.addSkill'],
    );
  });
});
