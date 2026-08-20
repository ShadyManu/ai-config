import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';

import type { AnalysisResult, ProviderId } from '@aiconfig/core';
import { NodeFileSystem, analyze, hasErrors, init, removeArtifact } from '@aiconfig/core';
import { createDefaultAdapters } from '@aiconfig/providers';

import type { ArtifactWizardContext } from '../wizards/artifacts.js';
import {
  REMOVE_CONFIRMATION,
  addAgent,
  addCommand,
  addInstruction,
  addSkill,
  askToRemoveArtifact,
} from '../wizards/artifacts.js';
import { pickProviders } from '../wizards/initialize.js';
import { openOverrideFile, writeOverrides } from '../wizards/overrides.js';

const adapters = createDefaultAdapters();
const ENABLED: readonly ProviderId[] = ['claude', 'codex', 'copilot', 'opencode'];

interface Prompt {
  readonly kind: 'input' | 'pick';
  readonly title: string;
  /** The input box prompt, or the quick pick placeholder. */
  readonly text: string;
  readonly items: readonly string[];
  readonly many: boolean;
}

/** What a scripted quick pick answers: labels, one label, or a dismissal. */
type PickReply = readonly string[] | string | undefined;

interface Scripted {
  readonly seen: readonly Prompt[];
  readonly messages: readonly string[];
  inputs: () => readonly Prompt[];
  picks: () => readonly Prompt[];
  restore: () => void;
}

/**
 * Replaces the prompt API with a script, and records everything it was asked.
 *
 * Recording is the point: what these flows must *not* ask is as much of the
 * contract as what they must. An unscripted prompt fails the test rather than
 * hanging, so a flow that starts asking for a description again is caught.
 */
const script = (inputs: readonly (string | undefined)[], picks: readonly PickReply[]): Scripted => {
  const seen: Prompt[] = [];
  const messages: string[] = [];
  const remainingInputs = [...inputs];
  const remainingPicks = [...picks];

  const window = vscode.window as unknown as Record<string, unknown>;
  const original = {
    showInputBox: window['showInputBox'],
    showQuickPick: window['showQuickPick'],
    showInformationMessage: window['showInformationMessage'],
    showWarningMessage: window['showWarningMessage'],
  };

  window['showInputBox'] = (options: vscode.InputBoxOptions = {}): Thenable<string | undefined> => {
    const title = options.title ?? '';
    const text = options.prompt ?? '';
    seen.push({ kind: 'input', title, text, items: [], many: false });
    assert.ok(remainingInputs.length > 0, `unscripted input box: ${title} — ${text}`);
    return Promise.resolve(remainingInputs.shift());
  };

  window['showQuickPick'] = (
    items: readonly vscode.QuickPickItem[],
    options: vscode.QuickPickOptions = {},
  ): Thenable<vscode.QuickPickItem | vscode.QuickPickItem[] | undefined> => {
    const many = options.canPickMany === true;
    const title = options.title ?? '';
    seen.push({
      kind: 'pick',
      title,
      text: options.placeHolder ?? '',
      items: items.map((item) => item.label),
      many,
    });
    assert.ok(remainingPicks.length > 0, `unscripted quick pick: ${title}`);

    const reply = remainingPicks.shift();
    if (reply === undefined) {
      return Promise.resolve(undefined);
    }
    const wanted = typeof reply === 'string' ? [reply] : reply;
    for (const label of wanted) {
      assert.ok(
        items.some((item) => item.label === label),
        `'${label}' was not offered in ${title}`,
      );
    }
    const chosen = items.filter((item) => wanted.includes(item.label));
    return Promise.resolve(many ? chosen : chosen[0]);
  };

  const record = (message: string): Thenable<string | undefined> => {
    messages.push(message);
    return Promise.resolve(undefined);
  };
  window['showInformationMessage'] = record;
  window['showWarningMessage'] = record;

  return {
    seen,
    messages,
    inputs: () => seen.filter((prompt) => prompt.kind === 'input'),
    picks: () => seen.filter((prompt) => prompt.kind === 'pick'),
    restore: () => {
      Object.assign(window, original);
    },
  };
};

let root = '';
let refreshes = 0;
let scripted: Scripted | undefined;

