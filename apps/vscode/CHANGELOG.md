# Changelog

All notable changes to the AI Config extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

The extension and `@aiconfig/cli` carry the same version, because each bundles
its own copy of the same compiler. Two different versions in one repository
would emit different files from the same `.ai/`, and each would read the other's
output as drift. The shared number is what says which compiler you are running.

## [1.4.0] - 2026-08-22

### Added

- Renaming an artifact follows, whichever half of it you rename. A canonical
  artifact carries its name twice — in the path, and in the `name` field — and
  they have to agree. Change `name` in the file and the file or directory is
  renamed to match, together with every provider override written for it under
  `.ai/providers/`. Rename the file or directory in the explorer and the `name`
  field is rewritten instead. Either way the project is valid again on save.

  Which of the two you edited is worked out from the state before the edit, not
  guessed, so neither direction undoes the other — renaming a directory in the
  explorer is not silently renamed back. When it cannot be worked out, because
  the project was already in this state when it was opened or because both names
  are taken, you are asked which one wins rather than having one picked for you.

  A rename that would overwrite something is refused and nothing moves. The
  generated provider files are not renamed directly: they become orphans the
  moment the source moves, and the synchronization that follows removes them
  after re-verifying each one still holds the bytes AI Config wrote, so a
  generated file you had edited is reported rather than discarded.

  The move is applied as a workspace edit — the same operation the explorer's own
  Rename performs — so a `SKILL.md` open while its directory is renamed follows
  the move instead of becoming a tab pointing at a path that no longer exists.
  That tab holds the file you were editing, since editing its `name` is what
  asked for the rename in the first place.

### Changed

- OpenCode agent overrides know every model option OpenCode documents:
  `reasoningEffort`, `textVerbosity`, `reasoningSummary`, `thinking` and
  `include`. All five were flagged in the Problems panel as fields AI Config did
  not recognize, which is what a documented option must never be. The guided
  flows now offer them too.

- An OpenCode agent option AI Config still does not know is shown as a hint
  rather than a yellow warning. OpenCode documents an open agent configuration —
  any option it does not define is forwarded to the model provider as a model
  option — so an unfamiliar field there is probably correct, and a warning said
  otherwise on every save.

  It is still shown. A typo looks exactly like a model option nobody has
  documented yet, and saying nothing would let `temperatur: 0.5` through in
  silence; the hint claims only that nothing checked the field, and lists the
  ones AI Config does know in case one of them was meant. Every other provider's
  schema is documented as closed and still warns, and a canonical field or a
  retired one is refused outright everywhere.

### Fixed

- Renaming an artifact's file no longer deletes the provider overrides written
  for it. An override is addressed by name — `.ai/providers/claude/agents/
  reviewer.yaml` — so once `reviewer.md` became `auditor.md`, the override
  refined an artifact that no longer existed and the synchronization that runs
  on save removed it as an orphan. A file you wrote, gone without being asked.

  Both halves of a rename now carry the overrides with them: changing the `name`
  field already did, and renaming the file or directory now does too.

  An instruction, agent or command scaffolded by AI Config declares no `name` at
  all, so renaming its file leaves nothing in the file to recognize the rename
  by. Two things stand in for it. A rename made in the explorer is reported by
  the editor itself, which is exact — it works even when the file is renamed and
  rewritten in one go. A rename made anywhere else, by `git mv` or another
  program, is matched by content: same kind, same description, same body, a
  different name than the previous refresh saw.

  That second match is deliberately strict, because it is an inference rather
  than a fact. An artifact renamed *and* edited outside the editor, or one that
  reads exactly like another, reports nothing and behaves as before rather than
  attaching one artifact's settings to another. A refresh that merely observes
  a missing artifact preserves its overrides; the explicit Delete action still
  removes the artifact and its overrides together.

- Every generated file listed under a provider opens something when clicked.
  Only the drifted rows did: they were the ones with a diff to show and a
  restore to offer, and that decision about those two actions quietly became the
  answer for clicking as well. A row naming a stale, orphaned or conflicting file
  did nothing at all, which reads as broken rather than as deliberate.

  A drifted file still opens the diff. A stale, orphaned or conflicting file
  opens the file itself — a conflicting one especially, since the question it
  raises is "what is this file AI Config will not touch?". A missing file has
  nothing on disk yet, so it opens a read-only preview of what the next
  synchronization would write there. Every row also carries a tooltip saying
  what its state means.

### Removed

- The `SKILL_DISCOVERY_OVERLAP` warning. It reported that enabling several
  providers makes the same skill reachable from several directories, and that
  none of them documents which copy wins.

  The condition is real; the warning was not actionable. Every copy is compiled
  from the same canonical skill and is identical, Copilot and OpenCode both
  deduplicate by name, and nothing you can write in `.ai/` changes it — Claude
  Code reads only `.claude/skills` and Codex only `.agents/skills`, so no copy
  can be withheld. It sat in the Problems panel on every save of an ordinary
  four-provider project with no way to resolve or silence it, which is how a
  Problems panel stops being read.

  What the duplication actually costs each tool is now in
  `docs/providers/opencode.md` and `docs/providers/copilot.md` — including an
  open defect in OpenCode's own discovery that costs prompt cache reuse. Those
  belong to those tools, not to your configuration.

- A YAML error in a canonical file now explains the mistake instead of only
  quoting the parser. "Unexpected scalar at node end" is what the parser says
  about a quoted `description:` containing another quotation mark, which is the
  most likely way to break a file: scaffolding writes `description: "TODO: …"`
  already quoted, and pasted prose brings its own quotes. The message now
  continues with the offending character, its column, and the three ways out —
  escape it, switch the outer quotes, or use a block scalar. Unterminated
  quotes, tabs used as indentation, and unquoted values containing a colon are
  explained the same way.

- Diagnostics for YAML errors point at the line and column that failed rather
  than at the first line of the frontmatter block, so **Go to File** lands on
  the mistake.

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
