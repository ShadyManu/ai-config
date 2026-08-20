import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import { decideRoot } from '../workspace.js';

const A = path.resolve('/workspace/a');
const B = path.resolve('/workspace/b');
const C = path.resolve('/workspace/c');

/**
 * The selected folder losing `.ai/config.yaml` — deleted by the user, or by a
 * branch switch — used to leave the extension pinned to a root that no longer
 * has any configuration, hiding sibling folders that still do.
 *
 * Every case below is reached from a filesystem event, so none of them may ask
 * the user anything: `ambiguous` is returned for the one case that genuinely
 * needs an answer, and the caller defers it to the next explicit command.
 */
suite('stale workspace root', () => {
  test('stays put, and reports not initialized, when no other folder is initialized', () => {
    assert.deepEqual(decideRoot([A, B], [], A), { kind: 'selected', root: A });

    // Single-folder workspaces are the same case: the folder stays selected so
    // it keeps its watcher and remains the target of Initialize.
    assert.deepEqual(decideRoot([A], [], A), { kind: 'selected', root: A });
  });

  test('moves to the one remaining initialized folder', () => {
    assert.deepEqual(decideRoot([A, B], [B], A), { kind: 'selected', root: B });
  });

  test('defers the choice when several initialized folders remain', () => {
    assert.deepEqual(decideRoot([A, B, C], [B, C], A), { kind: 'ambiguous', candidates: [B, C] });
  });
});

suite('workspace root selection', () => {
  test('keeps the folder in use while it is still initialized', () => {
    // Adding an initialized folder to the workspace must not move AI Config,
    // and must not raise a question about a root that is working fine.
    assert.deepEqual(decideRoot([A, B], [A, B], A), { kind: 'selected', root: A });
  });

  test('has no root when no folder is open', () => {
    assert.deepEqual(decideRoot([], [], undefined), { kind: 'none' });
    assert.deepEqual(decideRoot([], [], A), { kind: 'none' });
  });

  test('forgets a folder that has left the workspace', () => {
    assert.deepEqual(decideRoot([B], [B], A), { kind: 'selected', root: B });
    assert.deepEqual(decideRoot([B, C], [], A), { kind: 'none' });
  });

  test('selects the only folder open so Initialize has a target', () => {
    assert.deepEqual(decideRoot([A], [], undefined), { kind: 'selected', root: A });
  });

  test('selects the only initialized folder without being asked', () => {
    assert.deepEqual(decideRoot([A, B], [B], undefined), { kind: 'selected', root: B });
  });

  test('asks on a fresh start with several initialized folders', () => {
    assert.deepEqual(decideRoot([A, B], [A, B], undefined), {
      kind: 'ambiguous',
      candidates: [A, B],
    });
  });
});
