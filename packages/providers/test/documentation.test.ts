import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ProviderId } from '@aiconfig/core';

import { createDefaultAdapters } from '../src/index.js';

const adapters = createDefaultAdapters();
const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
const guide = fs.readFileSync(path.join(repositoryRoot, 'docs', 'user-guide.md'), 'utf8');
const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');

/**
 * Keeps the guide and the implementation from drifting apart.
 *
 * The override reference is the only place a user learns which provider fields
 * exist, so documenting one that is not supported, or supporting one that is
 * not documented, is a defect rather than a formatting problem.
 */
describe('documented override fields', () => {
  it('documents every field every adapter declares', () => {
    const missing: string[] = [];
    for (const adapter of adapters) {
      for (const schema of adapter.overrides ?? []) {
        for (const field of schema.fields) {
          if (!guide.includes(`\`${field.name}\``)) {
            missing.push(`${adapter.id} ${schema.kind} ${field.name}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('links every field to a first-party documentation URL', () => {
    for (const adapter of adapters) {
      for (const schema of adapter.overrides ?? []) {
        for (const field of schema.fields) {
          expect(field.documentation, `${adapter.id} ${field.name}`).toMatch(/^https:\/\//);
          expect(field.description.length, `${adapter.id} ${field.name}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('documents the override path of every supported provider and kind pair', () => {
    for (const adapter of adapters) {
      for (const schema of adapter.overrides ?? []) {
        const directory = `${schema.kind}s`;
        expect(
          guide.includes(`.ai/providers/${adapter.id}/${directory}/<id>.yaml`),
          `${adapter.id} ${schema.kind}`,
        ).toBe(true);
      }
    }
  });

  it('states explicitly where no override is supported', () => {
    // Every cell the matrix marks as none must be stated rather than omitted,
    // so a reader can tell "not supported" from "not written down yet".
    const none: readonly (readonly [string, string])[] = [
      ['claude', 'instruction'],
      ['codex', 'instruction'],
      ['opencode', 'instruction'],
      ['opencode', 'skill'],
      ['codex', 'command'],
    ];
    for (const [provider, kind] of none) {
      const adapter = adapters.find((candidate) => candidate.id === provider);
      expect(
        adapter?.overrides?.some((schema) => schema.kind === kind) ?? false,
        `${provider} ${kind} should declare no schema`,
      ).toBe(false);
    }
    expect(guide).toContain('No provider-specific override is supported for an OpenCode skill');
  });

  it('never documents a field an adapter does not declare', () => {
    // Every fenced override example in the guide is validated by parsing the
    // option keys out of it and checking them against the declared schemas.
    const blocks = [...guide.matchAll(/```yaml\n(# \.ai\/providers\/[^\n]+)\n([\s\S]*?)```/g)];
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      const header = block[1] ?? '';
      const body = block[2] ?? '';
      const match = /# \.ai\/providers\/([^/]+)\/([^/]+)\//.exec(header);
      expect(match, header).not.toBeNull();
      if (match === null) continue;

      const provider = match[1] ?? '';
      const kind = (match[2] ?? '').replace(/s$/, '');
      const schema = adapters
        .find((adapter) => adapter.id === provider)
        ?.overrides?.find((candidate) => candidate.kind === kind);
      expect(schema, `${provider} ${kind}`).toBeDefined();
      if (schema === undefined) continue;

      // Top-level keys under `options:` are indented by exactly two spaces.
      const keys = [...body.matchAll(/^ {2}([A-Za-z_][\w-]*):/gm)].map((entry) => entry[1] ?? '');
      for (const key of keys) {
        const declared = schema.fields.some(
          (field) => field.name === key || field.name.startsWith(`${key}.`),
        );
        expect(declared, `${provider} ${kind} ${key}`).toBe(true);
      }
    }
  });
});

/**
 * The front-page tables, checked against the adapters they describe.
 *
 * `README.md` is the first thing a reader sees and the only documentation many
 * will read. Its override grid is the same claim the guide makes, written a
 * second time in a different shape, so it can disagree on its own — and until
 * now nothing compared it with anything.
 */
describe('README tables', () => {
  /** One row of the override grid: `| Artifact | claude | codex | copilot | opencode |`. */
  const overrideRow = (kind: string): readonly string[] | undefined => {
    const match = new RegExp(`^\\| ${kind} \\|(.+)\\|\\s*$`, 'im').exec(readme);
    return match?.[1]?.split('|').map((cell) => cell.trim());
  };

  const COLUMNS: readonly ProviderId[] = ['claude', 'codex', 'copilot', 'opencode'];

  it('lists the providers in the documented column order', () => {
    // Every row below is read positionally, so the header is what gives the
    // cells their meaning.
    expect(readme).toContain('| Artifact | Claude | Codex | Copilot | OpenCode |');
  });

  for (const kind of ['Instruction', 'Agent', 'Skill', 'Command'] as const) {
    it(`states where a ${kind.toLowerCase()} override exists, matching what the adapters declare`, () => {
      const cells = overrideRow(kind);
      expect(cells, `no '${kind}' row in README.md`).toBeDefined();
      if (cells === undefined) {
        return;
      }
      expect(cells).toHaveLength(COLUMNS.length);

      COLUMNS.forEach((provider, index) => {
        const documented = (cells[index] ?? '').startsWith('yes');
        const declared =
          adapters
            .find((adapter) => adapter.id === provider)
            ?.overrides?.some((schema) => schema.kind === kind.toLowerCase()) ?? false;

        expect(documented, `${provider} ${kind}: README says ${cells[index] ?? ''}`).toBe(declared);
      });
    });
  }

  it('names every registered provider', () => {
    // A provider added without a README entry would be invisible to anyone who
    // never opens the guide.
    for (const adapter of adapters) {
      expect(readme, adapter.id).toContain(adapter.displayName);
    }
  });
});
