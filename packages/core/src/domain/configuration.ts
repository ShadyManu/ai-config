import type { Diagnostic } from './diagnostic.js';
import type { ProviderId } from './provider.js';

export type SourceKind = 'instruction' | 'agent' | 'skill' | 'command';

/** Identifies the canonical item a generated file was produced from. */
export interface SourceRef {
  readonly kind: SourceKind;
  readonly name: string;
}

const SOURCE_DIRECTORIES: Readonly<Record<SourceKind, string>> = {
  instruction: 'instructions',
  agent: 'agents',
  skill: 'skills',
  command: 'commands',
};

/** The `.ai/` subdirectory a kind lives in, e.g. `agents` for an agent. */
export const sourceDirectory = (kind: SourceKind): string => SOURCE_DIRECTORIES[kind];

/** Serializes a source reference for the manifest, e.g. `agents/reviewer`. */
export const formatSourceRef = (ref: SourceRef): string =>
  `${sourceDirectory(ref.kind)}/${ref.name}`;

export interface AiInstruction {
  readonly name: string;
  readonly description: string | undefined;
  /** Glob patterns limiting the instruction's scope. Empty means unscoped. */
  readonly applyTo: readonly string[];
  readonly body: string;
  /** Repository-relative POSIX path of the canonical file. */
  readonly sourcePath: string;
}

export interface AiAgent {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly sourcePath: string;
}

/**
 * A file inside a skill directory, described rather than carried.
 *
 * Payload bytes are deliberately absent: with four providers enabled a single
 * skill file becomes four generated files, and carrying bytes would mean
 * holding and re-hashing every payload four times on each sync. The planner
 * compares `sha256`, and only the writer reads the file.
 */
export interface AiSkillFile {
  /** POSIX path relative to the skill directory, e.g. `references/api.md`. */
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
  /**
   * Best-effort POSIX executable bit. Not recorded in the manifest and not
   * treated as drift: it would make the manifest differ between platforms for
   * identical sources.
   */
  readonly executable: boolean;
}

export interface AiSkill {
  readonly name: string;
  readonly description: string;
  /** Every file in the skill directory, including `SKILL.md`, sorted by path. */
  readonly files: readonly AiSkillFile[];
  /** Repository-relative POSIX path of the skill directory. */
  readonly sourcePath: string;
  /**
   * The decoded text of `SKILL.md`.
   *
   * Carried — unlike every other skill file, which is described by hash alone —
   * because a provider that supports skill-level overrides has to merge its own
   * frontmatter into this one file. It is read and parsed during discovery
   * anyway, and it is one small file per skill rather than one per provider.
   */
  readonly entrypointText: string;
  /** Top-level frontmatter keys of `SKILL.md`, for override collision checks. */
  readonly entrypointKeys: readonly string[];
}

/**
 * A command: an explicitly user-invoked workflow.
 *
 * No invocation control is carried. The three providers that document one
 * spell it in opposite polarities — Claude Code `disable-model-invocation`,
 * Codex `allow_implicit_invocation`, Copilot `disable-model-invocation` /
 * `user-invocable` — so a canonical field would add a fourth polarity and put
 * an inversion in every adapter. `docs/specification.md` fixes the canonical
 * semantics instead: a command is always user-invoked.
 */
export interface AiCommand {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly sourcePath: string;
}

/**
 * The provider-neutral intermediate representation handed to adapters.
 *
 * It carries content only. Provider settings live in {@link AiConfigFile}, so
 * an adapter cannot observe or act on which other providers are enabled.
 * Collections are sorted by name during parsing, which is what makes generated
 * output deterministic without every adapter having to sort.
 */
export interface AiConfiguration {
  readonly instructions: readonly AiInstruction[];
  readonly agents: readonly AiAgent[];
  readonly skills: readonly AiSkill[];
  readonly commands: readonly AiCommand[];
}

/** The parsed and validated `.ai/config.yaml`. */
export interface AiConfigFile {
  readonly schema: number;
  /** Sorted, duplicate-free provider IDs. Order in YAML is not significant. */
  readonly providers: readonly ProviderId[];
}

export const enabledProviders = (config: AiConfigFile): readonly ProviderId[] =>
  [...config.providers].sort();

/** The complete result of reading a `.ai/` directory. */
export interface AiProject {
  readonly config: AiConfigFile;
  readonly configuration: AiConfiguration;
  readonly diagnostics: readonly Diagnostic[];
}
