import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { Controller } from '../../controller.js';
import { Logger } from '../../logger.js';

/**
 * Following a rename, driven through the real `Controller` in a real workspace.
 *
 * Everything else about renaming is covered in milliseconds: core against a
 * memory filesystem, core against a temporary directory, and the direction
 * decision as a pure function. What none of those reach is the part that only
 * exists inside the editor — the `Controller` reading its root from
 * `vscode.workspace.workspaceFolders`, deciding against the state it remembers
 * from the previous refresh, and moving a directory through
 * `vscode.workspace.fs` so an open editor follows it.
 *
 * That is the part an author actually uses, and it was the part with no test.
 * These run against the scratch folder `.vscode-test.mjs` opens.
 */

const folder = vscode.workspace.workspaceFolders?.[0];
if (folder === undefined) {
  throw new Error('This suite requires the workspace launch configured in .vscode-test.mjs.');
}
const root = folder.uri.fsPath;

const CONFIG = ['schema: 1', 'providers:', '  enabled: [claude]', ''].join('\n');

const SKILL = (name: string): string =>
  ['---', `name: ${name}`, 'description: Scouts a change.', '---', '', 'Steps.', ''].join('\n');

const AGENT = ['---', 'description: Reviews a change.', '---', '', 'You review.', ''].join('\n');

/**
 * One body per file-based kind, none of which declares a `name`.
 *
 * That absence is the point: it is how AI Config scaffolds them, and it is why
 * renaming one of these files leaves nothing behind to recognize the rename by.
 */
const BODY_FOR = {
  agent: AGENT,
  command: ['---', 'description: Ships it.', '---', '', 'Ship it.', ''].join('\n'),
  instruction: ['---', 'description: House rules.', '---', '', 'Be careful.', ''].join('\n'),
} as const;

const at = (relativePath: string): string => path.join(root, ...relativePath.split('/'));

const write = (relativePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(at(relativePath)), { recursive: true });
  fs.writeFileSync(at(relativePath), content, 'utf8');
};

const read = (relativePath: string): string => fs.readFileSync(at(relativePath), 'utf8');

const exists = (relativePath: string): boolean => fs.existsSync(at(relativePath));

/**
 * Empties the scratch folder, keeping the placeholder git tracks.
 *
 * The retries are not superstition. On Windows a directory cannot be unlinked
 * while any process still holds a handle to it, and the editor's own file
 * watchers release theirs a moment after a controller is disposed — so the
 * first attempt on a directory the last test generated can fail with `EPERM`.
 */
