import { describe, expect, it } from 'vitest';

import type { ProviderOverrideSchema } from '../src/adapter/override.js';
import {
  createAgent,
  createCommand,
  createInstruction,
  createOverride,
  createOverrideTemplate,
  createSkill,
  removeOverride,
  renderOverrideDocument,
  renderOverrideTemplate,
} from '../src/scaffold/scaffold.js';
import { validateOverrideDocument } from '../src/adapter/override.js';
import { parseYaml } from '../src/parse/yaml.js';
import { disableProvider, enableProvider, withProviders } from '../src/config/providers.js';
import { MemoryFileSystem } from '../src/testing/memory-file-system.js';

const SCHEMA: ProviderOverrideSchema = {
  kind: 'agent',
  reserved: ['name', 'description'],
  fields: [
    {
      name: 'model',
      type: { kind: 'string' },
      description: 'Model.',
      documentation: 'https://example.invalid',
    },
    {
      name: 'permission',
      type: { kind: 'map' },
      description: 'Permissions.',
      documentation: 'https://example.invalid',
    },
  ],
};

const SCOPED_ONLY: ProviderOverrideSchema = {
  kind: 'instruction',
  reserved: ['applyTo'],
  unavailableReason: (target) =>
    target.applyTo.length > 0 ? undefined : 'This instruction has no applyTo.',
  fields: [
    {
      name: 'excludeAgent',
      type: { kind: 'enum', values: ['code-review'] },
      description: 'Exclude.',
      documentation: 'https://example.invalid',
    },
  ],
};

const AGENT_TARGET = { kind: 'agent' as const, name: 'coder', applyTo: [] };

describe('canonical artifact scaffolding', () => {
  it('creates an instruction with only the fields that were given', async () => {
    const fs = new MemoryFileSystem();
    const outcome = await createInstruction(fs, fs.root, { name: 'general', body: 'Be careful.' });

    expect(outcome).toEqual({ ok: true, created: ['.ai/instructions/general.md'] });
    expect(fs.get('.ai/instructions/general.md')).toBe('Be careful.\n');
  });

  it('writes description and applyTo when they are given', async () => {
    const fs = new MemoryFileSystem();
    await createInstruction(fs, fs.root, {
      name: 'backend',
      description: 'Backend rules',
      body: 'Use ports.',
      applyTo: ['backend/**', ' services/**/*.ts '],
    });

    expect(fs.get('.ai/instructions/backend.md')).toBe(
      [
        '---',
        'description: Backend rules',
        'applyTo:',
        '  - "backend/**"',
        '  - "services/**/*.ts"',
        '---',
        '',
        'Use ports.',
        '',
      ].join('\n'),
    );
  });

  it('creates an agent, a command and a skill in their canonical shapes', async () => {
    const fs = new MemoryFileSystem();
    await createAgent(fs, fs.root, { name: 'coder', description: 'Writes code', body: 'Code.' });
    await createCommand(fs, fs.root, { name: 'ship', description: 'Ships it', body: 'Ship.' });
    await createSkill(fs, fs.root, { name: 'review', description: 'Reviews', body: 'Review.' });

    expect(fs.get('.ai/agents/coder.md')).toContain('description: Writes code');
    expect(fs.get('.ai/commands/ship.md')).toContain('description: Ships it');
    // Every provider requires name and description in SKILL.md, and the file is
    // copied verbatim, so both are written.
    expect(fs.get('.ai/skills/review/SKILL.md')).toBe(
      ['---', 'name: review', 'description: Reviews', '---', '', 'Review.', ''].join('\n'),
    );
  });

  it('creates only the skill directories that were requested', async () => {
    const fs = new MemoryFileSystem();
    await createSkill(fs, fs.root, {
      name: 'review',
      description: 'Reviews',
      body: 'Review.',
      directories: ['references'],
    });

    expect(await fs.exists(`${fs.root}/.ai/skills/review/references`)).toBe(true);
    expect(await fs.exists(`${fs.root}/.ai/skills/review/scripts`)).toBe(false);
  });

  it('rejects an unknown skill directory', async () => {
    const fs = new MemoryFileSystem();
    const outcome = await createSkill(fs, fs.root, {
      name: 'review',
      description: 'Reviews',
      body: 'Review.',
      directories: ['secrets'],
    });

    expect(outcome.ok).toBe(false);
    expect(await fs.exists(`${fs.root}/.ai/skills/review/SKILL.md`)).toBe(false);
  });

  it('rejects an invalid name and writes nothing', async () => {
    const fs = new MemoryFileSystem();
    const outcome = await createAgent(fs, fs.root, {
      name: 'Not A Name',
      description: 'x',
      body: 'y',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.diagnostics[0]?.code).toBe('INVALID_NAME');
    expect(await fs.exists(`${fs.root}/.ai/agents/Not A Name.md`)).toBe(false);
  });

  it('never replaces an existing canonical file', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/agents/coder.md', 'mine');

    const outcome = await createAgent(fs, fs.root, {
      name: 'coder',
      description: 'x',
      body: 'y',
    });

    expect(outcome.ok).toBe(false);
    expect(fs.get('.ai/agents/coder.md')).toBe('mine');
  });
});

