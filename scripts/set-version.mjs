/**
 * Sets the CLI version everywhere it is declared.
 *
 * The version lives in two files: npm publishes what `package.json` says, and
 * `aiconfig --version` prints the constant. Editing one and forgetting the
 * other ships a CLI that misreports itself, and npm does not allow a published
 * version number to be corrected — only replaced by a new one. `version.test.ts`
 * fails when they disagree; this script is how they are kept in step.
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

const manifestPath = path.join(repositoryRoot, 'packages', 'cli', 'package.json');
const sourcePath = path.join(repositoryRoot, 'packages', 'cli', 'src', 'version.ts');

// The source is checked before the manifest is touched. Writing one and then
// failing on the other leaves exactly the mismatch this script exists to
// prevent, which is how it broke the first time the constant moved file.
const source = readFileSync(sourcePath, 'utf8');
const declaration = /export const VERSION = '[^']*';/;
if (!declaration.test(source)) {
  console.error(`Could not find the VERSION declaration in ${sourcePath}.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const previous = manifest.version;
manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(sourcePath, source.replace(declaration, `export const VERSION = '${version}';`));

console.log(`@aiconfig/cli ${previous} -> ${version}`);
console.log(
  `Next: add a '## [${version}]' section to packages/cli/CHANGELOG.md, then run the tests.`,
);
