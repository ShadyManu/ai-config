import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * Tests resolve workspace packages to their TypeScript sources so the suite
 * runs without a build step. Production resolution goes through each package's
 * compiled `dist/` entry point declared in its package.json.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@aiconfig/core/testing': fileURLToPath(
        new URL('./packages/core/src/testing/index.ts', import.meta.url),
      ),
      '@aiconfig/core': packageSource('core'),
      '@aiconfig/agents-md': packageSource('agents-md'),
      '@aiconfig/adapter-claude': packageSource('adapter-claude'),
      '@aiconfig/adapter-codex': packageSource('adapter-codex'),
      '@aiconfig/adapter-copilot': packageSource('adapter-copilot'),
      '@aiconfig/adapter-opencode': packageSource('adapter-opencode'),
      '@aiconfig/providers': packageSource('providers'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