describe('override scaffolding', () => {
  it('writes the envelope with nested options', async () => {
    const fs = new MemoryFileSystem();
    const outcome = await createOverride(
      fs,
      fs.root,
      {
        provider: 'claude',
        kind: 'agent',
        id: 'coder',
        options: { model: 'sonnet', permission: { edit: 'deny' } },
      },
      SCHEMA,
      AGENT_TARGET,
    );

    expect(outcome).toEqual({ ok: true, created: ['.ai/providers/claude/agents/coder.yaml'] });
    expect(fs.get('.ai/providers/claude/agents/coder.yaml')).toBe(
      ['schema: 1', 'options:', '  model: sonnet', '  permission:', '    edit: deny', ''].join(
        '\n',
      ),
    );
  });

  it('refuses to redefine a canonical field', async () => {
    const fs = new MemoryFileSystem();
    const outcome = await createOverride(
      fs,
      fs.root,
      { provider: 'claude', kind: 'agent', id: 'coder', options: { description: 'no' } },
      SCHEMA,
      AGENT_TARGET,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.diagnostics[0]?.code).toBe('OVERRIDE_CANONICAL_FIELD');
    expect(await fs.exists(`${fs.root}/.ai/providers/claude/agents/coder.yaml`)).toBe(false);
  });

  it('refuses an artifact the provider cannot configure', async () => {
    const fs = new MemoryFileSystem();
    const outcome = await createOverride(
      fs,
      fs.root,
      {
        provider: 'copilot',
        kind: 'instruction',
        id: 'general',
        options: { excludeAgent: 'code-review' },
      },
      SCOPED_ONLY,
      { kind: 'instruction', name: 'general', applyTo: [] },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.diagnostics[0]?.code).toBe('OVERRIDE_NOT_APPLICABLE');
  });

  it('refuses to write an override with no options', async () => {
    const fs = new MemoryFileSystem();
    const outcome = await createOverride(
      fs,
      fs.root,
      { provider: 'claude', kind: 'agent', id: 'coder', options: {} },
      SCHEMA,
      AGENT_TARGET,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.diagnostics[0]?.code).toBe('OVERRIDE_INVALID');
  });

  it('never overwrites an existing override unless forced', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/claude/agents/coder.yaml', 'mine');

    const refused = await createOverride(
      fs,
      fs.root,
      { provider: 'claude', kind: 'agent', id: 'coder', options: { model: 'opus' } },
      SCHEMA,
      AGENT_TARGET,
    );
    expect(refused.ok).toBe(false);
    expect(fs.get('.ai/providers/claude/agents/coder.yaml')).toBe('mine');

    const forced = await createOverride(
      fs,
      fs.root,
      { provider: 'claude', kind: 'agent', id: 'coder', options: { model: 'opus' } },
      SCHEMA,
      AGENT_TARGET,
      { force: true },
    );
    expect(forced.ok).toBe(true);
    expect(fs.get('.ai/providers/claude/agents/coder.yaml')).toContain('model: opus');
  });

  it('removes an override and reports a missing one', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/claude/agents/coder.yaml', 'schema: 1\noptions:\n  model: opus\n');

    expect(await removeOverride(fs, fs.root, 'claude', 'agent', 'coder')).toEqual({
      ok: true,
      created: [],
    });
    expect(await fs.exists(`${fs.root}/.ai/providers/claude/agents/coder.yaml`)).toBe(false);

    const missing = await removeOverride(fs, fs.root, 'claude', 'agent', 'coder');
    expect(missing.ok).toBe(false);
  });

  it('renders an empty option set as an explicit empty mapping', () => {
    expect(renderOverrideDocument(SCHEMA, {})).toBe('schema: 1\noptions: {}\n');
  });
});

