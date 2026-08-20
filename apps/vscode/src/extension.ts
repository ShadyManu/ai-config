import * as path from 'node:path';
import * as vscode from 'vscode';

import { countBySeverity, stateOf } from '@aiconfig/core';

import { Controller, GENERATED_SCHEME } from './controller.js';
import { Logger } from './logger.js';
import {
  commandTargetOverride,
  commandTargetPath,
  commandTargetItem,
  commandTargetProvider,
} from './tree-view.js';

export const activate = (context: vscode.ExtensionContext): void => {
  const logger = new Logger();
  // The manifest is the one place the version is declared, so it is read from
  // there rather than duplicated in the source.
  const declared = (context.extension.packageJSON as { version?: unknown }).version;
  const version = typeof declared === 'string' ? declared : 'unknown';
  const controller = new Controller(logger, version);

  context.subscriptions.push(logger, controller);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('aiconfig.explorer', controller.tree),
  );

  // The generated version of a drifted file, exposed as a read-only document so
  // VS Code's own diff editor can be used instead of a custom viewer.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GENERATED_SCHEME, {
      provideTextDocumentContent: async (uri) =>
        (await controller.generatedContent(uri.path.replace(/^\//, ''))) ??
        '// AI Config: this file is no longer generated.',
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiconfig.init', () => controller.initialize()),
    vscode.commands.registerCommand('aiconfig.sync', () => controller.synchronize()),
    vscode.commands.registerCommand('aiconfig.validate', () => runValidate(controller, logger)),
    vscode.commands.registerCommand('aiconfig.status', () => runStatus(controller, logger)),
    vscode.commands.registerCommand('aiconfig.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('aiconfig.deleteGenerated', () => controller.deleteGenerated()),
    vscode.commands.registerCommand('aiconfig.removeProject', () => controller.removeProject()),
    vscode.commands.registerCommand('aiconfig.showOutput', () => {
      logger.show();
    }),
    vscode.commands.registerCommand('aiconfig.showDiff', (target: unknown) =>
      showDiff(controller, target),
    ),
    // Both resolve their target through `commandTargetPath`, because each is
    // reachable from a tree item and from an inline view action, which are
    // invoked with different arguments. Neither is offered in the Command
    // Palette, so neither can be invoked without a target.
    vscode.commands.registerCommand('aiconfig.restoreFile', (target: unknown) =>
      restoreFile(controller, target),
    ),

    vscode.commands.registerCommand('aiconfig.addInstruction', () =>
      controller.addArtifact('instruction'),
    ),
    vscode.commands.registerCommand('aiconfig.addAgent', () => controller.addArtifact('agent')),
    vscode.commands.registerCommand('aiconfig.addSkill', () => controller.addArtifact('skill')),
    vscode.commands.registerCommand('aiconfig.addCommand', () => controller.addArtifact('command')),

    // Every artifact and override command resolves its target from the tree
    // node it was invoked on, and none is offered in the Command Palette, so
    // none can be invoked without one.
    vscode.commands.registerCommand('aiconfig.editArtifact', async (target: unknown) => {
      const item = commandTargetItem(target);
      if (item !== undefined) {
        await controller.editArtifact(item.file);
      }
    }),
    vscode.commands.registerCommand('aiconfig.deleteArtifact', async (target: unknown) => {
      const item = commandTargetItem(target);
      if (item !== undefined) {
        await controller.deleteArtifact(item.source, item.label);
      }
    }),
    vscode.commands.registerCommand('aiconfig.addOverride', async (target: unknown) => {
      const item = commandTargetItem(target);
      if (item !== undefined) {
        await controller.addOverride(item.source, item.label);
      }
    }),
    vscode.commands.registerCommand('aiconfig.editOverride', async (target: unknown) => {
      const override = commandTargetOverride(target);
      if (override !== undefined) {
        await controller.editOverride(override.provider, override.source, override.name);
      }
    }),
    vscode.commands.registerCommand('aiconfig.removeOverride', async (target: unknown) => {
      const override = commandTargetOverride(target);
      if (override !== undefined) {
        await controller.removeOverride(override.provider, override.source, override.name);
      }
    }),

    // The two provider actions resolve their target the same way, and each is
    // contributed only against the row it applies to: a disabled provider can
    // be enabled, an enabled one can be removed.
    vscode.commands.registerCommand('aiconfig.enableProvider', async (target: unknown) => {
      const node = commandTargetProvider(target);
      if (node !== undefined) {
        await controller.enableProvider(node.provider.id);
      }
    }),
    vscode.commands.registerCommand('aiconfig.removeProvider', async (target: unknown) => {
      const node = commandTargetProvider(target);
      if (node !== undefined) {
        await controller.removeProvider(node.provider.id);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => controller.reselectWorkspace()),
  );

  void controller.start();
};

export const deactivate = (): void => {
  // Everything is registered through context.subscriptions.
};

const runValidate = async (controller: Controller, logger: Logger): Promise<void> => {
  await controller.refresh();
  const analysis = controller.currentAnalysis();

  if (analysis === undefined) {
    void vscode.window.showWarningMessage(
      'AI Config: configuration could not be read. See the AI Config output.',
    );
    return;
  }

  const errors = countBySeverity(analysis.diagnostics, 'error');
  const warnings = countBySeverity(analysis.diagnostics, 'warning');

  if (errors === 0 && warnings === 0) {
    void vscode.window.showInformationMessage('AI Config: validation passed.');
    return;
  }

  const message = `AI Config: ${String(errors)} error${errors === 1 ? '' : 's'}, ${String(warnings)} warning${warnings === 1 ? '' : 's'}.`;
  const choice = await vscode.window.showWarningMessage(message, 'Show Problems', 'Show Output');

  if (choice === 'Show Problems') {
    await vscode.commands.executeCommand('workbench.actions.view.problems');
  } else if (choice === 'Show Output') {
    logger.show();
  }
};

const runStatus = async (controller: Controller, logger: Logger): Promise<void> => {
  await controller.refresh();
  const analysis = controller.currentAnalysis();

  if (analysis === undefined) {
    const choice = await vscode.window.showInformationMessage(
      'AI Config: not initialized in this workspace.',
      'Initialize',
    );
    if (choice === 'Initialize') {
      await controller.initialize();
    }
    return;
  }

  logger.info('Status:');
  for (const provider of analysis.providers) {
    logger.info(
      `  ${provider.displayName.padEnd(16)}${provider.status.padEnd(12)}${String(provider.fileCount)}`,
    );
  }
  for (const action of analysis.plan.actions) {
    const state = stateOf(action);
    if (state !== 'synced') {
      logger.info(`  ${state.padEnd(10)}${action.path}`);
    }
  }
  logger.show();
};

const restoreFile = async (controller: Controller, target: unknown): Promise<void> => {
  const relativePath = commandTargetPath(target);

  if (relativePath === undefined) {
    // Defensive: without a target this would have to mean "every drifted file",
    // which is not what a per-file action should ever do.
    void vscode.window.showWarningMessage(
      'AI Config: choose a file in the AI Config view to restore.',
    );
    return;
  }

  await controller.restoreFile(relativePath);
};

const showDiff = async (controller: Controller, target: unknown): Promise<void> => {
  const relativePath = commandTargetPath(target);
  const root = controller.currentRoot();

  if (relativePath === undefined || root === undefined) {
    return;
  }

  const generated = vscode.Uri.from({ scheme: GENERATED_SCHEME, path: `/${relativePath}` });
  const actual = vscode.Uri.file(path.join(root, ...relativePath.split('/')));

  await vscode.commands.executeCommand(
    'vscode.diff',
    generated,
    actual,
    `${relativePath} (generated ↔ on disk)`,
  );
};
