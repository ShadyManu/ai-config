import * as path from 'node:path';

import type { FileSystem, ProviderAdapter } from '@aiconfig/core';
import { NodeFileSystem, findRepositoryRoot } from '@aiconfig/core';
import { createDefaultAdapters } from '@aiconfig/providers';

import { HELP_TEXT, parseCommandLine } from './args.js';
import type { CommandContext } from './commands.js';
import {
  EXIT_FAILED,
  EXIT_OK,
  runClean,
  runInit,
  runRestore,
  runRules,
  runStatus,
  runSync,
  runValidate,
} from './commands.js';
import { runAdd, runOverride, runProviders, runRemove, runRename } from './scaffold.js';
import { VERSION } from './version.js';
import type { OutputStreams } from './output.js';
import { consoleStreams } from './output.js';

export { VERSION } from './version.js';

export const EXIT_USAGE = 2;

export interface CliDependencies {
  readonly fileSystem?: FileSystem;
  readonly adapters?: readonly ProviderAdapter[];
  readonly streams?: OutputStreams;
  readonly cwd?: string;
}

/**
 * Runs the CLI and returns a process exit code.
 *
 * Dependencies are injected so end-to-end tests can drive the real command
 * implementations against a temporary directory without spawning a process.
 */
export const runCli = async (
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> => {
  const streams = dependencies.streams ?? consoleStreams;
  const parsed = parseCommandLine(argv);

  switch (parsed.kind) {
    case 'help':
      streams.out(HELP_TEXT);
      return EXIT_OK;

    case 'version':
      streams.out(VERSION);
      return EXIT_OK;

    case 'error':
      streams.err(parsed.message);
      streams.err('');
      streams.err(HELP_TEXT);
      return EXIT_USAGE;

    case 'command':
      break;
  }

  const options = parsed.value;
  const fileSystem = dependencies.fileSystem ?? new NodeFileSystem();
  const adapters = dependencies.adapters ?? createDefaultAdapters();
  const startDirectory = path.resolve(options.cwd ?? dependencies.cwd ?? process.cwd());

  // `init` creates directories, so a mistyped `--cwd` would otherwise
  // materialize a `.ai/` tree at an arbitrary path outside any repository.
  if (!(await fileSystem.exists(startDirectory))) {
    streams.err(`No such directory: ${startDirectory}`);
    return EXIT_USAGE;
  }

  // `init` creates `.ai/` here rather than searching for an existing one; every
  // other command operates on the repository it finds by walking up.
  const root =
    options.command === 'init'
      ? startDirectory
      : ((await findRepositoryRoot(fileSystem, startDirectory)) ?? startDirectory);

  const context: CommandContext = { fileSystem, root, adapters, streams, options };

  try {
    switch (options.command) {
      case 'init':
        return await runInit(context);
      case 'sync':
        return await runSync(context);
      case 'validate':
        return await runValidate(context);
      case 'status':
        return await runStatus(context);
      case 'rules':
        return runRules(context);
      case 'add':
        return await runAdd(context);
      case 'remove':
        return await runRemove(context);
      case 'rename':
        return await runRename(context);
      case 'override':
        return await runOverride(context);
      case 'providers':
        return await runProviders(context);
      case 'restore':
        return await runRestore(context);
      case 'clean':
        return await runClean(context);
    }
  } catch (error) {
    // Unexpected failures are bugs. Report them without a stack trace, which is
    // noise to a user running a CLI.
    streams.err(`aiconfig: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
};

export { HELP_TEXT } from './args.js';
export type { OutputStreams } from './output.js';
