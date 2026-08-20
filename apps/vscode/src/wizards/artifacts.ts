import * as vscode from 'vscode';

import type {
  OverrideTarget,
  ProviderAdapter,
  ProviderId,
  ScaffoldOutcome,
  SourceKind,
} from '@aiconfig/core';
import {
  SKILL_SUBDIRECTORIES,
  createAgent,
  createCommand,
  createInstruction,
  createSkill,
} from '@aiconfig/core';

import type { OverrideWizardContext, PlannedOverride } from './overrides.js';
import { openCreated, planOverrides, writeOverrides } from './overrides.js';
import { askGlobs, askName, askYesNo, cancelled } from './prompts.js';
import {
  AGENT_BODY,
  AGENT_DESCRIPTION,
  COMMAND_BODY,
  COMMAND_DESCRIPTION,
  INSTRUCTION_BODY,
  INSTRUCTION_DESCRIPTION,
  SKILL_BODY,
  SKILL_DESCRIPTION,
} from './templates.js';

export interface ArtifactWizardContext extends OverrideWizardContext {
  readonly adapters: readonly ProviderAdapter[];
  readonly enabled: readonly ProviderId[];
}

/**
 * Writes what the flow decided, then opens it.
 *
 * Called only once every question has been answered: the canonical file and its
 * overrides are created together, so escaping any step leaves nothing behind.
 */
const scaffold = async (
  context: ArtifactWizardContext,
  target: OverrideTarget,
  planned: readonly PlannedOverride[],
  create: () => Promise<ScaffoldOutcome>,
): Promise<void> => {
  const outcome = await create();

  if (!outcome.ok) {
    void vscode.window.showWarningMessage(
      `AI Config: ${outcome.diagnostics[0]?.message ?? `the ${target.kind} could not be created.`}`,
    );
    return;
  }

  const overrides = await writeOverrides(context, target, planned);
  await context.refresh();

  const canonical = outcome.created[0];
  if (canonical !== undefined) {
    await openCreated(context.root, canonical, overrides);
  }
};

export const addInstruction = async (context: ArtifactWizardContext): Promise<void> => {
  const name = await askName('instruction');
  if (cancelled(name)) return;

  const scoped = await askYesNo(
    'New instruction',
    'Apply to specific repository paths?',
    'Leave unscoped to apply the instruction everywhere.',
  );
  if (cancelled(scoped)) return;

  let applyTo: readonly string[] = [];
  if (scoped) {
    const globs = await askGlobs();
    if (cancelled(globs)) return;
    applyTo = globs;
  }

  // The only kind whose overrides depend on an answer given in this flow:
  // Copilot can refine a path-scoped instruction and not an unscoped one.
  const target: OverrideTarget = { kind: 'instruction', name, applyTo };
  const planned = await planOverrides(context, target);
  if (cancelled(planned)) return;

  await scaffold(context, target, planned, () =>
    createInstruction(context.fileSystem, context.root, {
      name,
      description: INSTRUCTION_DESCRIPTION,
      body: INSTRUCTION_BODY,
      applyTo,
    }),
  );
};

export const addAgent = async (context: ArtifactWizardContext): Promise<void> => {
  const name = await askName('agent');
  if (cancelled(name)) return;

  const target: OverrideTarget = { kind: 'agent', name, applyTo: [] };
  const planned = await planOverrides(context, target);
  if (cancelled(planned)) return;

  await scaffold(context, target, planned, () =>
    createAgent(context.fileSystem, context.root, {
      name,
      description: AGENT_DESCRIPTION,
      body: AGENT_BODY,
    }),
  );
};

const DIRECTORY_HINTS: Readonly<Record<string, string>> = {
  references: 'Reference material the assistant loads on demand.',
  scripts: 'Executable scripts the skill can run.',
  assets: 'Templates and other files the skill uses.',
};

export const addSkill = async (context: ArtifactWizardContext): Promise<void> => {
  const name = await askName('skill');
  if (cancelled(name)) return;

  const chosen = await vscode.window.showQuickPick(
    SKILL_SUBDIRECTORIES.map((directory) => ({
      label: directory,
      detail: DIRECTORY_HINTS[directory] ?? '',
    })),
    {
      title: 'New skill',
      placeHolder: 'Supporting directories to create. Choose none if you do not need any.',
      canPickMany: true,
      ignoreFocusOut: true,
    },
  );
  if (chosen === undefined) return;

  const target: OverrideTarget = { kind: 'skill', name, applyTo: [] };
  const planned = await planOverrides(context, target);
  if (cancelled(planned)) return;

  await scaffold(context, target, planned, () =>
    createSkill(context.fileSystem, context.root, {
      name,
      description: SKILL_DESCRIPTION,
      body: SKILL_BODY,
      directories: chosen.map((item) => item.label),
    }),
  );
};

export const addCommand = async (context: ArtifactWizardContext): Promise<void> => {
  const name = await askName('command');
  if (cancelled(name)) return;

  const target: OverrideTarget = { kind: 'command', name, applyTo: [] };
  const planned = await planOverrides(context, target);
  if (cancelled(planned)) return;

  await scaffold(context, target, planned, () =>
    createCommand(context.fileSystem, context.root, {
      name,
      description: COMMAND_DESCRIPTION,
      body: COMMAND_BODY,
    }),
  );
};

/** The word the confirmation requires, and the label of its only action. */
export const REMOVE_CONFIRMATION = 'Delete';

/**
 * Asks whether an artifact should be deleted.
 *
 * Separated from the removal itself so the question can be put before the
 * operation queue is entered: a modal waiting on a person inside the queue
 * would stall a synchronization the watcher had already scheduled.
 *
 * The wording carries the part of the contract a reader has to understand
 * before answering, which is not just that the canonical file goes: its
 * provider overrides go with it, and the generated files follow. An override
 * left behind refines nothing and is reported on every run until it is removed,
 * so the three belong together — and this is the only place anyone is told so
 * before it happens.
 */
export const askToRemoveArtifact = async (kind: SourceKind, name: string): Promise<boolean> => {
  const answer = await vscode.window.showWarningMessage(
    `Delete the ${kind} '${name}'?`,
    {
      modal: true,
      detail:
        'Its canonical source and every provider override written for it are deleted. The files generated from it are removed by the synchronization that follows. This cannot be undone.',
    },
    REMOVE_CONFIRMATION,
  );

  // Anything other than the action itself — Cancel, Escape, the window closing —
  // leaves the artifact alone. Only the explicit answer removes anything.
  return answer === REMOVE_CONFIRMATION;
};
