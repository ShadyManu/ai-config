import type { ProviderId } from '../domain/provider.js';
import type { AiConfiguration, SourceKind } from '../domain/configuration.js';
import { sourceDirectory } from '../domain/configuration.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import type { FileSystem } from '../fs/file-system.js';
import { decodeSourceText } from '../parse/text.js';
import { isPlainObject, parseYaml } from '../parse/yaml.js';
import { resolveWithinRoot } from '../path/safe-path.js';
import { checkGeneratedPath } from '../path/safe-path.js';
import { checkPathsContained } from '../path/containment.js';
import type { ProviderExtensionDefinition } from '../adapter/adapter.js';
import type { ProviderOverrideSchema } from '../adapter/override.js';
import { overrideTargets, validateOverrideDocument } from '../adapter/override.js';
import type { FrontmatterMap } from '../text/yaml-frontmatter.js';

export interface ProviderOverlayExtension {
  readonly id: string;
  readonly type: string;
  readonly target: {
    readonly kind: SourceKind;
    readonly id: string;
  };
  readonly spec: unknown;
  readonly sourcePath: string;
  readonly assets: readonly string[];
}

/** Validated provider-native settings for one canonical artifact. */
export interface ProviderArtifactOverride {
  readonly kind: SourceKind;
  readonly id: string;
  /** Validated options, in the provider schema's declared field order. */
  readonly options: FrontmatterMap;
  readonly sourcePath: string;
}

export interface ProviderOverlay {
  readonly provider: ProviderId;
  readonly extensions: readonly ProviderOverlayExtension[];
  readonly overrides: readonly ProviderArtifactOverride[];
  /**
   * Override files whose canonical artifact no longer exists.
   *
   * Carried as data rather than left as a diagnostic to be parsed back out of a
   * message, so callers can report the paths without changing authored files.
   */
  readonly orphanedOverrides: readonly string[];
}

export const EMPTY_OVERLAY = (provider: ProviderId): ProviderOverlay => ({
  provider,
  extensions: [],
  overrides: [],
  orphanedOverrides: [],
});

/** The one override a provider has for an artifact, if the user wrote one. */
export const overrideFor = (
  overlay: ProviderOverlay | undefined,
  kind: SourceKind,
  id: string,
): ProviderArtifactOverride | undefined =>
  overlay?.overrides.find((candidate) => candidate.kind === kind && candidate.id === id);

export interface OverlayDiscoveryOptions {
  readonly extensions?: readonly ProviderExtensionDefinition[];
  readonly overrides?: readonly ProviderOverrideSchema[];
  readonly configuration?: AiConfiguration;
}

const OVERRIDE_KINDS: readonly SourceKind[] = ['instruction', 'agent', 'skill', 'command'];

const PROVIDERS_DIRECTORY = '.ai/providers';

/**
 * Reads only one provider's overlay; adapters never receive another provider's
 * data.
 *
 * Artifact overrides are discovered independently of `overlay.yaml`. The
 * envelope declares provider-only *extensions*; an override refines a canonical
 * artifact and needs no registration, so requiring the envelope would make an
 * override file the user wrote by hand silently do nothing.
 */
export const discoverOverlay = async (
  fileSystem: FileSystem,
  root: string,
  provider: ProviderId,
  options: OverlayDiscoveryOptions = {},
): Promise<{ readonly overlay: ProviderOverlay; readonly diagnostics: readonly Diagnostic[] }> => {
  const diagnostics: Diagnostic[] = [];
  const base = `${PROVIDERS_DIRECTORY}/${provider}`;

  // An overlay decides what a provider emits, so it is configuration just as
  // much as '.ai/config.yaml' is, and reading it through a symbolic link would
  // let a repository pull that decision in from outside. The asset check below
  // covers only the files an extension references, not the documents that
  // reference them.
  const containment = await checkPathsContained(fileSystem, root, [PROVIDERS_DIRECTORY, base]);
  if (containment.length > 0) {
    return { overlay: EMPTY_OVERLAY(provider), diagnostics: containment };
  }

  const extensions = await discoverExtensions(
    fileSystem,
    root,
    base,
    provider,
    options.extensions ?? [],
    diagnostics,
  );
  const orphaned: string[] = [];
  const overrides = await discoverOverrides(
    fileSystem,
    root,
    base,
    provider,
    options,
    diagnostics,
    orphaned,
  );

  return {
    overlay: { provider, extensions, overrides, orphanedOverrides: orphaned },
    diagnostics,
  };
};

