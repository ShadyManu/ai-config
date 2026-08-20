---
name: diagnostics
description: "Apply the AI Config diagnostic contract when adding, changing, or removing a user-facing problem report. Use whenever writing a Diagnostic, choosing a severity, wording a message, or touching packages/core/src/domain/codes.ts."
---

# Diagnostics

Every user-facing problem is a `Diagnostic`. There is no other channel: no
`console.log`, no thrown exception reaching the user, no silent skip.

## Codes are a public contract

Every code is declared in `packages/core/src/domain/codes.ts`. `Diagnostic.code`
is a checked union, not a free-form string.

Consumers match on codes in CI and in editor integrations, so:

- adding a code is an addition to the public API;
- removing or renaming one is a breaking change and belongs in the changelog;
- a code must be emitted by production code **and** asserted by at least one
  test. `test/diagnostic-codes.test.ts` enforces both directions.

Do not declare a code before the code path that raises it exists. Placeholder
codes have been added three times in this repository and removed three times.

Do not reuse an unrelated code because it is close enough. A code that names the
wrong condition is worse than a generic message, because a consumer branches on
it.

## Severity

- `error` — the sync is blocked. The output would be wrong, unsafe, or built
  from configuration that failed validation.
- `warning` — the sync proceeds, but the result is not what the author asked
  for: a lossy provider mapping, or undefined behaviour the author can resolve.
- `info` — the result is faithful; something merely changed shape, such as an
  invocation syntax.

A warning must be actionable. If the author cannot change anything, and the
behaviour is defined and harmless, it belongs in `docs/`, not in the diagnostic
stream. A permanent unfixable warning teaches people to ignore the whole set.

Reserve `warning` for genuinely undefined behaviour or genuine loss of intent.
Repetition of identical content is not loss of intent.

## Where a diagnostic points

`source` names a repository-relative path the author can open and change:

- a canonical file under `.ai/` for anything about its content;
- `.ai/config.yaml` for anything caused by the enabled provider combination;
- never a generated file, except drift diagnostics, which necessarily name it.

Include `line` and `column` when the position is known. Attribute `provider`
whenever the problem belongs to one.

Prefer reporting the same problem once, at the most specific location, over
restating it in aggregate somewhere less actionable.

## Messages

Say what is wrong **and** what to do about it:

```text
UNTRACKED_TARGET_EXISTS
AGENTS.md
'AGENTS.md' already exists and was not created by AI Config, so it will not be
overwritten. Move its content into '.ai/' and delete the file, then run sync
again.
```

Quote the offending value. Name the file. State the remedy as an instruction.

Do not leak absolute paths from the developer's machine, environment variables,
or file contents beyond the fragment that is wrong.

## Never silently discard

An unsupported provider feature, an unknown frontmatter field, a skipped file, a
mapping that loses intent — each produces a diagnostic. Dropping configuration
without saying so is the one failure this project cannot make.

If a condition cannot be reported because no code fits, add a code. Do not
downgrade it to silence.
