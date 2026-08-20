# @aiconfig/cli

**Write once. Synchronize everywhere.**

AI Config keeps configuration for Claude Code, OpenAI Codex, GitHub Copilot, and
OpenCode in one portable repository source: `.ai/`. It compiles that source into
each provider's own format, tracks which files it owns, and detects drift before
overwriting anything.

You do not need to know any provider's configuration format to use it.

[Watch the introductory video on YouTube](https://www.youtube.com/watch?v=1dwmBAFaYTM).

## Install

```bash
npm install -g @aiconfig/cli
```

Or run it without installing:

```bash
npx @aiconfig/cli init
```

Requires Node.js 20.10 or later.

## Quick start

```bash
aiconfig init --providers claude,codex,copilot,opencode
aiconfig add agent reviewer --description "Reviews changes for correctness"
aiconfig override create claude agent reviewer --set model=sonnet
aiconfig sync
```

## What lives where

```
.ai/
├── agents/                specialist helpers
├── commands/              prompts you invoke explicitly
├── instructions/          rules that are always in context
├── providers/             optional provider-specific refinements
├── skills/                procedures loaded on demand
└── config.yaml            which providers are enabled
```

A **portable artifact** holds only fields that mean the same thing everywhere,
and is compiled to every enabled provider. A **provider refinement** at
`.ai/providers/<provider>/<kind>/<id>.yaml` holds only settings specific to one
assistant, never repeats a canonical field, and never changes which providers an
artifact reaches.

Everything under `.ai/` is yours. `aiconfig sync` reads it and writes provider
output; it never writes back into `.ai/`. Deleting an artifact takes everything
that belonged to it — the generated files, and any provider override that
refined it.

## Commands

| Command | Purpose |
| --- | --- |
| `aiconfig init` | Create a `.ai/` directory in this repository |
| `aiconfig sync` | Compile `.ai/` into provider configuration |
| `aiconfig validate` | Check `.ai/` for errors and compatibility warnings |
| `aiconfig status` | Report provider synchronization state |
| `aiconfig rules` | Print what is generated where, and what each provider accepts |
| `aiconfig add <kind> <name>` | Create an instruction, agent, skill or command |
| `aiconfig remove <kind> <name>` | Delete an artifact and every override written for it |
| `aiconfig override <action>` | Create, list or remove provider-specific options |
| `aiconfig providers <action>` | Enable or disable a provider |
| `aiconfig restore <path>` | Replace one generated file with the version AI Config makes |
| `aiconfig clean` | Remove every file AI Config generated, keeping `.ai/` |

Run `aiconfig --help` for the full option reference.

`--json` makes `sync`, `validate`, `status`, `add` and `override` emit
machine-readable output, and `sync --dry-run` reports what would change without
writing. `validate --check` exits non-zero on warnings as well as errors, which
is the form to use in CI.

## Safety

- Compilation is deterministic and entirely local. No LLM, network access,
  account or telemetry is involved.
- AI Config only modifies files it generated, tracked in `.ai/.generated.json`.
  A file it did not create is never overwritten.
- Writes are atomic.

## Documentation

Full documentation lives in the repository:

- [User guide](https://github.com/ShadyManu/ai-config/blob/main/docs/user-guide.md)
- [Specification](https://github.com/ShadyManu/ai-config/blob/main/docs/specification.md)
- [Provider capabilities](https://github.com/ShadyManu/ai-config/blob/main/docs/provider-capabilities.md)

An AI Config VS Code extension providing the same engine with a guided UI is
also available.

## Support

Found a bug or have a suggestion? [Open an issue on GitHub](https://github.com/ShadyManu/ai-config/issues).

## License

MIT