const context = (): ArtifactWizardContext => ({
  root,
  fileSystem: new NodeFileSystem(),
  adapters,
  enabled: ENABLED,
  refresh: () => {
    refreshes += 1;
    return Promise.resolve();
  },
});

const read = (relativePath: string): string =>
  fs.readFileSync(nodePath.join(root, ...relativePath.split('/')), 'utf8');

const exists = (relativePath: string): boolean =>
  fs.existsSync(nodePath.join(root, ...relativePath.split('/')));

/** Repository-relative paths of the documents this test opened. */
const openedFiles = (): readonly string[] => {
  const prefix = `${root}${nodePath.sep}`;
  return vscode.workspace.textDocuments
    .filter((document) => document.uri.fsPath.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((document) => document.uri.fsPath.slice(prefix.length).split(nodePath.sep).join('/'));
};

const activeFile = (): string | undefined => {
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!active?.toLowerCase().startsWith(root.toLowerCase())) {
    return undefined;
  }
  return active
    .slice(root.length + 1)
    .split(nodePath.sep)
    .join('/');
};

const analysisOf = async (): Promise<AnalysisResult> => {
  const outcome = await analyze(new NodeFileSystem(), root, adapters);
  assert.ok(outcome.ok, 'the scaffolded project should be readable');
  return outcome.analysis;
};

suite('initialize wizard', () => {
  teardown(() => {
    scripted?.restore();
    scripted = undefined;
  });

  test('allows initializing without providers so they can be added later', async () => {
    scripted = script([], [[]]);

    const providers = await pickProviders(adapters);

    assert.deepEqual(providers, []);
    assert.deepEqual(scripted.messages, []);
  });
});

