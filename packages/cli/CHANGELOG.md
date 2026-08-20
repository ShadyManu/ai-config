# Changelog

All notable changes to `@aiconfig/cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.3.1] - 2026-08-20

### Changed

- Released in lockstep with version 1.3.1 of the VS Code extension, which adds
  compatibility with editors based on VS Code API 1.107. CLI behavior is
  unchanged.
- The public README now presents the `.ai/` directories consistently and links
  to the introductory video and GitHub support.

## [1.3.0] - 2026-08-20

### Security

- Removing generated files now refuses to run on a refused path, as `sync`
  already did. The compiler exposes this as `clean`, which the VS Code extension
  reaches through **Delete Generated Files** and **Remove AI Config from This
  Project**; the CLI has no `clean` command in v1. The manifest records paths,
  not the files they resolve to, so a generated directory that had since become
  a symbolic link would have had its target unlinked — outside the repository,
  in the worst case. Removal is the irreversible half of the pipeline and was
  the last place still making an exception for a refused path. It refuses on an
  unreadable manifest for the same reason: that file is the sole authority on
  what may be deleted. It does **not** refuse merely because `.ai/` fails to
  validate — see below.
- A generated path must now land exactly where it says it does. Containment
  previously asked only whether a path stayed somewhere inside the repository,
  which `.claude -> .ai` and `.claude -> src` both satisfy while redirecting
  output onto files no provider owns — the canonical sources among them. Any
  symbolic link along a generated path is refused, whether it leaves the
  repository or not, and `.ai/` is never a generated target. The check is
  anchored to the resolved root, so a repository living under a symlinked
  parent is unaffected.
- Paths that fail containment are no longer probed. Reading them followed the
  very link the check had just refused, holding the boundary for writes while
  leaking it for reads, and an unreadable target turned a clean diagnostic into
  an exception.
- `.ai/config.yaml`, `.ai/providers/` and each provider's overlay directory are
  checked for containment before they are read. Only the canonical content
  directories were covered before, so a symlinked configuration directory could
  supply the file that decides which providers run.

### Added

- `aiconfig remove <kind> <name>`, `aiconfig clean`, `aiconfig providers
  <enable|disable> <provider>` and `aiconfig restore <path>`. Every operation
  the VS Code view offers now has a command, and both front ends call the same
  compiler function, so neither can do more or less than the other: `remove`
  runs `removeArtifact` behind **Delete…**, `clean` runs `clean` behind **Delete
  Generated Files**, `restore` runs `restore` behind **Restore Generated File**,
  and `providers` runs the provider toggle. A parity suite runs each command and
  the view's own call on two copies of one project and compares the whole
  working tree.

  `aiconfig providers disable` has no equivalent in the view, which can only
  enable. `Remove AI Config from This Project` has no command: it deletes `.ai/`
  as well, and the extension can send it to the system trash where a CLI could
  only unlink it.

- `aiconfig init` reports provider files that already exist in the repository,
  as the guided flow does, and states that they stay the author's — AI Config
  has no ownership record for them, so it will not overwrite, delete or adopt
  them.

### Changed

- Removing the generated files does not require `.ai/` to be valid. An invalid
  source says nothing about whether a generated file may be removed: removal
  reads the manifest rather than the sources, and re-verifies each file before
  deleting it. Refusing there would withdraw the last way back from a repository
  that can no longer synchronize, at exactly the moment somebody reaches for it.

- An override file that refines nothing is no longer an error:
  `OVERRIDE_TARGET_MISSING`, `OVERRIDE_NOT_SUPPORTED` and
  `OVERRIDE_NOT_APPLICABLE` when they are raised while reading `.ai/providers/`.
  All three describe a file that contributes nothing to any provider, so the
  generated output is exactly what it would be without it — and an error there
  blocked `sync` **and** `clean`. Deleting a canonical artifact by hand and
  leaving its override behind was enough to reach a state where the problem was
  reported and every means of resolving it had been withdrawn, including
  removing the generated files. The same codes remain errors where a command
  was asked to do something and could not: `override create` on an artifact
  that declines it, `override remove` on a file that is not there.

- A provider override whose canonical artifact no longer exists is removed by
  the next synchronization, and `OVERRIDE_TARGET_MISSING` is now informational:
  it announces that removal rather than asking anyone to act. An override
  refines an artifact and means nothing without it, so when the artifact goes,
  everything that belonged to it goes — the generated files, which was already
  true, and now the overrides, which were the exception. It no longer matters
  whether the artifact was removed from the AI Config view or deleted in an
  editor; both end in the same place.

  This is the one thing a synchronization removes under `.ai/`. It still never
  creates or modifies a file there, it removes nothing else, each removal is
  named in the output and in `--json`, and `sync --dry-run` reports it without
  doing it. Nothing can produce an override in that state: an override is always
  written against an artifact that exists.

  A **disabled** provider's overrides are untouched, as before — its overlay is
  never read, so re-enabling still restores every setting exactly.

  `OVERRIDE_NOT_SUPPORTED` and `OVERRIDE_NOT_APPLICABLE` stay warnings and their
  files stay: those describe an override this provider can never apply, and AI
  Config does not know what the author meant by it.

- `aiconfig init` no longer writes a placeholder `.ai/instructions/general.md`.
  It was content AI Config invented, in a directory that belongs entirely to the
  author, and every project began by rewriting or deleting it. The four content
  directories are still created, empty, so the structure is visible without
  anything being put in the author's mouth.

### Fixed

- `update` and `restore` re-verify the file immediately before replacing it,
  the way `delete` already did, and report `TARGET_CHANGED_DURING_SYNC` when it
  no longer matches what planning saw. A save landing in the gap between the
  working-tree snapshot and the write was previously overwritten without a
  word, which is exactly what drift protection exists to prevent. Ownership is
  retained, so the next run reports drift rather than refusing the file.
- A manifest that cannot be written is reported as `MANIFEST_WRITE_FAILED`
  instead of throwing past the diagnostic machinery. The generated files are
  already on disk at that point; the diagnostic names the ones nothing claims,
  which is what makes the state recoverable rather than a puzzle on the next
  run.
- `aiconfig init` creates its starter files exclusively, so its refusal to
  replace an existing `.ai/` also covers a file that appears between the check
  and the write.
- `--force` is described accurately in `--help`. It replaces AI Config's own
  modified output; it has never replaced a file AI Config did not write, and no
  flag does.
- Enabling or disabling a provider no longer rewrites `.ai/config.yaml` from
  scratch when the `providers` block contains a comment or a key other than
  `enabled`. The targeted splice gave up on both, and the re-render that took
  over kept only `schema` and `providers.enabled` — so a comment anywhere in the
  file, including the header `init` writes, disappeared because of an unrelated
  line further down. The splice now steps over comments and sibling keys, and
  matches `enabled` only at the block's own indentation, so a nested key such as
  `providers.settings.<provider>.enabled` is never mistaken for the provider
  list. A comment between two list items is still dropped — the list is rebuilt
  from the resolved set and an annotation on one entry has nowhere to go — but
  the entries below it are no longer emitted twice.

### Removed

- The `INSTRUCTION_DISCOVERY_OVERLAP` diagnostic. It warned that GitHub Copilot
  also reads the `AGENTS.md` generated for Codex and OpenCode, so instructions
  reach Copilot twice. The condition is real but benign — both copies come from
  the same canonical source and cannot disagree, and Copilot's scoped channel
  keeps matching by path — while its one substantive consequence, a scoped
  instruction arriving unscoped, is already reported per instruction as
  `INSTRUCTION_SCOPE_NOT_SUPPORTED` against the file the author can change. The
  warning could not be resolved or suppressed, so it appeared on every run
  forever, which is how a diagnostic set loses its credibility.
  `SKILL_DISCOVERY_OVERLAP` is unaffected: it reports genuinely undefined
  behavior, since no provider documents which copy of a re-discovered skill
  wins. `docs/providers/copilot.md` now describes the `AGENTS.md` overlap and
  how to switch it off in the client.

  Diagnostic codes are part of the public contract, so removing one is a
  breaking change. Nothing fails that did not fail before: the code simply
  stops being emitted.

- The unused `UNKNOWN_SYNC_SETTING` and `INVALID_SYNC_SETTINGS` diagnostic
  codes, left over from a `sync` configuration key that no released build ever
  accepted.

- The unused `UNKNOWN_PROVIDER_SETTING` and `INVALID_PROVIDER_SETTINGS`
  diagnostic codes, reserved for a `providers.settings` key that was never
  implemented. Declaring a code no code path raises is a promise the compiler
  does not keep, and this is the second pair to be removed for it — so the
  contract is now enforced from both sides: every declared code must be emitted
  by production code and asserted by at least one test.

## [1.2.0] - 2026-08-19

### Added

- `aiconfig init` writes `.ai/generation-rules.md`: a two-part reference stating
  where every artifact kind is generated for each provider, and which fields
  each provider accepts in an override. It is derived by compiling a probe
  configuration with the real adapters, so it describes what the build actually
  emits rather than what documentation claims.
- `aiconfig rules` prints that reference. Nothing refreshes the file in place,
  because a synchronization never writes into `.ai/`; redirect this after an
  upgrade instead:

  ```sh
  aiconfig rules > .ai/generation-rules.md
  ```

### Changed

- `aiconfig init` no longer creates an empty `.ai/providers/<provider>/`
  directory for every enabled provider. One is created with the first override
  written into it, so the tree shows what is actually configured. Git never
  tracked the empty ones anyway.
- Deleting a generated file now removes the directory it leaves empty, and the
  parents that become empty in turn. A directory still holding anything —
  including a file AI Config did not generate — is left alone.

## [1.1.0] - 2026-08-18

### Changed

- A provider field AI Config does not recognize is now a warning rather than an
  error, and is written to the generated file unchanged. The same applies to an
  unrecognized value of a known field. A field the canonical artifact owns, and
  a field a provider has retired, are still refused.

  This means a field or value a provider ships after this release is usable
  immediately, without waiting for an AI Config update. The trade-off is that a
  typo is reported as a warning, so run `aiconfig validate --check` in CI to
  keep warnings failing the build.

- `override create --set` accepts a field it does not know, for the same reason,
  resolving the value the way YAML would resolve the same scalar. Setting a
  canonical field through `--set` is now reported as a canonical-field error
  rather than as an unknown field.

### Fixed

- Provider option metadata was verified against the schemas the providers
  actually ship, correcting values that did not exist and adding ones that were
  missing:
  - Claude Code `permissionMode` accepts the documented `manual` alias.
  - Codex `sandbox_mode` removes undocumented `external-sandbox`, and
    `model_reasoning_effort` removes undocumented `none` while retaining the
    subagent-specific `max` and `ultra` levels.
  - Copilot `excludeAgent` is a single documented value, not a list.
  - Copilot custom agents model structured `handoffs`, prioritized `model`
    lists, string-only `metadata`, IDE/cloud distinctions, and Preview `hooks`;
    undocumented `advancedOptions` is removed.
  - Codex agent overrides expose a curated set of documented session controls,
    and Codex skill overrides support `dependencies.tools` while reserving the
    canonical `allowed-tools` field.
  - Copilot skills expose VS Code's invocation and fork-context fields, Claude
    compatibility commands accept `metadata`, `license`, and `compatibility`,
    and OpenCode warns when it ignores canonical `allowed-tools`.
- An unrecognized field passed validation but was dropped before the generated
  file was written, so it never reached the provider.
- A YAML timestamp scalar resolves to a date and was treated as an empty
  mapping instead of being rejected.

## [1.0.0] - 2026-08-18

First release. Implements AI Config Specification v0.1.
