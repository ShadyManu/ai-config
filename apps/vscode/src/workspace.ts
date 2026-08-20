import * as path from 'node:path';
import * as vscode from 'vscode';

import type { FileSystem } from '@aiconfig/core';
import { isInitialized } from '@aiconfig/core';

interface FolderItem extends vscode.QuickPickItem {
  readonly folder: string;
}

const toItems = (folders: readonly string[]): FolderItem[] =>
  folders.map((folder) => ({
    label:
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(folder))?.name ?? path.basename(folder),
    description: folder,
    folder,
  }));

/**
 * Which folder AI Config should operate on, or that the answer needs a person.
 *
 * `ambiguous` is a first-class outcome rather than an immediate prompt because
 * the decision is re-taken on every refresh, including the ones a `.ai/` file
 * event triggers. A QuickPick raised from a background event would interrupt
 * work the user never connected to AI Config.
 */
export type RootResolution =
  | { readonly kind: 'selected'; readonly root: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] };

/**
 * The decision itself, free of VS Code and the filesystem so it can be tested
 * directly.
 *
 * `remembered` is the folder currently in use. It wins whenever it is still
 * initialized, so adding an unrelated folder to the workspace never moves AI
 * Config; and when it has *stopped* being initialized — its `.ai/` was deleted
 * — the rules below decide where that leaves things:
 *
 * - nothing else is initialized: stay, so the folder the user is working in
 *   keeps its watcher and stays the target of Initialize. It simply reports as
 *   not initialized.
 * - exactly one other folder is initialized: move there; there is no choice to
 *   put to the user.
 * - several others are initialized: no basis to guess, so `ambiguous`.
 *
 * `folders` and `initialized` are absolute paths; `initialized` is a subset.
 */
export const decideRoot = (
  folders: readonly string[],
  initialized: readonly string[],
  remembered: string | undefined,
): RootResolution => {
  if (folders.length === 0) {
    return { kind: 'none' };
  }

  if (remembered !== undefined && initialized.includes(remembered)) {
    return { kind: 'selected', root: remembered };
  }

  const [onlyInitialized] = initialized;
  if (initialized.length === 1 && onlyInitialized !== undefined) {
    return { kind: 'selected', root: onlyInitialized };
  }

  if (initialized.length > 1) {
    return { kind: 'ambiguous', candidates: initialized };
  }

  if (remembered !== undefined && folders.includes(remembered)) {
    return { kind: 'selected', root: remembered };
  }

  const [onlyFolder] = folders;
  return folders.length === 1 && onlyFolder !== undefined
    ? { kind: 'selected', root: onlyFolder }
    : { kind: 'none' };
};

const initializedFolders = async (fileSystem: FileSystem, folders: readonly string[]) => {
  const flags = await Promise.all(folders.map((folder) => isInitialized(fileSystem, folder)));
  return folders.filter((_, index) => flags[index] === true);
};

const localFolders = (): string[] =>
  (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath);

/**
 * Resolves the workspace root without ever showing UI.
 *
 * Core is deliberately single-root — "workspace folder" is an editor concept —
 * so the choice is made here.
 */
export const resolveRootSilently = async (
  fileSystem: FileSystem,
  remembered: string | undefined,
): Promise<RootResolution> => {
  const folders = localFolders();
  return decideRoot(folders, await initializedFolders(fileSystem, folders), remembered);
};

/**
 * Asks which initialized folder to use, when a deferred choice is finally being
 * resolved by an explicit AI Config command.
 *
 * Returns `undefined` if the choice is still open — either because nothing can
 * be offered or because the user dismissed the pick, in which case the caller
 * leaves it deferred and asks again on the next command.
 */
export const promptForWorkspaceRoot = async (
  fileSystem: FileSystem,
): Promise<string | undefined> => {
  const resolution = await resolveRootSilently(fileSystem, undefined);

  switch (resolution.kind) {
    case 'selected':
      return resolution.root;
    case 'none':
      return undefined;
    case 'ambiguous': {
      const picked = await vscode.window.showQuickPick(toItems(resolution.candidates), {
        title: 'AI Config: choose a workspace folder',
        ignoreFocusOut: true,
      });
      return picked?.folder;
    }
  }
};

/** The folder to initialize when the user runs the init command. */
export const pickFolderToInitialize = async (): Promise<string | undefined> => {
  const folders = localFolders();

  if (folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }

  const picked = await vscode.window.showQuickPick(toItems(folders), {
    title: 'AI Config: choose a folder to initialize',
    ignoreFocusOut: true,
  });

  return picked?.folder;
};
