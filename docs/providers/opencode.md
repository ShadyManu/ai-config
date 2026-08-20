# OpenCode

OpenCode receives aggregate instructions in `AGENTS.md`, agents in
`.opencode/agents/`, skills in `.opencode/skills/`, and commands in
`.opencode/commands/`. Scoped instructions are visible prose in `AGENTS.md`
and classified `lossy`. AI Config never writes `opencode.json`.

## Provider-specific overrides

Agents and commands accept an override.

The agent override uses the field names the current documentation gives:
`top_p` and `steps`, not the deprecated `topP` and `maxSteps`. `tools` is not
exposed, because OpenCode documents it as deprecated and directs new
configuration at `permission`.

`permission` accepts the documented shorthand — every key takes `allow`, `ask`
or `deny` — and the glob-pattern map form that `read`, `edit`, `glob`, `grep`,
`list`, `bash`, `task`, `external_directory`, `lsp` and `skill` additionally
accept. Guided flows offer the shorthand; the map form is written by hand and
validated the same way.

No instruction override exists: `AGENTS.md` is plain Markdown, and the
`instructions` key in `opencode.json` is global project configuration rather
than a per-instruction setting. No skill override exists: OpenCode recognizes
`name`, `description`, `license`, `compatibility`, and `metadata`, and ignores
unknown fields. It therefore ignores the specification's experimental
`allowed-tools`; AI Config preserves the canonical file and reports
`SKILL_ALLOWED_TOOLS_UNSUPPORTED` when that field is present.

Sources, read 2026-08-20:

- <https://opencode.ai/docs/agents/>
- <https://opencode.ai/docs/commands/>
- <https://opencode.ai/docs/skills/>
- <https://opencode.ai/docs/rules/>
