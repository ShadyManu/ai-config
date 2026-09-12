import * as path from 'node:path';

import type { Diagnostic, FileSystem } from '@aiconfig/core';
import { NodeFileSystem, ensureManagementInstruction } from '@aiconfig/core';

const MANAGEMENT_INSTRUCTION_MIGRATION = 'aiconfig.migrations.management-instruction-v1';

interface MigrationState {
  get: <T>(key: string, defaultValue: T) => T;
  update: (key: string, value: unknown) => Thenable<void>;
}

export interface ProjectMigrationResult {
  readonly changed: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Applies one-time, non-destructive additions to initialized projects.
 *
 * Completion is remembered per repository. That matters because deleting the
 * supplied instruction later is a valid author decision and must not cause the
 * extension to recreate it on every activation.
 */
export class ProjectMigrations {
  public constructor(
    private readonly state: MigrationState,
    private readonly fileSystem: FileSystem = new NodeFileSystem(),
  ) {}

  public async apply(root: string): Promise<ProjectMigrationResult> {
    const completed = this.state.get<readonly string[]>(MANAGEMENT_INSTRUCTION_MIGRATION, []);
    const repository = normalizeRoot(root);
    if (completed.includes(repository)) {
      return { changed: false, diagnostics: [] };
    }

    const outcome = await ensureManagementInstruction(this.fileSystem, root);
    if (!outcome.ok) {
      return { changed: false, diagnostics: outcome.diagnostics };
    }

    await this.state.update(
      MANAGEMENT_INSTRUCTION_MIGRATION,
      [...completed, repository].sort((left, right) => left.localeCompare(right)),
    );
    return { changed: outcome.created.length > 0, diagnostics: [] };
  }
}

const normalizeRoot = (root: string): string => {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
