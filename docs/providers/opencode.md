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

The agent override is deliberately open. OpenCode documents that "any other
options you specify in your agent configuration will be passed through directly
to the provider as model options", so a field AI Config does not declare is
ordinary configuration there rather than a mistake. It is written through
unchanged and reported as an informational `OVERRIDE_UNRECOGNIZED_FIELD` rather
than a warning: a typo cannot be told apart from a model option nobody has
written down yet, so the note claims only that nothing checked the field.

`reasoningEffort`, `textVerbosity`, `reasoningSummary`, `thinking` and `include`
are declared as fields because `https://opencode.ai/docs/models/` shows them on
an agent and states that an agent's value overrides the global one. Their
accepted values are left open — free strings and an unconstrained mapping —
because those belong to the model provider rather than to OpenCode, which
documents none of them.

The command override is not open: OpenCode documents `agent`, `model`,
`subtask`, `description` and `template`, and nothing about accepting more, so an
undeclared field there is still a warning.

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

## Skill discovery

OpenCode scans six directories for skills — `.opencode/skills`, `.claude/skills`
and `.agents/skills`, each in the project and in `~/.config/opencode` — so
enabling Claude Code or Codex beside it means the same skill is reachable from
more than one root.

AI Config does not report this. Every copy is compiled from the same canonical
skill and is byte-for-byte identical, and OpenCode deduplicates by name, so the
skill that loads is the same skill whichever copy it comes from.

Two things about that duplication are worth knowing, and neither is something a
`.ai/` author can act on:

- OpenCode's discovery has an open defect where the path it reports for a skill
  reachable from several roots flips between sessions, which costs prompt
  prefix-cache reuse. Ordering was made deterministic in
  `anomalyco/opencode#18261`; the path inside each entry was not.
- Scanning and deduplicating a large skill set across three roots costs startup
  time. A `skills.directories` setting to narrow the search was requested in
  `anomalyco/opencode#23035` and closed as not planned.

Both belong to OpenCode. AI Config cannot fix either — Claude Code reads only
`.claude/skills` and Codex only `.agents/skills`, so the copies those providers
need cannot be withheld — and reporting them on every synchronization would be a
warning that never goes away.

Sources, read 2026-08-21:

- <https://opencode.ai/docs/agents/>
- <https://opencode.ai/docs/commands/>
- <https://opencode.ai/docs/skills/>
- <https://opencode.ai/docs/rules/>
