export type {
  CompileResult,
  FileContent,
  ForeignIntake,
  GeneratedFile,
  ProviderAdapter,
  ProviderExtensionDefinition,
  CapabilityClassification,
  OwnershipMode,
  SkillFileRef,
} from './adapter/adapter.js';
export { skillArtifacts } from './adapter/skill-artifacts.js';

export type {
  DeprecatedOverrideField,
  OverrideField,
  OverrideFieldType,
  OverrideTarget,
  OverrideValidation,
  ProviderOverrideSchema,
} from './adapter/override.js';
export {
  OVERRIDE_SCHEMA_VERSION,
  orderedOptionFields,
  overridePath,
  overrideTargets,
  validateOverrideDocument,
} from './adapter/override.js';

export type { ResolvedContent, SkillFileLocation } from './compile/content.js';
export { indexSkillFiles, resolveContent } from './compile/content.js';

export type { CompiledArtifact, CompilationResult } from './compile/compile.js';
export { compile } from './compile/compile.js';

export type {
  AiAgent,
  AiCommand,
  AiConfigFile,
  AiConfiguration,
  AiInstruction,
  AiSkill,
  AiSkillFile,
  SourceKind,
  SourceRef,
} from './domain/configuration.js';
export { enabledProviders, sourceDirectory } from './domain/configuration.js';

export type { CrossProviderCode, DiagnosticCode } from './domain/codes.js';
export { DIAGNOSTIC_CODES } from './domain/codes.js';

export type { Diagnostic, DiagnosticSeverity } from './domain/diagnostic.js';
export { countBySeverity, hasErrors, sortDiagnostics } from './domain/diagnostic.js';

export type { ProviderId } from './domain/provider.js';
export { PROVIDER_IDS, isProviderId } from './domain/provider.js';

export type { DirectoryEntry, FileStat, FileSystem } from './fs/file-system.js';
export { NodeFileSystem } from './fs/node-file-system.js';

export type { Manifest, ManifestEntry } from './manifest/manifest.js';
export { MANIFEST_PATH, MANIFEST_VERSION, readManifest } from './manifest/manifest.js';

export { CONFIG_PATH, SUPPORTED_SCHEMA_VERSION } from './parse/config.js';
export type {
  ProviderArtifactOverride,
  ProviderOverlay,
  ProviderOverlayExtension,
} from './overlay/overlay.js';
export { discoverOverlay, EMPTY_OVERLAY, overrideFor } from './overlay/overlay.js';

export type { ProviderToggleOutcome } from './config/providers.js';
export { disableProvider, enableProvider, withProviders } from './config/providers.js';

export type {
  AgentDraft,
  CommandDraft,
  InstructionDraft,
  OverrideDraft,
  OverrideTemplateDraft,
  ScaffoldOutcome,
  SkillDraft,
} from './scaffold/scaffold.js';
export {
  SKILL_SUBDIRECTORIES,
  TEMPLATE_PLACEHOLDER,
  createAgent,
  createCommand,
  createInstruction,
  createOverride,
  createOverrideTemplate,
  createSkill,
  removeOverride,
  renderOverrideDocument,
  renderOverrideTemplate,
} from './scaffold/scaffold.js';
export type { RemovalOutcome } from './scaffold/remove.js';
export { removeArtifact, removeOrphanedOverrides } from './scaffold/remove.js';
export { AI_DIRECTORY, SKILL_ENTRYPOINT } from './parse/discover.js';
export { NAME_MAX_LENGTH, NAME_PATTERN, checkName } from './parse/name.js';
export { normalizeGeneratedText } from './parse/text.js';

export { GENERATED_INSTRUCTIONS_HEADER } from './text/generated-header.js';

export type {
  FrontmatterField,
  FrontmatterMap,
  FrontmatterValue,
} from './text/yaml-frontmatter.js';
export {
  renderFrontmatter,
  renderMarkdownDocument,
  renderYamlEntries,
  spliceFrontmatter,
} from './text/yaml-frontmatter.js';

export type {
  BlockedAction,
  BlockedReason,
  DeleteAction,
  DriftPolicy,
  FileState,
  PlanAction,
  PlanActionKind,
  SyncPlan,
  UnchangedAction,
  WritablePlan,
  WriteAction,
} from './plan/plan.js';
export { blockedActions, stateOf } from './plan/plan.js';

export { GENERATION_RULES_PATH, renderGenerationRules } from './docs/generation-rules.js';
export type { CleanOutcome, CleanResult } from './sync/clean.js';
export { clean } from './sync/clean.js';
export type { RestoreOutcome, RestoreResult } from './sync/restore.js';
export { restore } from './sync/restore.js';

export type { InitOptions, InitOutcome } from './sync/init.js';
export { init } from './sync/init.js';
export { findExistingProviderTargets } from './sync/untracked-targets.js';

export type { LoadedProject } from './sync/project.js';

export type {
  AnalysisResult,
  AnalyzeOutcome,
  ProviderReport,
  ProviderStatus,
  SyncOptions,
  SyncOutcome,
  SyncResult,
} from './sync/sync.js';
export { analyze, sync } from './sync/sync.js';

export type { WriteSummary } from './sync/writer.js';

export { findRepositoryRoot, isInitialized } from './workspace.js';
