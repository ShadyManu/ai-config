/**
 * Identifiers of the providers AI Config ships adapters for.
 *
 * This union types adapter identities and `config.yaml` provider keys, which
 * gives consumers static safety. Core never branches on it: a
 * `switch (providerId)` inside core would be provider-specific logic in core.
 *
 * Configuration is validated against the *registered adapter set* rather than
 * against this union, so enabling a provider whose adapter was not supplied is
 * a reported error instead of a silent no-op.
 */
export type ProviderId = 'claude' | 'codex' | 'copilot' | 'opencode';

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex', 'copilot', 'opencode'];

export const isProviderId = (value: string): value is ProviderId =>
  (PROVIDER_IDS as readonly string[]).includes(value);
