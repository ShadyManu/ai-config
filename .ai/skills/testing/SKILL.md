---
name: testing
description: "Design, add, and review automated tests for AI Config behavior changes, bug fixes, provider output, synchronization, and VS Code integration."
---

# Testing Standards

Every observable behavior change must have appropriate automated tests in the
same change.

- For a bug fix, add a regression test that demonstrates the original failure
  and passes only when the defect is fixed. Prefer observing it fail before
  changing production code.
- For a new feature, cover the public happy path and the relevant invalid,
  boundary, failure, and interaction cases.
- For a behavior-preserving refactor, docs-only change, or mechanical rename,
  do not add a test merely to satisfy a quota; run the existing relevant tests.

## Test hierarchy

Prefer:

1. unit tests for pure domain logic;
2. fixture/golden tests for provider compilation;
3. combination tests in `packages/providers/test` for anything that only holds
   across providers;
4. integration tests for filesystem synchronization;
5. minimal VS Code integration tests for IDE wiring.

Do not test implementation details unnecessarily.

## Combinations

Where the input space is small and closed, enumerate it instead of choosing
examples: enabled-provider subsets, artifact kind against provider, the planner's
desired/manifest/disk/drift-policy grid, every field of every override schema.

State the expected result as a declared table, written from the specification
rather than from the implementation, and assert the table is exhaustive. A rule
verified on one representative case is a rule that may already have stopped
holding for the others.

## Provider adapters

Every provider adapter must have fixture-based tests.

Given:

.ai input

verify the complete generated provider output.

When provider output format intentionally changes, review the fixture diff before updating expectations.

## Synchronization

Test at minimum:

- creation of generated files;
- updates;
- removal of stale owned files;
- preservation of non-owned files;
- drift detection;
- missing generated files;
- path traversal rejection;
- dry-run;
- disabled providers;
- partial failures.

## Bugs

First reproduce a bug with a failing test whenever the defect is observable in
an automated test. If that is genuinely impractical, explain why and verify the
fix at the nearest stable boundary.

## Test quality

Tests must be deterministic.

Assert observable behavior through the public or package entrypoint. A test of
only mocks, private helpers, call counts, or intermediate values is insufficient
when the final result can be asserted.

Prefer explicit expected values and semantic assertions. Use full fixture/golden
comparisons when generated output is the contract, and review intentional
fixture changes rather than updating them blindly.

Do not depend on:

- internet;
- user's home directory;
- real Claude configuration;
- real Codex configuration;
- current clock unless explicitly controlled.

Use isolated temporary directories.

Avoid arbitrary sleeps.

Tests must run independently and in any order.

Test names should state the behavior and condition, not the implementation
method. Keep each test focused enough that a failure identifies the broken
contract.

## Verification

Run the narrowest relevant test while iterating, then before completion run the
repository's complete quality gate:

1. `pnpm format:check`;
2. `pnpm typecheck`;
3. `pnpm lint`;
4. `pnpm test`;
5. `pnpm build`;
6. `pnpm test:vscode`.

Do not report completion with a failing check. If a check cannot run, state the
exact command, reason, and remaining risk.
