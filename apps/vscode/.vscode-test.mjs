import { defineConfig } from '@vscode/test-cli';

// The guided-flow tests scaffold a project on disk and open editors, which the
// default two-second budget does not cover on a cold extension host.
const mocha = { timeout: 20000 };

/**
 * Two editors, because the tests need two different worlds.
 *
 * Most suites run with no folder open: they exercise pure helpers and call the
 * guided flows with a context they build themselves, which is fast and keeps
 * each test independent.
 *
 * `Controller` cannot be reached that way. It takes its root from
 * `vscode.workspace.workspaceFolders`, so with no folder open there is nothing
 * for it to do, and the parts only it performs — following a rename after a
 * save, moving a directory through the editor's own filesystem API — had no
 * test at all. The second launch opens a scratch folder so those can be driven
 * end to end.
 *
 * The folder is empty in git apart from `.gitkeep`. It must exist when the
 * editor starts, and it must not contain `.ai/config.yaml` then: that is the
 * extension's activation event, and an extension activating here would put a
 * second Controller on the same directory as the one under test.
 */
export default defineConfig([
  {
    files: 'out/test/*.test.js',
    mocha,
  },
  {
    files: 'out/test/workspace/*.test.js',
    workspaceFolder: './test-workspace',
    mocha,
  },
]);
