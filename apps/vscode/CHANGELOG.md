# Changelog

All notable changes to the AI Config extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

The extension and `@aiconfig/cli` carry the same version, because each bundles
its own copy of the same compiler. Two different versions in one repository
would emit different files from the same `.ai/`, and each would read the other's
output as drift. The shared number is what says which compiler you are running.

## [1.3.1] - 2026-08-20

### Changed

- Lowered the minimum VS Code API requirement from 1.125 to 1.107, enabling
  installation in Google Antigravity and other compatible VS Code-based
  editors. The extension is compiled against the 1.107 API type definitions to
  prevent accidental use of newer APIs.
- The Marketplace README now presents the canonical directories in the same
  alphabetical order as the sidebar, links to the introductory video, and
  directs support to GitHub Issues.
- The welcome view and sidebar support link now open GitHub Issues instead of a
  generic contact page.

## [1.3.0] - 2026-08-20

First release of the extension, numbered with the project rather than from
1.0.0: `@aiconfig/cli` was already at 1.2.0, and the two share a version for the
reason stated above. Implements AI Config Specification v1.

### Added

- Compile a canonical `.ai/` directory into configuration for Claude Code,
  OpenAI Codex, GitHub Copilot and OpenCode.
- Commands: **AI Config: Initialize Project**, **Synchronize**, **Validate**,
  **Show Status**, plus **Refresh**, **Show Output Log**, **Show Diff** and
  **Restore Generated File**.
- **Delete Generated Files**, which removes every file AI Config generated and
  keeps the canonical sources, and **Remove AI Config from This Project**, which
  removes those files and the `.ai/` directory with them, returning the project
  to its uninitialized state. Both confirm through a modal that counts what is
  about to be lost; the second sends `.ai/` to the system trash, since it holds
  work no tool can recreate. Reachable from the view's overflow menu, the
  right-click menu on the Configuration section, and the command palette —
  findable without sitting one stray click from Synchronize.
- **Initialize Project** writes `.ai/generation-rules.md`, a two-part reference
  stating where each artifact kind is generated for every provider and which
  fields each provider accepts. It is derived by compiling a probe with the real
  adapters, so it describes what this build emits.
- Activity bar view listing canonical instructions, agents, skills and
  commands, and the status of every provider. Each artifact row carries **Edit**
  and **Delete...**; deleting removes the canonical source and every provider
  override written for it, then synchronizes so the files generated from it are
  removed as orphans. Provider directories under `.ai/providers/` that the
  removal emptied are pruned, `.ai/providers/` included.
- Each provider row carries the one action that applies to it: **+** on a
  disabled provider adds it to `.ai/config.yaml` and synchronizes in one step,
  so its files exist by the time the row reports it as enabled, and **Remove
  Provider...** on an enabled one disables it, deletes the files generated for
  it, and sends its `.ai/providers/<provider>/` directory to the system trash.
  The confirmation names what each of those will remove, counting every file in
  that directory rather than only the overrides in it. A file another enabled
  provider also produces is kept, and a synchronization that could not run
  leaves the provider-specific sources in place, so re-enabling the provider
  restores the project as it was. Enabling writes to `.ai/config.yaml` and
  nowhere else: a provider directory appears when an override is written for
  it, never before, so an empty one never claims settings that do not exist.
- Status bar item summarizing whether the repository is synchronized.
- Validation problems reported as diagnostics against the `.ai/` file that
  caused them, with a **Go to File** action on the notification shown when
  synchronization is blocked, opening that file at the reported line.
- A warning when the enabled provider combination makes one provider
  re-discover skills AI Config generated for another
  (`SKILL_DISCOVERY_OVERLAP`), reported against `.ai/config.yaml`, where the
  provider set is decided.
- Drift detection for generated files, inspectable in VS Code's diff editor.
- Automatic synchronization when a `.ai/` file changes and the configuration is
  valid.
- `AI Config` output channel logging configuration loads, syncs and writes.
- Multi-root workspace support, prompting for a folder when more than one is
  initialized.

### Notes

- Compilation is deterministic and entirely local. No LLM, network access,
  account or telemetry is involved.
- AI Config only modifies files it generated, tracked in `.ai/.generated.json`.
  A file it did not create is never overwritten.
- A generated path must land exactly where it says it does. Any symbolic link
  along it is refused, whether or not it leaves the repository, and `.ai/` is
  never a generated target.
- A write that would replace a file changed since planning is refused rather
  than silently applied, and deletion stops whenever analysis could not
  establish what it was about to remove.
- Generated files carry only frontmatter fields documented for the target
  surface. VS Code supports instruction `name` and `description`, but GitHub's
  broader Copilot instruction documentation does not, so the canonical
  description remains prose for cross-surface compatibility.
