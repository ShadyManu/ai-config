import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MANAGEMENT_INSTRUCTION_PATH } from '@aiconfig/core';

import { ProjectMigrations } from '../migrations.js';

class MemoryState {
  private readonly values = new Map<string, unknown>();

  public get<T>(key: string, defaultValue: T): T {
    return (this.values.get(key) as T | undefined) ?? defaultValue;
  }

  public update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

suite('project migrations', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiconfig-migration-'));
    fs.mkdirSync(path.join(root, '.ai'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.ai', 'config.yaml'),
      'schema: 1\nproviders:\n  enabled: []\n',
      'utf8',
    );
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('adds the management instruction once and respects a later deletion', async () => {
    const migrations = new ProjectMigrations(new MemoryState());

    const first = await migrations.apply(root);
    const instruction = path.join(root, ...MANAGEMENT_INSTRUCTION_PATH.split('/'));

    assert.deepEqual(first, { changed: true, diagnostics: [] });
    assert.equal(fs.existsSync(instruction), true);

    fs.rmSync(instruction);
    const second = await migrations.apply(root);

    assert.deepEqual(second, { changed: false, diagnostics: [] });
    assert.equal(fs.existsSync(instruction), false);
  });

  test('preserves an existing project-specific file', async () => {
    const instruction = path.join(root, ...MANAGEMENT_INSTRUCTION_PATH.split('/'));
    fs.mkdirSync(path.dirname(instruction), { recursive: true });
    fs.writeFileSync(instruction, 'Keep this.\n', 'utf8');

    const result = await new ProjectMigrations(new MemoryState()).apply(root);

    assert.deepEqual(result, { changed: false, diagnostics: [] });
    assert.equal(fs.readFileSync(instruction, 'utf8'), 'Keep this.\n');
  });
});
