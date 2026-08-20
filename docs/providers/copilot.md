# GitHub Copilot

Copilot receives unscoped instructions in `.github/copilot-instructions.md`,
scoped instructions in `.github/instructions/*.instructions.md`, agents in
`.github/agents/`, skills in `.github/skills/`, and commands as prompt files.
Scoped instructions map exactly. Command prompt files are IDE-only and public
preview, so command realization is classified `lossy`.

## Overlap with `AGENTS.md`

Copilot also reads a root `AGENTS.md`, which AI Config generates for Codex and
OpenCode. When Copilot is enabled beside either of them, every instruction
therefore reaches Copilot twice.

AI Config does not report this. The two copies are generated from the same
canonical source, so they never disagree, and Copilot's scoped channel —
`.github/instructions/*.instructions.md` — keeps matching by path exactly as it
would on its own. The repetition costs context, nothing else.

One consequence is real: an instruction you scoped with `applyTo` arrives
unscoped through `AGENTS.md`, which has no frontmatter and no glob scoping, so
Copilot may apply it outside the paths you chose. That loss is reported already,
once per instruction and against the canonical file, as
`INSTRUCTION_SCOPE_NOT_SUPPORTED`.

To stop the duplication entirely, disable `AGENTS.md` discovery in your Copilot
client — in VS Code, the `chat.useAgentsMdFile` setting. AI Config does not
write that setting: it is editor-local, while the same repository is read by
Copilot on github.com, in other IDEs, and in the Copilot CLI, none of which
would honour it.

## Provider-specific overrides

Instructions, agents, skills and commands accept an override.

The instruction override carries `excludeAgent` only, and only for a path-scoped
instruction. An unscoped instruction is aggregated into
`.github/copilot-instructions.md`, which GitHub documents with no frontmatter at
all, so the field has nowhere to go; the override is refused with
`OVERRIDE_NOT_APPLICABLE` rather than silently dropped.

The agent override excludes `infer`, which GitHub documents as retired in favour
of `disable-model-invocation` and `user-invocable`. Cloud-only `metadata` is a
string-to-string mapping. IDE-only `argument-hint`, `handoffs`, `agents`, and
Preview `hooks` follow the VS Code schema; `handoffs` is a list of mappings.
`model` accepts the cloud scalar form and the VS Code prioritized-list form.
`advancedOptions` is not exposed because neither current first-party reference
documents it.

A skill override carries VS Code's `argument-hint`, `user-invocable`,
`disable-model-invocation`, and experimental `context: fork`. The six Agent
Skills specification fields, including experimental `allowed-tools`, remain in
the canonical `SKILL.md`.

Sources, read 2026-08-20:

- <https://docs.github.com/en/copilot/reference/custom-agents-configuration>
- <https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions>
- <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills>
- <https://code.visualstudio.com/docs/agent-customization/prompt-files>
- <https://code.visualstudio.com/docs/agent-customization/custom-agents>
- <https://code.visualstudio.com/docs/agent-customization/agent-skills>

`AGENTS.md` discovery, read 2026-08-20:

- <https://code.visualstudio.com/docs/agent-customization/custom-instructions>
