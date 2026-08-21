# Architecture

## Pipeline

```text
                          .ai/
                            │
                       discovery  ← I/O
                            │
                          parser
                            │
                   AiConfiguration (IR)
                            │
                        validation
                            │
                         compiler
                ┌───────────┼───────────┬───────────┐
                ↓           ↓           ↓           ↓
             adapter     adapter     adapter     adapter
             claude      codex       copilot     opencode
                │           │           │           │
                └───────────┴─────┬─────┴───────────┘
                                  │
                    CompileResult (files + diagnostics)
                                  │
                          probe  ← I/O
                    (manifest + working tree)
                                  │
                               planner
                                  │
                              SyncPlan
                                  │
                             writer  ← I/O
                                  │
                    generated provider files
                              + manifest
```

Three stages perform I/O: **discovery**, **probe** and **writer**. Every other
stage is a pure function of its input. `probe` exists so the planner can be
pure: it reads exactly the paths in `desired ∪ manifest` and returns a
snapshot, which also bounds filesystem access to a known path set — AI Config
never walks `.github/` or `.claude/` looking for things.

## Packages

```text
ai-config/
├── apps/
│   └── vscode/                 VS Code extension
├── packages/
│   ├── core/                   @aiconfig/core
│   ├── agents-md/              @aiconfig/agents-md
│   ├── adapter-claude/         @aiconfig/adapter-claude
│   ├── adapter-codex/          @aiconfig/adapter-codex
│   ├── adapter-copilot/        @aiconfig/adapter-copilot
│   ├── adapter-opencode/       @aiconfig/adapter-opencode
│   ├── providers/              @aiconfig/providers
│   └── cli/                    @aiconfig/cli
├── docs/
└── examples/
```

Two packages exist beyond the obvious set. Both are private and internal, and
both replace duplication that would otherwise have no compile-time guard:

- **`agents-md`** renders the root `AGENTS.md` document. Codex and OpenCode both
  read that file and must receive byte-identical content. Implementing the
  concatenation format twice in two packages that cannot import each other
  would make divergence a silent bug caught only by a cross-adapter test, and
  it would surface to users as `OUTPUT_PATH_CONFLICT` — an error that reads
  like a configuration problem but is an AI Config defect. Sharing the renderer
  makes byte-identity structural.

  It is deliberately *not* in `core`: it is provider-flavoured output. It is
  also deliberately narrow — Copilot's `.github/copilot-instructions.md` is also
  a concatenation, but of unscoped instructions only, so it has its own renderer
  in `adapter-copilot`. Those are two different rules and are not unified.

- **`providers`** is the composition root: it exports `createDefaultAdapters()`.
  Without it, both `cli` and `apps/vscode` would independently assert which
  providers exist, and adding a provider would mean editing both.

### Dependency direction

```text
   ┌──────────────┐              ┌──────────────┐
   │ apps/vscode  │              │     cli      │
   └──────┬───────┘              └──────┬───────┘
          └─────────────┬───────────────┘
                        ↓
               ┌─────────────────┐
               │    providers    │
               └────────┬────────┘
                        ↓
               ┌─────────────────┐
               │    adapters     │
               └───┬─────────┬───┘
                   │         ↓
                   │  ┌─────────────┐
                   │  │  agents-md  │
                   │  └──────┬──────┘
                   ↓         ↓
               ┌─────────────────┐
               │      core       │
               └─────────────────┘
```

Arrows point from dependent to dependency. No upward edges, no cycles.

- `core` depends on nothing in the workspace.
- `agents-md` depends on `core` only.
- Adapters depend on `core`, and `adapter-codex` / `adapter-opencode` also on
  `agents-md`. **No adapter imports another adapter.**
- `providers` depends on the four adapters.
- `cli` and `apps/vscode` depend on `core` and `providers`.

These rules are enforced in CI by `no-restricted-imports` ESLint rules, not by
convention. Adapters are additionally forbidden from importing `node:fs`,
`node:path` and `vscode`; `core` is forbidden from importing `vscode` and any
adapter.

### Provider identity

