import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/index.js';

const packageDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const readPackageJson = (): { readonly version: string; readonly name: string } => {
  const raw = fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8');
  return JSON.parse(raw) as { version: string; name: string };
};

/**
 * The published version is declared twice: npm reads `package.json`, and
 * `aiconfig --version` prints the constant. Nothing at build time keeps them
 * equal, so a release that bumps only one ships a CLI that misreports itself —
 * and npm will not let that version number be corrected afterwards.
 */
describe('published version', () => {
  it('matches the version npm will publish', () => {
    expect(VERSION).toBe(readPackageJson().version);
  });

  it('is a plain semantic version, which is what a release tag is built from', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it('is documented in the changelog', () => {
    const changelog = fs.readFileSync(path.join(packageDirectory, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain(`## [${VERSION}]`);
  });
});
