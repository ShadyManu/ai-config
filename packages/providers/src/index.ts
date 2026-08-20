import type { ProviderAdapter, ProviderId } from '@aiconfig/core';
import { claudeAdapter } from '@aiconfig/adapter-claude';
import { codexAdapter } from '@aiconfig/adapter-codex';
import { copilotAdapter } from '@aiconfig/adapter-copilot';
import { opencodeAdapter } from '@aiconfig/adapter-opencode';

/**
 * The composition root for AI Config's built-in providers.
 *
 * Every consumer — the CLI, the VS Code extension — obtains its adapters here,
 * so the concrete provider set is asserted in exactly one place. Adding a
 * provider means a new adapter package and one line below; no `@aiconfig/core`
 * change is required.
 */
export const createDefaultAdapters = (): readonly ProviderAdapter[] => [
  claudeAdapter,
  codexAdapter,
  copilotAdapter,
  opencodeAdapter,
];

/** Identifiers of the built-in providers, sorted. */
export const defaultProviderIds = (): readonly ProviderId[] =>
  createDefaultAdapters()
    .map((adapter) => adapter.id)
    .sort();
