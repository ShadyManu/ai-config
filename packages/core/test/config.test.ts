import { describe, expect, it } from 'vitest';

import type { DiagnosticCode } from '../src/domain/codes.js';
import { enabledProviders } from '../src/domain/configuration.js';
import type { ProviderId } from '../src/domain/provider.js';
import { CONFIG_PATH, parseConfig } from '../src/parse/config.js';

const ALL: readonly ProviderId[] = ['claude', 'codex', 'copilot', 'opencode'];

describe('schema v1 configuration', () => {
  it('parses schema: 1 and sorts enabled providers independently of YAML order', () => {
    const result = parseConfig(
      'schema: 1\nproviders:\n  enabled:\n    - opencode\n    - claude\n',
      ALL,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.config?.schema).toBe(1);
    expect(result.config === undefined ? [] : enabledProviders(result.config)).toEqual([
      'claude',
      'opencode',
    ]);
  });
});

/**
 * Every way `.ai/config.yaml` can be wrong, and what each one reports.
 *
 * `config.yaml` decides which providers run, so a malformation that parsed to
 * something other than what was written would compile the wrong repository.
 * The file is small enough to enumerate its failure modes rather than sample
 * them, and the table below is asserted to cover every diagnostic code the
 * parser can raise.
 */

/** The codes `parseConfig` owns. Stated here so the table cannot leave one out. */
const CONFIG_CODES: readonly DiagnosticCode[] = [
  'CONFIG_INVALID_YAML',
  'CONFIG_NOT_A_MAP',
  'MISSING_SCHEMA_VERSION',
  'INVALID_SCHEMA_VERSION',
  'UNSUPPORTED_SCHEMA_VERSION',
  'UNKNOWN_CONFIG_KEY',
  'INVALID_PROVIDERS',
  'UNKNOWN_PROVIDER',
];

interface ConfigCase {
  readonly label: string;
  readonly text: string;
  readonly expected: readonly DiagnosticCode[];
  /** Whether a configuration is still produced despite the diagnostics. */
  readonly parsed: boolean;
}