const clean = (): void => {
  for (const entry of fs.readdirSync(root)) {
    if (entry !== '.gitkeep') {
      fs.rmSync(path.join(root, entry), {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    }
  }
};

/**
 * Waits for something the editor does on its own schedule.
 *
 * Not a sleep: it polls a condition and fails with what it was still seeing, so
 * a genuine regression reports the state rather than a timeout. The editor
 * settles its open documents after a rename independently of the promise the
 * rename returned, and asserting immediately makes a passing test depend on how
 * busy the machine is.
 */
const waitFor = async (
  condition: () => boolean,
  describe: () => string,
  timeoutMs = 5000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting: ${describe()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Renames a path the way the explorer does, so the editor reports it.
 *
 * A `fs.renameSync` moves the bytes and tells nobody — which is exactly what a
 * `git mv` looks like, and is used above to test that case. This is the other
 * one: a workspace edit is what the explorer's own Rename applies, and it is
 * what makes `onDidRenameFiles` fire.
 */
const renameThroughEditor = async (from: string, to: string): Promise<void> => {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(vscode.Uri.file(at(from)), vscode.Uri.file(at(to)));
  assert.ok(await vscode.workspace.applyEdit(edit), `the editor refused to rename ${from}`);
};

/** Repository-relative paths of every open document inside the workspace. */
const openInWorkspace = (): readonly string[] =>
  vscode.workspace.textDocuments
    .map((document) => document.uri.fsPath)
    .filter((fsPath) => fsPath.startsWith(root));

/** What the notifications said, and what the next one answers. */
interface Notifications {
  readonly shown: string[];
  /** Labels offered by each warning, in order. */
  readonly offered: string[][];
  /** Answers the pending warnings, oldest first. */
  answer: (...choices: readonly (string | undefined)[]) => void;
  restore: () => void;
}

/**
 * Replaces the notification API, recording what was said and scripting the
 * answers.
 *
 * The ambiguous case asks a question, and a question nobody answers is as much
 * of the contract as the answer: an unscripted warning resolves to `undefined`,
 * which is a dismissal, so a test that forgets to answer sees nothing happen
 * rather than hanging.
 */
const captureNotifications = (): Notifications => {
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = {
    showInformationMessage: window['showInformationMessage'],
    showWarningMessage: window['showWarningMessage'],
    showErrorMessage: window['showErrorMessage'],
  };

  const shown: string[] = [];
  const offered: string[][] = [];
  const answers: (string | undefined)[] = [];

  const record =
    (kind: string) =>
    (message: string, ...rest: unknown[]): Thenable<string | undefined> => {
      shown.push(`${kind}: ${message}`);
      const labels = rest.filter((item): item is string => typeof item === 'string');
      offered.push(labels);
      const reply = answers.shift();
      return Promise.resolve(reply !== undefined && labels.includes(reply) ? reply : undefined);
    };

  window['showInformationMessage'] = record('info');
  window['showWarningMessage'] = record('warning');
  window['showErrorMessage'] = record('error');

  return {
    shown,
    offered,
    answer: (...choices) => answers.push(...choices),
    restore: () => {
      Object.assign(window, original);
    },
  };
};

let controller: Controller | undefined;
let logger: Logger | undefined;
let notifications: Notifications | undefined;

/**
 * Starts a controller on the seeded workspace and lets it take a first reading.
 *
 * That first refresh is not a formality: it is what records the names the
 * project currently has, which is the evidence the next refresh uses to work
 * out which half of a rename was edited.
 */
const start = async (): Promise<Controller> => {
  logger = new Logger();
  const started = new Controller(logger, 'test');
  controller = started;
  await started.refresh();
  return started;
};

suiteSetup(() => {
  // If this fails, the scratch folder still held `.ai/config.yaml` when the
  // editor launched, so the extension activated against the directory these
  // tests drive and a second Controller is racing them. Every symptom of that
  // is confusing; this is the cause, stated once.
  assert.equal(
    vscode.extensions.getExtension('aiconfig.ai-config')?.isActive,
    false,
    'the extension activated on the scratch workspace; it was not empty at launch',
  );
});

setup(() => {
  clean();
  notifications = captureNotifications();
  write('.ai/config.yaml', CONFIG);
  write('.ai/skills/scouts/SKILL.md', SKILL('scouts'));
  write('.ai/skills/scouts/references/checklist.md', '# Checklist\n');
  write('.ai/agents/reviewer.md', AGENT);
});

teardown(async () => {
  controller?.dispose();
  controller = undefined;
  logger?.dispose();
  logger = undefined;
  notifications?.restore();
  notifications = undefined;

  // Closing the editors is not enough: Windows refuses to unlink a directory
  // while a document under it is still open, and the workbench lets go of one
  // shortly after the tab closes rather than at the moment it does.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(
    () => openInWorkspace().length === 0,
    () => `still open: ${openInWorkspace().join(', ')}`,
  );
  clean();
});

suiteTeardown(() => {
  // The folder must not hold `.ai/config.yaml` when the editor next launches,
  // or the extension activates here and puts a second controller on it.
  clean();
});

suite('following a rename in a real workspace', () => {
  test('renames the skill directory when the name field changes', async () => {
    const started = await start();
    assert.equal(exists('.ai/skills/scouts/SKILL.md'), true);

    write('.ai/skills/scouts/SKILL.md', SKILL('scout'));
    await started.refresh();

    assert.equal(exists('.ai/skills/scouts'), false, 'the old directory should be gone');
    assert.equal(exists('.ai/skills/scout/SKILL.md'), true);
    // The whole tree moves, not just the entrypoint.
    assert.equal(read('.ai/skills/scout/references/checklist.md'), '# Checklist\n');
    assert.equal(read('.ai/skills/scout/SKILL.md'), SKILL('scout'));
  });

  test('takes the provider overrides with it', async () => {
    write(
      '.ai/providers/claude/skills/scouts.yaml',
      ['schema: 1', 'options:', '  model: opus', ''].join('\n'),
    );
    const started = await start();

    write('.ai/skills/scouts/SKILL.md', SKILL('scout'));
    await started.refresh();

    assert.equal(exists('.ai/providers/claude/skills/scouts.yaml'), false);
    assert.match(read('.ai/providers/claude/skills/scout.yaml'), /model: opus/);
  });

  test('regenerates under the new name and leaves nothing under the old one', async () => {
    const started = await start();
    // The first refresh synchronizes, so the generated copy exists already.
    assert.equal(exists('.claude/skills/scouts/SKILL.md'), true);

    write('.ai/skills/scouts/SKILL.md', SKILL('scout'));
    await started.refresh();

    assert.equal(exists('.claude/skills/scout/SKILL.md'), true);
    // The old generated files were orphans after the rename, and the
    // synchronization that follows removes them.
    assert.equal(exists('.claude/skills/scouts'), false);
  });

  test('rewrites the name field when the directory is renamed instead', async () => {
    const started = await start();

    fs.renameSync(at('.ai/skills/scouts'), at('.ai/skills/scout'));
    await started.refresh();

    // The other direction: nothing moves, the stale field catches up. Getting
    // this backwards would rename the directory the author just renamed.
    assert.equal(exists('.ai/skills/scout/SKILL.md'), true);
    assert.equal(read('.ai/skills/scout/SKILL.md'), SKILL('scout'));
    assert.equal(exists('.ai/skills/scouts'), false);
  });

  test('renames a file-based artifact the same way', async () => {
    const started = await start();

    write(
      '.ai/agents/reviewer.md',
      ['---', 'name: auditor', ...AGENT.split('\n').slice(1)].join('\n'),
    );
    await started.refresh();

    assert.equal(exists('.ai/agents/reviewer.md'), false);
    assert.match(read('.ai/agents/auditor.md'), /name: auditor/);
    assert.equal(exists('.claude/agents/auditor.md'), true);
  });

  test('performs the move through the editor, not behind its back', async () => {
    const started = await start();
    const renames: string[] = [];
    // `onDidRenameFiles` fires for a move made through `vscode.workspace.fs`
    // and not for one made with `fs.rename`, so it distinguishes the two
    // directly rather than through a side effect that settles on its own time.
    const subscription = vscode.workspace.onDidRenameFiles((event) => {
      for (const file of event.files) {
        renames.push(`${file.oldUri.fsPath} -> ${file.newUri.fsPath}`);
      }
    });

    try {
      write('.ai/skills/scouts/SKILL.md', SKILL('scout'));
      await started.refresh();

      await waitFor(
        () => renames.length > 0,
        () => `no rename reported; saw ${renames.join(', ')}`,
      );
      assert.deepEqual(renames, [`${at('.ai/skills/scouts')} -> ${at('.ai/skills/scout')}`]);
    } finally {
      subscription.dispose();
    }
  });

  test('carries an open editor to the new path', async () => {
    const started = await start();
    const entrypoint = vscode.Uri.file(at('.ai/skills/scouts/SKILL.md'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(entrypoint));

    write('.ai/skills/scouts/SKILL.md', SKILL('scout'));
    await started.refresh();

    // The consequence of the test above, from the author's side: a plain
    // `fs.rename` leaves the tab pointing at a path that no longer exists, and
    // that tab holds the file they were editing when they asked for the rename.
    await waitFor(
      () => openInWorkspace().includes(at('.ai/skills/scout/SKILL.md')),
      () => `open documents: ${openInWorkspace().join(', ')}`,
    );
  });
});

/**
 * The reported defect: rename an artifact's file in the explorer and its
 * provider override disappears.
 *
 * Nothing noticed the rename — an agent scaffolded by AI Config declares no
 * `name`, so the file *is* the name — and the override was left refining an
 * artifact that no longer existed. The synchronization that runs on save then
 * removed it as an orphan, deleting a file the author wrote.
 */
suite('an override survives a rename made in the explorer', () => {
  const OVERRIDE = ['schema: 1', 'options:', '  model: opus', ''].join('\n');

  const cases = [
    { kind: 'agent', directory: 'agents', from: 'reviewer', to: 'auditor' },
    { kind: 'command', directory: 'commands', from: 'ship', to: 'release' },
    { kind: 'instruction', directory: 'instructions', from: 'general', to: 'house-rules' },
  ] as const;

  for (const { kind, directory, from, to } of cases) {
    test(`follows a renamed ${kind} file`, async () => {
      write(`.ai/${directory}/${from}.md`, BODY_FOR[kind]);
      write(`.ai/providers/claude/${directory}/${from}.yaml`, OVERRIDE);
      const started = await start();
      assert.equal(exists(`.ai/providers/claude/${directory}/${from}.yaml`), true);

      fs.renameSync(at(`.ai/${directory}/${from}.md`), at(`.ai/${directory}/${to}.md`));
      await started.refresh();

      assert.equal(
        exists(`.ai/providers/claude/${directory}/${from}.yaml`),
        false,
        'the override should not be left at the old name',
      );
      assert.equal(
        read(`.ai/providers/claude/${directory}/${to}.yaml`),
        OVERRIDE,
        'the override should have moved to the new name, unchanged',
      );
    });
  }

  test('takes the overrides of every enabled provider', async () => {
    write(
      '.ai/config.yaml',
      ['schema: 1', 'providers:', '  enabled: [claude, codex]', ''].join('\n'),
    );
    write('.ai/agents/reviewer.md', BODY_FOR.agent);
    write('.ai/providers/claude/agents/reviewer.yaml', OVERRIDE);
    write(
      '.ai/providers/codex/agents/reviewer.yaml',
      ['schema: 1', 'options:', '  model: gpt-5.5', ''].join('\n'),
    );
    const started = await start();

    fs.renameSync(at('.ai/agents/reviewer.md'), at('.ai/agents/auditor.md'));
    await started.refresh();

    assert.equal(read('.ai/providers/claude/agents/auditor.yaml'), OVERRIDE);
    assert.match(read('.ai/providers/codex/agents/auditor.yaml'), /gpt-5\.5/);
  });

  test('preserves the override when an artifact is deleted outside AI Config', async () => {
    // A refresh cannot distinguish deletion from a rename or branch switch.
    // Authored overrides therefore survive until an explicit cleanup action.
    write('.ai/agents/reviewer.md', BODY_FOR.agent);
    write('.ai/providers/claude/agents/reviewer.yaml', OVERRIDE);
    const started = await start();

    fs.rmSync(at('.ai/agents/reviewer.md'));
    await started.refresh();

    assert.equal(exists('.ai/providers/claude/agents/reviewer.yaml'), true);
    assert.equal(exists('.claude/agents/reviewer.md'), false);
  });

  test('keeps the override when the rename came from the editor and the file also changed', async () => {
    // The case content matching cannot decide: name, description and body all
    // different at once, so nothing links the two artifacts. A rename made in
    // the explorer is reported by the editor itself, and that is a fact rather
    // than an inference — so this works where matching alone would give up.
    write('.ai/agents/reviewer.md', BODY_FOR.agent);
    write('.ai/providers/claude/agents/reviewer.yaml', OVERRIDE);
    const started = await start();

    await renameThroughEditor('.ai/agents/reviewer.md', '.ai/agents/auditor.md');
    write(
      '.ai/agents/auditor.md',
      ['---', 'description: Audits a change.', '---', '', 'You audit.', ''].join('\n'),
    );
    await started.refresh();

    assert.equal(read('.ai/providers/claude/agents/auditor.yaml'), OVERRIDE);
    assert.equal(exists('.ai/providers/claude/agents/reviewer.yaml'), false);
  });

  test('leaves the override alone when a rename outside the editor also changed the file', async () => {
    // A `git mv` or another program: the editor reports nothing, and the two
    // artifacts have nothing in common, so there is no evidence of a rename at
    // all. The old behaviour stands rather than a guess being made.
    write('.ai/agents/reviewer.md', BODY_FOR.agent);
    write('.ai/providers/claude/agents/reviewer.yaml', OVERRIDE);
    const started = await start();

    fs.renameSync(at('.ai/agents/reviewer.md'), at('.ai/agents/auditor.md'));
    write('.ai/agents/auditor.md', BODY_FOR.agent.replace('You review.', 'You audit.'));
    await started.refresh();

    assert.equal(exists('.ai/providers/claude/agents/auditor.yaml'), false);
    assert.equal(exists('.ai/providers/claude/agents/reviewer.yaml'), true);
  });

  test('keeps the override when a skill directory is renamed in the explorer', async () => {
    // A folder rename is a single event naming the directory, not one per file.
    write('.ai/providers/claude/skills/scouts.yaml', OVERRIDE);
    const started = await start();

    await renameThroughEditor('.ai/skills/scouts', '.ai/skills/scout');
    await started.refresh();

    assert.equal(read('.ai/providers/claude/skills/scout.yaml'), OVERRIDE);
    assert.equal(exists('.ai/providers/claude/skills/scouts.yaml'), false);
  });

  test('ignores a rename that is not an artifact of its own', async () => {
    // A file inside a skill moving is that skill being edited, not renamed, and
    // must not be read as one.
    write('.ai/providers/claude/skills/scouts.yaml', OVERRIDE);
    const started = await start();

    await renameThroughEditor(
      '.ai/skills/scouts/references/checklist.md',
      '.ai/skills/scouts/references/list.md',
    );
    await started.refresh();

    assert.equal(read('.ai/providers/claude/skills/scouts.yaml'), OVERRIDE);
  });
});

suite('a rename the workspace cannot decide on its own', () => {
  test('asks which name wins when it did not see the change happen', async () => {
    // A project opened in this state: neither name was there a moment ago,
    // because there was no moment ago.
    write('.ai/skills/scouts/SKILL.md', SKILL('scout'));
    notifications?.answer("Rename to 'scout'");

    const started = await start();
    // The answer is applied on its own queued operation, so the next refresh
    // is what waits for it.
    await started.refresh();

    assert.ok(
      notifications?.shown.some((message) => message.includes("called 'scouts' by its location")),
      `expected the question among ${String(notifications?.shown.join(' | '))}`,
    );
    assert.equal(exists('.ai/skills/scout/SKILL.md'), true);
    assert.equal(exists('.ai/skills/scouts'), false);
  });

  test('keeps the location instead, when that is the answer', async () => {
    write('.ai/skills/scouts/SKILL.md', SKILL('scout'));
    notifications?.answer("Keep 'scouts'");

    const started = await start();
    await started.refresh();

    assert.equal(exists('.ai/skills/scouts/SKILL.md'), true);
    assert.equal(read('.ai/skills/scouts/SKILL.md'), SKILL('scouts'));
  });

  test('changes nothing when the question is dismissed', async () => {
    write('.ai/skills/scouts/SKILL.md', SKILL('scout'));
    // No answer scripted: the notification resolves to a dismissal.

    const started = await start();
    await started.refresh();

    assert.equal(exists('.ai/skills/scouts/SKILL.md'), true);
    assert.equal(read('.ai/skills/scouts/SKILL.md'), SKILL('scout'));
  });

  test('asks once, not on every refresh', async () => {
    write('.ai/skills/scouts/SKILL.md', SKILL('scout'));

    const started = await start();
    await started.refresh();
    await started.refresh();

    // The mismatch survives every refresh until somebody resolves it. Asking
    // again each time is how a notification becomes something people dismiss
    // without reading.
    const questions = (notifications?.shown ?? []).filter((message) =>
      message.includes('by its name field'),
    );
    assert.equal(questions.length, 1, questions.join(' | '));
  });

  test('offers both directions, naming each one', async () => {
    write('.ai/skills/scouts/SKILL.md', SKILL('scout'));

    await start();

    const question = (notifications?.offered ?? []).find((labels) => labels.length === 2);
    assert.deepEqual(question, ["Rename to 'scout'", "Keep 'scouts'"]);
  });

  test('follows two renames made in the same save', async () => {
    write('.ai/skills/hunters/SKILL.md', SKILL('hunters'));
    const started = await start();

    write('.ai/skills/scouts/SKILL.md', SKILL('scout'));
    write('.ai/skills/hunters/SKILL.md', SKILL('hunter'));
    await started.refresh();

    // One refresh sees both mismatches. Resolving only the first would leave
    // the project invalid and the second untouched until the next save.
    assert.equal(exists('.ai/skills/scout/SKILL.md'), true);
    assert.equal(exists('.ai/skills/hunter/SKILL.md'), true);
    assert.equal(exists('.ai/skills/scouts'), false);
    assert.equal(exists('.ai/skills/hunters'), false);
  });

  test('refuses a name that is not a valid canonical name, and leaves the skill alone', async () => {
    const started = await start();

    // Uppercase is refused by the canonical name rule, which exists so a name
    // is portable to every provider and safe as a path segment on every
    // platform. The rename must not half-happen.
    write('.ai/skills/scouts/SKILL.md', SKILL('Scout'));
    await started.refresh();

    assert.equal(exists('.ai/skills/scouts/SKILL.md'), true);
    assert.equal(exists('.ai/skills/Scout'), false);
    assert.ok(
      notifications?.shown.some((message) => message.includes('Invalid name')),
      `expected a refusal among ${String(notifications?.shown.join(' | '))}`,
    );
  });

  test('does nothing when the name field is not a string', async () => {
    const started = await start();

    // There is no rename to infer from `name: 42`. The mismatch stays reported
    // against the file, which is where the author fixes it.
    write(
      '.ai/skills/scouts/SKILL.md',
      ['---', 'name: 42', 'description: Scouts a change.', '---', '', 'Steps.', ''].join('\n'),
    );
    await started.refresh();

    assert.equal(exists('.ai/skills/scouts/SKILL.md'), true);
    assert.match(read('.ai/skills/scouts/SKILL.md'), /name: 42/);
  });

  test('refuses, and says so, when the new name is already taken', async () => {
    write('.ai/skills/scout/SKILL.md', SKILL('scout'));
    const started = await start();

    write('.ai/skills/scouts/SKILL.md', SKILL('scout'));
    await started.refresh();

    // Both names existed before the edit, so this is the ambiguous path; and
    // whichever way it is answered, the rename cannot complete.
    assert.equal(exists('.ai/skills/scouts/SKILL.md'), true);
    assert.equal(exists('.ai/skills/scout/SKILL.md'), true);
  });
});
