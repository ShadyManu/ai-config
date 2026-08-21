import type { DiagnosticCode } from '../domain/codes.js';
import type { AiConfigFile } from '../domain/configuration.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import type { ProviderId } from '../domain/provider.js';
import { isPlainObject, parseYaml } from './yaml.js';

export const SUPPORTED_SCHEMA_VERSION = 1;

export const CONFIG_PATH = '.ai/config.yaml';

export interface ConfigParseResult {
  readonly config: AiConfigFile | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

const diagnostic = (
  code: DiagnosticCode,
  message: string,
  line?: number,
  column?: number,
): Diagnostic => ({ code, severity: 'error', message, source: CONFIG_PATH, line, column });

/**
 * Parses and validates `.ai/config.yaml`.
 *
 * `knownProviders` is the set of registered adapter identifiers, supplied by
 * the caller. Validating against it rather than against a compiled-in list is
 * what turns "enabled a provider with no adapter" from a silent no-op into a
 * reported error.
 */
export const parseConfig = (
  text: string,
  knownProviders: readonly ProviderId[],
): ConfigParseResult => {
  const parsed = parseYaml(text);
  if (!parsed.ok) {
    return {
      config: undefined,
      diagnostics: [
        diagnostic(
          'CONFIG_INVALID_YAML',
          `Could not parse ${CONFIG_PATH}: ${parsed.reason}.${parsed.explanation === undefined ? '' : ` ${parsed.explanation}`}`,
          parsed.position?.line,
          parsed.position?.column,
        ),
      ],
    };
  }

  if (!isPlainObject(parsed.value)) {
    return {
      config: undefined,
      diagnostics: [
        diagnostic('CONFIG_NOT_A_MAP', `${CONFIG_PATH} must contain a YAML mapping.`, 1, 1),
      ],
    };
  }

  const root = parsed.value;
  const diagnostics: Diagnostic[] = [];

  for (const key of Object.keys(root)) {
    if (key !== 'schema' && key !== 'providers') {
      diagnostics.push(
        diagnostic(
          'UNKNOWN_CONFIG_KEY',
          `Unknown key '${key}' in ${CONFIG_PATH}. Supported keys: schema, providers.`,
        ),
      );
    }
  }

  const versionResult = readVersion(root['schema'], diagnostics);
  const providers = readProviders(root['providers'], knownProviders, diagnostics);

  if (versionResult === undefined) {
    return { config: undefined, diagnostics };
  }

  return {
    config: { schema: versionResult, providers },
    diagnostics,
  };
};

const readVersion = (raw: unknown, diagnostics: Diagnostic[]): number | undefined => {
  if (raw === undefined) {
    diagnostics.push(
      diagnostic(
        'MISSING_SCHEMA_VERSION',
        `${CONFIG_PATH} is missing the required 'schema' field.`,
      ),
    );
    return undefined;
  }

  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    diagnostics.push(
      diagnostic(
        'INVALID_SCHEMA_VERSION',
        `'schema' must be a positive integer. Supported version: ${String(SUPPORTED_SCHEMA_VERSION)}.`,
      ),
    );
    return undefined;
  }

  if (raw > SUPPORTED_SCHEMA_VERSION) {
    // Refuse rather than guess: a future schema may reinterpret fields this
    // version thinks it understands.
    diagnostics.push(
      diagnostic(
        'UNSUPPORTED_SCHEMA_VERSION',
        `${CONFIG_PATH} declares schema version ${String(raw)}, but this version of AI Config supports up to ${String(SUPPORTED_SCHEMA_VERSION)}. Upgrade AI Config.`,
      ),
    );
    return undefined;
  }

  return raw;
};

const readProviders = (
  raw: unknown,
  knownProviders: readonly ProviderId[],
  diagnostics: Diagnostic[],
): readonly ProviderId[] => {
  const providers: ProviderId[] = [];

  if (raw === undefined) {
    return providers;
  }

  if (!isPlainObject(raw) || !Array.isArray(raw['enabled'])) {
    diagnostics.push(
      diagnostic(
        'INVALID_PROVIDERS',
        `'providers' must be a mapping containing an 'enabled' list.`,
      ),
    );
    return providers;
  }

  const known = new Set<string>(knownProviders);

  for (const key of Object.keys(raw)) {
    if (key !== 'enabled') {
      diagnostics.push(
        diagnostic(
          'INVALID_PROVIDERS',
          `Unknown key '${key}' in 'providers'. Supported key: enabled.`,
        ),
      );
    }
  }
  for (const value of raw['enabled']) {
    if (typeof value !== 'string') {
      diagnostics.push(
        diagnostic('INVALID_PROVIDERS', `'providers.enabled' must contain provider ID strings.`),
      );
      continue;
    }
    const key = value;
    if (!known.has(key)) {
      diagnostics.push(
        diagnostic(
          'UNKNOWN_PROVIDER',
          `Unknown provider '${key}'. Available providers: ${[...knownProviders].sort().join(', ')}.`,
        ),
      );
      continue;
    }

    const providerId = key as ProviderId;
    if (providers.includes(providerId)) {
      diagnostics.push(
        diagnostic('INVALID_PROVIDERS', `Provider '${key}' is listed more than once.`),
      );
      continue;
    }
    providers.push(providerId);
  }
  return providers.sort();
};
