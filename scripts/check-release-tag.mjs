/**
 * Refuses to publish when public package versions differ. When a Git tag is
 * supplied, it must also match those versions.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const releaseTag = process.argv[2] ?? '';

const readVersion = (relativePath) => {
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
  if (typeof manifest.version !== 'string') {
    throw new Error(`${relativePath} does not declare a version.`);
  }
  return manifest.version;
};

const declarations = [
  ['package.json', readVersion('package.json')],
  ['packages/cli/package.json', readVersion('packages/cli/package.json')],
  ['apps/vscode/package.json', readVersion('apps/vscode/package.json')],
];
const expectedVersion = declarations[0][1];
const mismatches = declarations.filter(([, version]) => version !== expectedVersion);

if (mismatches.length > 0) {
  const details = declarations.map(([file, version]) => `${file}: ${version}`).join('\n');
  throw new Error(`Release versions are not aligned:\n${details}`);
}

if (releaseTag !== '' && releaseTag !== `v${expectedVersion}`) {
  throw new Error(`Tag ${releaseTag} does not match release version v${expectedVersion}.`);
}

console.log(
  releaseTag === ''
    ? `Validated aligned release version ${expectedVersion}.`
    : `Validated ${releaseTag} against every public package manifest.`,
);
