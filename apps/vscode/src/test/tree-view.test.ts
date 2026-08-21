import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import type { AnalysisResult, FileState, PlanAction } from '@aiconfig/core';
import { MANIFEST_VERSION, SUPPORTED_SCHEMA_VERSION, stateOf } from '@aiconfig/core';

import { GENERATED_SCHEME } from '../generated-document.js';
import {
  AiConfigTreeProvider,
  SUPPORT_URL,
  DISABLED_PROVIDER_CONTEXT,
  DRIFTED_FILE_CONTEXT,
  ENABLED_PROVIDER_CONTEXT,
  commandTargetPath,
  commandTargetProvider,
} from '../tree-view.js';

const EXTENSION_ID = 'aiconfig.ai-config';
const ROOT = '/workspace';
const DRIFTED_PATH = '.claude/agents/reviewer.md';

/** The tree's own element type, which it deliberately does not export. */
type TreeNode = Parameters<AiConfigTreeProvider['getTreeItem']>[0];

/** What every planned action for this path carries, whatever its kind. */
const PLANNED = {
  path: DRIFTED_PATH,
  providers: ['claude'],
  source: 'agents/reviewer',
} as const;

const GENERATED = { kind: 'text', value: 'generated' } as const;

const driftedAction: PlanAction = { ...PLANNED, kind: 'blocked', reason: 'drift' };

/**
 * The minimum an analysis needs to render one drifted Claude Code file.
 *
 * Built by hand rather than by synchronizing a real repository: drift detection
 * is covered by the core suite, and what is under test here is only how the
 * tree turns an action into an item and into a command argument.
 */
const analysisWithDrift = (): AnalysisResult => ({
  project: {
    config: {
      schema: SUPPORTED_SCHEMA_VERSION,
      providers: ['claude'],
    },
    configuration: { instructions: [], agents: [], skills: [], commands: [] },
    enabled: ['claude'],
    overlays: new Map(),
    diagnostics: [],
  },
  artifacts: [],
  plan: {
    actions: [driftedAction],
    currentManifest: { version: MANIFEST_VERSION, entries: [] },
  },
  providers: [
    {
      id: 'claude',
      displayName: 'Claude Code',
      enabled: true,
      fileCount: 1,
      status: 'drift',
      actions: [driftedAction],
    },
  ],
  diagnostics: [],
});

const treeWithDrift = (): AiConfigTreeProvider => {
  const tree = new AiConfigTreeProvider();
  tree.update(ROOT, analysisWithDrift());
  return tree;
};

/** The element VS Code hands to a `view/item/context` action on the drifted file. */
const driftedFileElement = (tree: AiConfigTreeProvider): TreeNode => {
  const providers = tree
    .getChildren()
    .find((node) => node.kind === 'section' && node.label === 'Providers');
  assert.ok(providers, 'the tree should have a Providers section');

  const claude = tree.getChildren(providers)[0];
  assert.ok(claude, 'Claude Code should be listed under Providers');

  const files = tree.getChildren(claude);
  assert.equal(files.length, 1, 'only the drifted file should be listed');

  const file = files[0];
  assert.ok(file);
  return file;
};