const TEMPLATE_SCHEMA: ProviderOverrideSchema = {
  kind: 'skill',
  reserved: ['name', 'description'],
  fields: [
    {
      name: 'model',
      type: { kind: 'string' },
      description: 'Model used while this skill is active.',
      documentation: 'https://example.invalid/skills',
      defaultNote: 'inherit',
      suggestions: ['sonnet', 'opus'],
    },
    {
      name: 'effort',
      type: { kind: 'enum', values: ['low', 'high'] },
      description: 'Effort level.',
      documentation: 'https://example.invalid/skills',
    },
    {
      name: 'context',
      type: { kind: 'enum', values: ['fork'] },
      description: 'Run in an isolated context.',
      documentation: 'https://example.invalid/skills',
    },
    {
      name: 'maxTurns',
      type: { kind: 'number', min: 1, integer: true },
      description: 'Turn budget.',
      documentation: 'https://example.invalid/skills',
    },
    {
      name: 'background',
      type: { kind: 'boolean' },
      description: 'Run in the background.',
      documentation: 'https://example.invalid/skills',
    },
    {
      name: 'tools',
      type: { kind: 'string-list' },
      description: 'Allowed tools.',
      documentation: 'https://example.invalid/skills',
    },
    {
      name: 'hooks',
      type: { kind: 'map' },
      description: 'Lifecycle hooks.',
      documentation: 'https://example.invalid/skills',
    },
    {
      name: 'interface.display_name',
      type: { kind: 'string' },
      description: 'User-facing name.',
      documentation: 'https://example.invalid/skills',
    },
    {
      name: 'interface.brand_color',
      type: { kind: 'string' },
      description: 'Hex colour.',
      documentation: 'https://example.invalid/skills',
    },
  ],
};

const SKILL_TARGET = { kind: 'skill' as const, name: 'review', applyTo: [] };

const TEMPLATE_DRAFT = {
  provider: 'claude' as const,
  kind: 'skill' as const,
  id: 'review',
  fields: ['model', 'maxTurns', 'tools'],
};

/** Removes one level of comment marker, as a reader filling the file in does. */
const uncomment = (content: string, key: string): string => {
  const line = new RegExp(`^\\s*#\\s*${key}:`);
  return content
    .split('\n')
    .map((candidate) => (line.test(candidate) ? candidate.replace('# ', '') : candidate))
    .join('\n');
};

const validateTemplate = (content: string) => {
  const parsed = parseYaml(content);
  expect(parsed.ok).toBe(true);
  return validateOverrideDocument(parsed.ok ? parsed.value : undefined, TEMPLATE_SCHEMA, {
    provider: 'claude',
    sourcePath: '.ai/providers/claude/skills/review.yaml',
  });
};

