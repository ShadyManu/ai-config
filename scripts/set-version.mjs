/**
 * Sets the release version everywhere it is declared.
 *
 * The CLI and extension are released in lockstep because both bundle the same
 * compiler. The workspace manifest records the project release, npm publishes
 * the CLI manifest, `aiconfig --version` prints the source constant, and the VS
 * Code Marketplace publishes the extension manifest. This script keeps all
 * four declarations in step.
 *
 * Usage: node scripts/set-version.mjs 1.2.0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2];

if (version === undefined || !SEMVER.test(version)) {
  console.error(`Usage: node scripts/set-version.mjs <version>
Expected a semantic version such as 1.2.0, received: ${version ?? '(nothing)'}`);
  process.exit(2);
}

const sourcePath = path.join(repositoryRoot, 'packages', 'cli', 'src', 'version.ts');
const manifestPaths = [
  path.join(repositoryRoot, 'package.json'),
  path.join(repositoryRoot, 'packages', 'cli', 'package.json'),
  path.join(repositoryRoot, 'apps', 'vscode', 'package.json'),
];

// The source is checked before the manifest is touched. Writing one and then
// failing on the other leaves exactly the mismatch this script exists to
// prevent, which is how it broke the first time the constant moved file.
const source = readFileSync(sourcePath, 'utf8');
const declaration = /export const VERSION = '[^']*';/;
if (!declaration.test(source)) {
  console.error(`Could not find the VERSION declaration in ${sourcePath}.`);
  process.exit(1);
}

const manifests = manifestPaths.map((manifestPath) => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    console.error(`Could not find a semantic version in ${manifestPath}.`);
    process.exit(1);
  }
  return { manifestPath, manifest, previous: manifest.version };
});

for (const { manifestPath, manifest } of manifests) {
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
writeFileSync(sourcePath, source.replace(declaration, `export const VERSION = '${version}';`));

for (const { manifestPath, previous } of manifests) {
  console.log(`${path.relative(repositoryRoot, manifestPath)} ${previous} -> ${version}`);
}
console.log(`packages/cli/src/version.ts -> ${version}`);
console.log(`Next: add a '## [${version}]' section to both public changelogs, then run the tests.`);
