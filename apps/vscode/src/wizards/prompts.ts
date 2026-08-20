import * as vscode from 'vscode';

import type { OverrideField, OverrideFieldType, ProviderOverrideSchema } from '@aiconfig/core';
import { NAME_PATTERN, checkName } from '@aiconfig/core';

/**
 * A cancelled step.
 *
 * Escaping abandons the whole flow, which must then leave nothing behind. Every
 * optional part of a flow is skipped by answering it, never by escaping it.
 */
export const CANCELLED = Symbol('cancelled');

export type Answer<T> = T | typeof CANCELLED;

export const cancelled = <T>(value: Answer<T>): value is typeof CANCELLED => value === CANCELLED;

/**
 * The one thing a guided flow has to ask for.
 *
 * A name decides the canonical path, so it cannot be filled in afterwards the
 * way a description or a prompt can.
 */
export const askName = async (kind: string): Promise<Answer<string>> => {
  const value = await vscode.window.showInputBox({
    title: `New ${kind}`,
    prompt: `Name for the ${kind}. This becomes the file name and the identifier every provider sees.`,
    placeHolder: NAME_PATTERN.source,
    ignoreFocusOut: true,
    validateInput: (input) => {
      const result = checkName(input.trim());
      return result.ok ? undefined : result.reason;
    },
  });
  return value === undefined ? CANCELLED : value.trim();
};

/** Collects zero or more globs; an empty entry ends the list. */
export const askGlobs = async (): Promise<Answer<readonly string[]>> => {
  const globs: string[] = [];
  for (;;) {
    const value = await vscode.window.showInputBox({
      title: 'Apply to specific paths',
      prompt:
        globs.length === 0
          ? 'Glob pattern, for example src/**/*.ts. Leave empty when you are done.'
          : `Added ${globs.join(', ')}. Add another, or leave empty when you are done.`,
      ignoreFocusOut: true,
      validateInput: (input) => {
        const trimmed = input.trim();
        if (trimmed.length === 0) {
          return undefined;
        }
        if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed) || trimmed.includes('\\')) {
          return 'Use a repository-relative POSIX glob, for example src/**/*.ts.';
        }
        return undefined;
      },
    });
    if (value === undefined) {
      return CANCELLED;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return globs;
    }
    globs.push(trimmed);
  }
};

export const askYesNo = async (
  title: string,
  question: string,
  detail?: string,
): Promise<Answer<boolean>> => {
  const yes: vscode.QuickPickItem = { label: 'Yes', ...(detail === undefined ? {} : { detail }) };
  const choice = await vscode.window.showQuickPick([yes, { label: 'No' }], {
    title,
    placeHolder: question,
    ignoreFocusOut: true,
  });
  return choice === undefined ? CANCELLED : choice.label === 'Yes';
};

/**
 * Asks which of a provider's settings to scaffold, never what they should be.
 *
 * The list comes from the adapter's declared schema and nothing else, so a
 * setting a provider does not support cannot be offered here, and a setting it
 * adds needs no change in the editor. Values are left to the file: a model ID,
 * a permission map or a hooks object is written far more easily in an editor
 * than through a sequence of input boxes.
 */
export const askFields = async (
  schema: ProviderOverrideSchema,
  providerName: string,
): Promise<Answer<readonly string[]>> => {
  const chosen = await vscode.window.showQuickPick(
    orderedFields(schema).map((field) => ({
      label: field.name,
      description: summarize(field),
      detail: field.description,
    })),
    {
      title: `Which ${providerName} settings do you want to configure?`,
      placeHolder:
        'Chosen settings are scaffolded with placeholders you fill in afterwards. Anything unchecked is left out.',
      canPickMany: true,
      ignoreFocusOut: true,
    },
  );

  return chosen === undefined ? CANCELLED : chosen.map((item) => item.label);
};

/**
 * Structured settings last.
 *
 * A mapping or a list — a hooks table, a set of MCP servers — is the largest
 * thing to fill in, so it does not lead the list. Which fields those are is
 * read from the declared type rather than from a hint an adapter has to
 * remember to set.
 */
const orderedFields = (schema: ProviderOverrideSchema): readonly OverrideField[] => {
  const structured = (field: OverrideField): boolean =>
    field.type.kind === 'map' ||
    field.type.kind === 'string-map' ||
    field.type.kind === 'list' ||
    field.type.kind === 'map-list';
  return [
    ...schema.fields.filter((field) => !structured(field)),
    ...schema.fields.filter(structured),
  ];
};

/** A short type and default hint, shown beside the field name. */
const summarize = (field: OverrideField): string => {
  const parts = [
    describeType(field.type),
    ...(field.defaultNote === undefined ? [] : [`default: ${field.defaultNote}`]),
  ];
  return parts.join(' · ');
};

const describeType = (type: OverrideFieldType): string => {
  switch (type.kind) {
    case 'string':
      return 'text';
    case 'enum':
      return type.values.join(' | ');
    case 'enum-or-map':
      return `${type.values.join(' | ')} | mapping`;
    case 'number':
      return 'number';
    case 'boolean':
      return 'true | false';
    case 'string-list':
      return 'list of text';
    case 'string-or-string-list':
      return 'text or list of text';
    case 'map':
      return 'mapping';
    case 'string-map':
      return 'text mapping';
    case 'list':
      return 'list';
    case 'map-list':
      return 'list of mappings';
  }
};
