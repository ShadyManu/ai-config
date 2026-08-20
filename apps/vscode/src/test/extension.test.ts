import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'aiconfig.ai-config';

const EXPECTED_COMMANDS = [
  'aiconfig.init',
  'aiconfig.sync',
  'aiconfig.validate',
  'aiconfig.status',
  'aiconfig.refresh',
  'aiconfig.showOutput',
  'aiconfig.showDiff',
  'aiconfig.restoreFile',
  'aiconfig.addInstruction',
  'aiconfig.addAgent',
  'aiconfig.addSkill',
  'aiconfig.addCommand',
  'aiconfig.editArtifact',
  'aiconfig.deleteArtifact',
  'aiconfig.addOverride',
  'aiconfig.editOverride',
  'aiconfig.removeOverride',
];

/**
 * These tests cover the wiring between VS Code and AI Config only.
 *
 * Compilation, ownership and drift behaviour are covered by the core and CLI
 * suites, which run without an editor; re-testing them here would be slow and
 * would mostly exercise VS Code itself.
 */
suite('AI Config extension', () => {
  test('is present and activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be installed`);

    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  test('registers every contributed command', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const registered = await vscode.commands.getCommands(true);

    for (const command of EXPECTED_COMMANDS) {
      assert.ok(registered.includes(command), `${command} should be registered`);
    }
  });

  test('declares every registered command in the manifest', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    const contributed = (
      extension.packageJSON as { contributes?: { commands?: { command: string }[] } }
    ).contributes?.commands?.map((entry) => entry.command);

    assert.ok(contributed, 'the manifest should contribute commands');
    for (const command of EXPECTED_COMMANDS) {
      assert.ok(contributed.includes(command), `${command} should appear in package.json`);
    }
  });

  test('contributes the AI Config tree view', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    const views = (
      extension.packageJSON as { contributes?: { views?: Record<string, { id: string }[]> } }
    ).contributes?.views;

    assert.ok(views?.['aiconfig']?.some((view) => view.id === 'aiconfig.explorer'));
  });

  test('status runs without a workspace and does not throw', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    // No folder is open in the test host, so this exercises the uninitialized
    // path: it must degrade gracefully rather than fail.
    await vscode.commands.executeCommand('aiconfig.refresh');
  });
});
