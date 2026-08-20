---
name: typescript-quality
description: "Apply strict production-grade TypeScript design and implementation practices. Use when creating, modifying, or reviewing TypeScript code."
---

# TypeScript Quality

When writing TypeScript for this repository:

## Types

- Preserve strict typing end-to-end.
- Avoid `any`.
- Prefer `unknown` for genuinely unknown external input and narrow it safely.
- Avoid unsafe type assertions.
- Use `interface` for object shapes, as enforced by this repository's ESLint
  configuration. Use `type` for unions, intersections, tuples, primitive
  aliases, mapped/conditional types, and derived compositions.
- Prefer discriminated unions for finite domain states.
- Prefer readonly data where mutation is unnecessary.
- Distinguish optional values from nullable values deliberately.
- Do not use non-null assertions to suppress legitimate uncertainty.
- Add explicit return types at module and package boundaries. Do not expose an
  inferred implementation detail accidentally through a public API.

## Classes

- State every member's accessibility explicitly: `public`, `private` or
  `protected`. There is no implicit default in this repository.
- Mark `readonly` every member that is never reassigned after construction.
- Prefer a module of functions over a class when there is no state to hold.

## Functions

- Follow the repository's enforced style: declare every TypeScript function as
  an arrow expression bound to a `const`, including exported functions. This is
  a consistency rule; choose it because the lint configuration and codebase do,
  not because function declarations are inherently obsolete.
- Arrow expressions are not hoisted, so declare a helper above the first use that runs while the module is still evaluating.
- Keep functions focused.
- Prefer pure functions for transformations and compilation logic.
- Separate I/O from computation.
- Avoid boolean parameters when they obscure intent.
- Prefer parameter objects when a function requires several related inputs.

## Domain modeling

Do not represent meaningful domain concepts as arbitrary strings when a constrained type is appropriate.

Prefer:

type ProviderId =
| 'claude'
| 'codex'
| 'copilot'
| 'opencode';

over repeated free-form strings.

Use exhaustive checking when branching over closed unions.

Model invalid states out when practical. Prefer a discriminated result over a
partially populated object whose fields become valid only by convention.

## Errors

Do not catch exceptions only to ignore them.

Use explicit result/diagnostic models for expected validation failures.

Reserve thrown exceptions for exceptional failures.

Include useful context in errors without leaking sensitive information.

## Imports and exports

Keep package boundaries explicit.

Use `import type` and `export type` for type-only boundaries.

Avoid circular dependencies.

Avoid barrel files when they create ambiguous dependency graphs or unintentionally expose internals.

## Async

Do not mark functions async unnecessarily.

Do not create unhandled promises.

Run independent operations concurrently only where behavior remains deterministic and failure handling is explicit.

## Cleanup

Remove:

- unused exports;
- commented-out implementations;
- temporary logging;
- obsolete TODOs;
- duplicated helpers.

Before completion, run the full quality gate in `docs/contributing.md`; narrow
typecheck, lint, and test commands are useful only while iterating. Formatting,
TypeScript, and ESLint configuration are the source of truth when a personal
style preference differs from the repository.