`ProviderId` is a closed union in `core`. It is used as the type of an adapter's
`id` and of `config.yaml` provider keys, which gives `cli` and `apps/vscode`
static safety. **Core never branches on it** — there is no `switch (providerId)`
anywhere in `core`, because that would be provider-specific logic in core.

Two consequences follow, and both are load-bearing:

- **Configuration is validated against the registered adapter set**, passed in
  as data, not against the union. Enabling a provider for which no adapter was
  registered is `UNKNOWN_PROVIDER`, not a silent no-op that produces no files.
- **The manifest parses provider identifiers as plain strings.** A manifest
  written by a newer AI Config that knows a fifth provider must still be
  readable, because ownership does not require understanding what an identifier
  means. Typing that field as the union would make such a manifest unparseable,
  hence treated as empty, hence every path blocked as untracked.

Adding a provider means: a new adapter package, one line in `providers`,
fixtures, and documentation. No `core` edits.

## Core responsibilities

| Module | Responsibility |
| --- | --- |
| `domain/` | IR types, `ProviderId`, diagnostics, plan actions |
| `parse/` | frontmatter, YAML, `config.yaml`, `.ai/` discovery |
| `validate/` | canonical validation over the IR |
| `adapter/` | `ProviderAdapter` contract, `GeneratedFile`, `CompileResult` |
| `compile/` | runs adapters, enforces path safety, resolves output conflicts |
| `manifest/` | read and write the manifest; hash generated content |
| `probe/` | snapshot the working tree for a bounded path set |
| `plan/` | derive a `SyncPlan` from desired output, manifest and snapshot |
| `sync/` | orchestration: parse → validate → compile → probe → plan → write |
| `fs/` | `FileSystem` interface plus the Node implementation |

Collection sorting happens once in `core`, on the IR, so every adapter inherits
deterministic ordering for free.

Deciding *what* to serialize belongs entirely to adapters: which fields a
provider gets, under which names, in which order. TOML exists only in
`adapter-codex`, and each adapter owns its own markdown layout.

`core/text/yaml-frontmatter.ts` is the one shared serialization primitive. It
takes an ordered list of key/value pairs and turns them into bytes, and it knows
nothing about which provider uses which key — Claude's `paths` and Copilot's
`applyTo` are both just keys the caller supplies. It exists because correct YAML
scalar quoting is subtle (a bare `0x1F` reads back as the integer 31, `*.ts`
looks like an alias) and four independent implementations of that rule would
eventually disagree.

### Filesystem abstraction

All filesystem access goes through a narrow `FileSystem` interface. The Node
implementation is the only production implementation; an in-memory
implementation backs the unit tests, which keeps them fast, isolated from the
developer's real provider configuration, and free of temp-directory cleanup.

Integration tests use the Node implementation against a temporary directory.

### Path safety

Path safety has two layers, because one is not enough.

**Lexical**, in `path/safe-path.ts`: applied in `compile/` to every artifact
returned by every adapter. It rejects absolute paths, drive and UNC forms, `..`
segments, control characters, Windows reserved device names, and characters
Windows cannot store. Adapters return repository-relative paths and cannot
bypass it — they never receive a `FileSystem`, an absolute root, or any other
means of touching disk.

**Real**, in `path/containment.ts`: applied before any canonical directory is
read and before any generated file is written. A lexically perfect path still
escapes if a directory along it is a symbolic link, and both `mkdir -p` and
`rename` follow links — so a repository could otherwise ship
`.claude -> /somewhere/else` and redirect writes anywhere on the machine. Every
path is resolved through its deepest existing ancestor and confirmed to sit
inside the real repository root.

## Adapter contract

```ts
interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly targetRoots: readonly string[];       // locations it may generate into
  compile(configuration: AiConfiguration): CompileResult;
}

interface CompileResult {
  readonly files: readonly GeneratedFile[];
  readonly diagnostics: readonly Diagnostic[];
}

interface GeneratedFile {
  readonly path: string;             // repository-relative, POSIX separators
  readonly source: SourceRef | null; // canonical origin; null for aggregates
  readonly content: FileContent;
}

type FileContent =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'copy'; readonly source: SkillFileRef };
```

