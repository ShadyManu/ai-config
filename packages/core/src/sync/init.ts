import type { ProviderAdapter } from '../adapter/adapter.js';
import { GENERATION_RULES_PATH, renderGenerationRules } from '../docs/generation-rules.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import type { ProviderId } from '../domain/provider.js';
import type { FileSystem } from '../fs/file-system.js';
import { AI_DIRECTORY } from '../parse/discover.js';
import { CONFIG_PATH, SUPPORTED_SCHEMA_VERSION } from '../parse/config.js';
import { resolveWithinRoot } from '../path/safe-path.js';

export interface InitOptions {
  readonly providers: readonly ProviderId[];
  /**
   * Adapters the generated reference is derived from.
   *
   * Required rather than optional: the reference is written by compiling a
   * probe with these, and an optional argument would let a caller drop the file
   * without noticing.
   */
  readonly adapters: readonly ProviderAdapter[];
  /** Recorded in the reference, so a stale one says which build wrote it. */
  readonly version: string;
}

export type InitOutcome =
  | { readonly ok: true; readonly created: readonly string[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Creates a starter `.ai/` directory.
 *
 * Refuses outright if `.ai/` already exists. Merging into an existing canonical
 * directory would mean deciding which of the user's files to replace, and that
 * decision is not AI Config's to make.
 *
 * The starter files are created exclusively, so that refusal also covers a path
 * that appears between the check and the write — a second `init` racing this
 * one, or an editor restoring a file. Checking once and writing later would
 * replace exactly the file this promises never to touch.
 */
export const init = async (
  fileSystem: FileSystem,
  root: string,
  options: InitOptions,
): Promise<InitOutcome> => {
  const aiPath = resolveWithinRoot(root, AI_DIRECTORY);

  if (await fileSystem.exists(aiPath)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'ALREADY_INITIALIZED',
          severity: 'error',
          message: `'${AI_DIRECTORY}/' already exists. Remove it first if you want to start over.`,
          source: AI_DIRECTORY,
        },
      ],
    };
  }

  const files = [
    ...starterFiles(options.providers, options.adapters),
    {
      path: GENERATION_RULES_PATH,
      content: renderGenerationRules(options.adapters, options.version),
    },
  ];

  for (const directory of ['instructions', 'agents', 'skills', 'commands']) {
    await fileSystem.createDirectory(resolveWithinRoot(root, `${AI_DIRECTORY}/${directory}`));
  }
  // No provider directories. An override is user configuration, and an empty
  // '.ai/providers/<provider>/' suggests one exists where none does — for every
  // enabled provider at once, most of which will never get an override. The
  // directory is created with the first override written into it, so the tree
  // shows what is actually configured. Git does not track an empty directory
  // either, so these never survived a clone in the first place.

  for (const file of files) {
    try {
      await fileSystem.writeFileAtomic(
        resolveWithinRoot(root, file.path),
        Buffer.from(file.content, 'utf8'),
        { exclusive: true },
      );
    } catch {
      return {
        ok: false,
        diagnostics: [
          {
            code: 'ALREADY_INITIALIZED',
            severity: 'error',
            message: `'${file.path}' appeared while AI Config was initializing and was left alone. Remove '${AI_DIRECTORY}/' if you want to start over.`,
            source: file.path,
          },
        ],
      };
    }
  }

  return { ok: true, created: files.map((file) => file.path) };
};

interface StarterFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Only the configuration file.
 *
 * No placeholder instruction: it was content AI Config invented, in a directory
 * that belongs entirely to the author, and every project began by deleting or
 * rewriting it. The four content directories are created empty instead, which
 * says where things go without putting words in anyone's mouth.
 */
const starterFiles = (
  providers: readonly ProviderId[],
  adapters: readonly ProviderAdapter[],
): StarterFile[] => [{ path: CONFIG_PATH, content: renderConfig(providers, adapters) }];

const renderConfig = (
  providers: readonly ProviderId[],
  adapters: readonly ProviderAdapter[],
): string => {
  const available = adapters
    .map((adapter) => adapter.id)
    .sort()
    .join(', ');
  const lines = [
    '# AI Config canonical configuration.',
    '# Specification: https://github.com/ShadyManu/ai-config/blob/main/docs/specification.md',
    ...(available.length === 0 ? [] : [`# Available providers: ${available}.`]),
    '',
    `schema: ${String(SUPPORTED_SCHEMA_VERSION)}`,
    '',
    'providers:',
  ];

  if (providers.length === 0) {
    lines.push('  enabled: []');
  } else {
    lines.push('  enabled:');
    for (const provider of [...providers].sort()) {
      lines.push(`    - ${provider}`);
    }
  }

  lines.push('');

  return lines.join('\n');
};
