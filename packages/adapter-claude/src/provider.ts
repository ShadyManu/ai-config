/**
 * The provider identifier, in its own module so that the per-capability modules
 * can tag diagnostics with it without importing the package entrypoint, which
 * imports them back.
 */
export const CLAUDE_PROVIDER_ID = 'claude';
