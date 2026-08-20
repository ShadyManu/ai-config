/**
 * Every diagnostic code AI Config emits.
 *
 * Codes are part of the public contract: consumers match on them in CI and in
 * editor integrations. Declaring them in one place makes `Diagnostic.code` a
 * checked type rather than a free-form string, so a typo or a silent rename
 * cannot slip through, and gives the specification a single list to document.
 */
export const DIAGNOSTIC_CODES = [
  // Configuration file
  'CONFIG_INVALID_YAML',
  'CONFIG_NOT_A_MAP',
  'MISSING_SCHEMA_VERSION',
  'INVALID_SCHEMA_VERSION',
  'UNSUPPORTED_SCHEMA_VERSION',
  'UNKNOWN_CONFIG_KEY',
  'INVALID_PROVIDERS',
  'UNKNOWN_PROVIDER',
  'OVERLAY_INVALID',
  'OVERLAY_EXTENSION_MISSING',
  'OVERLAY_EXTENSION_UNSUPPORTED',
  'OVERLAY_TARGET_INVALID',
  'OVERLAY_ASSET_UNREFERENCED',
  'OVERLAY_ASSET_MISSING',
  'OVERLAY_ASSET_UNSAFE',

  // Provider-specific artifact overrides
  'OVERRIDE_INVALID',
  'OVERRIDE_UNKNOWN_FIELD',
  'OVERRIDE_UNRECOGNIZED_FIELD',
  'OVERRIDE_UNRECOGNIZED_VALUE',
  'OVERRIDE_CANONICAL_FIELD',
  'OVERRIDE_VALUE_INVALID',
  'OVERRIDE_TARGET_MISSING',
  'OVERRIDE_NOT_APPLICABLE',
  'OVERRIDE_NOT_SUPPORTED',
  'OVERRIDE_PROVIDER_DISABLED',
  'OVERRIDE_EMPTY',

  // Frontmatter and canonical files
  'FRONTMATTER_UNTERMINATED',
  'FRONTMATTER_INVALID_YAML',
  'FRONTMATTER_NOT_A_MAP',
  'UNKNOWN_FRONTMATTER_KEY',
  'MISSING_DESCRIPTION',
  'INVALID_DESCRIPTION',
  'INVALID_NAME',
  'NAME_MISMATCH',
  'DUPLICATE_NAME',
  'DUPLICATE_INVOCABLE_NAME',
  'INVALID_APPLY_TO',
  'INSTRUCTION_EMPTY_APPLY_TO',
  'INSTRUCTION_BODY_EMPTY',
  'AGENT_BODY_EMPTY',
  'COMMAND_BODY_EMPTY',
  'UNSUPPORTED_ENCODING',

  // Skills
  'SKILL_MISSING',
  'SKILL_FRONTMATTER_MISSING',
  'SKILL_NAME_INVALID',
  'SKILL_NAME_MISSING',
  'SKILL_DESCRIPTION_MISSING',
  'SKILL_DESCRIPTION_LENGTH',
  'SKILL_ENTRYPOINT_NOT_A_FILE',
  'SKILL_EMPTY',
  'SKILL_FILE_UNSAFE_NAME',
  'SKILL_SYMLINK_SKIPPED',
  'SKILL_DEPTH_EXCEEDED',
  'SYMLINK_SKIPPED',

  // Compilation
  'UNSAFE_OUTPUT_PATH',
  'OUTPUT_PATH_CONFLICT',
  'UNKNOWN_SKILL_FILE',
  'ADAPTER_INTERNAL_ERROR',

  // Manifest and synchronization
  'MANIFEST_UNREADABLE',
  'UNSUPPORTED_MANIFEST_VERSION',
  'DRIFT_BLOCKS_WRITE',
  'UNTRACKED_TARGET_EXISTS',
  'ORPHAN_MODIFIED',
  'TARGET_CHANGED_DURING_SYNC',
  'WRITE_FAILED',
  'MANIFEST_WRITE_FAILED',
  'ROOT_NOT_FOUND',
  'NOT_INITIALIZED',
  'ALREADY_INITIALIZED',

  // Provider compatibility
  'INSTRUCTION_SCOPE_NOT_SUPPORTED',
  'COMMAND_CONVERTED_TO_SKILL',
  'COMMAND_LIMITED_SURFACE',
  'AGENT_BODY_TOO_LONG',
  'SKILL_ALLOWED_TOOLS_UNSUPPORTED',

  // Cross-provider: one enabled provider consumes another's generated output
  'SKILL_DISCOVERY_OVERLAP',
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/**
 * The codes core may raise on a provider's behalf for a foreign intake.
 *
 * Deliberately a closed subset of {@link DiagnosticCode}: an adapter supplies
 * the location and the consequence, and core decides everything else, so an
 * adapter must not be able to raise an arbitrary code through that path.
 * Declared with `Extract` so renaming a code breaks compilation here rather
 * than silently widening the set. One code today, but the set is the contract,
 * not the count.
 */
export type CrossProviderCode = Extract<DiagnosticCode, 'SKILL_DISCOVERY_OVERLAP'>;
