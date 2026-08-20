import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { AiConfigTreeProvider } from '../tree-view.js';
import { WATCHED_GLOB, isRelevantChange } from '../watch.js';

const EXTENSION_ID = 'aiconfig.ai-config';
const ROOT = path.resolve('/workspace');

suite('watching .ai/', () => {
  test('watches the .ai directory itself, not only its contents', () => {
    assert.equal(WATCHED_GLOB, '{.ai,.ai/**}');
  });

  test('reacts to the .ai directory appearing or disappearing', () => {
    // Deleting `.ai/` is reported as this single event — the files that went
    // with it are not enumerated — so ignoring it as "just another dotfile"
    // leaves the whole UI describing a configuration that is gone.
    assert.equal(isRelevantChange(ROOT, path.join(ROOT, '.ai')), true);
  });

  test('reacts to canonical sources', () => {
    for (const relative of [
      '.ai/config.yaml',
      '.ai/agents/coder.md',
      '.ai/skills/review/SKILL.md',
    ]) {
      assert.equal(isRelevantChange(ROOT, path.join(ROOT, ...relative.split('/'))), true, relative);
    }
  });

  test('ignores the files AI Config writes under .ai/', () => {
    // The manifest and the staging files atomic writes create; reacting to them
    // would make every sync schedule another refresh.
    for (const relative of ['.ai/.generated.json', '.ai/.generated.json.tmp', '.ai/skills/.ai']) {
      assert.equal(
        isRelevantChange(ROOT, path.join(ROOT, ...relative.split('/'))),
        false,
        relative,
      );
    }
  });
});

suite('uninitialized workspace', () => {
  test('shows nothing in the tree, so the welcome view takes over', () => {
    const provider = new AiConfigTreeProvider();

    // What the controller publishes once `.ai/` is gone: a known root, no
    // analysis.
    provider.update(ROOT, undefined);
    assert.deepEqual(provider.getChildren(), []);

    // And what it publishes when no folder is open at all.
    provider.update(undefined, undefined);
    assert.deepEqual(provider.getChildren(), []);

    provider.dispose();
  });

  test('offers Initialize Project from the welcome view', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    const welcome = (
      extension.packageJSON as {
        contributes?: { viewsWelcome?: { view: string; contents: string }[] };
      }
    ).contributes?.viewsWelcome?.find((entry) => entry.view === 'aiconfig.explorer');

    assert.ok(welcome, 'the explorer view needs welcome content when it is empty');
    assert.ok(welcome.contents.includes('command:aiconfig.init'));
  });
});
