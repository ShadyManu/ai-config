import type { AiConfiguration, SourceRef } from '../domain/configuration.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import type { ProviderId } from '../domain/provider.js';
import type { ProviderOverlay } from '../overlay/overlay.js';
import type { ProviderOverrideSchema } from './override.js';

export type CapabilityClassification = 'exact' | 'lossy' | 'unsupported' | 'unverified';
export type OwnershipMode = 'managed' | 'external';

export interface ProviderExtensionDefinition {
  readonly id: string;
  readonly provider: ProviderId;
  readonly targetKinds: readonly ('skill' | 'command' | 'agent' | 'instruction')[];
  readonly ownedOutputPaths: readonly string[];
  readonly executable: boolean;
}

/**
 * A reference to a file inside a canonical skill directory.
 *
 * Adapters name a skill and a file within it; core resolves that to a path.
 * An adapter never constructs a source path, so it cannot read outside `.ai/`.
 */
export interface SkillFileRef {
  readonly skill: string;
  readonly relativePath: string;
}

export type FileContent =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'copy'; readonly ref: SkillFileRef };

export interface GeneratedFile {
  /** Repository-relative POSIX path. Validated centrally before any write. */
  readonly path: string;
  /** Canonical origin, or `null` for aggregates such as `AGENTS.md`. */
  readonly source: SourceRef | null;
  readonly content: FileContent;
  readonly extension?: string | undefined;
  readonly executable?: boolean | undefined;
}

export interface CompileResult {
  readonly files: readonly GeneratedFile[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Translates the provider-neutral configuration into one provider's files.
 *
 * `compile` is a single member rather than a separate `analyze` + `compile`
 * pair: splitting them lets an adapter's warnings drift out of step with what
 * it actually emits, and there is nothing to gain, because `compile` is pure
 * and cheap enough for `validate` to call and discard the files.
 *
 * Implementations must be pure and synchronous: no I/O, no clock, no
 * randomness. That is what makes `--dry-run` provably side-effect free.
 *
 * An adapter reports failure by returning an `error` diagnostic. Core then
 * discards its files and blocks the sync.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  /**
   * Repository-relative locations this adapter may generate into, as files or
   * directory prefixes.
   *
   * Declared rather than derived from `compile`, because the question it
   * answers — "does this repository already contain files that look like this
   * provider's?" — is asked before there is any canonical configuration to
   * compile. Each entry is as narrow as the provider allows: `.github/agents`,
   * never `.github`, which is full of unrelated user content.
   *
   * Recognition only, never ownership: nothing but the manifest can prove AI
   * Config wrote a file. A cross-adapter test keeps this in step with what
   * `compile` actually emits.
   */
  readonly targetRoots: readonly string[];
  /** Registered provider-owned extensions. Core validates envelope/targets only. */
  readonly extensions?: readonly ProviderExtensionDefinition[];
  /**
   * Provider-specific options this adapter accepts for canonical artifacts.
   *
   * One declaration per artifact kind, and the only place a provider's field
   * names, enums and ranges are written down. Core validates against it, the
   * CLI and the editor build their prompts from it, and this adapter consumes
   * the validated result — so none of the four can disagree.
   */
  readonly overrides?: readonly ProviderOverrideSchema[];
  compile: (configuration: AiConfiguration, overlay?: ProviderOverlay) => CompileResult;
}
