---
name: security
description: "Review filesystem, configuration, path, dependency, and execution behavior for security risks. Use whenever working with paths, file writes, YAML/frontmatter, commands, external processes, dependencies, or provider output."
---

# Security Requirements

Treat configuration and filesystem input as untrusted.

Before changing a trust boundary, identify the untrusted input, the sensitive
operation it can reach, and the invariant that prevents abuse. Enforce that
invariant in production code and in a regression test.

## Path safety

Never allow generated paths to escape the workspace root.

Protect against:

- `../`
- absolute paths
- Windows drive paths
- UNC paths
- path normalization bypasses
- Windows reserved device names and characters that are not portable
- control characters in path segments

A generated path must land exactly where it says it does. **Any** symbolic link
along it is refused — not only one that leaves the repository — because
`.claude -> .ai` redirects output onto files no provider owns while satisfying
a containment check. The check is anchored to the resolved root, so a repository
living under a symlinked parent still works.

Resolve and validate paths before mutation, and before reading. A path that
failed the check is never opened: following the very link the check refused
holds the boundary for writes while leaking it for reads.

Use the existing safe-path and real-containment primitives. Do not replace them
with string-prefix checks or duplicate a weaker validation at a call site.
Validate as close as possible to the boundary and re-check immediately before a
sensitive filesystem operation when intervening state can change.

## File ownership

Never overwrite or delete arbitrary provider files.

Only mutate:

- files tracked in AI Config's generated manifest; or
- files explicitly approved by the user.

## Parsing

Do not execute configuration as code.

YAML/frontmatter parsing must produce plain data.

Validate parsed structures before use.

Reject or diagnose malformed, ambiguous, excessively large, or unsupported
input rather than coercing it into a plausible value. Preserve the distinction
between absent, invalid, and explicitly empty input.

Serialize provider output through the established serializers. Do not assemble
YAML, TOML, JSON, or frontmatter with unescaped user-controlled interpolation.

## Commands

Do not execute shell commands derived from `.ai` configuration unless such functionality is explicitly designed, reviewed, and documented.

The synchronization engine should not need arbitrary command execution.

When process execution is unavoidable, pass arguments without a shell, allowlist
the executable and operation, bound input and output, and propagate failures
without including secrets.

## Dependencies

Prefer established dependencies with narrow responsibility.

Do not introduce packages that execute arbitrary lifecycle/runtime code without need.

Before adding or upgrading a dependency, verify its necessity, maintenance,
license compatibility, transitive footprint, and known security implications.
Pin changes through the lockfile and do not weaken validation to accommodate a
dependency's permissive behavior.

## Logs

Do not log secrets, environment variables, tokens, or arbitrary file contents unnecessarily.

Diagnostics and errors must not disclose absolute machine paths, credentials,
environment contents, or more user-controlled content than is needed to explain
and remediate the problem.

## Failure behavior

Prefer failing safely to guessing.

If ownership, compatibility, or path safety is uncertain, stop the operation and emit a clear diagnostic.

Security-sensitive changes require negative tests for the blocked behavior as
well as a positive test for valid input. Cover the relevant platform forms,
including POSIX, Windows drive/UNC syntax, normalization, and symbolic links
when paths are involved.
