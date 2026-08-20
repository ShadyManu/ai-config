import type { ProviderAdapter } from '../adapter/adapter.js';
import type { AiConfigFile, AiConfiguration } from '../domain/configuration.js';
import { enabledProviders } from '../domain/configuration.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import { compareStrings } from '../domain/ordering.js';
import type { ProviderId } from '../domain/provider.js';
import type { FileSystem } from '../fs/file-system.js';
import { CONFIG_PATH, parseConfig } from '../parse/config.js';
import { AI_DIRECTORY, discoverConfiguration } from '../parse/discover.js';
import { decodeSourceText } from '../parse/text.js';
import { checkPathsContained } from '../path/containment.js';
import { resolveWithinRoot } from '../path/safe-path.js';
import { validateConfiguration } from '../validate/validate.js';
import { discoverOverlay, reportDisabledProviderOverrides } from '../overlay/overlay.js';
import type { ProviderOverlay } from '../overlay/overlay.js';

export interface LoadedProject {
  readonly config: AiConfigFile;
  readonly configuration: AiConfiguration;
  readonly enabled: readonly ProviderId[];
  readonly overlays: ReadonlyMap<ProviderId, ProviderOverlay>;
  readonly diagnostics: readonly Diagnostic[];
}

export type LoadResult =
  | { readonly ok: true; readonly project: LoadedProject }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Reads and validates `.ai/`.
 *
 * Adapters are supplied by the caller and used only to establish which provider
 * identifiers are known, so enabling a provider whose adapter is absent is
 * reported rather than silently producing nothing.
 */
export const loadProject = async (
  fileSystem: FileSystem,
  root: string,
  adapters: readonly ProviderAdapter[],
): Promise<LoadResult> => {
  // Before anything is read from it. `discoverConfiguration` checks the same
  // thing for the content directories, but the configuration file is opened
  // first, and a symlinked '.ai/' would let it come from outside the repository
  // and decide which providers run.
  const containment = await checkPathsContained(fileSystem, root, [AI_DIRECTORY]);
  if (containment.length > 0) {
    return { ok: false, diagnostics: containment };
  }

  const configContent = await fileSystem.readFile(resolveWithinRoot(root, CONFIG_PATH));
  if (configContent === undefined) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'NOT_INITIALIZED',
          severity: 'error',
          message: `No ${CONFIG_PATH} found. Run 'aiconfig init' to create one.`,
          source: CONFIG_PATH,
        },
      ],
    };
  }

  const knownProviders = adapters.map((adapter) => adapter.id);
  const configResult = parseConfig(decodeSourceText(configContent), knownProviders);
  if (configResult.config === undefined) {
    return { ok: false, diagnostics: configResult.diagnostics };
  }

  const discovery = await discoverConfiguration(fileSystem, root);
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const enabled = enabledProviders(configResult.config);
  const overlayResults = await Promise.all(
    enabled.map((provider) =>
      discoverOverlay(fileSystem, root, provider, {
        extensions: adapterById.get(provider)?.extensions ?? [],
        overrides: adapterById.get(provider)?.overrides ?? [],
        configuration: discovery.configuration,
      }),
    ),
  );
  const overlays = new Map<ProviderId, ProviderOverlay>();
  for (const result of overlayResults) overlays.set(result.overlay.provider, result.overlay);
  const diagnostics = [
    ...configResult.diagnostics,
    ...discovery.diagnostics,
    ...validateConfiguration(discovery.configuration),
    ...overlayResults.flatMap((result) => result.diagnostics),
    ...(await reportDisabledProviderOverrides(fileSystem, root, enabled)),
  ];

  return {
    ok: true,
    project: {
      config: configResult.config,
      configuration: discovery.configuration,
      enabled: enabledProviders(configResult.config),
      overlays,
      diagnostics,
    },
  };
};

/** The adapters for the providers enabled in `config.yaml`, in stable order. */
export const activeAdapters = (
  project: LoadedProject,
  adapters: readonly ProviderAdapter[],
): readonly ProviderAdapter[] => {
  const enabled = new Set<ProviderId>(project.enabled);
  return adapters
    .filter((adapter) => enabled.has(adapter.id))
    .sort((a, b) => compareStrings(a.id, b.id));
};