`targetRoots` is recognition, never ownership: it lets Initialize warn that a
repository already holds files that look like a provider's, before there is any
configuration to compile. Only `.ai/.generated.json` establishes ownership, so
nothing is adopted on the strength of a match. A cross-adapter test asserts that
every path an adapter generates falls inside its declared roots.

`compile` is a single member rather than a separate `analyze` + `compile` pair.
Splitting them would let an adapter's warnings drift out of sync with what it
actually emits — `adapter-codex` must warn `INSTRUCTION_SCOPE_NOT_SUPPORTED`
for exactly the instructions whose scope it flattens — and there is no cost to
avoid: `compile` is pure, synchronous and cheap, so `validate` simply calls it
and discards the files.

`compile` is synchronous and performs no I/O, no clock reads and no randomness.
That is what makes `aiconfig validate` possible without touching the filesystem
and `--dry-run` provably side-effect free.

An adapter reports failure by returning an `error`-severity diagnostic; `core`
then discards that adapter's files and blocks the sync. `core` also wraps each
adapter call and converts an escaping exception into `ADAPTER_INTERNAL_ERROR`,
so a defective adapter degrades into a diagnostic rather than a stack trace.

`GeneratedFile` has no `provider` field. Ownership is attributed by `core` from
the adapter that returned the file, so an adapter cannot claim ownership on
another provider's behalf.

### Directories a provider reads but does not own

Some providers read directories another provider owns: Copilot and OpenCode both
scan `.claude/skills` and `.agents/skills`, and Copilot reads a root `AGENTS.md`.
With several providers enabled, one consumes the other's generated output.

Nothing reports this, and no adapter declares it. Every copy is compiled from the
same canonical source and is byte-for-byte identical, both tools deduplicate
skills by name, and the ambiguity that remains — which of several identical
copies a tool happens to bind to — is a property of that tool, not of the
configuration. It is documented per provider under `docs/providers/`, where a
reader can find it, rather than reported on every synchronization where nobody
can act on it.

This is the second diagnostic removed for that reason, after
`INSTRUCTION_DISCOVERY_OVERLAP` in 1.3.0. The rule they both failed is in
`.claude/skills/diagnostics/SKILL.md`: a warning must be actionable, and a
permanent unfixable one teaches people to ignore the whole set.

The mechanism that carried them — an `alsoReads` declaration on the adapter,
matched against reconciled artifacts by core — went with the last of them.
Keeping an extension point with no consumer would have been a promise the next
adapter author could not cash.

### Skill payloads

Skill files are referenced, not carried. Discovery records
`{ path, size, sha256, executable }` for each file in a skill directory; an
adapter emits a `copy` descriptor pointing at that record.

This matters because four enabled providers produce four copies of every skill
file. Carrying bytes would mean holding and hashing each payload four times on
every sync — including on every save, since the extension synchronizes whenever
a `.ai/` change is valid. With descriptors, the planner compares hashes without
reading a payload byte, and the writer streams only the files it actually
writes.

A `copy` descriptor is a reference *into the IR*, never a path the adapter
constructs, so path safety remains unbypassable.

## Synchronization planning

The planner is a pure function of three inputs:

1. desired output — the compiled `GeneratedFile[]`;
2. recorded ownership — the manifest;
3. reality — the `WorkingTreeSnapshot` from `probe`.

It emits a `SyncPlan` of typed actions. **Plan actions are the single source of
truth**; the file states reported by `aiconfig status` are derived from them, so
status and sync cannot disagree.

| Action | Condition | Derived status state |
| --- | --- | --- |
| `create` | Desired, not in manifest, absent on disk | `missing` |
| `restore` | Desired, in manifest, absent on disk | `missing` |
| `update` | Desired, in manifest, on disk, content differs | `stale` |
| `unchanged` | Desired, in manifest, on disk, content matches | `synced` |
| `delete` | In manifest, no longer desired | `orphaned` |
| `blocked` | Desired, but the target cannot be safely written | `drift` or `conflict` |

`blocked` carries a typed reason, because the two causes need different
remedies and different VS Code actions:

