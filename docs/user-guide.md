# AI Config user guide

Write your AI coding configuration once, in `.ai/`. AI Config compiles it into
the native format each assistant reads, keeps track of every file it generated,
and refuses to overwrite anything it does not own.

- [Getting started](#getting-started)
- [How it fits together](#how-it-fits-together)
- [Instructions](#instructions)
- [Agents](#agents)
- [Skills](#skills)
- [Commands](#commands)
- [Provider override reference](#provider-override-reference)
- [Command line](#command-line)
- [Ownership, drift and safety](#ownership-drift-and-safety)

---

## Getting started

### In VS Code

1. Run **AI Config: Initialize Project** from the Command Palette.
2. Choose the assistants this repository should stay in sync with.
3. Use the **Add** menu at the top of the AI Config sidebar to create an
   instruction, agent, skill or command. Each flow asks for a name, which
   decides the file it creates.
4. Answer the few structural questions that remain — whether an instruction is
   path-scoped, which supporting directories a skill needs, and which
   provider-specific settings to include.
5. AI Config scaffolds valid source files and opens them.
6. Write the description, the prompt or instructions, and any provider values
   directly in the editor.
7. AI Config synchronizes automatically after a valid change; **AI Config:
   Synchronize** runs it on demand.

The guided flows collect **structure, not content**. They never ask for a
description, a system prompt, an instruction body or a provider value through an
input box: those are long-form text, and a one-line input box is the wrong place
to write them. What you get instead is a valid file with `TODO` placeholders,
open in the editor, where the same text is easy to write, review and revise.

Every step uses ordinary VS Code inputs. Nothing you can do through the guided
flows is anything you could not also write by hand.

A scaffolded artifact is valid immediately, so nothing is broken while you fill
it in. A scaffolded provider override has every setting you chose written as a
commented placeholder; until you uncomment one, the file is valid and changes
nothing, which AI Config reports as an informational `OVERRIDE_EMPTY`.

Once an override exists, the YAML file is the way to edit it: **Edit Override**
opens it, and it already lists every setting you chose with its type, its
default, and a link to the provider's documentation.

### On the command line

```bash
aiconfig init --providers claude,codex,copilot,opencode
aiconfig add agent reviewer --description "Reviews changes for correctness"
aiconfig override create claude agent reviewer --set model=sonnet
aiconfig sync
```

---

## How it fits together

```
.ai/
├── agents/                specialist helpers
├── commands/              prompts you invoke explicitly
├── instructions/          rules that are always in context
├── providers/             optional provider-specific refinements
├── skills/                procedures loaded on demand
└── config.yaml            which providers are enabled
```

There are exactly two kinds of file:

**Portable artifacts** — `.ai/<kind>/<id>` — contain only fields that mean the
same thing to every assistant. Each one is compiled to **every enabled
provider**.

**Provider refinements** — `.ai/providers/<provider>/<kind>/<id>.yaml` — contain
only settings that are specific to one assistant. They never repeat anything the
portable artifact already says, and they never change which providers an
artifact reaches.

Everything under `.ai/` is yours. AI Config writes there only when you ask it
to: `init`, a guided Add action, an explicit override action, or a CLI
scaffolding command. **`aiconfig sync` never creates or modifies a file under
`.ai/`.**

It does not remove authored files there. If a provider override's canonical
artifact no longer exists, AI Config reports the situation and preserves the
override. It may be a rename, a branch switch, or an artifact that will be
restored later. Remove it explicitly when that is your intent. Generated files
are still cleaned up according to the ownership manifest.

### Enabled providers

```yaml
# .ai/config.yaml
schema: 1
providers:
  enabled:
    - claude
    - opencode
```

Disabling a provider stops generating its output and removes what AI Config
previously generated for it. It never deletes that provider's override files
under `.ai/providers/`, so re-enabling it restores your settings exactly.

**Remove Provider…** in the VS Code view is the one exception: it disables the
provider and then deletes `.ai/providers/<provider>/` as well, after saying so
in the confirmation. It is offered as a single action because removing an
assistant you no longer use and leaving its settings behind is rarely what was
meant. The command line never deletes them: `aiconfig providers disable` keeps
the directory.

---

## Instructions

### What it is

Standing rules that are loaded into context for every request — build commands,
conventions, architectural boundaries. Optionally limited to files matching a
set of globs.

### File location

`.ai/instructions/<id>.md`

### Complete example

```markdown
---
description: Backend service conventions
applyTo:
  - "backend/**"
  - "services/**/*.ts"
---

Every service exposes its dependencies as constructor parameters.

Database access goes through a repository type; no handler talks to the driver
directly.
```

### Supported canonical fields

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `name` | No | String, must match the filename | Identifier. Taken from the filename; the field is optional and must agree with it. | filename |
| `description` | No | String | One line on what the instruction covers. Carried into the body for providers with no description field. | — |
| `applyTo` | No | String, or list of repository-relative POSIX globs | Limits the instruction to matching files. Omit it to apply everywhere. | applies everywhere |
| body | Yes | Markdown | The instruction text. | — |

### Provider-specific options

| Provider | Override available? | Override path | Supported provider-specific fields |
| --- | --- | --- | --- |
| Claude Code | No | — | — |
| Codex | No | — | — |
| GitHub Copilot | Yes, path-scoped instructions only | `.ai/providers/copilot/instructions/<id>.yaml` | `excludeAgent` |
| OpenCode | No | — | — |

Claude Code documents exactly one frontmatter field for a rules file, `paths`,
which is the canonical `applyTo`. Codex and OpenCode read instructions from
`AGENTS.md`, which has no frontmatter at all. See
[Copilot instruction override](#copilot-instruction-override).

### Generated outputs

| Provider | Generated path | Capability | Notes |
| --- | --- | --- | --- |
| Claude Code | `.claude/rules/<id>.md` | exact | `applyTo` becomes `paths`. |
| Codex | `AGENTS.md` | exact unscoped, lossy scoped | One aggregated file. Globs are recorded as prose and are not enforced. |
| GitHub Copilot | `.github/copilot-instructions.md` (unscoped)<br>`.github/instructions/<id>.instructions.md` (scoped) | exact | Copilot joins multiple globs with commas. |
| OpenCode | `AGENTS.md` | exact unscoped, lossy scoped | Same aggregation and same limitation as Codex. |

### Capability notes

Codex and OpenCode have no path scoping. A scoped instruction still reaches
them, but it applies everywhere, and AI Config reports
`INSTRUCTION_SCOPE_NOT_SUPPORTED` for each one rather than letting the
difference pass silently.

When Copilot is enabled alongside Codex or OpenCode, Copilot also reads the
generated `AGENTS.md`, so every instruction reaches it twice. This is not
reported: the content is identical to what Copilot already receives through
`.github/`, and its scoped channel keeps matching as before. See
[GitHub Copilot](providers/copilot.md) for what the repetition does and does not
change.

### Common errors

| Code | Cause |
| --- | --- |
| `INSTRUCTION_BODY_EMPTY` | The file has frontmatter but no instruction text. |
| `INVALID_APPLY_TO` | A glob is absolute, uses backslashes, or is not a string. |
| `INSTRUCTION_EMPTY_APPLY_TO` | `applyTo: []`. Remove the field instead. |
| `INVALID_APPLY_TO` (Copilot) | A pattern contains a comma, which Copilot uses as its own separator. Split it into two patterns. |
| `OVERRIDE_NOT_APPLICABLE` | A Copilot override on an instruction with no `applyTo`. |

### Complete examples

An unscoped instruction:

```markdown
---
description: Project-wide engineering guidelines
---

Run `pnpm test` before proposing a change.

Prefer small, focused modules with one clear responsibility.
```

A scoped instruction with a Copilot refinement:

```markdown
<!-- .ai/instructions/backend.md -->
---
description: Backend service conventions
applyTo:
  - "backend/**"
---

Database access goes through a repository type.
```

```yaml
# .ai/providers/copilot/instructions/backend.yaml
schema: 1
options:
  excludeAgent: code-review
```

---

## Agents

### What it is

A named specialist an assistant can delegate to — a reviewer, a migration
writer, a test author. The body becomes the agent's system prompt.

### File location

`.ai/agents/<id>.md`

### Complete example

```markdown
---
description: Reviews changes for correctness and clarity without modifying files
---

You are a code reviewer.

Read the change and report findings ordered by severity. For each finding give
the file, the problem, and a concrete fix. Do not modify any file.
```

### Supported canonical fields

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `name` | No | String, must match the filename | Identifier. Taken from the filename. | filename |
| `description` | Yes | String | When an assistant should delegate to this agent. | — |
| body | Yes | Markdown | The agent's system prompt. | — |

### Provider-specific options

| Provider | Override available? | Override path | Supported provider-specific fields |
| --- | --- | --- | --- |
| Claude Code | Yes | `.ai/providers/claude/agents/<id>.yaml` | `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `memory`, `effort`, `background`, `isolation`, `color`, `initialPrompt`, `mcpServers`, `hooks` |
| Codex | Yes | `.ai/providers/codex/agents/<id>.yaml` | `model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `personality`, `sandbox_mode`, `approval_policy`, `web_search`, `service_tier`, `tools.view_image`, `mcp_servers` |
| GitHub Copilot | Yes | `.ai/providers/copilot/agents/<id>.yaml` | `target`, `tools`, `model`, `disable-model-invocation`, `user-invocable`, `mcp-servers`, `metadata`, `argument-hint`, `handoffs`, `agents`, `hooks` |
| OpenCode | Yes | `.ai/providers/opencode/agents/<id>.yaml` | `mode`, `model`, `temperature`, `top_p`, `steps`, `disable`, `hidden`, `color`, `permission`, `reasoningEffort`, `textVerbosity`, `reasoningSummary`, `thinking`, `include`, plus any other model option |

### Generated outputs

| Provider | Generated path | Capability | Notes |
| --- | --- | --- | --- |
| Claude Code | `.claude/agents/<id>.md` | exact | `name` and `description` in frontmatter; override fields follow. |
| Codex | `.codex/agents/<id>.toml` | exact | Body becomes `developer_instructions`. Mapping options become TOML tables. |
| GitHub Copilot | `.github/agents/<id>.agent.md` | exact | Body limited to 30,000 characters. |
| OpenCode | `.opencode/agents/<id>.md` | exact | No `name` field: OpenCode takes it from the filename. `mode: subagent` unless an override sets `mode`. |

### Capability notes

GitHub Copilot documents a 30,000-character maximum for an agent body. A longer
body is an error rather than a truncated file; move the detail into a skill.

### Common errors

| Code | Cause |
| --- | --- |
| `MISSING_DESCRIPTION` | An agent must have a description. |
| `AGENT_BODY_EMPTY` | The body becomes the system prompt, so it cannot be empty. |
| `AGENT_BODY_TOO_LONG` | Over Copilot's 30,000-character limit. |
| `OVERRIDE_CANONICAL_FIELD` | The override sets `name`, `description` or `prompt`. Those live in the canonical agent. |

### Complete examples

```markdown
<!-- .ai/agents/reviewer.md -->
---
description: Reviews changes for correctness and clarity without modifying files
---

You are a code reviewer. Report findings ordered by severity.
```

```yaml
# .ai/providers/claude/agents/reviewer.yaml
schema: 1
options:
  tools:
    - Read
    - Grep
    - Glob
  model: sonnet
  permissionMode: plan
```

```yaml
# .ai/providers/opencode/agents/reviewer.yaml
schema: 1
options:
  temperature: 0.1
  permission:
    edit: deny
    bash: ask
```

---

## Skills

### What it is

A procedure an assistant loads when it becomes relevant: a directory with a
`SKILL.md` and any supporting files. Unlike an instruction, it costs nothing
until it is used.

### File location

`.ai/skills/<id>/SKILL.md`, plus any files you add beside it.

### Complete example

```markdown
---
name: code-review
description: Reviews a change against the project checklist, covering correctness, tests, and public API impact. Use before opening a pull request.
---

# Code review

1. Read `references/checklist.md` and work through it in order.
2. Note every finding with its file and line.
3. Report findings ordered by severity, with a concrete fix for each.
```

### Supported canonical fields

Every provider reads the same directory-based format, and AI Config copies the
whole directory **byte for byte**. That means `SKILL.md` is yours: fields beyond
the two required ones pass through untouched.

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `name` | Yes | String, must match the directory name | Skill identifier. | — |
| `description` | Yes | String, at most 1024 characters | What the skill does and when to use it. | — |
| `license` | No | String | Part of the Agent Skills specification. | — |
| `compatibility` | No | String | Part of the Agent Skills specification. | — |
| `metadata` | No | Mapping | Free-form data for your own tooling. | — |
| `allowed-tools` | No | Space-separated string (experimental) | Tools pre-approved while the skill runs. Support varies by provider; OpenCode currently ignores it. | — |
| body | Yes | Markdown | The skill instructions. | — |

Because these are read identically by more than one assistant, set them here
once rather than in a provider override.

### Provider-specific options

| Provider | Override available? | Override path | Supported provider-specific fields |
| --- | --- | --- | --- |
| Claude Code | Yes | `.ai/providers/claude/skills/<id>.yaml` | `when_to_use`, `disable-model-invocation`, `user-invocable`, `argument-hint`, `arguments`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`, `paths`, `shell`, `hooks` |
| Codex | Yes | `.ai/providers/codex/skills/<id>.yaml` | `policy.allow_implicit_invocation`, `interface.display_name`, `interface.short_description`, `interface.icon_small`, `interface.icon_large`, `interface.brand_color`, `interface.default_prompt`, `dependencies.tools` |
| GitHub Copilot | Yes | `.ai/providers/copilot/skills/<id>.yaml` | `argument-hint`, `user-invocable`, `disable-model-invocation`, `context` |
| OpenCode | No | — | — |

No provider-specific override is supported for an OpenCode skill. OpenCode
recognizes the five stable specification fields and ignores `allowed-tools`;
AI Config preserves the canonical file and emits
`SKILL_ALLOWED_TOOLS_UNSUPPORTED` when that experimental field is present.

### Generated outputs

| Provider | Generated path | Capability | Notes |
| --- | --- | --- | --- |
| Claude Code | `.claude/skills/<id>/**` | exact | Copied byte for byte. With an override, `SKILL.md` gains the override lines at the end of its existing frontmatter; nothing else changes. |
| Codex | `.agents/skills/<id>/**` | exact | Copied byte for byte. An override adds `agents/openai.yaml` beside it. |
| GitHub Copilot | `.github/skills/<id>/**` | exact | Copied byte for byte. With an override, `SKILL.md` gains only the Copilot-specific lines. |
| OpenCode | `.opencode/skills/<id>/**` | exact except `allowed-tools` | Copied byte for byte; warns when OpenCode ignores canonical `allowed-tools`. |

### Capability notes

Claude Code, GitHub Copilot and OpenCode all scan `.claude/skills`,
`.agents/skills` and their own directory. With several providers enabled the
same skill is therefore reachable from more than one root.

AI Config does not report this. Every copy is compiled from the same canonical
skill and is byte-for-byte identical, and Copilot and OpenCode both deduplicate
by name, so the skill that loads is the same skill whichever copy it comes from.
Nor is there anything to act on: Claude Code reads only `.claude/skills` and
Codex only `.agents/skills`, so no copy those providers need can be withheld.

What each tool does with the duplication is described in
[docs/providers/](providers/) — including an open defect in OpenCode's discovery
that costs prompt cache reuse. Those are theirs to fix, and a warning on every
synchronization would not have made any of them go away.

### Common errors

| Code | Cause |
| --- | --- |
| `SKILL_MISSING` | The directory has no `SKILL.md`. |
| `NAME_MISMATCH` | Frontmatter `name` does not match the directory name. In VS Code this is resolved for you: whichever of the two you edited, the other follows. |
| `RENAME_TARGET_EXISTS` | A rename would overwrite something that is already there. |
| `RENAME_SOURCE_MISSING` | There is nothing at the old name to rename. |
| `SKILL_DESCRIPTION_LENGTH` | The description is over 1024 characters. |
| `SKILL_SYMLINK_SKIPPED` | Symbolic links are not followed, because the target may lie outside the repository. |
| `OVERRIDE_CANONICAL_FIELD` | A provider override sets a key the canonical `SKILL.md` already sets. Set it in one place. |
| `SKILL_ALLOWED_TOOLS_UNSUPPORTED` | A canonical skill uses `allowed-tools`, which OpenCode currently ignores. |

### Complete examples

```
.ai/skills/code-review/
├── SKILL.md
└── references/
    └── checklist.md
```

```yaml
# .ai/providers/claude/skills/code-review.yaml
schema: 1
options:
  disable-model-invocation: true
  paths:
    - "src/**/*.ts"
```

```yaml
# .ai/providers/codex/skills/code-review.yaml
schema: 1
options:
  policy:
    allow_implicit_invocation: false
```

---

## Commands

### What it is

A prompt you invoke deliberately, by name. Canonical commands are always
explicit: an assistant never selects one on its own.

### File location

`.ai/commands/<id>.md`

### Complete example

```markdown
---
description: Diagnose and fix a failing test
---

Reproduce the failure described in $ARGUMENTS.

Find the root cause, fix it, and confirm the test passes. Do not weaken the
assertion to make it pass.
```

### Supported canonical fields

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `name` | No | String, must match the filename | Identifier, and the name you type to invoke it. | filename |
| `description` | Yes | String | One line shown in the command list. | — |
| body | Yes | Markdown | The prompt. Argument placeholders such as `$ARGUMENTS` and `$1` pass through untranslated. | — |

### Provider-specific options

| Provider | Override available? | Override path | Supported provider-specific fields |
| --- | --- | --- | --- |
| Claude Code | Yes | `.ai/providers/claude/commands/<id>.yaml` | `metadata`, `license`, `compatibility`, `argument-hint`, `arguments`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`, `when_to_use`, `shell`, `hooks` |
| Codex | No | — | — |
| GitHub Copilot | Yes | `.ai/providers/copilot/commands/<id>.yaml` | `agent`, `model`, `tools`, `argument-hint` |
| OpenCode | Yes | `.ai/providers/opencode/commands/<id>.yaml` | `agent`, `model`, `subtask` |

No provider-specific override is required or supported for a Codex command in
v1. A command becomes a Codex skill, and the one command-relevant control that
skill format offers — `policy.allow_implicit_invocation` — is already fixed to
`false` by the explicit-only meaning of a canonical command.

For the same reason, no provider override may set `disable-model-invocation` or
`user-invocable` on a command.

### Generated outputs

| Provider | Generated path | Capability | Notes |
| --- | --- | --- | --- |
| Claude Code | `.claude/commands/<id>.md` | exact | Always includes `disable-model-invocation: true`. |
| Codex | `.agents/skills/<id>/SKILL.md`<br>`.agents/skills/<id>/agents/openai.yaml` | exact | Invoked as `$name`, not `/name`. Implicit selection disabled. |
| GitHub Copilot | `.github/prompts/<id>.prompt.md` | lossy | Available in VS Code, Visual Studio and JetBrains IDEs only. |
| OpenCode | `.opencode/commands/<id>.md` | exact | The body is the command template. |

### Capability notes

Codex has no repository-scoped command mechanism; its custom prompts are
documented as deprecated and are user-scoped only. A command therefore becomes a
skill, reported as `COMMAND_CONVERTED_TO_SKILL`. The conversion loses nothing —
implicit invocation is switched off — but the syntax you type changes.

GitHub prompt files do not reach the Copilot cloud agent, Copilot code review or
the Copilot CLI, and GitHub documents them as in public preview. That is
reported as `COMMAND_LIMITED_SURFACE`.

### Common errors

| Code | Cause |
| --- | --- |
| `MISSING_DESCRIPTION` | A command must have a description. |
| `COMMAND_BODY_EMPTY` | The body is the prompt, so it cannot be empty. |
| `OVERRIDE_CANONICAL_FIELD` | The override sets `disable-model-invocation` or `user-invocable`, which canonical command semantics own. |

### Complete examples

```markdown
<!-- .ai/commands/fix-bug.md -->
---
description: Diagnose and fix a failing test
---

Reproduce the failure described in $ARGUMENTS, fix the root cause, and confirm
the test passes.
```

```yaml
# .ai/providers/claude/commands/fix-bug.yaml
schema: 1
options:
  metadata:
    audience: maintainers
  license: MIT
  compatibility: Requires git
  argument-hint: "[test name]"
  model: sonnet
  allowed-tools:
    - Read
    - Edit
```

```yaml
# .ai/providers/opencode/commands/fix-bug.yaml
schema: 1
options:
  agent: build
  subtask: true
```

---

## Renaming an artifact

An artifact's name appears twice: in the path — `.ai/skills/code-review/`,
`.ai/agents/reviewer.md` — and in the `name` field inside the file. They have to
agree, and `NAME_MISMATCH` is reported when they do not.

Either one can be edited. In VS Code the other follows on save:

- change `name` in the file, and the file or directory is renamed to match,
  together with every override written for it under `.ai/providers/`;
- rename the file or directory in the explorer, and the `name` field is
  rewritten to match.

Which of the two you edited is worked out from the state before the edit, so
neither undoes the other. When it cannot be worked out — the first refresh after
opening a project that was already in this state, or a project where both names
are taken — you are asked which one wins instead.

On the command line the same operation is one command:

```bash
aiconfig rename skill scouts scout
aiconfig rename agent reviewer code-reviewer
```

It refuses to overwrite: if something already exists at the new name, nothing is
moved and `RENAME_TARGET_EXISTS` says what is in the way.

The generated provider files are not renamed directly. They become orphans the
moment the canonical source moves, and the next synchronization removes them
after checking each one still holds the bytes AI Config wrote — so a generated
file you had edited by hand is reported rather than discarded.

## Provider override reference

Every override file has the same shape:

```yaml
schema: 1
options:
  <provider field>: <value>
```

`schema` is the override format version. `options` holds provider fields and
nothing else. The provider, artifact kind and artifact id come from the file's
path, so they cannot disagree with its contents.

### Fields and values AI Config does not know

The tables below are a snapshot of what each provider accepted when this release
was built. Providers add fields and accepted values on their own schedule, so
AI Config does not refuse what it does not recognize:

- an unrecognized **field** is reported as a warning and written to the
  generated file unchanged;
- an unrecognized **value** of a known field is reported as a warning and
  written through unchanged.

This means a field a provider shipped after this release is usable immediately,
without waiting for an AI Config update. The trade-off is that a typo is a
warning rather than an error, so check the Problems panel — or `aiconfig
validate` — when a setting does not behave as expected. Run `aiconfig validate
--check` in CI to make these warnings fail the build.

One provider goes further. OpenCode documents that any agent option it does not
itself define is forwarded to the model provider as a model option, so for an
OpenCode **agent** override an undeclared field is ordinary configuration. It is
still reported — a typo is indistinguishable from a new model option, and
silence would let one through — but as an informational note rather than a
warning, and the note says why the field is probably fine. Everywhere else,
OpenCode's own command overrides included, an undeclared field stays a warning.

A field the canonical artifact owns, and a field a provider has retired, are
still refused outright: both are known to be wrong rather than merely unknown.

If your editor flags a generated file that `aiconfig validate` considers
correct, the two are probably not using the same schema — see
[Editors that validate another provider's files](provider-capabilities.md#editors-that-validate-another-providers-files).

Rules that apply to all overrides:

- An override never repeats a canonical field. Setting one is an error.
- An unrecognized field is a warning and is written through unchanged; see
  above.
- Enumerations, ranges and types are checked before anything is generated.
- An override never changes which providers an artifact reaches.
- Omitting a field means the provider's own default applies. AI Config does not
  write a default back as though you had chosen it.
- An override with nothing set — a freshly scaffolded one, whose settings are
  all still commented out — is valid and inert. It is reported as an
  informational `OVERRIDE_EMPTY`, never as an error, so scaffolding one never
  blocks synchronization.

### Claude Code agent override

`.ai/providers/claude/agents/<id>.yaml`

```yaml
schema: 1
options:
  tools:
    - Read
    - Grep
  disallowedTools:
    - Write
  model: sonnet
  permissionMode: plan
  maxTurns: 12
  skills:
    - code-review
  memory: project
  effort: high
  background: false
  isolation: worktree
  color: cyan
  initialPrompt: Start by reading the failing test.
  mcpServers:
    - slack
  hooks:
    PreToolUse:
      - matcher: Bash
        command: ./scripts/audit.sh
```

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `tools` | No | List of strings | Allowlist of tools the subagent may use. | inherits all available |
| `disallowedTools` | No | List of strings | Tools removed from the inherited or specified list. | — |
| `model` | No | `sonnet`, `opus`, `haiku`, `fable`, a full model ID, or `inherit` | Model for this subagent. | `inherit` |
| `permissionMode` | No | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, `manual` | Permission mode. | inherits the parent session |
| `maxTurns` | No | Integer ≥ 1 | Maximum agentic turns before the subagent stops. | unlimited |
| `skills` | No | List of strings | Skills preloaded into the subagent's context. | — |
| `memory` | No | `user`, `project`, `local` | Persistent memory scope. | — |
| `effort` | No | `low`, `medium`, `high`, `xhigh`, `max` | Effort level while active. | inherits the session |
| `background` | No | Boolean | Keep the subagent in the background. | `false` |
| `isolation` | No | `worktree` | Run in a temporary git worktree. | — |
| `color` | No | `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan` | Display colour. | — |
| `initialPrompt` | No | String | First user turn when run as the main session agent. | — |
| `mcpServers` | No | List | Server names or inline definitions. | — |
| `hooks` | No | Mapping | Lifecycle hooks scoped to this subagent. | — |

Each field is written into the frontmatter of `.claude/agents/<id>.md`, after
`name` and `description`.

Reference: [Claude Code subagents](https://code.claude.com/docs/en/sub-agents).

### Claude Code skill override

`.ai/providers/claude/skills/<id>.yaml`

```yaml
schema: 1
options:
  when_to_use: When a pull request is ready for review.
  disable-model-invocation: true
  user-invocable: true
  argument-hint: "[pull request]"
  arguments:
    - pull-request
  disallowed-tools:
    - Write
  model: sonnet
  effort: high
  context: fork
  agent: reviewer
  background: true
  paths:
    - "src/**/*.ts"
  shell: bash
  hooks:
    Stop:
      - command: ./scripts/report.sh
```

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `when_to_use` | No | String | Extra trigger context, appended to the description in the skill listing. | — |
| `disable-model-invocation` | No | Boolean | Prevent Claude loading the skill automatically. | `false` |
| `user-invocable` | No | Boolean | Set false when only Claude should invoke it. | `true` |
| `argument-hint` | No | String | Autocomplete hint. | — |
| `arguments` | No | List of strings | Named positional arguments for `$name` substitution. | — |
| `disallowed-tools` | No | List of strings | Tools removed while the skill is active. | — |
| `model` | No | String, or `inherit` | Model while the skill is active. | — |
| `effort` | No | `low`, `medium`, `high`, `xhigh`, `max` | Effort level while active. | inherits the session |
| `context` | No | `fork` | Run in an isolated subagent context. | — |
| `agent` | No | String | Subagent type used when `context: fork` is set. | — |
| `background` | No | Boolean | With `context: fork`, whether to run in the background. | `true` |
| `paths` | No | List of globs | Limits when Claude loads the skill automatically. | — |
| `shell` | No | `bash`, `powershell` | Shell for inline command execution. | `bash` |
| `hooks` | No | Mapping | Hooks registered when the skill is invoked. | — |

These lines are appended to the end of the existing frontmatter block in
`.claude/skills/<id>/SKILL.md`. Your canonical bytes are preserved exactly; the
generated file differs from the source by these lines and nothing else. A key
already present in the canonical `SKILL.md` is rejected rather than written
twice.

Reference:
[Claude Code skills frontmatter](https://code.claude.com/docs/en/skills#frontmatter-reference).

### Claude Code command override

`.ai/providers/claude/commands/<id>.yaml`

```yaml
schema: 1
options:
  argument-hint: "[test name]"
  arguments:
    - test
  allowed-tools:
    - Read
    - Edit
  disallowed-tools:
    - WebFetch
  model: sonnet
  effort: medium
  context: fork
  agent: reviewer
  background: false
  when_to_use: When a test is failing and the cause is unknown.
  shell: bash
  hooks:
    Stop:
      - command: ./scripts/notify.sh
```

The fields mean exactly what they do for a skill; a Claude Code command file
accepts the same frontmatter except `name` and `paths`. They are written into
`.claude/commands/<id>.md` after `description` and
`disable-model-invocation: true`.

Reference:
[Claude Code skills frontmatter](https://code.claude.com/docs/en/skills#frontmatter-reference).

### Codex agent override

`.ai/providers/codex/agents/<id>.yaml`

```yaml
schema: 1
options:
  model: gpt-5.5
  model_reasoning_effort: high
  model_reasoning_summary: concise
  model_verbosity: low
  personality: pragmatic
  sandbox_mode: workspace-write
  approval_policy: on-request
  web_search: cached
  service_tier: fast
  tools:
    view_image: true
  mcp_servers:
    docs:
      command: npx
      args:
        - -y
        - docs-server
```

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `model` | No | String | Model for sessions spawned from this agent. | the parent session's model |
| `model_reasoning_effort` | No | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | Reasoning effort. `max` and `ultra` are documented specifically for subagents and remain model-dependent. | the parent session's effort |
| `model_reasoning_summary` | No | `auto`, `concise`, `detailed`, `none` | Reasoning-summary detail. | — |
| `model_verbosity` | No | `low`, `medium`, `high` | GPT-5 response verbosity. | the model preset |
| `personality` | No | `none`, `friendly`, `pragmatic` | Communication style when supported by the model. | — |
| `sandbox_mode` | No | `read-only`, `workspace-write`, `danger-full-access` | Filesystem and network sandbox policy. | the parent session's policy |
| `approval_policy` | No | `untrusted`, `on-request`, `never`, or granular mapping | When Codex pauses for approval. | the parent session's policy |
| `web_search` | No | `disabled`, `cached`, `indexed`, `live` | Web-search mode. | the parent session's mode |
| `service_tier` | No | String | Preferred service tier, such as `fast`. | the model default |
| `tools.view_image` | No | Boolean | Enable the local-image attachment tool. | — |
| `mcp_servers` | No | Mapping keyed by server id | MCP servers available to this agent. | — |

Scalars become top-level keys in `.codex/agents/<id>.toml`; `mcp_servers`
becomes `[mcp_servers.<id>]` tables after them.

`skills.config` is deliberately not supported: it is a list of filesystem paths,
which does not survive being committed to a repository other people clone.

References:
[Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents),
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

### Codex skill override

`.ai/providers/codex/skills/<id>.yaml`

```yaml
schema: 1
options:
  policy:
    allow_implicit_invocation: false
  interface:
    display_name: Code review
    short_description: Reviews a change against the project checklist
    icon_small: ./assets/small-logo.svg
    icon_large: ./assets/large-logo.png
    brand_color: "#3B82F6"
    default_prompt: Review the current change.
  dependencies:
    tools:
      - type: mcp
        value: openaiDeveloperDocs
```

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `policy.allow_implicit_invocation` | No | Boolean | Whether Codex may invoke the skill from prompt context. Explicit `$name` invocation always works. | `true` |
| `interface.display_name` | No | String | User-facing name. | — |
| `interface.short_description` | No | String | User-facing description. | — |
| `interface.icon_small` | No | String | Path to a small logo, relative to the skill directory. | — |
| `interface.icon_large` | No | String | Path to a large logo, relative to the skill directory. | — |
| `interface.brand_color` | No | String | Hex colour. | — |
| `interface.default_prompt` | No | String | Surrounding prompt used on invocation. | — |
| `dependencies.tools` | No | List of mappings | Tool dependencies. Nested dependency fields pass through without a frozen schema. | — |

This becomes `.agents/skills/<id>/agents/openai.yaml`, written beside the copied
skill. Without an override, no such file is generated.

Reference: [Codex skills](https://learn.chatgpt.com/docs/build-skills).

### GitHub Copilot instruction override

`.ai/providers/copilot/instructions/<id>.yaml`

```yaml
schema: 1
options:
  excludeAgent: code-review
```

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `excludeAgent` | No | `code-review`, `cloud-agent` | Stops one Copilot agent reading the file. | both agents read the file |

This becomes frontmatter in `.github/instructions/<id>.instructions.md`,
after `applyTo`.

**Only available on a path-scoped instruction.** An unscoped instruction is
aggregated into `.github/copilot-instructions.md`, which GitHub documents with
no frontmatter at all, so there is nowhere for the field to go. AI Config
refuses the override with `OVERRIDE_NOT_APPLICABLE` rather than dropping it.

Reference:
[Copilot repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions).

### GitHub Copilot agent override

`.ai/providers/copilot/agents/<id>.yaml`

```yaml
schema: 1
options:
  target: vscode
  tools:
    - read
    - edit
  model:
    - GPT-5.6
    - Claude Sonnet 5
  disable-model-invocation: false
  user-invocable: true
  mcp-servers:
    docs:
      type: local
      command: npx
  metadata:
    team: platform
  argument-hint: "[task]"
  handoffs:
    - label: Review
      agent: reviewer
      prompt: Review the implementation.
      send: false
  agents:
    - reviewer
  hooks:
    Stop:
      - command: ./scripts/notify.sh
```

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `target` | No | `vscode`, `github-copilot` | Restrict the agent to one environment. | available in both |
| `tools` | No | List of strings | Tool names the agent may use. | all tools |
| `model` | No | String, or prioritized list in VS Code | Model used when the agent executes. GitHub cloud accepts the scalar form. | inherits the default |
| `disable-model-invocation` | No | Boolean | Stop the cloud agent selecting this agent from task context. | `false` |
| `user-invocable` | No | Boolean | Whether a user can select the agent. | `true` |
| `mcp-servers` | No | Mapping | Additional MCP servers and tools. | — |
| `metadata` | No | Mapping of strings | Free-form annotations. | — |
| `argument-hint` | No | String | IDE invocation hint; ignored by GitHub cloud. | — |
| `handoffs` | No | List of mappings | VS Code handoff actions (`label`, `agent`, `prompt`, optional `send` and `model`). | — |
| `agents` | No | List of strings | Agents available as VS Code subagents. | — |
| `hooks` | No | Mapping | Preview lifecycle hooks scoped to the agent in VS Code. | — |

Each becomes frontmatter in `.github/agents/<id>.agent.md`, after `name` and
`description`. `infer` is not supported: GitHub documents it as retired in
favour of the two invocation fields.

Reference:
[Copilot custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration).

### GitHub Copilot skill override

`.ai/providers/copilot/skills/<id>.yaml`

```yaml
schema: 1
options:
  argument-hint: "[pull request]"
  user-invocable: true
  disable-model-invocation: false
  context: fork
```

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `argument-hint` | No | String | Hint shown for slash-command invocation. | — |
| `user-invocable` | No | Boolean | Whether the skill appears in the slash-command menu. | `true` |
| `disable-model-invocation` | No | Boolean | Require manual invocation. | `false` |
| `context` | No | `fork` | Run in a dedicated subagent context (experimental). | inline |

These lines are appended to the canonical frontmatter in
`.github/skills/<id>/SKILL.md`. Canonical Agent Skills fields remain reserved.

Reference:
[Agent Skills in VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills).

### GitHub Copilot command override

`.ai/providers/copilot/commands/<id>.yaml`

```yaml
schema: 1
options:
  agent: plan
  model: gpt-5.5
  tools:
    - codebase
    - githubRepo
  argument-hint: "[test name]"
```

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `agent` | No | `ask`, `agent`, `plan`, or a custom agent name | Agent used to run the prompt. | the current agent, or `agent` when tools are set |
| `model` | No | String | Language model used to run the prompt. | the selected model |
| `tools` | No | List of strings | Tool or tool set names. Use `<server>/*` for all tools of an MCP server. | — |
| `argument-hint` | No | String | Hint shown in the chat input field. | — |

Each becomes frontmatter in `.github/prompts/<id>.prompt.md`, after
`description`.

Reference:
[Prompt files in VS Code](https://code.visualstudio.com/docs/agent-customization/prompt-files).

### OpenCode agent override

`.ai/providers/opencode/agents/<id>.yaml`

```yaml
schema: 1
options:
  mode: subagent
  model: anthropic/claude-sonnet-4-20250514
  temperature: 0.1
  top_p: 0.9
  steps: 20
  disable: false
  hidden: false
  color: accent
  permission:
    edit: deny
    webfetch: ask
    bash:
      "*": ask
      "git status *": allow
```

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `mode` | No | `primary`, `subagent`, `all` | How the agent can be used. | `subagent`, written by AI Config |
| `model` | No | String, `provider/model-id` | Model override. | the global model setting |
| `temperature` | No | Number, 0.0–1.0 | Response randomness. | model-specific |
| `top_p` | No | Number, 0.0–1.0 | Nucleus sampling cutoff. | — |
| `steps` | No | Integer ≥ 1 | Maximum agentic iterations. | unlimited |
| `disable` | No | Boolean | Disable the agent without deleting it. | — |
| `hidden` | No | Boolean | Hide the subagent from `@` autocomplete. | — |
| `color` | No | Hex value, or `primary`, `secondary`, `accent`, `success`, `warning`, `error`, `info` | Display colour. | — |
| `permission` | No | Mapping | Per-tool permissions. Every key accepts `allow`, `ask` or `deny`; `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `lsp` and `skill` also accept a glob-pattern map. Which subagents the agent may invoke is `permission.task`; there is no top-level `task` field. | — |
| `reasoningEffort` | No | String; OpenAI reasoning models accept `low`, `medium`, `high`, `xhigh` | Model option, forwarded to the model provider. | the model provider's own default |
| `textVerbosity` | No | String; OpenAI reasoning models accept `low`, `medium`, `high` | Model option, forwarded to the model provider. | the model provider's own default |
| `reasoningSummary` | No | String, such as `auto` | Model option, forwarded to the model provider. Asks an OpenAI reasoning model for a summary of its reasoning. | the model provider's own default |
| `thinking` | No | Mapping, such as `{ type: enabled, budgetTokens: 16000 }` | Model option, forwarded to the model provider. Anthropic extended thinking. | the model provider's own default |
| `include` | No | List of strings, such as `reasoning.encrypted_content` | Model option, forwarded to the model provider. Extra response fields to request. | — |

Each becomes frontmatter in `.opencode/agents/<id>.md`, after `description`. No
`name` is written: OpenCode takes the agent name from the filename.

`tools` is not supported: OpenCode documents it as deprecated and directs new
configuration at `permission`.

The last five are model options: OpenCode does not interpret them, it forwards
them to whichever model provider the agent uses. They are listed because
OpenCode's own documentation shows them on an agent, and their accepted values
are left open because those belong to the model provider rather than to
OpenCode.

**This table is not the limit.** OpenCode documents an open agent
configuration: any option it does not itself define is forwarded to the model
provider as a model option. A field this table does not list is therefore
ordinary configuration rather than a mistake — write it and AI Config emits it
unchanged.

It is still reported, as an **informational** `OVERRIDE_UNRECOGNIZED_FIELD`
rather than a warning. AI Config cannot tell a model option it has not heard of
from a typo, and saying nothing at all would let `temperatur: 0.5` reach the
generated file in silence. The note says only what is true — nothing checked
this field — and lists the ones it does know, in case one of them was meant.

OpenCode agents are currently the only open schema. Everywhere else, OpenCode's
own command overrides included, an undeclared field is a warning, because those
providers document closed sets.

Reference: [OpenCode agents](https://opencode.ai/docs/agents/).

### OpenCode command override

`.ai/providers/opencode/commands/<id>.yaml`

```yaml
schema: 1
options:
  agent: build
  model: anthropic/claude-sonnet-4-20250514
  subtask: true
```

| Field | Required | Type / Allowed values | Description | Default |
| --- | --- | --- | --- | --- |
| `agent` | No | String | Which agent executes the command. | the current agent |
| `model` | No | String, `provider/model-id` | Model override. | the default model |
| `subtask` | No | Boolean | Force the command to run through a subagent. | — |

Each becomes frontmatter in `.opencode/commands/<id>.md`, after `description`.

Reference: [OpenCode commands](https://opencode.ai/docs/commands/).

---

## Command line

```bash
aiconfig init      [--providers <list>] [--cwd <dir>]
aiconfig add       <instruction|agent|skill|command> <name> [options]
aiconfig remove    <instruction|agent|skill|command> <name> [--json]
aiconfig override  <create|list|remove> [arguments]
aiconfig providers <enable|disable> <provider> [--json]
aiconfig validate  [--check] [--json] [--cwd <dir>]
aiconfig sync      [--dry-run] [--force] [--json] [--cwd <dir>]
aiconfig status    [--json] [--cwd <dir>]
aiconfig restore   <generated-file-path> [--json]
aiconfig clean     [--json] [--cwd <dir>]
aiconfig rules     [--cwd <dir>]
```

Every operation the VS Code view offers has a command here, and both run the
same compiler:

| In the view | On the command line |
| --- | --- |
| **Add** menu | `aiconfig add <kind> <name>` |
| **Delete…** on an artifact | `aiconfig remove <kind> <name>` |
| **Add Provider Override…** | `aiconfig override create <provider> <kind> <id>` |
| **Remove Override** | `aiconfig override remove <provider> <kind> <id>` |
| **+** on a disabled provider | `aiconfig providers enable <provider>` |
| **Remove Provider…** | `aiconfig providers disable <provider>`, then delete `.ai/providers/<provider>/` |
| **Synchronize** | `aiconfig sync` |
| **Validate** | `aiconfig validate` |
| **Show Status** | `aiconfig status` |
| **Restore Generated File** | `aiconfig restore <path>` |
| **Delete Generated Files** | `aiconfig clean` |

`aiconfig remove` deletes the canonical artifact and every override written for
it, exactly as **Delete…** does; the files it generated are removed by the
synchronization that follows. The view confirms through a modal because it is a
click — here, naming the kind and the artifact is the confirmation.

**Remove AI Config from This Project** has no command. It deletes `.ai/` as
well, and the extension can send it to the system trash where a CLI could only
unlink it; `aiconfig clean` followed by removing `.ai/` yourself says the same
thing deliberately.

### The generated reference

`aiconfig init` writes `.ai/generation-rules.md`: where each artifact kind is
generated for every provider, and which fields each provider accepts in an
override. It is produced by compiling a probe with the real adapters, so it
states what the installed build emits rather than what a document claims.

Nothing reads it, and nothing refreshes it — a synchronization never writes into
`.ai/`. After upgrading AI Config, rewrite it yourself:

```bash
aiconfig rules > .ai/generation-rules.md
```

### Scaffolding

```bash
aiconfig add instruction backend --description "Backend rules" \
  --apply-to 'backend/**' --apply-to 'services/**/*.ts'

aiconfig add agent reviewer --description "Reviews changes" --body-file prompt.md
aiconfig add skill code-review --description "Reviews a change" --with references,scripts
aiconfig add command fix-bug --description "Fix a failing test" --body-file -
```

| Option | Applies to | Description |
| --- | --- | --- |
| `--description <text>` | all | Required for an agent, skill and command. |
| `--body-file <path>` | all | Read the body from a file, or `-` for standard input. A placeholder is written when omitted. |
| `--apply-to <glob>` | instruction | Repeatable. |
| `--with <list>` | skill | Comma-separated subdirectories: `references`, `scripts`, `assets`. |

### Overrides

```bash
aiconfig override create claude agent reviewer --set model=sonnet --set maxTurns=12
aiconfig override create codex skill code-review --set policy.allow_implicit_invocation=false
aiconfig override list
aiconfig override remove claude agent reviewer
```

`--set` is repeatable and validated against the provider's declared field types,
so a bad enum or an out-of-range number fails before anything is written. Use a
dotted key for a nested field. Structured fields — `hooks`, `mcpServers`,
`permission`, `mcp-servers`, `metadata` — are not settable this way; create the
override without them and edit the file, which the same validation covers.

`override create` refuses to replace an existing file unless you pass `--force`.

Every command supports `--json` and reports the same key set whether it
succeeded or failed.

---

## Ownership, drift and safety

`.ai/.generated.json` records every file AI Config generated, with its hash.
Commit it alongside `.ai/` so a later clone can tell generated files from yours.

- A generated file edited by hand is **drift**. Sync stops rather than
  overwriting it; `--force` replaces every drifted file that still has a
  canonical source.
- A file at a target path that AI Config never generated is **untracked**. It is
  never touched.
- A generated file whose canonical source was deleted is an **orphan**. It is
  removed, unless it was edited, in which case it is left alone and reported.
- Symbolic links inside `.ai/` are not followed, and no path outside the
  repository root is ever written.

`aiconfig sync` reads `.ai/` and writes provider output. It never writes back
into `.ai/`, and removes nothing there but a provider override left without the
artifact it refined.

If a repository already contains provider files when you initialize — an
existing `.claude/` setup, or output left behind after `.ai/` was deleted — the
VS Code Initialize flow lists them and continues only if you tell it to. It
never adopts them: with no `.ai/.generated.json`, nothing can prove AI Config
wrote them, and matching content is not evidence. They stay yours and untracked,
and sync reports them as `UNTRACKED_TARGET_EXISTS` until you move or remove them
yourself.
