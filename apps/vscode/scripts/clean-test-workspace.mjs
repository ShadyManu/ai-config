/**
 * Empties the scratch folder the workspace tests open, before the editor starts.
 *
 * It has to happen here rather than in a test hook. The folder is opened as a
 * workspace, and the extension's activation event is
 * `workspaceContains:**\/.ai/config.yaml` — so a `.ai/` left behind by an
 * interrupted run activates the extension against the very directory the tests
 * are about to drive, putting a second Controller on it. By the time any test
 * hook could clean up, that has already happened.
 *
 * `.gitkeep` stays: git tracks the folder through it, and the folder must exist
 * when the editor launches.
 */
import { readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  'test-workspace',
);

for (const entry of readdirSync(workspace)) {
  if (entry === '.gitkeep') {
    continue;
  }
  // Windows refuses to unlink a directory while any process still holds a
  // handle to it, and an editor that has just closed releases them a moment
  // later, so this retries rather than failing the run.
  rmSync(path.join(workspace, entry), {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
