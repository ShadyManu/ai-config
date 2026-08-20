import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const readVersion = (manifest: string): string => {
  const raw = fs.readFileSync(path.join(repositoryRoot, manifest), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
};

/**
 * The CLI and the extension go to different registries under one version
 * number, because each bundles its own copy of the compiler rather than
 * resolving it at runtime. Two versions installed against one repository would
 * compile the same `.ai/` differently, and each would read the other's output
 * as drift, so the shared number is the only thing that tells a user which
 * compiler they are running. `docs/contributing.md` states the rule; until this
 * test nothing enforced it, and a release that bumped only one manifest passed.
 */
describe('release consistency', () => {
  const version = readVersion('packages/cli/package.json');

  it('ships the extension under the same version as the CLI', () => {
    expect(readVersion('apps/vscode/package.json')).toBe(version);
  });

  /**
   * `version.test.ts` makes the same demand of the CLI changelog. This one
   * matters more in public: the Marketplace renders `CHANGELOG.md` as a tab on
   * the extension page, whereas npm publishes the file but never shows it.
   */
  it('documents the release in the extension changelog', () => {
    const changelog = fs.readFileSync(
      path.join(repositoryRoot, 'apps/vscode/CHANGELOG.md'),
      'utf8',
    );
    expect(changelog).toContain(`## [${version}]`);
  });
});
