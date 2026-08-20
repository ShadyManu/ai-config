import * as path from 'node:path';

import type { ProviderAdapter } from '../adapter/adapter.js';
import { compile } from '../compile/compile.js';
import type { AiConfiguration } from '../domain/configuration.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import { compareStrings } from '../domain/ordering.js';
import { NodeFileSystem } from '../fs/node-file-system.js';
import { discoverOverlay } from '../overlay/overlay.js';
import { discoverConfiguration } from '../parse/discover.js';
import { resolveWithinRoot } from '../path/safe-path.js';

export interface CompiledFixture {
  readonly configuration: AiConfiguration;
  /** Generated file contents keyed by repository-relative path, sorted. */
  readonly files: ReadonlyMap<string, string>;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Compiles a real `.ai/` directory with one adapter and materializes the result
 * as text, for golden-file comparison.
 *
 * Lives in core rather than being duplicated per adapter so that every adapter
 * fixture test exercises the same pipeline the CLI does, including path safety
 * and skill payload resolution.
 */
export const compileFixture = async (
  repositoryRoot: string,
  adapter: ProviderAdapter,
): Promise<CompiledFixture> => {
  const fileSystem = new NodeFileSystem();
  const discovery = await discoverConfiguration(fileSystem, repositoryRoot);
  // Overlays are discovered here so a fixture exercises the same
  // canonical-plus-override path the CLI does, rather than only the
  // canonical-only half of every adapter.
  const overlay = await discoverOverlay(fileSystem, repositoryRoot, adapter.id, {
    extensions: adapter.extensions ?? [],
    overrides: adapter.overrides ?? [],
    configuration: discovery.configuration,
  });
  const compilation = compile(
    discovery.configuration,
    [adapter],
    new Map([[adapter.id, overlay.overlay]]),
  );

  const files = new Map<string, string>();
  for (const artifact of [...compilation.artifacts].sort((a, b) =>
    compareStrings(a.path, b.path),
  )) {
    if (artifact.content.kind === 'text') {
      files.set(artifact.path, artifact.content.value);
      continue;
    }

    const ref = artifact.content.ref;
    const skill = discovery.configuration.skills.find((candidate) => candidate.name === ref.skill);
    if (skill === undefined) {
      throw new Error(`Fixture references unknown skill '${ref.skill}'.`);
    }
    const source = await fileSystem.readFile(
      resolveWithinRoot(repositoryRoot, `${skill.sourcePath}/${ref.relativePath}`),
    );
    if (source === undefined) {
      throw new Error(`Fixture skill file '${ref.relativePath}' could not be read.`);
    }
    files.set(artifact.path, source.toString('utf8'));
  }

  return {
    configuration: discovery.configuration,
    files,
    diagnostics: [...discovery.diagnostics, ...overlay.diagnostics, ...compilation.diagnostics],
  };
};

/** Parses a `.ai/` directory into the IR, for tests that compile it themselves. */
export const discoverFixtureConfiguration = async (
  repositoryRoot: string,
): Promise<AiConfiguration> => {
  const discovery = await discoverConfiguration(new NodeFileSystem(), repositoryRoot);
  return discovery.configuration;
};

/** Absolute path of the checked-in `examples/basic` repository. */
export const exampleRepositoryRoot = (fromDirectory: string): string =>
  path.resolve(fromDirectory, '..', '..', '..', 'examples', 'basic');
