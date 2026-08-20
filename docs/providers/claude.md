# Claude Code

Claude receives instructions as `.claude/rules/*.md`, agents as
`.claude/agents/*.md`, skills as `.claude/skills/`, and commands as
`.claude/commands/*.md`. Scoped instruction globs map exactly to Claude rule
`paths`. Commands include `disable-model-invocation: true` because AI Config v1
commands are explicit-only.

## Provider-specific overrides

Agents, skills and commands each accept an override. No instruction override
exists: `.claude/rules/*.md` documents exactly one frontmatter field, `paths`,
and that is the canonical `applyTo`.

Skill overrides carry only the fields Claude Code adds on top of the Agent
Skills specification. The six specification fields — `name`, `description`,
`license`, `metadata`, `compatibility`, `allowed-tools` — are read identically by
other assistants from the same `SKILL.md`, which AI Config copies verbatim, so
they belong in the canonical skill and are reserved against overrides.

Command overrides reserve `disable-model-invocation` and `user-invocable` on top
of the canonical fields: a canonical command is developer-invoked by definition,
and letting an override flip either one would contradict the canonical model.
Compatibility command files accept the remaining skill frontmatter, including
`metadata`, `license`, and `compatibility`; `name` and `paths` are ignored by
Claude Code and therefore are not exposed.

`permissionMode: manual` is exposed as the documented alias for `default`.
Canonical values remain preferred in examples, but accepting a current provider
alias avoids rejecting configuration Claude Code accepts.

Sources, read 2026-08-20:

- <https://code.claude.com/docs/en/sub-agents>
- <https://code.claude.com/docs/en/skills#frontmatter-reference>
- <https://code.claude.com/docs/en/memory>

Command file frontmatter is documented on the skills page: "Files in
`.claude/commands/` support the same frontmatter, except `name` and `paths`,
which Claude Code ignores in a command file."
