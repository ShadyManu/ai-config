import type { DiagnosticCode } from './codes.js';
import { compareStrings } from './ordering.js';
import type { ProviderId } from './provider.js';
import type { CapabilityClassification } from '../adapter/adapter.js';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * A validation or compatibility result.
 *
 * `code` is part of the public contract: consumers match on it. `source` points
 * at a repository-relative canonical file so problems are reported where the
 * author can fix them, never at generated output — except drift diagnostics,
 * which necessarily name the generated file.
 */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source?: string | undefined;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly provider?: ProviderId | undefined;
  /** How faithfully a provider realizes the relevant canonical intent. */
  readonly capability?: CapabilityClassification | undefined;
}

export const hasErrors = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === 'error');

export const countBySeverity = (
  diagnostics: readonly Diagnostic[],
  severity: DiagnosticSeverity,
): number => diagnostics.filter((diagnostic) => diagnostic.severity === severity).length;

const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Orders diagnostics for display.
 *
 * The comparison is total — it ends on `message`, so no two distinct
 * diagnostics compare equal. A partial order would leave equal-ranked entries
 * in whatever order they were produced, which is not stable across runs.
 */
export const sortDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  [...diagnostics].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    const bySource = compareStrings(a.source ?? '', b.source ?? '');
    if (bySource !== 0) {
      return bySource;
    }
    const byLine = (a.line ?? 0) - (b.line ?? 0);
    if (byLine !== 0) {
      return byLine;
    }
    const byColumn = (a.column ?? 0) - (b.column ?? 0);
    if (byColumn !== 0) {
      return byColumn;
    }
    const byProvider = compareStrings(a.provider ?? '', b.provider ?? '');
    if (byProvider !== 0) {
      return byProvider;
    }
    const byCapability = compareStrings(a.capability ?? '', b.capability ?? '');
    if (byCapability !== 0) return byCapability;
    const byCode = compareStrings(a.code, b.code);
    return byCode !== 0 ? byCode : compareStrings(a.message, b.message);
  });
