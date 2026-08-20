---
name: architecture
description: "Enforce AI Config architectural boundaries and dependency direction. Use for architecture decisions, new modules, packages, adapters, synchronization logic, CLI features, and VS Code integration."
---

# AI Config Architecture

Maintain this dependency direction:

.ai filesystem
↓
parser
↓
provider-neutral IR
↓
validation
↓
compiler / synchronization planner
↓
provider adapters
↓
generated files

Consumers:

CLI → core
VS Code → core

## Hard boundaries

`@aiconfig/core`:

- must not import `vscode`;
- must not depend on CLI libraries;
- must not know UI concepts;
- must not contain hard-coded provider-specific output logic.

Provider packages:

- translate provider-neutral models into provider-specific artifacts;
- must not control generic filesystem synchronization;
- must not modify arbitrary workspace files directly.

CLI:

- orchestrates core functionality;
- contains presentation/parsing of CLI arguments;
- contains no duplicated synchronization logic.

VS Code extension:

- contains IDE integration only;
- commands, TreeViews, diagnostics, status bar, watchers;
- delegates actual operations to core.

## Design principles

Prefer dependency inversion around external I/O.

Separate:

- discovery;
- parsing;
- validation;
- compilation;
- planning;
- filesystem mutation.

Compilation should be side-effect free whenever practical.

Provider adapters should return desired artifacts rather than writing them directly.

Example:

compile(config) -> GeneratedArtifact[]

not:

compileAndWriteEverything(config, workspace)

## Ownership

AI Config may mutate only files it owns or files the user explicitly authorizes it to manage.

Provider directories may contain user-owned files.

Never assume a whole provider directory belongs to AI Config.

## Packages

```text
packages/core/          domain model, parser, validator, planner, sync engine
packages/agents-md/     shared AGENTS.md renderer (Codex + OpenCode)
packages/adapter-*/     one package per provider
packages/providers/     composition root: the built-in adapter set
packages/cli/           the aiconfig command
apps/vscode/            the extension
```

An adapter may not import another adapter. Code two adapters need lives in
`@aiconfig/agents-md` or in core. Only `packages/providers` knows the full set.

## Extensibility

Adding a provider requires, in order:

1. `docs/providers/<name>.md`, written from the provider's current official
   documentation, quoting exact paths and frontmatter fields;
2. a row in `docs/provider-capabilities.md`, classifying every canonical
   capability — `unsupported` is a valid answer, an invented mapping is not;
3. the identifier in `ProviderId`;
4. `packages/adapter-<name>/` implementing `ProviderAdapter`;
5. `targetRoots`, declaring every location the adapter may generate into, as
   narrowly as the provider allows — `.github/agents`, never `.github`;
6. `alsoReads`, declaring every location the provider reads but does not own;
   an adapter cannot see which others are enabled, so this declaration is the
   only way an overlap gets reported instead of silently emitted;
7. `overrides`, declaring any provider-specific artifact settings;
8. one line in `packages/providers/src/index.ts`;
9. fixture tests, and the combination tables in `packages/providers/test`.

It should not require modifying synchronization internals. If it does, the
adapter contract is missing something — say so rather than working around it.

See `docs/contributing.md` for the full procedure and `docs/architecture.md`
for why the boundaries sit where they do.