describe('override templates', () => {
  it('scaffolds the chosen settings, commented out, with their placeholders', () => {
    const content = renderOverrideTemplate(TEMPLATE_SCHEMA, TEMPLATE_DRAFT);

    expect(content).toContain('  # model: TODO');
    expect(content).toContain('  # maxTurns: TODO');
    expect(content).toContain('  # tools: []');
  });

  it('leaves out every setting that was not chosen', () => {
    const content = renderOverrideTemplate(TEMPLATE_SCHEMA, TEMPLATE_DRAFT);

    for (const absent of ['effort', 'background', 'hooks', 'display_name']) {
      expect(content).not.toContain(`${absent}:`);
    }
  });

  it('documents each setting with its constraint and default', () => {
    const content = renderOverrideTemplate(TEMPLATE_SCHEMA, {
      ...TEMPLATE_DRAFT,
      fields: ['model', 'effort', 'maxTurns', 'background', 'hooks'],
    });

    expect(content).not.toContain('Suggested values:');
    expect(content).toContain('# Default: inherit.');
    expect(content).toContain('# One of: low, high.');
    expect(content).toContain('# A whole number, at least 1.');
    expect(content).toContain('# true or false.');
    expect(content).toContain('  # hooks: {}');
    expect(content).toContain('# Reference: https://example.invalid/skills');
  });

  it('writes the only valid enum value into the template', () => {
    const content = renderOverrideTemplate(TEMPLATE_SCHEMA, {
      ...TEMPLATE_DRAFT,
      fields: ['context'],
    });

    expect(content).toContain('  # context: fork');
    expect(content).not.toContain('Only value:');
    expect(content).not.toContain('context: TODO');
  });

  it('nests a dotted field name so uncommenting it produces the right key', () => {
    const content = renderOverrideTemplate(TEMPLATE_SCHEMA, {
      ...TEMPLATE_DRAFT,
      fields: ['interface.display_name', 'interface.brand_color'],
    });

    expect(content).toContain('  # interface:');
    expect(content).toContain('  #   display_name: TODO');
    expect(content).toContain('  #   brand_color: TODO');
    // One parent key for both children, not one per field.
    expect(content.split('interface:').length - 1).toBe(1);
    expect(content).toContain(
      'For nested settings, uncomment the parent section and the setting below it together.',
    );
  });

  it('is deterministic and independent of the order the fields were chosen in', () => {
    expect(
      renderOverrideTemplate(TEMPLATE_SCHEMA, { ...TEMPLATE_DRAFT, fields: ['tools', 'model'] }),
    ).toBe(
      renderOverrideTemplate(TEMPLATE_SCHEMA, { ...TEMPLATE_DRAFT, fields: ['model', 'tools'] }),
    );
  });

  it('is valid, and inert, before anything is filled in', () => {
    const result = validateTemplate(renderOverrideTemplate(TEMPLATE_SCHEMA, TEMPLATE_DRAFT));

    expect(result.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(['info']);
    expect(result.diagnostics[0]?.code).toBe('OVERRIDE_EMPTY');
    expect(result.options).toEqual({});
  });

  it('becomes a valid override as soon as one placeholder is replaced', () => {
    const template = renderOverrideTemplate(TEMPLATE_SCHEMA, TEMPLATE_DRAFT);
    const filled = uncomment(template, 'model').replace('model: TODO', 'model: opus');

    const result = validateTemplate(filled);

    expect(result.diagnostics).toEqual([]);
    expect(result.options).toEqual({ model: 'opus' });
  });

  it('keeps a nested setting valid when it is uncommented', () => {
    const template = renderOverrideTemplate(TEMPLATE_SCHEMA, {
      ...TEMPLATE_DRAFT,
      fields: ['interface.display_name'],
    });
    const filled = uncomment(uncomment(template, 'interface'), 'display_name').replace(
      'display_name: TODO',
      'display_name: Review',
    );

    const result = validateTemplate(filled);

    expect(result.diagnostics).toEqual([]);
    expect(result.options).toEqual({ interface: { display_name: 'Review' } });
  });

  it('writes the template file', async () => {
    const fs = new MemoryFileSystem();
    const outcome = await createOverrideTemplate(
      fs,
      fs.root,
      TEMPLATE_DRAFT,
      TEMPLATE_SCHEMA,
      SKILL_TARGET,
    );

    expect(outcome).toEqual({ ok: true, created: ['.ai/providers/claude/skills/review.yaml'] });
    expect(fs.get('.ai/providers/claude/skills/review.yaml')).toBe(
      renderOverrideTemplate(TEMPLATE_SCHEMA, TEMPLATE_DRAFT),
    );
  });

  it('refuses a field the provider does not declare', async () => {
    const fs = new MemoryFileSystem();
    const outcome = await createOverrideTemplate(
      fs,
      fs.root,
      { ...TEMPLATE_DRAFT, fields: ['nonsense'] },
      TEMPLATE_SCHEMA,
      SKILL_TARGET,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.diagnostics[0]?.code).toBe('OVERRIDE_UNKNOWN_FIELD');
    expect(await fs.exists(`${fs.root}/.ai/providers/claude/skills/review.yaml`)).toBe(false);
  });

  it('refuses to write a template with nothing in it', async () => {
    const fs = new MemoryFileSystem();
    const outcome = await createOverrideTemplate(
      fs,
      fs.root,
      { ...TEMPLATE_DRAFT, fields: [] },
      TEMPLATE_SCHEMA,
      SKILL_TARGET,
    );

    expect(outcome.ok).toBe(false);
    expect(await fs.exists(`${fs.root}/.ai/providers/claude/skills/review.yaml`)).toBe(false);
  });

  it('refuses an artifact the provider cannot configure', async () => {
    const fs = new MemoryFileSystem();
    const outcome = await createOverrideTemplate(
      fs,
      fs.root,
      { provider: 'copilot', kind: 'instruction', id: 'general', fields: ['excludeAgent'] },
      SCOPED_ONLY,
      { kind: 'instruction', name: 'general', applyTo: [] },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.diagnostics[0]?.code).toBe('OVERRIDE_NOT_APPLICABLE');
  });

  it('never replaces an override that already exists', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/providers/claude/skills/review.yaml', 'mine');

    const outcome = await createOverrideTemplate(
      fs,
      fs.root,
      TEMPLATE_DRAFT,
      TEMPLATE_SCHEMA,
      SKILL_TARGET,
    );

    expect(outcome.ok).toBe(false);
    expect(fs.get('.ai/providers/claude/skills/review.yaml')).toBe('mine');
  });
});

