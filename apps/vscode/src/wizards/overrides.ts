import * as path from 'node:path';
import * as vscode from 'vscode';

import type {
  AiConfiguration,
  FileSystem,
  OverrideTarget,
  ProviderAdapter,
  ProviderId,
  ProviderOverrideSchema,
  SourceKind,
} from '@aiconfig/core';
import { createOverrideTemplate, overridePath, overrideTargets } from '@aiconfig/core';

import type { Answer } from './prompts.js';
import { CANCELLED, askFields, askYesNo, cancelled } from './prompts.js';

/** A provider that can actually carry an override for one specific artifact. */
export interface OverrideCandidate {
  readonly adapter: ProviderAdapter;
  readonly schema: ProviderOverrideSchema;
}

/**
 * The providers that have real options for this artifact.
 *
 * A provider appears only when it is enabled for the project, declares a schema
 * for the kind, *and* that schema accepts this particular artifact. Anything
 * else would offer the user a configuration step that produces an empty or
 * rejected file, or settings for a provider this project never generates.
 */
export const candidatesFor = (
  adapters: readonly ProviderAdapter[],
  enabled: readonly ProviderId[],
  target: OverrideTarget,
): readonly OverrideCandidate[] => {
  const candidates: OverrideCandidate[] = [];
  for (const adapter of adapters) {
    if (!enabled.includes(adapter.id)) {
      continue;
    }
    const schema = adapter.overrides?.find((candidate) => candidate.kind === target.kind);
    if (schema === undefined || schema.unavailableReason?.(target) !== undefined) {
      continue;
    }
    candidates.push({ adapter, schema });
  }
  return candidates;
};

export const targetFor = (
  configuration: AiConfiguration,
  kind: SourceKind,
  name: string,
): OverrideTarget | undefined =>
  overrideTargets(configuration).find(
    (candidate) => candidate.kind === kind && candidate.name === name,
  );

export const CUSTOMIZE_DETAIL =
  'The shared file will be used for all enabled providers. You can optionally add extra settings for specific providers.';

export interface OverrideWizardContext {
  readonly root: string;
  readonly fileSystem: FileSystem;
  readonly adapters: readonly ProviderAdapter[];
  readonly enabled: readonly ProviderId[];
  refresh: () => Promise<void>;
}

/** One provider's chosen settings, decided before anything has been written. */
export interface PlannedOverride {
  readonly candidate: OverrideCandidate;
  readonly fields: readonly string[];
}

/**
 * Asks which providers to add settings for, and which settings.
 *
 * Nothing is written here. An Add flow settles every question first so that
 * escaping any step leaves the repository exactly as it was, and returns
 * `CANCELLED` to say so; an empty plan means the user declined, which is not
 * the same thing.
 *
 * Returns without asking anything when no enabled provider has options for this
 * kind of artifact — an empty question is worse than no question.
 */
export const planOverrides = async (
  context: OverrideWizardContext,
  target: OverrideTarget,
): Promise<Answer<readonly PlannedOverride[]>> => {
  const candidates = candidatesFor(context.adapters, context.enabled, target);
  if (candidates.length === 0) {
    return [];
  }

  const wanted = await askYesNo(
    `Customize '${target.name}'`,
    'Add provider-specific settings?',
    CUSTOMIZE_DETAIL,
  );
  if (cancelled(wanted)) {
    return CANCELLED;
  }
  if (!wanted) {
    return [];
  }

  const chosen = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: candidate.adapter.displayName,
      description: candidate.adapter.id,
      detail: `${String(candidate.schema.fields.length)} ${candidate.adapter.displayName}-specific setting${candidate.schema.fields.length === 1 ? '' : 's'}`,
    })),
    {
      title: `Customize this ${target.kind} for these providers`,
      placeHolder: CUSTOMIZE_DETAIL,
      canPickMany: true,
      ignoreFocusOut: true,
    },
  );
  if (chosen === undefined) {
    return CANCELLED;
  }

  const planned: PlannedOverride[] = [];
  for (const item of chosen) {
    const candidate = candidates.find((entry) => entry.adapter.id === item.description);
    if (candidate === undefined) {
      continue;
    }
    const fields = await askFields(candidate.schema, candidate.adapter.displayName);
    if (cancelled(fields)) {
      return CANCELLED;
    }
    if (fields.length === 0) {
      void vscode.window.showInformationMessage(
        `AI Config: no ${candidate.adapter.displayName} settings were chosen, so no ${candidate.adapter.displayName} override was created for '${target.name}'.`,
      );
      continue;
    }
    planned.push({ candidate, fields });
  }

  return planned;
};

/** Writes the planned override templates and returns the files created. */
export const writeOverrides = async (
  context: OverrideWizardContext,
  target: OverrideTarget,
  planned: readonly PlannedOverride[],
): Promise<readonly string[]> => {
  const created: string[] = [];

  for (const entry of planned) {
    const outcome = await createOverrideTemplate(
      context.fileSystem,
      context.root,
      {
        provider: entry.candidate.adapter.id,
        kind: target.kind,
        id: target.name,
        fields: entry.fields,
      },
      entry.candidate.schema,
      target,
    );

    if (outcome.ok) {
      created.push(...outcome.created);
    } else {
      void vscode.window.showWarningMessage(
        `AI Config: ${outcome.diagnostics[0]?.message ?? `the ${entry.candidate.adapter.displayName} override could not be created.`}`,
      );
    }
  }

  return created;
};

/**
 * Opens everything one Add flow created, leaving the canonical file active.
 *
 * Only `.ai/` sources are opened. A generated provider file is not something to
 * edit, and offering it here would invite exactly that.
 */
export const openCreated = async (
  root: string,
  canonical: string,
  overrides: readonly string[],
): Promise<void> => {
  await openFile(root, canonical);
  for (const override of overrides) {
    await openFile(root, override, { preserveFocus: true });
  }
  if (overrides.length > 0) {
    // Showing it again is what makes the canonical file the active editor: an
    // override opened after it would otherwise be the one in front.
    await openFile(root, canonical);
  }
};

/**
 * Opens one override file, asking nothing.
 *
 * An override that already exists is edited in the file itself, where every
 * supported setting is listed and documented, so opening it is the whole
 * action.
 */
export const openOverrideFile = async (
  root: string,
  provider: ProviderId,
  kind: SourceKind,
  name: string,
): Promise<void> => {
  await openFile(root, overridePath(provider, kind, name));
};

export const openFile = async (
  root: string,
  relativePath: string,
  options: { readonly preserveFocus?: boolean } = {},
): Promise<void> => {
  const uri = vscode.Uri.file(path.join(root, ...relativePath.split('/')));
  await vscode.window.showTextDocument(uri, {
    // A scaffolded file is meant to be filled in, so it never opens in a
    // preview tab that the next click would replace.
    preview: false,
    preserveFocus: options.preserveFocus ?? false,
  });
};
