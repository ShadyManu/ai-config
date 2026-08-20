# Codex

Codex receives aggregate instructions in `AGENTS.md`, agents in
`.codex/agents/`, and skills in `.agents/skills/`. Scoped instruction globs are
rendered as visible prose and classified `lossy`. Commands become skills with
`agents/openai.yaml` containing `policy.allow_implicit_invocation: false`.

## Provider-specific overrides

Agents and skills accept an override.

An agent override carries a curated set of session-level `config.toml` keys:
`model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`,
`personality`, `sandbox_mode`, `approval_policy`, `web_search`, `service_tier`,
`tools.view_image`, and `mcp_servers`. The schema uses the general Config
Reference values except that `max` and `ultra` reasoning are included only here,
where the Subagents page documents them. `skills.config` is not exposed because
it contains machine-specific filesystem paths. The `[agents]` block remains
global orchestration configuration and is not an individual-agent setting.

A skill override writes the `agents/openai.yaml` sidecar. `policy`, `interface`,
and `dependencies.tools` are exposed. Tool dependencies are validated as a list
of mappings without freezing the evolving nested dependency shape.

No instruction override exists: `AGENTS.md` is plain Markdown with no
frontmatter and no path scoping. No command override exists: a canonical command
becomes a skill, and the one command-relevant control the sidecar offers is
already fixed to `false` by the explicit-only meaning of a canonical command.

Sources, read 2026-08-20:

- <https://learn.chatgpt.com/docs/agent-configuration/subagents>
- <https://learn.chatgpt.com/docs/agent-configuration/agents-md>
- <https://learn.chatgpt.com/docs/build-skills>
- <https://learn.chatgpt.com/docs/config-file/config-reference>

Codex custom prompts are documented as deprecated and are user-scoped
(`~/.codex/prompts/`), with no repository-scoped equivalent, which is why
commands target skills.