suite('AI Config tree view', () => {
  test('labels executable files and explains lossy provider capability details', () => {
    const analysis = analysisWithDrift();
    const executableAction: PlanAction = {
      ...driftedAction,
      executable: true,
      extension: 'fixture.extension',
    };
    const augmented: AnalysisResult = {
      ...analysis,
      providers: [{ ...analysis.providers[0]!, actions: [executableAction] }],
      diagnostics: [
        {
          code: 'INSTRUCTION_SCOPE_NOT_SUPPORTED',
          severity: 'warning',
          message: 'Scope is rendered as prose.',
          provider: 'claude',
          source: '.ai/instructions/backend.md',
          capability: 'lossy',
        },
        {
          code: 'COMMAND_CONVERTED_TO_SKILL',
          severity: 'info',
          message: 'Converted without semantic loss.',
          provider: 'claude',
          source: '.ai/commands/review.md',
          capability: 'exact',
        },
        {
          code: 'COMMAND_LIMITED_SURFACE',
          severity: 'warning',
          message: 'Available only in the editor.',
          provider: 'claude',
          source: '.ai/commands/review.md',
          capability: 'unsupported',
        },
        {
          code: 'COMMAND_LIMITED_SURFACE',
          severity: 'info',
          message: 'Provider behaviour has not been verified.',
          provider: 'claude',
          source: '.ai/commands/review.md',
          capability: 'unverified',
        },
      ],
    };
    const tree = new AiConfigTreeProvider();
    tree.update(ROOT, augmented);
    const providers = tree.getChildren()[1]!;
    const provider = tree.getChildren(providers)[0]!;
    const tooltip = tree.getTreeItem(provider).tooltip;
    assert.equal(typeof tooltip, 'string');
    if (typeof tooltip !== 'string') return;
    for (const capability of ['exact', 'lossy', 'unsupported', 'unverified'])
      assert.match(tooltip, new RegExp(capability));
    assert.match(tooltip, /\.ai\/instructions\/backend\.md/);
    assert.match(tooltip, /Scope is rendered as prose/);
    assert.match(
      String(tree.getTreeItem(tree.getChildren(provider)[0]!).description),
      /executable/,
    );
    tree.dispose();
  });

  test('lists a drifted generated file with the context value the inline actions require', () => {
    const tree = treeWithDrift();
    const item = tree.getTreeItem(driftedFileElement(tree));

    assert.equal(item.label, DRIFTED_PATH);
    assert.equal(
      item.contextValue,
      DRIFTED_FILE_CONTEXT,
      'without this context value the inline actions are never offered',
    );

    tree.dispose();
  });

  test('offers a contact link at the bottom of the sidebar', () => {
    const tree = treeWithDrift();
    const contact = tree.getChildren().at(-1);
    assert.ok(contact);

    const item = tree.getTreeItem(contact);
    assert.equal(item.label, 'Found a bug or have a suggestion? Open GitHub Issues →');
    assert.equal(item.iconPath instanceof vscode.ThemeIcon, true);
    assert.equal((item.iconPath as vscode.ThemeIcon).id, 'arrow-right');
    assert.equal(item.command?.command, 'vscode.open');
    assert.equal(String(item.command?.arguments?.[0]), SUPPORT_URL);

    tree.dispose();
  });

  test('resolves the target of an inline view action from the clicked tree element', () => {
    const tree = treeWithDrift();

    // VS Code invokes a `view/item/context` command with the element itself,
    // never with `TreeItem.command.arguments`. Rejecting that shape is what made
    // "Restore Generated File" report that no file had been chosen.
    assert.equal(commandTargetPath(driftedFileElement(tree)), DRIFTED_PATH);

    tree.dispose();
  });

  test('resolves the target of the tree item command as well', () => {
    const tree = treeWithDrift();
    const item = tree.getTreeItem(driftedFileElement(tree));

    assert.equal(item.command?.command, 'aiconfig.showDiff');
    assert.equal(commandTargetPath(item.command?.arguments?.[0]), DRIFTED_PATH);

    tree.dispose();
  });

  /**
   * Every generated file row opens something.
   *
   * Only the drifted rows used to carry a command, because only they had a diff
   * and a restore to offer — a decision about those two actions that quietly
   * became the answer for clicking as well, leaving a row that named a real
   * file and did nothing at all when clicked. The table below is the whole
   * state space, so a state added later cannot slip through inert.
   */
  const CLICKS: readonly {
    readonly state: FileState;
    readonly action: PlanAction;
    readonly command: string;
    readonly opens: 'the file' | 'the generated version' | 'a diff';
  }[] = [
    {
      state: 'drift',
      action: driftedAction,
      command: 'aiconfig.showDiff',
      opens: 'a diff',
    },
    {
      state: 'conflict',
      action: { ...PLANNED, kind: 'blocked', reason: 'untracked' },
      command: 'vscode.open',
      opens: 'the file',
    },
    {
      state: 'stale',
      action: { ...PLANNED, kind: 'update', content: GENERATED, hash: 'hash' },
      command: 'vscode.open',
      opens: 'the file',
    },
    {
      state: 'orphaned',
      action: { ...PLANNED, kind: 'delete', hash: 'hash' },
      command: 'vscode.open',
      opens: 'the file',
    },
    {
      state: 'missing',
      action: { ...PLANNED, kind: 'create', content: GENERATED, hash: 'hash' },
      command: 'vscode.open',
      opens: 'the generated version',
    },
  ];

  for (const { state, action, command, opens } of CLICKS) {
    test(`a ${state} file opens ${opens} when clicked`, () => {
      const analysis = analysisWithDrift();
      const tree = new AiConfigTreeProvider();
      tree.update(ROOT, {
        ...analysis,
        providers: [{ ...analysis.providers[0]!, actions: [action] }],
      });

      const item = tree.getTreeItem(driftedFileElement(tree));
      assert.equal(stateOf(action), state, 'the fixture should produce the state under test');
      assert.equal(item.command?.command, command);

      const argument: unknown = item.command?.arguments?.[0];
      if (opens === 'a diff') {
        assert.equal(commandTargetPath(argument), DRIFTED_PATH);
      } else if (opens === 'the generated version') {
        // A read-only preview, because `create` and `restore` are planned only
        // when nothing is at the path: there is no file to open yet.
        assert.equal((argument as vscode.Uri).scheme, GENERATED_SCHEME);
        assert.equal((argument as vscode.Uri).path, `/${DRIFTED_PATH}`);
      } else {
        assert.equal((argument as vscode.Uri).scheme, 'file');
        assert.ok((argument as vscode.Uri).fsPath.endsWith('reviewer.md'));
      }

      // A tooltip on every row, so a state that cannot be acted on still says
      // what it means.
      assert.ok(typeof item.tooltip === 'string' && item.tooltip.length > 0);

      tree.dispose();
    });
  }

  test('offers the diff and restore actions on the drifted row only', () => {
    const analysis = analysisWithDrift();

    for (const { state, action } of CLICKS) {
      const tree = new AiConfigTreeProvider();
      tree.update(ROOT, {
        ...analysis,
        providers: [{ ...analysis.providers[0]!, actions: [action] }],
      });

      // Opening is offered everywhere; comparing and restoring stay where they
      // mean something, which is what the context value gates.
      assert.equal(
        tree.getTreeItem(driftedFileElement(tree)).contextValue,
        state === 'drift' ? DRIFTED_FILE_CONTEXT : undefined,
        state,
      );

      tree.dispose();
    }
  });

  test('resolves nothing when a command is invoked without a usable target', () => {
    assert.equal(commandTargetPath(undefined), undefined);
    assert.equal(commandTargetPath({ kind: 'provider' }), undefined);
  });

  test('offers both per-file actions on exactly the drifted context value', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    const menus = (
      extension.packageJSON as {
        contributes?: { menus?: Record<string, { command: string; when?: string }[]> };
      }
    ).contributes?.menus?.['view/item/context'];

    assert.ok(menus, 'the manifest should contribute view item actions');

    for (const command of ['aiconfig.showDiff', 'aiconfig.restoreFile']) {
      const entry = menus.find((candidate) => candidate.command === command);
      assert.ok(entry, `${command} should be offered on a tree item`);
      // The action is only reachable when the item's context value matches, so
      // the manifest and DRIFTED_FILE_CONTEXT have to stay in step.
      assert.ok(
        entry.when?.includes(`viewItem == ${DRIFTED_FILE_CONTEXT}`),
        `${command} should be gated on ${DRIFTED_FILE_CONTEXT}`,
      );
    }
  });

  test('marks each provider row with the context value its inline action needs', () => {
    const analysis = analysisWithDrift();
    const withDisabled: AnalysisResult = {
      ...analysis,
      providers: [
        analysis.providers[0]!,
        {
          id: 'opencode',
          displayName: 'OpenCode',
          enabled: false,
          fileCount: 0,
          status: 'disabled',
          actions: [],
        },
      ],
    };
    const tree = new AiConfigTreeProvider();
    tree.update(ROOT, withDisabled);

    const providers = tree
      .getChildren()
      .find((node) => node.kind === 'section' && node.label === 'Providers');
    assert.ok(providers, 'the tree should have a Providers section');

    const [enabled, disabled] = tree.getChildren(providers);
    assert.ok(enabled && disabled);
    assert.equal(tree.getTreeItem(enabled).contextValue, ENABLED_PROVIDER_CONTEXT);
    assert.equal(tree.getTreeItem(disabled).contextValue, DISABLED_PROVIDER_CONTEXT);

    // The inline actions are invoked with the element itself, and act on rows
    // of one kind only.
    assert.equal(commandTargetProvider(disabled)?.provider.id, 'opencode');
    assert.equal(commandTargetProvider(driftedFileElement(tree)), undefined);
    assert.equal(commandTargetProvider(undefined), undefined);

    tree.dispose();
  });

  test('offers Enable and Remove on opposite provider rows, and neither in the palette', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    const contributed = (
      extension.packageJSON as {
        contributes?: { menus?: Record<string, { command: string; when?: string }[]> };
      }
    ).contributes?.menus;

    const menus = contributed?.['view/item/context'];
    assert.ok(menus, 'the manifest should contribute view item actions');

    const enable = menus.find((entry) => entry.command === 'aiconfig.enableProvider');
    const remove = menus.find((entry) => entry.command === 'aiconfig.removeProvider');
    assert.ok(enable?.when?.includes(`viewItem == ${DISABLED_PROVIDER_CONTEXT}`));
    assert.ok(remove?.when?.includes(`viewItem == ${ENABLED_PROVIDER_CONTEXT}`));

    // Each row offers exactly one of the two: enabling what is already enabled
    // does nothing, and removing what was never enabled has nothing to remove.
    assert.ok(!enable?.when?.includes(ENABLED_PROVIDER_CONTEXT));
    assert.ok(!remove?.when?.includes(DISABLED_PROVIDER_CONTEXT));

    // Both act on the row they were invoked on, so neither can be reached
    // without one.
    const palette = contributed?.['commandPalette'];
    assert.ok(palette);
    for (const command of ['aiconfig.enableProvider', 'aiconfig.removeProvider']) {
      assert.equal(palette.find((entry) => entry.command === command)?.when, 'false', command);
    }
  });

  test('lists the artifact kinds alphabetically, and the Add menu in the same order', () => {
    const tree = new AiConfigTreeProvider();
    tree.update(ROOT, analysisWithDrift());

    const configuration = tree
      .getChildren()
      .find((node) => node.kind === 'section' && node.label === 'Configuration');
    assert.ok(configuration, 'the tree should have a Configuration section');

    const labels = tree
      .getChildren(configuration)
      .map((node) => (node.kind === 'category' ? node.label : ''));
    assert.deepEqual(labels, ['Agents', 'Commands', 'Instructions', 'Skills']);

    // The same four, offered in the same order, so the menu and the tree do
    // not disagree about where a kind sits.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    const addMenu = (
      extension.packageJSON as {
        contributes?: { menus?: Record<string, { command: string; group?: string }[]> };
      }
    ).contributes?.menus?.['aiconfig.add'];

    assert.ok(addMenu, 'the manifest should contribute an Add submenu');
    const ordered = [...addMenu]
      .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? ''))
      .map((entry) => entry.command);
    assert.deepEqual(ordered, [
      'aiconfig.addAgent',
      'aiconfig.addCommand',
      'aiconfig.addInstruction',
      'aiconfig.addSkill',
    ]);
  });
});
