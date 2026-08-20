# AI Config

**Define your AI coding configuration once and keep Claude Code, Codex, GitHub
Copilot, and OpenCode synchronized.**

Every AI assistant reads its own files, from its own directory, in its own
format. Keeping the same instructions, agents and commands in step across four
of them by hand does not work for long, and the drift stays invisible until one
assistant starts behaving differently from the others.

AI Config gives you a single directory to edit — `.ai/` — and generates the
provider files from it: `.claude/`, `.codex/`, `.github/`, `.opencode/` and
`AGENTS.md`. You write your intent once, in one format, and AI Config takes care
of expressing it in each assistant's own conventions.

Everything runs locally in your editor. No LLM, no network access, no account,
no telemetry.

## Supported assistants

- Claude Code
- OpenAI Codex
- GitHub Copilot
- OpenCode

## Getting started

1. Install AI Config.
2. Open the repository you want to configure.
3. Run **AI Config: Initialize Project** from the Command Palette.
4. Select the assistants this repository should stay in sync with.
5. Add instructions, agents, skills or commands from the **Add** menu in the AI
   Config sidebar.
6. Add provider-specific settings where you need them.
7. Run **AI Config: Synchronize**.

The guided flows only ask for short structural details — a name, a path scope,
which settings to include. They then scaffold valid files and open them in the
normal VS Code editor, where you write the description, prompt or instructions.
Long-form content is never requested through an input box, and you never have to
learn a YAML schema before starting.

## One source of truth

```text
.ai/
├── instructions/
├── agents/
├── skills/
├── commands/
├── providers/
└── config.yaml
```

**Instructions** — rules the assistant should always follow, either
repository-wide or scoped to specific paths.

**Agents** — reusable specialists you can delegate to, such as a reviewer, a
backend coder or a test writer.

**Skills** — reusable capabilities and workflows, with optional reference
material, scripts and assets alongside them.

**Commands** — explicit prompts you invoke yourself when you want them.

**Providers** — optional provider-specific refinements for the artifacts above.

`config.yaml` records which assistants are enabled. Everything under `.ai/` is
yours to edit; AI Config only ever reads it and writes provider output.

## Provider-specific overrides

Shared content lives in one file and reaches every enabled assistant. When one
assistant supports a setting the others do not, you add it separately instead of
duplicating the artifact.

`.ai/agents/coder.md` holds the agent's description and instructions, and is
compiled for every enabled provider. Alongside it:

```yaml
# .ai/providers/opencode/agents/coder.yaml
schema: 1
options:
  model: anthropic/claude-sonnet-4-20250514
  temperature: 0.1
  permission:
    edit: deny
```

The override adds OpenCode-only options. It never repeats the shared content and
never changes which assistants the agent reaches — remove it and the agent is
still generated everywhere.

AI Config only offers overrides that genuinely exist for that combination of
provider and artifact, so you are never walked through a question that produces
nothing. Claude Code and Codex agents accept model and reasoning settings,
Copilot instructions accept path scoping, and so on; each scaffolded file lists
the supported settings with a short explanation and a link to the provider's own
documentation.

## Guided creation

From the AI Config sidebar:

- **Add Agent**
- **Add Command**
- **Add Instruction**
- **Add Skill**
- **Add Provider Override…**, on any artifact that can still be customized

Every artifact row carries **Edit** and **Delete…**. Deleting removes the
canonical source and every provider override written for it, then synchronizes,
which removes the files generated from it. Deleting the file under `.ai/` by hand
works too: the generated files are removed on the next synchronization. Provider
overrides written for it are **kept**, and AI Config notes that each one produces
no output until an artifact of that name returns — the same way a disabled
provider's overrides are kept. That is what makes switching to a branch without
the artifact, and back, lossless. Delete them yourself when you want them gone,
or use **Delete…** on the artifact, which takes both.

Existing overrides appear underneath the artifact they belong to, with actions to
edit or remove them.

## Synchronization

```text
.ai/
  ↓
AI Config
  ↓
Claude Code · Codex · GitHub Copilot · OpenCode
```

**AI Config: Synchronize** compiles `.ai/` and writes the provider files. AI
Config also watches `.ai/` and re-synchronizes automatically once a change is
valid, so in day-to-day use the generated files simply stay current. Nothing is
written while the configuration still has errors.

The sidebar lists each assistant with its current status — up to date, changes
pending, drifted, conflicting or disabled — and expands to show the files that
need attention. Each row carries the one action that applies to it. A disabled
assistant offers **+**, which adds it to `.ai/config.yaml` and synchronizes, so
its files exist by the time the row reports it as enabled. An enabled one offers
**Remove Provider…**, which disables it, deletes the files generated for it —
keeping any file another enabled assistant also produces — and sends its
`.ai/providers/<provider>/` directory to the system trash. The confirmation says
which of those apply before anything is removed. Nothing else under `.ai/` is
touched, so enabling it again regenerates everything except the
provider-specific settings you had written for it. The status bar reports the same at a glance, and validation
problems appear in the Problems panel on the `.ai/` file that caused them.
**AI Config: Show Status**, **AI Config: Validate** and **AI Config: Show Output
Log** give you the details on demand.

## Exact and lossy mappings

Assistants do not support identical features, and AI Config says so rather than
pretending otherwise. Each mapping is reported as **exact**, **lossy**,
**unsupported** or **unverified**.

For example, an instruction scoped to `src/api/**` is expressed exactly in Claude
Code and GitHub Copilot, which both enforce path scopes. Codex and OpenCode
receive the same instruction through `AGENTS.md`, where the scope is recorded in
prose but not enforced — a lossy mapping, reported as a warning naming exactly
what was lost.

## Drift protection

AI Config records every file it generates. If one of them is edited by hand, that
is drift, and synchronization stops instead of overwriting your change. You can
open the generated version side by side in VS Code's diff editor and, if the edit
was a mistake, restore the generated file. If you meant to keep the change, AI
Config tells you it is blocking and leaves the decision to you.

Provider files that AI Config did not generate are never touched. When you
initialize a repository that already contains a `.claude/` setup or an
`AGENTS.md` you wrote yourself, AI Config lists those files and explains that
they stay yours.

## Safety

- Files AI Config never generated are never overwritten, deleted or adopted.
- Ownership is tracked per file, so generated output is always distinguishable
  from your own.
- Unsafe paths and symlinks escaping the repository are rejected.
- A generated file whose source you deleted is removed — unless you edited it, in
  which case it is preserved and reported.
- Commit `.ai/.generated.json` along with `.ai/`. It records which files AI
  Config owns, so a fresh clone can tell generated files from yours.

## Current scope

AI Config manages instructions, agents, skills and commands, plus the
provider-specific settings those artifacts support — which, depending on the
assistant, can include per-agent model, reasoning, permission, MCP server and
hook settings.

It does not manage repository-wide or global assistant configuration such as
plugins, global model settings or standalone MCP and hook configuration files,
and it does not import or merge configuration you already have. Those files stay
under your control.

## Configuration

`aiconfig.showStatusBar` — show or hide the AI Config status bar item.

## Support

Found a bug or have a suggestion? [Get in touch](https://manuelraso.dev/contacts).

## License

MIT
