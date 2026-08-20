# AI Config

**Write once. Synchronize everywhere.**

AI Config keeps configuration for Claude Code, OpenAI Codex, GitHub Copilot, and OpenCode in one portable repository source: `.ai/`. It compiles that source into provider files, tracks its ownership, and detects drift before overwriting anything.

You do not need to know any provider's configuration format to use it.

## Getting started

### VS Code

1. Install the AI Config extension.
2. Run **AI Config: Initialize Project** and choose your assistants.
3. Use the **Add** menu in the AI Config sidebar: **Add Instruction**, **Add Agent**, **Add Skill**, **Add Command**. Each one asks for a name.
4. Optionally choose which provider-specific settings to include, or add them later with **Add Provider Override…** on any artifact.
5. AI Config scaffolds valid source files and opens them; write the description, prompt, instructions and provider values in the editor.
6. AI Config synchronizes after a valid change; **AI Config: Synchronize** runs it on demand.

The guided flows collect structure — a name, a scope, which settings to include — and deliberately never ask for long-form content through an input box. Descriptions, prompts and provider values are written in a normal editor, where they belong. Editing the files by hand stays fully supported.

### Command line

```bash
aiconfig init --providers claude,codex,copilot,opencode
aiconfig add agent reviewer --description "Reviews changes for correctness"
aiconfig override create claude agent reviewer --set model=sonnet
aiconfig sync
```

## What lives where

```
.ai/
├── config.yaml            which providers are enabled
├── instructions/          rules that are always in context
├── agents/                specialist helpers
├── skills/                procedures loaded on demand
├── commands/              prompts you invoke explicitly
└── providers/             optional provider-specific refinements
```

A **portable artifact** holds only fields that mean the same thing everywhere, and is compiled to every enabled provider. A **provider refinement** at `.ai/providers/<provider>/<kind>/<id>.yaml` holds only settings specific to one assistant, never repeats a canonical field, and never changes which providers an artifact reaches.

```yaml
# .ai/providers/opencode/agents/reviewer.yaml
schema: 1
options:
  temperature: 0.1
  permission:
    edit: deny
```

Everything under `.ai/` is yours. `aiconfig sync` reads it and writes provider output; it never writes back into `.ai/`. Deleting an artifact takes everything that belonged to it — the generated files, and any provider override that refined it — whether you delete it from the AI Config view or in an editor.

## Where overrides exist

Only where the provider genuinely documents artifact-specific settings.

| Artifact | Claude | Codex | Copilot | OpenCode |
| --- | --- | --- | --- | --- |
| Instruction | — | — | yes, path-scoped only | — |
| Agent | yes | yes | yes | yes |
| Skill | yes | yes | yes | — |
| Command | yes | — | yes | yes |

The guided flows and the CLI both refuse to offer a combination that is not in this table, so you are never walked through a question that produces nothing. See the [user guide](docs/user-guide.md#provider-override-reference) for every supported field.

## Capability honesty

**Exact** preserves intent. **Lossy** reduces it and warns. **Unsupported** cannot be produced. **Unverified** is not established provider behavior.

| Capability | Claude | Codex | Copilot | OpenCode |
| --- | --- | --- | --- | --- |
| Unscoped instructions | exact | exact | exact | exact |
| Scoped instructions (`applyTo`) | exact | lossy | exact | lossy |
| Agents | exact | exact | exact | exact |
| Skills | exact | exact | exact | exact |
| Explicit commands | exact | exact | lossy | exact |

Codex and OpenCode record scoped rules visibly in `AGENTS.md` but apply them globally. Codex commands become `$name` skills with implicit invocation disabled. Copilot commands become IDE prompt files, not cloud-agent, code-review, or CLI commands.

## CLI

```bash
aiconfig init      [--providers <list>] [--cwd <dir>]
aiconfig add       <instruction|agent|skill|command> <name> [options]
aiconfig remove    <instruction|agent|skill|command> <name>
aiconfig override  <create|list|remove> [arguments]
aiconfig providers <enable|disable> <provider>
aiconfig validate  [--check] [--json] [--cwd <dir>]
aiconfig sync      [--dry-run] [--force] [--json] [--cwd <dir>]
aiconfig status    [--json] [--cwd <dir>]
aiconfig restore   <generated-file-path>
aiconfig clean     [--json] [--cwd <dir>]
aiconfig rules     [--cwd <dir>]
```

`validate --check` fails on warnings for CI. `--json` is supported by every command. The CLI is fully usable without VS Code, and every operation the VS Code view offers has a command here.

## Ownership and boundaries

`.ai/.generated.json` is the ownership manifest; commit it with `.ai/` so later clones can recognize generated files safely. Changed managed files block sync; `--force` replaces every drifted managed file that still has a canonical source in that sync run. Modified orphan files are never deleted. AI Config rejects unsafe paths and symlink escapes.

Disabling a provider removes its generated output and keeps every override file under `.ai/providers/`, so re-enabling it restores your settings exactly.

v1 does not import or merge existing provider configuration, and does not generate `opencode.json`.

## Documentation

- [User guide](docs/user-guide.md) — complete public v1 reference
- [Provider capabilities](docs/provider-capabilities.md)
- [Provider overlays](docs/provider-overlays.md)
- [Architecture](docs/architecture.md) and [contributing](docs/contributing.md)

## License

MIT