suite('guided add flows', () => {
  setup(async () => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'aiconfig-wizard-'));
    refreshes = 0;
    const outcome = await init(new NodeFileSystem(), root, {
      providers: [...ENABLED],
      adapters,
      version: 'test',
    });
    assert.ok(outcome.ok);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  teardown(async () => {
    scripted?.restore();
    scripted = undefined;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try {
      // Windows can still hold a handle on a just-closed document. The
      // directory is a temporary one, so failing to remove it is not a test
      // failure.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Left to the operating system.
    }
  });

  test('Add Agent asks for a name, and never for a description or a body', async () => {
    scripted = script(['coder'], ['No']);

    await addAgent(context());

    assert.deepEqual(
      scripted.inputs().map((prompt) => prompt.title),
      ['New agent'],
      'the name is the only thing typed into an input box',
    );
    assert.match(scripted.inputs()[0]?.text ?? '', /Name for the agent/);
    assert.equal(
      read('.ai/agents/coder.md'),
      '---\ndescription: "TODO: Describe when this agent should be used."\n---\n\nTODO: Add agent instructions.\n',
    );
  });

  test('Add Skill asks for a name and its supporting directories, and nothing else', async () => {
    scripted = script(['review'], [['references', 'scripts'], 'No']);

    await addSkill(context());

    assert.deepEqual(
      scripted.inputs().map((prompt) => prompt.title),
      ['New skill'],
    );
    assert.deepEqual(scripted.picks()[0]?.title, 'New skill');
    assert.equal(
      read('.ai/skills/review/SKILL.md'),
      '---\nname: review\ndescription: "TODO: Describe when this skill should be used."\n---\n\nTODO: Add skill instructions.\n',
    );
    assert.ok(exists('.ai/skills/review/references'));
    assert.ok(exists('.ai/skills/review/scripts'));
    assert.ok(!exists('.ai/skills/review/assets'));
  });

  test('Add Command asks for a name, and never for the prompt', async () => {
    scripted = script(['ship'], ['No']);

    await addCommand(context());

    assert.deepEqual(
      scripted.inputs().map((prompt) => prompt.title),
      ['New command'],
    );
    assert.equal(
      read('.ai/commands/ship.md'),
      '---\ndescription: "TODO: Describe what this command does."\n---\n\nTODO: Add command prompt.\n',
    );
  });

  test('Add Instruction asks about scope but never for the instruction itself', async () => {
    scripted = script(['backend', 'backend/**', ''], ['Yes', 'No']);

    await addInstruction(context());

    // Name, then the globs: short structured answers, and nothing else.
    assert.deepEqual(
      scripted.inputs().map((prompt) => prompt.title),
      ['New instruction', 'Apply to specific paths', 'Apply to specific paths'],
    );
    for (const prompt of scripted.inputs()) {
      assert.doesNotMatch(prompt.text, /description|body|content/i);
    }
    assert.equal(
      read('.ai/instructions/backend.md'),
      [
        '---',
        'description: "TODO: Describe what this instruction covers."',
        'applyTo:',
        '  - "backend/**"',
        '---',
        '',
        'TODO: Add instruction content.',
        '',
      ].join('\n'),
    );
  });

  test('an unscoped instruction omits applyTo, and is asked nothing about providers', async () => {
    scripted = script(['style'], ['No']);

    await addInstruction(context());

    // Copilot is the only provider with instruction settings and it refuses an
    // unscoped instruction, so the customization question is skipped entirely.
    assert.deepEqual(
      scripted.picks().map((prompt) => prompt.title),
      ['New instruction'],
    );
    assert.equal(
      read('.ai/instructions/style.md'),
      '---\ndescription: "TODO: Describe what this instruction covers."\n---\n\nTODO: Add instruction content.\n',
    );
  });

  test('provider customization chooses settings, never their values', async () => {
    scripted = script(
      ['coder'],
      ['Yes', ['Claude Code', 'OpenCode'], ['model', 'maxTurns'], ['model', 'temperature']],
    );

    await addAgent(context());

    assert.equal(scripted.inputs().length, 1, 'no value is ever typed into an input box');

    const fieldPicks = scripted
      .picks()
      .filter((prompt) => prompt.title.startsWith('Which '))
      .map((prompt) => prompt.title);
    assert.deepEqual(fieldPicks, [
      'Which Claude Code settings do you want to configure?',
      'Which OpenCode settings do you want to configure?',
    ]);

    const claude = read('.ai/providers/claude/agents/coder.yaml');
    assert.match(claude, /^ {2}# model: TODO$/m);
    assert.match(claude, /^ {2}# maxTurns: TODO$/m);
    assert.ok(!claude.includes('permissionMode:'), 'an unchosen setting is left out');

    const opencode = read('.ai/providers/opencode/agents/coder.yaml');
    assert.match(opencode, /^ {2}# model: TODO$/m);
    assert.match(opencode, /^ {2}# temperature: TODO$/m);
    assert.ok(!opencode.includes('steps:'));
  });

  test('offers only the providers and fields the adapters declare', async () => {
    scripted = script(['review'], [[], 'Yes', ['Claude Code'], ['when_to_use']]);

    await addSkill(context());

    const providerPick = scripted.picks().find((prompt) => prompt.title.includes('for these'));
    // Only these providers declare skill settings.
    assert.deepEqual(providerPick?.items, ['Claude Code', 'Codex', 'GitHub Copilot']);

    const declared = adapters
      .find((adapter) => adapter.id === 'claude')
      ?.overrides?.find((schema) => schema.kind === 'skill')
      ?.fields.map((field) => field.name);
    const offered = scripted.picks().find((prompt) => prompt.title.startsWith('Which '))?.items;
    assert.ok(declared !== undefined && offered !== undefined);
    assert.deepEqual([...offered].sort(), [...declared].sort());
    // A canonical field is never a provider setting.
    assert.ok(!offered.includes('description'));
  });

  test('scaffolds valid sources: nothing it creates makes the project invalid', async () => {
    scripted = script(['coder'], ['Yes', ['Claude Code'], ['model', 'hooks']]);
    await addAgent(context());
    scripted.restore();

    scripted = script(['ship'], ['No']);
    await addCommand(context());
    scripted.restore();

    scripted = script(['review'], [[], 'No']);
    await addSkill(context());
    scripted.restore();

    scripted = script(['backend', 'src/**', ''], ['Yes', 'No']);
    await addInstruction(context());

    const analysis = await analysisOf();
    assert.equal(
      hasErrors(analysis.diagnostics),
      false,
      analysis.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`)
        .join('\n'),
    );

    // The override is inert until a placeholder is replaced, and says so
    // without blocking anything.
    const empty = analysis.diagnostics.filter((diagnostic) => diagnostic.code === 'OVERRIDE_EMPTY');
    assert.equal(empty.length, 1);
    assert.equal(empty[0]?.severity, 'info');
    assert.equal(analysis.project.configuration.agents.length, 1);
    assert.equal(analysis.project.configuration.skills.length, 1);
  });

  test('opens the canonical source and every override it created, and nothing generated', async () => {
    scripted = script(['coder'], ['Yes', ['Claude Code', 'OpenCode'], ['model'], ['model']]);

    await addAgent(context());

    const opened = openedFiles();
    assert.ok(opened.includes('.ai/agents/coder.md'));
    assert.ok(opened.includes('.ai/providers/claude/agents/coder.yaml'));
    assert.ok(opened.includes('.ai/providers/opencode/agents/coder.yaml'));
    for (const file of opened) {
      assert.ok(file.startsWith('.ai/'), `${file} is generated output and must not be opened`);
    }
    assert.equal(activeFile(), '.ai/agents/coder.md', 'the canonical file stays in front');
    assert.ok(refreshes > 0, 'the tree is refreshed after the files are created');
  });

  test('Edit Override opens the existing YAML directly, asking nothing', async () => {
    const override = '.ai/providers/claude/agents/coder.yaml';
    fs.mkdirSync(nodePath.join(root, '.ai', 'providers', 'claude', 'agents'), { recursive: true });
    fs.writeFileSync(
      nodePath.join(root, ...override.split('/')),
      'schema: 1\noptions:\n  model: opus\n',
    );
    scripted = script([], []);

    await openOverrideFile(root, 'claude', 'agent', 'coder');

    assert.deepEqual(scripted.seen, []);
    assert.equal(activeFile(), override);
  });

  test('cancelling before the end creates nothing at all', async () => {
    // Dismissing the field selection abandons the flow, so not even the
    // canonical file — already decided by then — is written.
    scripted = script(['coder'], ['Yes', ['Claude Code'], undefined]);

    await addAgent(context());

    assert.ok(!exists('.ai/agents/coder.md'));
    assert.ok(!exists('.ai/providers/claude/agents/coder.yaml'));

    scripted.restore();
    scripted = script([undefined], []);
    await addCommand(context());
    assert.ok(!exists('.ai/commands/coder.md'));
  });

  test('never replaces a canonical file that already exists', async () => {
    fs.mkdirSync(nodePath.join(root, '.ai', 'agents'), { recursive: true });
    fs.writeFileSync(nodePath.join(root, '.ai', 'agents', 'coder.md'), 'mine');
    scripted = script(['coder'], ['No']);

    await addAgent(context());

    assert.equal(read('.ai/agents/coder.md'), 'mine');
    assert.ok(scripted.messages.some((message) => message.includes('already exists')));
  });

  test('never replaces an override that already exists', async () => {
    const override = '.ai/providers/claude/agents/coder.yaml';
    fs.mkdirSync(nodePath.join(root, '.ai', 'providers', 'claude', 'agents'), { recursive: true });
    fs.writeFileSync(nodePath.join(root, ...override.split('/')), 'mine');
    scripted = script([], []);

    const adapter = adapters.find((entry) => entry.id === 'claude');
    const schema = adapter?.overrides?.find((entry) => entry.kind === 'agent');
    assert.ok(adapter !== undefined && schema !== undefined);

    const created = await writeOverrides(context(), { kind: 'agent', name: 'coder', applyTo: [] }, [
      { candidate: { adapter, schema }, fields: ['model'] },
    ]);

    assert.deepEqual(created, []);
    assert.equal(read(override), 'mine');
    assert.ok(scripted.messages.some((message) => message.includes('already exists')));
  });
});

/** Answers the confirmation modal, and records exactly how it was put. */
interface Asked {
  readonly calls: readonly { message: string; modal: boolean; detail: string; actions: string[] }[];
  restore: () => void;
}

const answerConfirmation = (answer: string | undefined): Asked => {
  const calls: { message: string; modal: boolean; detail: string; actions: string[] }[] = [];
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = window['showWarningMessage'];

  window['showWarningMessage'] = (
    message: string,
    options: vscode.MessageOptions = {},
    ...actions: string[]
  ): Thenable<string | undefined> => {
    calls.push({
      message,
      modal: options.modal === true,
      detail: options.detail ?? '',
      actions,
    });
    return Promise.resolve(answer);
  };

  return {
    calls,
    restore: () => {
      window['showWarningMessage'] = original;
    },
  };
};

/**
 * Deleting an artifact is the one irreversible thing the view can do, and the
 * only guard on it is a question. These tests hold that guard: what it says
 * before anything is removed, and that every answer except the explicit one
 * removes nothing at all.
 */
suite('artifact removal confirmation', () => {
  let asked: Asked | undefined;

  setup(async () => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'aiconfig-remove-'));
    const outcome = await init(new NodeFileSystem(), root, {
      providers: [...ENABLED],
      adapters,
      version: 'test',
    });
    assert.ok(outcome.ok);
    fs.writeFileSync(
      nodePath.join(root, '.ai', 'agents', 'coder.md'),
      '---\ndescription: Writes code\n---\n\nYou write code.\n',
      'utf8',
    );
    fs.mkdirSync(nodePath.join(root, '.ai', 'providers', 'claude', 'agents'), { recursive: true });
    fs.writeFileSync(
      nodePath.join(root, '.ai', 'providers', 'claude', 'agents', 'coder.yaml'),
      'schema: 1\noptions:\n  model: sonnet\n',
      'utf8',
    );
  });

  teardown(() => {
    asked?.restore();
    asked = undefined;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Left to the operating system.
    }
  });

  test('states what goes with the artifact, in a modal', async () => {
    asked = answerConfirmation(REMOVE_CONFIRMATION);

    assert.equal(await askToRemoveArtifact('agent', 'coder'), true);

    const [call] = asked.calls;
    assert.ok(call, 'the artifact must not be deleted without asking');
    assert.ok(call.modal, 'a deletion that cannot be undone is not a dismissible notification');
    assert.match(call.message, /agent/);
    assert.match(call.message, /coder/);
    // The three things a reader has to know before answering.
    assert.match(call.detail, /override/i);
    assert.match(call.detail, /generated/i);
    assert.match(call.detail, /cannot be undone/i);
    assert.deepEqual(call.actions, [REMOVE_CONFIRMATION]);
  });

  for (const [label, answer] of [
    ['dismissed', undefined],
    ['answered with something else', 'Cancel'],
  ] as const) {
    test(`removes nothing when the question is ${label}`, async () => {
      asked = answerConfirmation(answer);

      assert.equal(await askToRemoveArtifact('agent', 'coder'), false);
      assert.equal(asked.calls.length, 1);
    });
  }

  test('removes the artifact and its override once confirmed', async () => {
    // The confirmation and the removal are separate on purpose — the question
    // is put before the operation queue is entered — so this covers the pair
    // the command actually runs.
    asked = answerConfirmation(REMOVE_CONFIRMATION);

    const confirmed = await askToRemoveArtifact('agent', 'coder');
    assert.equal(confirmed, true);

    const outcome = await removeArtifact(new NodeFileSystem(), root, 'agent', 'coder');

    assert.ok(outcome.ok);
    assert.deepEqual(outcome.ok && [...outcome.removed], [
      '.ai/agents/coder.md',
      '.ai/providers/claude/agents/coder.yaml',
    ]);
    assert.equal(exists('.ai/agents/coder.md'), false);
    assert.equal(exists('.ai/providers'), false, 'an emptied provider tree is pruned');
    // What must survive: the rest of the canonical directory.
    assert.equal(exists('.ai/agents'), true);
    assert.equal(exists('.ai/config.yaml'), true);
  });

  test('leaves everything in place when the answer was no', async () => {
    asked = answerConfirmation(undefined);

    if (await askToRemoveArtifact('agent', 'coder')) {
      await removeArtifact(new NodeFileSystem(), root, 'agent', 'coder');
    }

    assert.equal(exists('.ai/agents/coder.md'), true);
    assert.equal(exists('.ai/providers/claude/agents/coder.yaml'), true);
  });
});
