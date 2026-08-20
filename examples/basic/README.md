# Example: basic

A minimal repository showing the canonical `.ai/` layout with every v1 concept
represented:

```text
.ai/
├── config.yaml                          all four providers enabled
├── instructions/
│   ├── general.md                       unscoped
│   └── backend.md                       scoped with applyTo
├── agents/
│   └── reviewer.md
├── skills/
│   └── code-review/
│       ├── SKILL.md
│       └── references/checklist.md       supporting file
└── commands/
    └── fix-bug.md
```

To compile it:

```bash
aiconfig sync
```

Generated provider files are not committed here. The adapter fixture tests
compile this directory and compare the result against the expected output
checked in under `packages/adapter-*/test/fixtures/`, so those files serve as
the worked example of what each provider receives.

Note that `aiconfig validate` reports warnings for this example by design:
`backend.md` uses `applyTo`, which Codex and OpenCode cannot express, and
`fix-bug.md` is a command, which Codex represents as a skill and Copilot only
exposes in IDEs.
