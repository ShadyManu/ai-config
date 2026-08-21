import * as vscode from 'vscode';

/**
 * The scheme the generated version of a file is served under.
 *
 * A read-only virtual document rather than a real file: it is what a
 * synchronization *would* write, which has no place on disk until one runs. The
 * diff editor compares against it, and a file that does not exist yet is
 * previewed through it.
 *
 * It lives in its own module because three places need it — the content
 * provider that serves it, the diff command, and the tree — and routing the
 * constant through any one of them would couple the other two to that one.
 */
export const GENERATED_SCHEME = 'aiconfig-generated';

/** The virtual document holding what AI Config would write at `relativePath`. */
export const generatedUri = (relativePath: string): vscode.Uri =>
  vscode.Uri.from({ scheme: GENERATED_SCHEME, path: `/${relativePath}` });
