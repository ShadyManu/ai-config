/**
 * The published version of this CLI.
 *
 * Its own module because both the entry point and the commands need it, and
 * importing the entry point from a command would close an import cycle.
 * `version.test.ts` keeps it equal to what `package.json` publishes.
 */
export const VERSION = '1.3.0';
