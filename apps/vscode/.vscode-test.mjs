import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  // The guided-flow tests scaffold a project on disk and open editors, which
  // the default two-second budget does not cover on a cold extension host.
  mocha: { timeout: 20000 },
});