/**
 * An override file that refines nothing is reported and skipped, not refused.
 *
 * Three conditions land here: the canonical artifact is gone, the provider has
 * no schema for that kind, or the schema declines this particular artifact. All
 * three produce the same outcome — the file contributes nothing to any provider,
 * and the output is exactly what it would be if the file were not there. None
 * of them can make the output wrong, so none of them refuses a synchronization.
 *
 * They differ in what happens next. A missing target means the override has
 * outlived what it refined, and nothing can bring it back into use except an
 * artifact of that name returning; `sync` preserves it, so it is informational
 * rather than a warning — it is reported so that `validate` and `--dry-run`
 * announce the preserved file, not to ask anyone to act. The other two describe a file
 * this provider can never apply whatever changes, and AI Config does not know
 * what the author meant by it, so they warn and the file stays.
 *
 * The same codes stay errors where a command was asked to do something and
 * could not — `createOverride` on an artifact that declines it, `removeOverride`
 * on a file that is not there. That is a failed operation, not an inert file.
 */
const discoverOverrides = async (
  fileSystem: FileSystem,
  root: string,
  base: string,
  provider: ProviderId,
  options: OverlayDiscoveryOptions,
  diagnostics: Diagnostic[],
  orphaned: string[],
): Promise<readonly ProviderArtifactOverride[]> => {
  const schemas = options.overrides ?? [];
  const targets = options.configuration === undefined ? [] : overrideTargets(options.configuration);
  const overrides: ProviderArtifactOverride[] = [];

  for (const kind of OVERRIDE_KINDS) {
    const directory = `${base}/${sourceDirectory(kind)}`;
    const entries = await fileSystem.readDirectory(resolveWithinRoot(root, directory));
    const schema = schemas.find((candidate) => candidate.kind === kind);

    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.yaml') || entry.name.startsWith('.')) {
        continue;
      }
      const id = entry.name.slice(0, -'.yaml'.length);
      const sourcePath = `${directory}/${entry.name}`;

      if (schema === undefined) {
        diagnostics.push({
          code: 'OVERRIDE_NOT_SUPPORTED',
          severity: 'warning',
          provider,
          source: sourcePath,
          message: `'${provider}' has no provider-specific options for a ${kind}, so this override cannot be applied. Remove the file.`,
        });
        continue;
      }

      const target = targets.find((candidate) => candidate.kind === kind && candidate.name === id);
      if (target === undefined) {
        orphaned.push(sourcePath);
        // Informational: nothing is wrong with the file, and nothing is lost.
        // Synchronization preserves authored overrides when their target is
        // absent because this may be a deletion, rename, or branch switch.
        // `validate` and `--dry-run` report the state without changing it.
        diagnostics.push({
          code: 'OVERRIDE_TARGET_MISSING',
          severity: 'info',
          provider,
          source: sourcePath,
          message: `No canonical ${kind} named '${id}' exists, so this override refines nothing. It is preserved until you remove it explicitly or restore the artifact.`,
        });
        continue;
      }

      const unavailable = schema.unavailableReason?.(target);
      if (unavailable !== undefined) {
        diagnostics.push({
          code: 'OVERRIDE_NOT_APPLICABLE',
          severity: 'warning',
          provider,
          source: sourcePath,
          message: unavailable,
        });
        continue;
      }

      const content = await fileSystem.readFile(resolveWithinRoot(root, sourcePath));
      if (content === undefined) {
        continue;
      }
      const parsed = parseYaml(decodeSourceText(content));
      if (!parsed.ok) {
        diagnostics.push({
          code: 'OVERRIDE_INVALID',
          severity: 'error',
          provider,
          source: sourcePath,
          message: `Could not parse ${sourcePath}: ${parsed.reason}.${parsed.explanation === undefined ? '' : ` ${parsed.explanation}`}`,
          line: parsed.position?.line,
          column: parsed.position?.column,
        });
        continue;
      }

      const validation = validateOverrideDocument(parsed.value, schema, { provider, sourcePath });
      diagnostics.push(...validation.diagnostics);
      if (validation.options === undefined) {
        continue;
      }
      overrides.push({ kind, id, options: validation.options, sourcePath });
    }
  }

  return overrides;
};

