/**
 * Test-only helpers, exposed through the `@aiconfig/core/testing` subpath so
 * they stay out of the package's production API surface.
 */
export type { CompiledFixture } from './fixture.js';
export { compileFixture, discoverFixtureConfiguration, exampleRepositoryRoot } from './fixture.js';
export { readGoldenTree, shouldUpdateFixtures, writeGoldenTree } from './golden.js';
export { MemoryFileSystem } from './memory-file-system.js';
