# Provider overrides and overlays

Core `.ai` files describe portable instructions, agents, skills, and explicit
commands. Anything specific to one assistant lives under
`.ai/providers/<provider>/` and cannot alter canonical identity, text, skill
payloads, command semantics, scopes, or core-selected output paths.

There are two mechanisms, and almost everything uses the first.

## Artifact overrides

An override refines one canonical artifact for one provider.

```text
.ai/providers/opencode/
  agents/
    reviewer.yaml
```

```yaml
# agents/reviewer.yaml
schema: 1
options:
  temperature: 0.1
  permission:
    edit: deny
```

The provider, artifact kind and artifact id come from the path. `options` holds
provider fields and nothing else, which is what keeps a provider from ever
colliding with a reserved key.

Each adapter declares its supported fields — name, type, enumeration, range,
default and documentation URL. Core validates every override against that
declaration; the adapter then compiles the validated result into its own format.
The CLI's `--set` parsing and the editor's guided flows are built from the same
declaration, so a field cannot be accepted in one place and rejected in another.

Overrides are discovered independently of `overlay.yaml`. A file you write by
hand takes effect with no registration step.

The VS Code flows scaffold an override rather than interviewing you for values:
you choose which settings to include, and each one is written as a commented
placeholder for you to fill in. An override in that state is valid and has no
effect, which is what `OVERRIDE_EMPTY` reports.

| Code | Meaning |
| --- | --- |
| `OVERRIDE_INVALID` | Malformed envelope, wrong `schema`, or `options` present but not a mapping. |
| `OVERRIDE_EMPTY` | Informational: no setting is filled in yet, so the file has no effect. |
| `OVERRIDE_UNKNOWN_FIELD` | A field the provider does not declare, or one it documents as deprecated. |
| `OVERRIDE_CANONICAL_FIELD` | A field the canonical artifact owns. |
| `OVERRIDE_VALUE_INVALID` | Wrong type, enumeration miss, or out of range. |
| `OVERRIDE_TARGET_MISSING` | Informational: no canonical artifact with that id, so the file produces no output. It is preserved. |
| `OVERRIDE_NOT_APPLICABLE` | Warning: the provider cannot represent an override for this particular artifact. |
| `OVERRIDE_NOT_SUPPORTED` | Warning: the provider declares no options for that artifact kind. |
| `OVERRIDE_PROVIDER_DISABLED` | Informational: the files are preserved and inert. |

None of the last three is an error. An override file in any of those states
contributes nothing to any provider, so the generated output is exactly what it
would be without the file, and refusing to synchronize over it would withhold
every remedy — including removing the generated files — for a condition that
changes no output.

`OVERRIDE_TARGET_MISSING` is informational rather than a warning, and the file
is kept, for the same reason a disabled provider's overrides are kept: the
artifact may come back. A branch on which that artifact does not exist is the
ordinary way to reach this state, and deleting the settings on checkout would
lose work no tool can recreate. Deleting the artifact from the AI Config view is
the deliberate act that removes both together.

Which combinations exist is decided by what each provider's own documentation
supports, not by symmetry. See the
[user guide](user-guide.md#provider-override-reference) for the full matrix and
every field.

## Overlay extensions

The envelope is for provider-only capabilities that are **not** refinements of a
canonical artifact.

```text
.ai/providers/codex/
  overlay.yaml
  extensions/
    release-policy.yaml
  assets/
    release-policy/
```

```yaml
# overlay.yaml
schema: 1
provider: codex
extensions:
  - release-policy
```

No extension type is registered in v1: everything providers currently document
is a refinement of a canonical artifact, and is served by an override. The
machinery remains because a genuinely provider-only artifact would need it, and
because an unknown extension type must be an error rather than silence. Unknown
types, invalid targets and invalid schemas are errors.

## Manifest

Generated-file manifest entries include file-level ownership (`managed`), an
optional extension origin, and whether content is executable. `external` is
reserved for paths AI Config must never write; structured `merge` ownership is
reserved for future key-level merge support and is intentionally not implemented.