const discoverExtensions = async (
  fileSystem: FileSystem,
  root: string,
  base: string,
  provider: ProviderId,
  definitions: readonly ProviderExtensionDefinition[],
  diagnostics: Diagnostic[],
): Promise<readonly ProviderOverlayExtension[]> => {
  const envelopePath = `${base}/overlay.yaml`;
  const envelope = await fileSystem.readFile(resolveWithinRoot(root, envelopePath));
  if (envelope === undefined) {
    return [];
  }
  const parsed = parseYaml(decodeSourceText(envelope));
  if (
    !parsed.ok ||
    !isPlainObject(parsed.value) ||
    parsed.value['schema'] !== 1 ||
    parsed.value['provider'] !== provider ||
    !Array.isArray(parsed.value['extensions']) ||
    !parsed.value['extensions'].every((x) => typeof x === 'string')
  ) {
    diagnostics.push({
      code: 'OVERLAY_INVALID',
      severity: 'error',
      message: `${envelopePath} must contain schema: 1, provider: ${provider}, and an extensions list.`,
      source: envelopePath,
    });
    return [];
  }

  const extensions: ProviderOverlayExtension[] = [];
  for (const id of parsed.value['extensions']) {
    const sourcePath = `${base}/extensions/${id}.yaml`;
    const content = await fileSystem.readFile(resolveWithinRoot(root, sourcePath));
    if (content === undefined) {
      diagnostics.push({
        code: 'OVERLAY_EXTENSION_MISSING',
        severity: 'error',
        message: `Overlay extension '${id}' is declared but ${sourcePath} is missing.`,
        source: envelopePath,
        provider,
      });
      continue;
    }
    const document = parseYaml(decodeSourceText(content));
    if (
      !document.ok ||
      !isPlainObject(document.value) ||
      document.value['schema'] !== 1 ||
      typeof document.value['type'] !== 'string' ||
      !isPlainObject(document.value['target']) ||
      typeof document.value['target']['kind'] !== 'string' ||
      typeof document.value['target']['id'] !== 'string' ||
      !('spec' in document.value)
    ) {
      diagnostics.push({
        code: 'OVERLAY_INVALID',
        severity: 'error',
        message: `${sourcePath} is not a valid extension document.`,
        source: sourcePath,
        provider,
      });
      continue;
    }
    const value = document.value;
    const definition = definitions.find((candidate) => candidate.id === value['type']);
    if (definition?.provider !== provider) {
      diagnostics.push({
        code: 'OVERLAY_EXTENSION_UNSUPPORTED',
        severity: 'error',
        message: `Provider '${provider}' does not register extension type '${String(value['type'])}'.`,
        source: sourcePath,
        provider,
      });
      continue;
    }
    const target = value['target'] as Record<string, unknown>;
    const targetKind = target['kind'] as SourceKind;
    if (!definition.targetKinds.includes(targetKind)) {
      diagnostics.push({
        code: 'OVERLAY_TARGET_INVALID',
        severity: 'error',
        message: `Extension '${String(value['type'])}' cannot target '${targetKind}'.`,
        source: sourcePath,
        provider,
      });
      continue;
    }
    const rawAssets = value['assets'] ?? [];
    if (!Array.isArray(rawAssets) || !rawAssets.every((asset) => typeof asset === 'string')) {
      diagnostics.push({
        code: 'OVERLAY_INVALID',
        severity: 'error',
        message: `${sourcePath} assets must be a list of relative paths.`,
        source: sourcePath,
        provider,
      });
      continue;
    }
    const assetRoot = `${base}/assets/${id}`;
    const assets: string[] = [];
    for (const asset of rawAssets) {
      const checked = checkGeneratedPath(asset);
      if (!checked.ok || checked.path.startsWith('../')) {
        diagnostics.push({
          code: 'OVERLAY_ASSET_UNSAFE',
          severity: 'error',
          message: `Asset '${asset}' must stay inside ${assetRoot}/.`,
          source: sourcePath,
          provider,
        });
        continue;
      }
      const assetPath = `${assetRoot}/${checked.path}`;
      if (!(await fileSystem.exists(resolveWithinRoot(root, assetPath)))) {
        diagnostics.push({
          code: 'OVERLAY_ASSET_MISSING',
          severity: 'error',
          message: `Extension '${id}' references missing asset '${asset}'.`,
          source: sourcePath,
          provider,
        });
        continue;
      }
      const contained = await checkPathsContained(fileSystem, root, [assetPath]);
      if (contained.length > 0) {
        diagnostics.push({
          code: 'OVERLAY_ASSET_UNSAFE',
          severity: 'error',
          message: `Asset '${asset}' resolves outside the repository.`,
          provider,
          source: assetPath,
        });
        continue;
      }
      assets.push(assetPath);
    }
    extensions.push({
      id,
      type: value['type'] as string,
      target: { kind: targetKind, id: target['id'] as string },
      spec: value['spec'],
      sourcePath,
      assets: assets.sort(),
    });
  }

  const referenced = new Set(extensions.flatMap((extension) => extension.assets));
  for (const asset of await listAssets(fileSystem, root, `${base}/assets`)) {
    if (!referenced.has(asset)) {
      diagnostics.push({
        code: 'OVERLAY_ASSET_UNREFERENCED',
        severity: 'error',
        message: `Overlay asset '${asset}' is not referenced by a valid extension.`,
        source: asset,
        provider,
      });
    }
  }

  return extensions.sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * Reports override files belonging to providers that are not enabled.
 *
 * Disabling a provider preserves its overrides, and they produce no output
 * while it stays disabled. Saying so once per provider is what keeps that from
 * looking like the files were lost.
 */
export const reportDisabledProviderOverrides = async (
  fileSystem: FileSystem,
  root: string,
  enabled: readonly ProviderId[],
): Promise<readonly Diagnostic[]> => {
  const providersRoot = PROVIDERS_DIRECTORY;
  const containment = await checkPathsContained(fileSystem, root, [providersRoot]);
  if (containment.length > 0) {
    return containment;
  }

  const diagnostics: Diagnostic[] = [];
  const entries = await fileSystem.readDirectory(resolveWithinRoot(root, providersRoot));

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.kind !== 'directory' || enabled.includes(entry.name as ProviderId)) {
      continue;
    }
    const files: string[] = [];
    for (const kind of OVERRIDE_KINDS) {
      const directory = `${providersRoot}/${entry.name}/${sourceDirectory(kind)}`;
      for (const child of await fileSystem.readDirectory(resolveWithinRoot(root, directory))) {
        if (child.kind === 'file' && child.name.endsWith('.yaml') && !child.name.startsWith('.')) {
          files.push(`${directory}/${child.name}`);
        }
      }
    }
    if (files.length > 0) {
      diagnostics.push({
        code: 'OVERRIDE_PROVIDER_DISABLED',
        severity: 'info',
        source: `${providersRoot}/${entry.name}`,
        message: `'${entry.name}' is not enabled, so its ${String(files.length)} override file${files.length === 1 ? '' : 's'} produce no output. They are preserved and take effect again when the provider is re-enabled.`,
      });
    }
  }

  return diagnostics;
};

const listAssets = async (
  fileSystem: FileSystem,
  root: string,
  relative: string,
): Promise<readonly string[]> => {
  const entries = await fileSystem.readDirectory(resolveWithinRoot(root, relative));
  const files: string[] = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.kind === 'file' || entry.kind === 'symlink') files.push(child);
    else if (entry.kind === 'directory') files.push(...(await listAssets(fileSystem, root, child)));
  }
  return files.sort();
};