describe('provider enablement', () => {
  const CONFIG = [
    '# AI Config canonical configuration.',
    '',
    'schema: 1',
    '',
    'providers:',
    '  enabled:',
    '    - claude',
    '',
  ].join('\n');

  it('splices the enabled list while preserving comments', () => {
    expect(withProviders(CONFIG, ['claude', 'opencode'])).toBe(
      [
        '# AI Config canonical configuration.',
        '',
        'schema: 1',
        '',
        'providers:',
        '  enabled:',
        '    - claude',
        '    - opencode',
        '',
      ].join('\n'),
    );
  });

  it('handles the inline empty form in both directions', () => {
    const empty = 'schema: 1\nproviders:\n  enabled: []\n';
    expect(withProviders(empty, ['codex'])).toContain('    - codex');
    expect(withProviders(withProviders(empty, ['codex']), [])).toContain('enabled: []');
  });

  it('preserves a comment written inside the providers block', () => {
    // A comment here used to abandon the splice, and the re-render that took
    // over dropped every comment in the file — including the header, which has
    // nothing to do with the line that caused it.
    const annotated = [
      '# AI Config canonical configuration.',
      '',
      'schema: 1',
      '',
      'providers:',
      '  # kept deliberately short',
      '  enabled:',
      '    - claude',
      '',
    ].join('\n');

    expect(withProviders(annotated, ['claude', 'codex'])).toBe(
      [
        '# AI Config canonical configuration.',
        '',
        'schema: 1',
        '',
        'providers:',
        '  # kept deliberately short',
        '  enabled:',
        '    - claude',
        '    - codex',
        '',
      ].join('\n'),
    );
  });

  it('preserves a sibling key that precedes the enabled list', () => {
    // Not a key this schema version understands: parsing reports it. Reporting
    // is the correct response — deleting the user's line is not.
    const sibling = [
      'schema: 1',
      '',
      'providers:',
      '  settings:',
      '    copilot:',
      '      something: true',
      '  enabled:',
      '    - claude',
      '',
    ].join('\n');

    expect(withProviders(sibling, ['claude', 'codex'])).toBe(
      [
        'schema: 1',
        '',
        'providers:',
        '  settings:',
        '    copilot:',
        '      something: true',
        '  enabled:',
        '    - claude',
        '    - codex',
        '',
      ].join('\n'),
    );
  });

  it('never mistakes a nested enabled key for the provider list', () => {
    // Stepping over sibling keys must not mean matching whatever they contain:
    // `enabled` under another key is a different setting entirely.
    const nested = [
      'schema: 1',
      '',
      'providers:',
      '  settings:',
      '    copilot:',
      '      enabled: false',
      '  enabled:',
      '    - claude',
      '',
    ].join('\n');

    const result = withProviders(nested, ['claude', 'codex']);

    expect(result).toContain('      enabled: false');
    expect(result).toContain('    - codex');
  });

  it('preserves a comment that follows the enabled list', () => {
    const trailing = ['schema: 1', '', 'providers:', '  enabled:', '    - claude', ''].join('\n');

    expect(withProviders(`${trailing}# unrelated footer\n`, ['claude', 'codex'])).toBe(
      [
        'schema: 1',
        '',
        'providers:',
        '  enabled:',
        '    - claude',
        '    - codex',
        '# unrelated footer',
        '',
      ].join('\n'),
    );
  });

  it('rewrites a list that has a comment between its items without duplicating one', () => {
    // The comment annotates one entry, so it cannot survive a list rebuilt from
    // the resolved set. Leaving it in place was worse: the splice resumed after
    // it and the items below were emitted a second time.
    const interleaved = [
      'schema: 1',
      '',
      'providers:',
      '  enabled:',
      '    - claude',
      '    # kept for the migration',
      '    - codex',
      '',
    ].join('\n');

    expect(withProviders(interleaved, ['claude', 'codex', 'opencode'])).toBe(
      [
        'schema: 1',
        '',
        'providers:',
        '  enabled:',
        '    - claude',
        '    - codex',
        '    - opencode',
        '',
      ].join('\n'),
    );
  });

  it('falls back to a re-render when there is no enabled key to splice', () => {
    const flow = 'schema: 1\n\nproviders: { enabled: [claude] }\n';

    expect(withProviders(flow, ['claude', 'codex'])).toBe(
      ['schema: 1', '', 'providers:', '  enabled:', '    - claude', '    - codex', ''].join('\n'),
    );
  });

  it('is deterministic and order-independent', () => {
    expect(withProviders(CONFIG, ['opencode', 'claude'])).toBe(
      withProviders(CONFIG, ['claude', 'opencode']),
    );
  });

  it('enables a provider without creating any directory for it', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/config.yaml', CONFIG);

    const outcome = await enableProvider(fs, fs.root, 'opencode');

    expect(outcome).toEqual({ ok: true, providers: ['claude', 'opencode'], changed: true });
    expect(fs.get('.ai/config.yaml')).toContain('    - opencode');
    // A directory under `.ai/providers/` says settings were written for that
    // provider. An empty one says it and is wrong, which is also why `init`
    // creates none.
    expect(await fs.exists(`${fs.root}/.ai/providers`)).toBe(false);
    expect(await fs.exists(`${fs.root}/.ai/providers/opencode`)).toBe(false);
  });

  it('leaves scaffolding an override to create the path it needs', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/config.yaml', CONFIG);
    await enableProvider(fs, fs.root, 'opencode');

    const outcome = await createOverrideTemplate(
      fs,
      fs.root,
      { ...TEMPLATE_DRAFT, provider: 'opencode' },
      TEMPLATE_SCHEMA,
      SKILL_TARGET,
    );

    expect(outcome).toEqual({ ok: true, created: ['.ai/providers/opencode/skills/review.yaml'] });
  });

  it('is a no-op when the provider is already enabled', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/config.yaml', CONFIG);

    const outcome = await enableProvider(fs, fs.root, 'claude');

    expect(outcome).toEqual({ ok: true, providers: ['claude'], changed: false });
    expect(fs.get('.ai/config.yaml')).toBe(CONFIG);
  });

  it('disabling a provider preserves its override files', async () => {
    const fs = new MemoryFileSystem();
    fs.set('.ai/config.yaml', CONFIG);
    fs.set('.ai/providers/claude/agents/coder.yaml', 'schema: 1\noptions:\n  model: opus\n');

    const outcome = await disableProvider(fs, fs.root, 'claude');

    expect(outcome).toEqual({ ok: true, providers: [], changed: true });
    expect(fs.get('.ai/config.yaml')).toContain('enabled: []');
    expect(fs.get('.ai/providers/claude/agents/coder.yaml')).toContain('model: opus');
  });

  it('reports a missing configuration file rather than creating one', async () => {
    const fs = new MemoryFileSystem();
    const outcome = await enableProvider(fs, fs.root, 'claude');

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.diagnostics[0]?.code).toBe('NOT_INITIALIZED');
  });
});
