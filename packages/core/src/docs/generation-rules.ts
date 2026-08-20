import type { ProviderAdapter } from '../adapter/adapter.js';
import type { AiConfiguration, SourceKind } from '../domain/configuration.js';
import { compareStrings } from '../domain/ordering.js';
import type { ProviderId } from '../domain/provider.js';

/** Where the rendered reference is written, relative to the repository root. */
export const GENERATION_RULES_PATH = '.ai/generation-rules.md';

/**
 * The name every probe artifact is given, replaced by a placeholder in the
 * rendered paths.
 *
 * A valid artifact name, so no adapter rejects or rewrites it, and one no
 * provider path contains for another reason.
 */
const PROBE = 'example';
const PLACEHOLDER = '<name>';
const SCOPED_PROBE = 'scoped';

/** Key under which a path-scoped instruction's output is collected. */
const SCOPED_KEY = 'instruction:scoped';

const KIND_TITLES: readonly (readonly [SourceKind, string])[] = [
  ['instruction', 'Instructions'],
  ['agent', 'Agents'],
  ['skill', 'Skills'],
  ['command', 'Commands'],
];

/**
 * Builds the configuration the reference is derived from.
 *
 * Two instructions rather than one: scoping changes what several providers
 * emit — Copilot writes a per-file instruction only for a scoped one — so a
 * reference showing a single row would be wrong for half of them.
 */
const probeConfiguration = (): AiConfiguration => {
  const body = 'Probe.';
  return {
    instructions: [
      {
        name: PROBE,
        description: 'Probe',
        applyTo: [],
        body,
        sourcePath: `.ai/instructions/${PROBE}.md`,
      },
      {
        name: SCOPED_PROBE,
        description: 'Probe',
        applyTo: ['src/'],
        body,
        sourcePath: `.ai/instructions/${SCOPED_PROBE}.md`,
      },
    ],
    agents: [{ name: PROBE, description: 'Probe', body, sourcePath: `.ai/agents/${PROBE}.md` }],
    skills: [
      {
        name: PROBE,
        description: 'Probe',
        files: [{ relativePath: 'SKILL.md', sha256: '0'.repeat(64), size: 1, executable: false }],
        sourcePath: `.ai/skills/${PROBE}`,
        entrypointText: `---\nname: ${PROBE}\ndescription: Probe\n---\n\n${body}\n`,
        entrypointKeys: ['name', 'description'],
      },
    ],
    commands: [{ name: PROBE, description: 'Probe', body, sourcePath: `.ai/commands/${PROBE}.md` }],
  };
};

interface EmittedPaths {
  /** Paths tied to one canonical artifact, with the name placeheld. */
  readonly perArtifact: readonly string[];
  /** Paths every artifact of the kind shares, such as `AGENTS.md`. */
  readonly aggregate: readonly string[];
}

const placehold = (path: string): string => {
  // Both probes stand for the same thing in the rendered table: one artifact,
  // named by its file.
  return path.split(PROBE).join(PLACEHOLDER).split(SCOPED_PROBE).join(PLACEHOLDER);
};

const emitted = (
  adapter: ProviderAdapter,
  configuration: AiConfiguration,
): ReadonlyMap<string, EmittedPaths> => {
  const result = new Map<string, EmittedPaths>();

  const add = (key: string, path: string, aggregate: boolean): void => {
    const current = result.get(key) ?? { perArtifact: [], aggregate: [] };
    const next = aggregate
      ? { perArtifact: current.perArtifact, aggregate: [...new Set([...current.aggregate, path])] }
      : {
          perArtifact: [...new Set([...current.perArtifact, placehold(path)])],
          aggregate: current.aggregate,
        };
    result.set(key, next);
  };

  for (const file of adapter.compile(configuration).files) {
    if (file.source === null) {
      // An aggregate belongs to whichever kind fed it. Instructions are the
      // only aggregated kind today, and saying so here beats inventing a fifth
      // bucket the reader would have to interpret.
      add('instruction', file.path, true);
      continue;
    }
    add(file.source.name === SCOPED_PROBE ? SCOPED_KEY : file.source.kind, file.path, false);
  }

  return result;
};

const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

const code = (paths: readonly string[]): string =>
  paths.length === 0 ? '—' : paths.map((path) => `\`${path}\``).join('<br>');

/**
 * Renders the reference AI Config writes into `.ai/` when a project is created.
 *
 * Derived by compiling a probe configuration with the real adapters rather than
 * written by hand, so it states what this build actually emits and cannot drift
 * from it. It is a snapshot all the same: nothing refreshes it, because a
 * synchronization never writes into `.ai/`. `aiconfig rules` reprints it.
 */
export const renderGenerationRules = (
  adapters: readonly ProviderAdapter[],
  version: string,
): string => {
  const configuration = probeConfiguration();
  const ordered = [...adapters].sort((a, b) => compareStrings(a.id, b.id));
  const byProvider = new Map<ProviderId, ReadonlyMap<string, EmittedPaths>>();
  for (const adapter of ordered) {
    byProvider.set(adapter.id, emitted(adapter, configuration));
  }

  const lines: string[] = [
    '# What AI Config generates',
    '',
    `Written by AI Config ${version} when this project was created, from the`,
    'providers it supports. Nothing reads this file: it is here for you.',
    '',
    'It is a snapshot. Run `aiconfig rules` to reprint it after an upgrade.',
    '',
    '## Where each artifact goes',
    '',
    `\`${PLACEHOLDER}\` stands for the artifact's file name without its extension.`,
    '',
  ];

  for (const [kind, title] of KIND_TITLES) {
    const scoped = kind === 'instruction';
    lines.push(
      `### ${title}`,
      '',
      row(scoped ? ['Provider', 'Unscoped', 'With `applyTo`'] : ['Provider', 'Generated']),
      row(scoped ? ['---', '---', '---'] : ['---', '---']),
    );

    for (const adapter of ordered) {
      const paths = byProvider.get(adapter.id);
      const own = paths?.get(kind);
      const plain = [...(own?.perArtifact ?? []), ...(own?.aggregate ?? [])];
      if (scoped) {
        const withScope = paths?.get(SCOPED_KEY)?.perArtifact ?? [];
        lines.push(
          row([adapter.displayName, code(plain), code(withScope.length === 0 ? plain : withScope)]),
        );
      } else {
        lines.push(row([adapter.displayName, code(plain)]));
      }
    }
    lines.push('');
  }

  lines.push(
    '## What you can set per provider',
    '',
    'All optional, and written in `.ai/providers/<provider>/<kind>s/<id>.yaml` —',
    'create one with `aiconfig override create`, or from the editor. Everything',
    'here refines a single provider; the canonical artifact still reaches every',
    'enabled one.',
    '',
    'A field this build does not recognize is written through with a warning',
    'rather than refused, so a setting a provider adds later still works.',
    '',
  );

  for (const adapter of ordered) {
    const schemas = adapter.overrides ?? [];
    lines.push(`### ${adapter.displayName}`, '');
    if (schemas.length === 0) {
      lines.push('Nothing to set.', '');
      continue;
    }
    lines.push(row(['Applies to', 'Fields']), row(['---', '---']));
    for (const schema of [...schemas].sort((a, b) => compareStrings(a.kind, b.kind))) {
      lines.push(row([schema.kind, schema.fields.map((field) => `\`${field.name}\``).join(', ')]));
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
};
