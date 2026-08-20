import type { Diagnostic, DiagnosticSeverity } from '@aiconfig/core';
import { sortDiagnostics } from '@aiconfig/core';

export const SYMBOL = {
  ok: '✓',
  warning: '⚠',
  error: '✗',
  pending: '•',
} as const;

/** Where CLI output goes. Injected so tests can capture it. */
export interface OutputStreams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export const consoleStreams: OutputStreams = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

export const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + ' '.repeat(width - text.length);

export const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  `${String(count)} ${count === 1 ? singular : plural}`;

const SEVERITY_LABEL: Readonly<Record<DiagnosticSeverity, string>> = {
  error: 'Errors',
  warning: 'Warnings',
  info: 'Notes',
};

/**
 * Renders diagnostics grouped by severity.
 *
 * Each entry leads with its machine-readable code so a message can be looked
 * up or matched in CI, then the source location, then the explanation.
 */
export const renderDiagnostics = (
  diagnostics: readonly Diagnostic[],
  severity: DiagnosticSeverity,
): readonly string[] => {
  const matching = sortDiagnostics(diagnostics).filter(
    (diagnostic) => diagnostic.severity === severity,
  );
  if (matching.length === 0) {
    return [];
  }

  const lines: string[] = ['', `${SEVERITY_LABEL[severity]}:`];

  for (const diagnostic of matching) {
    lines.push('', `  ${diagnostic.code}`);
    if (diagnostic.source !== undefined) {
      const position = diagnostic.line === undefined ? '' : `:${String(diagnostic.line)}`;
      lines.push(`  ${diagnostic.source}${position}`);
    }
    lines.push(`  ${diagnostic.message}`);
  }

  return lines;
};

export const jsonDiagnostic = (diagnostic: Diagnostic): Record<string, unknown> => ({
  code: diagnostic.code,
  severity: diagnostic.severity,
  message: diagnostic.message,
  source: diagnostic.source ?? null,
  line: diagnostic.line ?? null,
  provider: diagnostic.provider ?? null,
  capability: diagnostic.capability ?? null,
});

/** Serializes machine-readable output with a stable shape and trailing newline. */
export const renderJson = (payload: unknown): string => JSON.stringify(payload, null, 2);