| Reason | Cause | Remedy |
| --- | --- | --- |
| `drift` | On disk, in manifest, hash differs from the manifest | diff, restore, or `--force` |
| `untracked` | On disk, not in manifest | move the content into `.ai/`, or delete the file |

`restore` is distinct from `create` because it reports differently: a file AI
Config previously generated has been deleted, which the user may want to know
about.

### Drift policy

Whether drift blocks is a planning input, not a CLI concern:

```ts
plan(desired, manifest, snapshot, { onDrift: 'block' | 'overwrite' })
```

`--force` in the CLI and the "Restore Generated File" action in VS Code both set
`onDrift: 'overwrite'`. Neither reimplements the decision.

**`onDrift: 'overwrite'` never applies to `untracked`.** Adopting a file AI
Config never created is a different and more dangerous operation than restoring
one it did create, and it is what would destroy a hand-written `AGENTS.md`.
There is no flag for it in v1.

## Write protocol

`plan()` returns a `SyncPlan` that may contain `blocked` actions. A total
function `toWritablePlan(plan)` returns either a `WritablePlan` — a distinct
type that is the only thing `write()` accepts — or the blocking diagnostics.
The invariant is enforced by the compiler, not by discipline.

1. Create parent directories.
2. For each `create` / `restore` / `update`: write to a temporary file in the
   destination directory, then rename over the target. Rename within a
   directory is atomic on POSIX and effectively atomic on Windows.
3. For each `delete`: remove the file. Empty directories are **not** pruned —
   the manifest records files only, so nothing records that AI Config created a
   directory, and removing directories it cannot prove it owns is exactly the
   assumption the ownership model forbids. An empty directory is harmless.
4. Write the manifest last.

If a write fails partway, the files already written are valid and complete, and
the manifest still describes the previous state. The next sync reconciles.
`stale` is a recoverable state; a truncated file is not.

## Consumers

### CLI

`@aiconfig/cli` parses arguments, obtains adapters from `providers`, calls
`core`, and renders results as text or JSON. It contains no synchronization
logic.

### VS Code extension

`apps/vscode` contains IDE integration only: commands, status bar, tree view,
diagnostics, file watcher, output channel and drift actions. It calls the same
`core` entry points as the CLI.

Core stays single-root: it exposes `findRepositoryRoot` and `isInitialized(root)`
and knows nothing about workspace folders. Choosing among several folders is a
few lines in the extension, where the VS Code concept belongs.

The extension bundles `core`, `providers` and the adapters with esbuild, so the
published `.vsix` has no runtime workspace dependencies.

## Testing layers

| Layer | Location | What it covers |
| --- | --- | --- |
| Unit | `packages/core/test` | parsing, validation, path safety, hashing, manifest, planner |
| Fixture | `packages/adapter-*/test` | exact generated bytes for each adapter |
| Cross-provider | `packages/providers/test` | every enabled combination, and every declared override field |
| Integration | `packages/core/test/integration` | real filesystem, temp dirs, full sync lifecycle |
| End-to-end | `packages/cli/test` | CLI commands against a temp copy of `examples/basic` |
| Extension | `apps/vscode/src/test` | activation and command registration |

Fixture tests compare complete generated output against checked-in expected
files, because provider formats are serialization contracts. A change to
expected output must be reviewed as a diff.

The cross-provider layer exists because a fixture test compiles one adapter at
a time, and several guarantees only mean anything across the set: that enabling
a provider changes nothing another one generates, that ownership of a shared
path lands on exactly the providers producing it, that a foreign intake is
reported once per consuming provider, and that switching the enabled set leaves
the working tree in the state a project with that set would have had. Four
providers give sixteen subsets and 256 transitions between them, which is small
enough to run in full rather than sample. It is also where the override schemas
are swept field by field, so a field is covered the moment an adapter declares
it rather than when someone remembers to write a test.

`packages/providers` is the only package that may depend on every adapter,
which is what makes it the place these tests can live at all.

End-to-end tests copy `examples/basic` into a temporary directory before running
commands. They never write into the checked-in example.
