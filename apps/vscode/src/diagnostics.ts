import * as path from 'node:path';
import * as vscode from 'vscode';

import type { Diagnostic } from '@aiconfig/core';

/**
 * Publishes core diagnostics as editor diagnostics.
 *
 * Only diagnostics that name a canonical source file are shown: the author
 * fixes problems in `.ai/`, and pointing at generated output would send them to
 * a file they should not be editing. Drift is surfaced through the tree view
 * instead, where a diff and a restore action are available.
 *
 * Capability notes are excluded for the same reason. They describe what a
 * provider can express — that Codex has no path-scoped instructions, say — not
 * a mistake in the file, so nothing the author writes there can resolve one.
 * Left in, they would sit permanently on line 1 of every artifact that has an
 * `applyTo` or a command, which is how a Problems panel stops being read. They
 * are reported on the provider in the tree view, where they belong, and by
 * `aiconfig validate`. None of them is ever an error, so this hides nothing
 * that blocks a synchronization.
 */
export class DiagnosticPublisher implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('aiconfig');

  public publish(root: string, diagnostics: readonly Diagnostic[]): void {
    this.collection.clear();

    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const diagnostic of diagnostics) {
      if (!diagnostic.source?.startsWith('.ai/')) {
        continue;
      }

      if (diagnostic.capability !== undefined) {
        continue;
      }

      const absolute = path.join(root, ...diagnostic.source.split('/'));
      const existing = byFile.get(absolute) ?? [];
      existing.push(toVsCodeDiagnostic(diagnostic));
      byFile.set(absolute, existing);
    }

    for (const [file, entries] of byFile) {
      this.collection.set(vscode.Uri.file(file), entries);
    }
  }

  public clear(): void {
    this.collection.clear();
  }

  public dispose(): void {
    this.collection.dispose();
  }
}

const toVsCodeDiagnostic = (diagnostic: Diagnostic): vscode.Diagnostic => {
  // Core reports 1-based positions; VS Code ranges are 0-based.
  const line = Math.max(0, (diagnostic.line ?? 1) - 1);
  const column = Math.max(0, (diagnostic.column ?? 1) - 1);

  const result = new vscode.Diagnostic(
    new vscode.Range(line, column, line, Number.MAX_SAFE_INTEGER),
    diagnostic.message,
    severityOf(diagnostic),
  );

  result.source = 'AI Config';
  result.code = diagnostic.code;
  return result;
};

const severityOf = (diagnostic: Diagnostic): vscode.DiagnosticSeverity => {
  switch (diagnostic.severity) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'info':
      return vscode.DiagnosticSeverity.Information;
  }
};
