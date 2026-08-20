import * as path from 'node:path';

import type { FileSystem, ProviderId } from '@aiconfig/core';
import { AI_DIRECTORY, CONFIG_PATH } from '@aiconfig/core';

/** Guards against a pathological tree, as core does when it removes one. */
const MAX_DEPTH = 16;

/** Where a provider's own sources live, relative to the repository root. */
export const providerSourceDirectory = (provider: ProviderId): string =>
  `${AI_DIRECTORY}/providers/${provider}`;

/**
 * How many files the user has written under `.ai/providers/<provider>/`, or
 * `undefined` when the directory is not there at all.
 *
 * Counted from disk rather than from the parsed overlay, because the count is
 * shown to justify a deletion: an asset an extension refers to, or a note left
 * beside an override, is removed with the directory and has to be counted with
 * it. Enabling a provider creates nothing, so the absent case is the ordinary
 * one — a provider that was never customized.
 */
export const countProviderSources = async (
  fileSystem: FileSystem,
  root: string,
  provider: ProviderId,
): Promise<number | undefined> => {
  const directory = path.join(root, AI_DIRECTORY, 'providers', provider);
  if (!(await fileSystem.exists(directory))) {
    return undefined;
  }
  return countFiles(fileSystem, directory, 0);
};

const countFiles = async (
  fileSystem: FileSystem,
  directory: string,
  depth: number,
): Promise<number> => {
  if (depth > MAX_DEPTH) {
    return 0;
  }

  let total = 0;
  for (const entry of await fileSystem.readDirectory(directory)) {
    total +=
      entry.kind === 'directory'
        ? await countFiles(fileSystem, path.join(directory, entry.name), depth + 1)
        : 1;
  }
  return total;
};

/**
 * What removing a provider will delete, said before anything is deleted.
 *
 * Separate from the modal so the wording is testable, and stated in terms of
 * what survives as much as what goes: everything except the provider's own
 * settings comes back by enabling it again, and that is the difference between
 * this and the two project-wide removals.
 */
export const providerRemovalDetail = (
  displayName: string,
  provider: ProviderId,
  sources: number | undefined,
): string => {
  const directory = `${providerSourceDirectory(provider)}/`;
  const authored =
    sources === undefined
      ? ''
      : sources === 0
        ? ` Its empty ${directory} directory is removed as well.`
        : ` The ${String(sources)} file${sources === 1 ? '' : 's'} you wrote in ${directory} ${sources === 1 ? 'goes' : 'go'} to the system trash.`;

  return (
    `Disables ${displayName} in ${CONFIG_PATH} and deletes every file AI Config generated for it; a file another enabled provider also produces is kept.${authored}` +
    ` Your instructions, agents, skills and commands are not touched — enable ${displayName} again to regenerate its files.`
  );
};
