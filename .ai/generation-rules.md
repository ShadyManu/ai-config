# What AI Config generates

Written by AI Config 1.3.0 when this project was created, from the
providers it supports. Nothing reads this file: it is here for you.

It is a snapshot. Run `aiconfig rules` to reprint it after an upgrade.

## Where each artifact goes

`<name>` stands for the artifact's file name without its extension.

### Instructions

| Provider | Unscoped | With `applyTo` |
| --- | --- | --- |
| Claude Code | `.claude/rules/<name>.md` | `.claude/rules/<name>.md` |
| Codex | `AGENTS.md` | `AGENTS.md` |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/instructions/<name>.instructions.md` |
| OpenCode | `AGENTS.md` | `AGENTS.md` |

### Agents

| Provider | Generated |
| --- | --- |
| Claude Code | `.claude/agents/<name>.md` |
| Codex | `.codex/agents/<name>.toml` |
| GitHub Copilot | `.github/agents/<name>.agent.md` |
| OpenCode | `.opencode/agents/<name>.md` |

### Skills

| Provider | Generated |
| --- | --- |
| Claude Code | `.claude/skills/<name>/SKILL.md` |
| Codex | `.agents/skills/<name>/SKILL.md` |
| GitHub Copilot | `.github/skills/<name>/SKILL.md` |
| OpenCode | `.opencode/skills/<name>/SKILL.md` |

### Commands

| Provider | Generated |
| --- | --- |
| Claude Code | `.claude/commands/<name>.md` |
| Codex | `.agents/skills/<name>/SKILL.md`<br>`.agents/skills/<name>/agents/openai.yaml` |
| GitHub Copilot | `.github/prompts/<name>.prompt.md` |
| OpenCode | `.opencode/commands/<name>.md` |

## What you can set per provider

All optional, and written in `.ai/providers/<provider>/<kind>s/<id>.yaml` —
create one with `aiconfig override create`, or from the editor. Everything
here refines a single provider; the canonical artifact still reaches every
enabled one.

A field this build does not recognize is written through with a warning
rather than refused, so a setting a provider adds later still works.

### Claude Code

| Applies to | Fields |
| --- | --- |
| agent | `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `memory`, `effort`, `background`, `isolation`, `color`, `initialPrompt`, `mcpServers`, `hooks` |
| command | `metadata`, `license`, `compatibility`, `argument-hint`, `arguments`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`, `when_to_use`, `shell`, `hooks` |
| skill | `when_to_use`, `disable-model-invocation`, `user-invocable`, `argument-hint`, `arguments`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`, `paths`, `shell`, `hooks` |

### Codex

| Applies to | Fields |
| --- | --- |
| agent | `model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `personality`, `sandbox_mode`, `approval_policy`, `web_search`, `service_tier`, `tools.view_image`, `mcp_servers` |
| skill | `policy.allow_implicit_invocation`, `interface.display_name`, `interface.short_description`, `interface.icon_small`, `interface.icon_large`, `interface.brand_color`, `interface.default_prompt`, `dependencies.tools` |

### GitHub Copilot

| Applies to | Fields |
| --- | --- |
| agent | `target`, `tools`, `model`, `disable-model-invocation`, `user-invocable`, `mcp-servers`, `metadata`, `argument-hint`, `handoffs`, `agents`, `hooks` |
| command | `agent`, `model`, `tools`, `argument-hint` |
| instruction | `excludeAgent` |
| skill | `argument-hint`, `user-invocable`, `disable-model-invocation`, `context` |

### OpenCode

| Applies to | Fields |
| --- | --- |
| agent | `mode`, `model`, `temperature`, `top_p`, `steps`, `disable`, `hidden`, `color`, `permission` |
| command | `agent`, `model`, `subtask` |
