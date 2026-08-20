import * as vscode from 'vscode';

import type { ProviderAdapter, ProviderId } from '@aiconfig/core';

/**
 * Asks which providers to enable.
 *
 * Everything is pre-selected: a canonical artifact is compiled to every enabled
 * provider, so the common case is all of them, and the question exists to let
 * someone opt out rather than to make them opt in four times.
 */
export const pickProviders = async (
  adapters: readonly ProviderAdapter[],
  preselected: readonly ProviderId[] = adapters.map((adapter) => adapter.id),
): Promise<readonly ProviderId[] | undefined> => {
  const items = adapters.map((adapter) => ({
    label: adapter.displayName,
    description: adapter.id,
    picked: preselected.includes(adapter.id),
  }));

  const chosen = await vscode.window.showQuickPick(items, {
    title: 'Initialize AI Config',
    placeHolder: 'Select assistants now, or leave empty to add them later.',
    canPickMany: true,
    ignoreFocusOut: true,
  });

  if (chosen === undefined) {
    return undefined;
  }

  const selected = new Set(chosen.map((item) => item.description));
  return adapters.map((adapter) => adapter.id).filter((id) => selected.has(id));
};
