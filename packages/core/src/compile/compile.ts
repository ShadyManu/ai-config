import type { CompileResult, GeneratedFile, ProviderAdapter } from '../adapter/adapter.js';
import type { AiConfiguration } from '../domain/configuration.js';
import { formatSourceRef } from '../domain/configuration.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import { hasErrors } from '../domain/diagnostic.js';
import type { ProviderId } from '../domain/provider.js';
import { sha256 } from '../manifest/hash.js';
import { compareStrings } from '../domain/ordering.js';
import { checkGeneratedPath } from '../path/safe-path.js';
import { AI_DIRECTORY } from '../parse/discover.js';
import { crossProviderDiagnostics } from './cross-provider.js';
import type { ProviderOverlay } from '../overlay/overlay.js';

/** A generated file after ownership, path safety and conflict resolution. */
export interface CompiledArtifact {
  readonly path: string;
  readonly providers: readonly ProviderId[];
  readonly source: string | null;
  readonly hash: string;
  readonly content: GeneratedFile['content'];
  readonly ownership?: 'managed';
  readonly extension?: string | null;
  readonly executable?: boolean;
}

export interface CompilationResult {
  readonly artifacts: readonly CompiledArtifact[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Runs every adapter and reconciles their output.
 *
 * Ownership is attributed here, from the adapter that returned each file, so an
 * adapter cannot claim a file on another provider's behalf.
 */
export const compile = (
  configuration: AiConfiguration,
  adapters: readonly ProviderAdapter[],
  overlays: ReadonlyMap<ProviderId, ProviderOverlay> = new Map(),
): CompilationResult => {
  const diagnostics: Diagnostic[] = [];
  const byPath = new Map<string, CompiledArtifact>();
  const skillFiles = skillFileIndex(configuration);

  for (const adapter of [...adapters].sort((a, b) => compareStrings(a.id, b.id))) {
    const result = runAdapter(adapter, configuration, overlays.get(adapter.id));
    diagnostics.push(...result.diagnostics);

    // A failing adapter contributes no files, but compilation continues so the
    // user sees every problem in one pass rather than one per run.
    if (hasErrors(result.diagnostics)) {
      continue;
    }

    for (const file of result.files) {
      const artifact = validateFile(adapter.id, file, skillFiles, diagnostics);
      if (artifact === undefined) {
        continue;
      }

      const existing = byPath.get(artifact.path);
      if (existing === undefined) {
        byPath.set(artifact.path, artifact);
        continue;
      }

      if (existing.hash !== artifact.hash) {
        diagnostics.push({
          code: 'OUTPUT_PATH_CONFLICT',
          severity: 'error',
          message: `Providers ${[...existing.providers, adapter.id].sort().join(' and ')} both generate '${artifact.path}' with different content. This is an AI Config defect; please report it.`,
          provider: adapter.id,
        });
        continue;
      }

      byPath.set(artifact.path, {
        ...existing,
        providers: [...new Set([...existing.providers, adapter.id])].sort(),
      });
    }
  }

  const artifacts = [...byPath.values()].sort((a, b) => compareStrings(a.path, b.path));

  return {
    artifacts,
    // Runs last, over reconciled ownership: which provider owns a path is only
    // settled once every adapter has contributed.
    diagnostics: [...diagnostics, ...crossProviderDiagnostics(adapters, artifacts)],
  };
};

const runAdapter = (
  adapter: ProviderAdapter,
  configuration: AiConfiguration,
  overlay?: ProviderOverlay,
): CompileResult => {
  try {
    return adapter.compile(configuration, overlay);
  } catch (error) {
    // A defective adapter degrades into a diagnostic rather than a stack trace.
    return {
      files: [],
      diagnostics: [
        {
          code: 'ADAPTER_INTERNAL_ERROR',
          severity: 'error',
          message: `The ${adapter.displayName} adapter failed: ${error instanceof Error ? error.message : String(error)}`,
          provider: adapter.id,
        },
      ],
    };
  }
};

const skillFileIndex = (configuration: AiConfiguration): ReadonlyMap<string, string> => {
  const index = new Map<string, string>();
  for (const skill of configuration.skills) {
    for (const file of skill.files) {
      index.set(`${skill.name}/${file.relativePath}`, file.sha256);
    }
  }
  return index;
};

const validateFile = (
  providerId: ProviderId,
  file: GeneratedFile,
  skillFiles: ReadonlyMap<string, string>,
  diagnostics: Diagnostic[],
): CompiledArtifact | undefined => {
  const check = checkGeneratedPath(file.path);
  if (!check.ok) {
    diagnostics.push({
      code: 'UNSAFE_OUTPUT_PATH',
      severity: 'error',
      message: `The ${providerId} adapter produced an unsafe output path '${file.path}': ${check.reason}.`,
      provider: providerId,
    });
    return undefined;
  }

  // Generated output must never land inside the canonical directory: `.ai/` is
  // the source of truth, and writing into it would let a provider adapter
  // influence the next parse.
  if (check.path === AI_DIRECTORY || check.path.startsWith(`${AI_DIRECTORY}/`)) {
    diagnostics.push({
      code: 'UNSAFE_OUTPUT_PATH',
      severity: 'error',
      message: `The ${providerId} adapter tried to write '${file.path}' inside the canonical '${AI_DIRECTORY}/' directory.`,
      provider: providerId,
    });
    return undefined;
  }

  let hash: string;
  if (file.content.kind === 'text') {
    hash = sha256(file.content.value);
  } else {
    const key = `${file.content.ref.skill}/${file.content.ref.relativePath}`;
    const known = skillFiles.get(key);
    if (known === undefined) {
      diagnostics.push({
        code: 'UNKNOWN_SKILL_FILE',
        severity: 'error',
        message: `The ${providerId} adapter referenced skill file '${key}', which is not part of the parsed configuration.`,
        provider: providerId,
      });
      return undefined;
    }
    hash = known;
  }

  return {
    path: check.path,
    providers: [providerId],
    source: file.source === null ? null : formatSourceRef(file.source),
    hash,
    content: file.content,
    ownership: 'managed',
    extension: file.extension ?? null,
    executable: file.executable ?? false,
  };
};
