---
name: vscode-extension
description: "Apply VS Code extension engineering practices when modifying apps/vscode."
---

# VS Code Extension Engineering

Keep the extension thin.

The extension is an adapter between VS Code and AI Config core.

## Activation

Keep activation lightweight.

Do not perform expensive workspace scans during activation.

Register disposables through `context.subscriptions`.

## VS Code APIs

Prefer native APIs:

- commands;
- TreeView;
- DiagnosticCollection;
- FileSystemWatcher;
- OutputChannel;
- status bar;
- built-in diff editor.

Do not create a WebView when native VS Code UI is sufficient.

## Workspace

Do not assume a workspace exists.

Handle:

- no workspace;
- single workspace;
- multi-root workspace.

Do not assume `workspaceFolders[0]` is always correct.

## Watchers

Watch only relevant `.ai` files.

Debounce bursts of filesystem events.

Avoid feedback loops.

Dispose watchers correctly.

## Notifications

Do not spam users.

Routine details belong in the AI Config Output Channel.

Use notifications for:

- actionable failures;
- significant warnings;
- explicit command completion when useful.

## Errors

Convert core diagnostics into appropriate VS Code diagnostics or messages.

Do not expose stack traces as normal UI messages.
