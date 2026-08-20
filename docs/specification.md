# AI Config v1 specification

`.ai/` is the canonical, portable source. Generated provider files are managed
only when recorded in `.ai/.generated.json`; unrecorded files are external and
are never overwritten, restored, or deleted.

## Configuration

```yaml
schema: 1
providers:
  enabled:
    - claude
    - codex
    - copilot
    - opencode
```

The provider IDs are closed, unique, and unordered. The only valid IDs are
`claude`, `codex`, `copilot`, and `opencode`. Output, diagnostics, and manifests
are deterministic regardless of their YAML order.

## Canonical artifacts

- Instructions: `.ai/instructions/<id>.md`; optional `description` and a
  non-empty positive root-relative `applyTo` glob list.
- Agents: `.ai/agents/<id>.md`; required `description` and non-empty body.
- Skills: `.ai/skills/<id>/SKILL.md`; required matching `name` and
  `description`; package contents are copied byte-for-byte.
- Commands: `.ai/commands/<id>.md`; required `description` and body. Commands
  are always explicit user-invoked workflows. `invocation` is not a v1 field.

Skill and command IDs must not collide.

## Capability classification

Every provider diagnostic identifies realization as one of `exact`, `lossy`,
`unsupported`, or `unverified`. Unscoped instructions, agents, and skills are
exact across the shipped providers. Scoped instructions are exact for Claude and
Copilot, and lossy for Codex and OpenCode. Commands are exact for Claude,
Codex, and OpenCode; Copilot is lossy because prompt files are IDE-only preview.

## Provider mappings

Claude writes scoped rules with `paths`. Copilot writes scoped instruction files
with `applyTo`. Codex and OpenCode write scope as visible prose in `AGENTS.md`
and report the loss. Codex converts a command to a skill and always writes
`agents/openai.yaml` with `policy.allow_implicit_invocation: false`.

## Provider overrides

Provider-specific settings for a canonical artifact live at
`.ai/providers/<provider>/<kind>/<id>.yaml`, where `<kind>` is `instructions`,
`agents`, `skills` or `commands`. The document has exactly two keys:

```yaml
schema: 1
options:
  <provider field>: <value>
```

The provider, kind and id come from the path, so they cannot disagree with the
contents. Each adapter declares which fields it accepts for which kind, with
their types, enumerations and ranges; core validates every override against that
declaration and passes the validated result back to the adapter to compile. The
same declaration drives CLI validation and the editor's guided flows, so none of
the four can disagree about what a provider supports.

An override cannot modify canonical identity, prompt or body, skill payloads,
command semantics, scopes, or core output paths. Setting a canonical field is
`OVERRIDE_CANONICAL_FIELD`; an undeclared field is `OVERRIDE_UNKNOWN_FIELD`. An
adapter may additionally refuse a specific artifact — Copilot refuses an
instruction override when the instruction has no `applyTo`, because the file it
would be written to has no frontmatter — reported as `OVERRIDE_NOT_APPLICABLE`.

`options` may be absent or empty. That is the state a scaffolded override is in
before any setting has been filled in, and it is reported as an informational
`OVERRIDE_EMPTY` rather than an error: an override that sets nothing is inert,
and creating one must never make a project invalid.

Override files for a disabled provider are read but produce no output, are never
deleted, and are reported once as `OVERRIDE_PROVIDER_DISABLED`.

## Overlays

The overlay envelope at `.ai/providers/<provider>/overlay.yaml` lists typed
extension documents for provider-only capabilities that are not refinements of a
canonical artifact. Core validates the envelope and target; adapters own the
extension schema and compilation. No extension type is registered in v1. Overlay
discovery is independent of override discovery: an override file takes effect
whether or not an envelope exists. See
[provider overlays](provider-overlays.md).

## Safety and ownership

Manifest entries record `managed` ownership, providers, source, content hash,
extension origin, and executable classification. `external` is reserved for
files AI Config must never write. Future structured `merge` ownership is not
implemented. Drift blocks normal sync; `--force` may replace drifted managed
files but never external files or modified orphans. Dry runs make no writes.