const CASES: readonly ConfigCase[] = [
  {
    label: 'a valid file',
    text: 'schema: 1\nproviders:\n  enabled: [claude]\n',
    expected: [],
    parsed: true,
  },
  {
    // `providers` is optional; a file that enables nothing is not an error.
    label: 'no providers key at all',
    text: 'schema: 1\n',
    expected: [],
    parsed: true,
  },
  {
    label: 'YAML that does not parse',
    text: 'schema: 1\nproviders: [unclosed\n',
    expected: ['CONFIG_INVALID_YAML'],
    parsed: false,
  },
  {
    label: 'a top-level list',
    text: '- claude\n- codex\n',
    expected: ['CONFIG_NOT_A_MAP'],
    parsed: false,
  },
  {
    label: 'a top-level scalar',
    text: 'claude\n',
    expected: ['CONFIG_NOT_A_MAP'],
    parsed: false,
  },
  {
    label: 'a missing schema version',
    text: 'providers:\n  enabled: []\n',
    expected: ['MISSING_SCHEMA_VERSION'],
    parsed: false,
  },
  {
    label: 'a schema version of zero',
    text: 'schema: 0\nproviders:\n  enabled: []\n',
    expected: ['INVALID_SCHEMA_VERSION'],
    parsed: false,
  },
  {
    label: 'a fractional schema version',
    text: 'schema: 1.5\nproviders:\n  enabled: []\n',
    expected: ['INVALID_SCHEMA_VERSION'],
    parsed: false,
  },
  {
    label: 'a schema version that is not a number',
    text: 'schema: one\nproviders:\n  enabled: []\n',
    expected: ['INVALID_SCHEMA_VERSION'],
    parsed: false,
  },
  {
    // Refused rather than guessed at: a later schema may reinterpret the very
    // fields this version thinks it understands.
    label: 'a schema version from the future',
    text: 'schema: 2\nproviders:\n  enabled: []\n',
    expected: ['UNSUPPORTED_SCHEMA_VERSION'],
    parsed: false,
  },
  {
    label: 'an unknown top-level key',
    text: 'schema: 1\nsync:\n  onSave: true\nproviders:\n  enabled: []\n',
    expected: ['UNKNOWN_CONFIG_KEY'],
    parsed: true,
  },
  {
    // The retired v0 shape: `version`, and a mapping of provider to settings.
    label: 'the v0 provider mapping',
    text: 'version: 1\nproviders:\n  claude:\n    enabled: true\n',
    expected: ['UNKNOWN_CONFIG_KEY', 'MISSING_SCHEMA_VERSION', 'INVALID_PROVIDERS'],
    parsed: false,
  },
  {
    label: 'providers as a list',
    text: 'schema: 1\nproviders: []\n',
    expected: ['INVALID_PROVIDERS'],
    parsed: true,
  },
  {
    label: 'providers without an enabled list',
    text: 'schema: 1\nproviders:\n  other: 1\n',
    expected: ['INVALID_PROVIDERS'],
    parsed: true,
  },
  {
    label: 'an unknown key beside enabled',
    text: 'schema: 1\nproviders:\n  enabled: []\n  extra: 1\n',
    expected: ['INVALID_PROVIDERS'],
    parsed: true,
  },
  {
    label: 'an enabled entry that is not a string',
    text: 'schema: 1\nproviders:\n  enabled: [true]\n',
    expected: ['INVALID_PROVIDERS'],
    parsed: true,
  },
  {
    label: 'the same provider twice',
    text: 'schema: 1\nproviders:\n  enabled: [claude, claude]\n',
    expected: ['INVALID_PROVIDERS'],
    parsed: true,
  },
  {
    // Reported rather than ignored: a typo would otherwise silently disable a
    // provider the author believes is running.
    label: 'a provider with no adapter',
    text: 'schema: 1\nproviders:\n  enabled: [cursor]\n',
    expected: ['UNKNOWN_PROVIDER'],
    parsed: true,
  },
];

describe('.ai/config.yaml malformations', () => {
  it('covers every diagnostic the configuration parser can raise', () => {
    const covered = new Set(CASES.flatMap((testCase) => testCase.expected));
    expect(CONFIG_CODES.filter((code) => !covered.has(code))).toEqual([]);
  });

  for (const testCase of CASES) {
    it(`${testCase.label} → ${testCase.expected.length === 0 ? 'accepted' : testCase.expected.join(', ')}`, () => {
      const result = parseConfig(testCase.text, ALL);

      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        ...testCase.expected,
      ]);
      expect(result.config !== undefined).toBe(testCase.parsed);

      // Every configuration problem is an error — none of them has a safe
      // interpretation — and every one names the file the author must open.
      for (const diagnostic of result.diagnostics) {
        expect(diagnostic.severity).toBe('error');
        expect(diagnostic.source).toBe(CONFIG_PATH);
      }
    });
  }

  it('enables nothing when the file could not be understood', () => {
    // A refused configuration must not fall back to a default provider set:
    // compiling the wrong providers is worse than compiling none.
    for (const testCase of CASES.filter((candidate) => !candidate.parsed)) {
      expect(parseConfig(testCase.text, ALL).config, testCase.label).toBeUndefined();
    }
  });

  it('reports an unknown provider without enabling it', () => {
    const result = parseConfig('schema: 1\nproviders:\n  enabled: [cursor, claude]\n', ALL);
    expect(result.config === undefined ? [] : enabledProviders(result.config)).toEqual(['claude']);
  });

  it('keeps a duplicated provider once', () => {
    const result = parseConfig('schema: 1\nproviders:\n  enabled: [claude, claude]\n', ALL);
    expect(result.config === undefined ? [] : enabledProviders(result.config)).toEqual(['claude']);
  });
});
