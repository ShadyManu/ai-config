---
description: "Repository-wide engineering, verification, security, and scope rules for every AI Config change."
---

# AI Config Development Guidelines

## Quality standard

This is a public open-source repository. Treat all production code as library-quality code intended for external contributors and long-term maintenance.

Prefer correctness, clarity, maintainability, testability, and explicit behavior over speed of implementation.

## General engineering rules

- Use strict TypeScript.
- Do not use `any` unless there is no reasonable alternative and the reason is documented.
- Follow the repository's enforced function style: declare TypeScript functions as
  `const name = (...) => ...`, including exported functions. This is a local
  consistency rule, not a claim that arrow functions are universally superior.
- Use `interface` for object shapes. Use `type` for unions, intersections,
  tuples, primitive aliases, mapped/conditional types, and other compositions
  that an interface cannot express clearly.
- State class member accessibility explicitly (`public`, `private`, `protected`) and mark every member `readonly` that is never reassigned.
- Prefer small cohesive modules with one clear responsibility.
- Avoid deep inheritance hierarchies.
- Prefer composition and explicit interfaces.
- Keep domain/core code independent from VS Code and provider APIs.
- Provider-specific behavior belongs exclusively in provider adapters.
- Do not introduce abstractions until at least one concrete requirement justifies them.
- Do not duplicate domain logic across CLI and VS Code.
- Do not silently swallow errors.
- Use typed domain errors where appropriate.
- Never silently ignore unsupported provider features.
- Never delete files not explicitly owned by AI Config.
- Never write outside the repository root.
- Treat external filesystem/config input as untrusted.
- Keep generated output deterministic.
- Preserve backwards compatibility of exported APIs, serialized formats,
  diagnostic codes, generated paths, and CLI output unless the change is
  explicitly intended and documented as breaking.

## Before implementing

Before changing code:

1. inspect related existing code;
2. identify the correct architectural layer;
3. inspect existing tests;
4. avoid creating a parallel implementation of existing functionality.

## After implementing

For every meaningful change:

1. add or update behavioral tests for every observable behavior change;
2. run the repository quality gates documented in `docs/contributing.md`;
3. review the diff;
4. remove dead code and temporary debugging output.

Do not declare a task complete while tests, typecheck, lint, or build are failing.
The complete gate is `pnpm format:check`, `pnpm typecheck`, `pnpm lint`,
`pnpm test`, `pnpm build`, and `pnpm test:vscode`. Narrow checks are useful
during iteration but do not replace the complete gate before completion. If a
gate cannot run in the current environment, report the exact command, reason,
and remaining risk.

## Test obligation

- A bug fix must leave a regression test that fails for the original defect and
  passes with the fix. Prefer writing or confirming that failing test first.
- A new feature must test the public happy path plus relevant invalid, boundary,
  failure, and cross-package/provider behavior.
- A behavior-preserving refactor, documentation-only edit, or mechanical rename
  does not require a contrived new test, but the existing relevant suite must run.
- Exercise the public entrypoint and observable result. A mock-only or
  intermediate-value assertion is not sufficient evidence by itself.
- Keep tests deterministic, isolated, independent of execution order, and free
  of network, real user configuration, uncontrolled clocks, or arbitrary sleeps.

## Public API

Be conservative when exporting symbols.

Do not expose implementation details from package public APIs.

Prefer explicit package entrypoints.

Breaking public API changes must be deliberate.

## Comments

Do not comment obvious code.

Comments should explain WHY, invariants, compatibility constraints, provider quirks, or non-obvious design decisions.

## Dependencies

Do not add a dependency if the functionality can reasonably and safely be implemented with Node.js or an existing dependency.

Before adding a dependency, consider:

- maintenance status;
- bundle impact;
- security;
- necessity;
- whether it belongs in runtime or devDependencies.

## Scope

Do not implement unrelated improvements while completing a task.

If you notice unrelated problems, mention them separately.
