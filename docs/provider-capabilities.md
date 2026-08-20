# Provider capabilities

AI Config v1 classifies realization of canonical intent as `exact`, `lossy`,
`unsupported`, or `unverified`.

| Intent | Claude | Codex | Copilot | OpenCode |
| --- | --- | --- | --- | --- |
| Unscoped instructions | exact | exact | exact | exact |
| `instructions.applyTo` | exact | lossy | exact | lossy |
| Agents | exact | exact | exact | exact |
| Skills | exact | exact | exact | exact |
| Explicit commands | exact | exact | lossy | exact |

Codex commands are skills with a policy sidecar preventing implicit selection.
Copilot prompt files are public preview and IDE-only. Codex and OpenCode render
scoped instruction intent as visible prose because neither has portable glob
scope. See the individual provider pages for generated paths.

## Editors that validate another provider's files

VS Code assigns the `chatagent` language to `**/.claude/agents/*.md` as well as
to its own `**/.github/agents/*.md`, and GitHub Copilot then validates both
against Copilot's agent schema. Claude Code's schema is not the same one, so a
Claude Code agent AI Config generated can show warnings in VS Code for fields
and values Claude Code itself accepts.

The clearest case is `permissionMode`. Claude Code accepts `auto`; Copilot does
not, and reports it as invalid. Copilot in turn accepts values Claude Code has
never had. Neither tool is wrong about its own format — they simply disagree
about who owns the file.

These warnings come from the editor, not from AI Config, and they do not affect
what Claude Code reads. `aiconfig validate` is the authority on whether a
generated file is correct for the provider that owns it.
