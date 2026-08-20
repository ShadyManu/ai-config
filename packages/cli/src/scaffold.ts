import type {
  Diagnostic,
  OverrideField,
  ProviderAdapter,
  ProviderOverrideSchema,
  ScaffoldOutcome,
  SourceKind,
} from '@aiconfig/core';
import {
  AI_DIRECTORY,
  analyze,
  createAgent,
  createCommand,
  createInstruction,
  createSkill,
  createOverride,
  disableProvider,
  enableProvider,
  isProviderId,
  overridePath,
  overrideTargets,
  removeArtifact,
  removeOverride,
  sourceDirectory,
} from '@aiconfig/core';

import type { CommandContext } from './commands.js';
import { EXIT_FAILED, EXIT_OK, JSON_SCHEMA_VERSION } from './commands.js';
import { jsonDiagnostic, renderDiagnostics, renderJson } from './output.js';

const PLACEHOLDER = 'Describe what this should do, then run: aiconfig sync';

/**
 * Reads an artifact body.
 *
 * A placeholder rather than an error when no body is given: scaffolding is
 * meant to be scriptable, and an empty body would fail validation on the very
 * next command.
 */
const readBody = async (context: CommandContext): Promise<string | Diagnostic> => {
  const source = context.options.bodyFile;
  if (source === undefined) {
    return PLACEHOLDER;
  }
  if (source === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const content = await context.fileSystem.readFile(source);
  if (content === undefined) {
    return {
      code: 'ROOT_NOT_FOUND',
      severity: 'error',
      message: `Could not read '${source}'.`,
      source,
    };
  }
  return content.toString('utf8').trim();
};

const report = (context: CommandContext, command: string, outcome: ScaffoldOutcome): number => {
  const { streams, options } = context;

  if (options.json) {
    streams.out(
      renderJson({
        schema: JSON_SCHEMA_VERSION,
        command,
        ok: outcome.ok,
        created: outcome.ok ? outcome.created : null,
        diagnostics: outcome.ok ? [] : outcome.diagnostics.map(jsonDiagnostic),
      }),
    );
    return outcome.ok ? EXIT_OK : EXIT_FAILED;
  }

  if (!outcome.ok) {
    streams.err('AI Config');
    for (const line of renderDiagnostics(outcome.diagnostics, 'error')) {
      streams.err(line);
    }
    return EXIT_FAILED;
  }

  streams.out('AI Config');
  streams.out('');
  for (const created of outcome.created) {
    streams.out(`Created ${created}`);
  }
  streams.out('');
  streams.out('Run: aiconfig sync');
  return EXIT_OK;
};

export const runAdd = async (context: CommandContext): Promise<number> => {
  const { fileSystem, root, options, streams } = context;
  const kind = options.positionals[0] as SourceKind;
  const name = options.positionals[1] ?? '';

  const description = options.description?.trim() ?? '';
  if (kind !== 'instruction' && description.length === 0) {
    streams.err(`aiconfig add ${kind}: --description is required.`);
    return EXIT_FAILED;
  }
  if (options.applyTo.length > 0 && kind !== 'instruction') {
    streams.err(`'--apply-to' applies only to an instruction.`);
    return EXIT_FAILED;
  }
  if (options.directories.length > 0 && kind !== 'skill') {
    streams.err(`'--with' applies only to a skill.`);
    return EXIT_FAILED;
  }

  const body = await readBody(context);
  if (typeof body !== 'string') {
    return report(context, `add ${kind}`, { ok: false, diagnostics: [body] });
  }

  switch (kind) {
    case 'instruction':
      return report(
        context,
        'add instruction',
        await createInstruction(fileSystem, root, {
          name,
          ...(description.length === 0 ? {} : { description }),
          body,
          applyTo: options.applyTo,
        }),
      );
    case 'agent':
      return report(
        context,
        'add agent',
        await createAgent(fileSystem, root, { name, description, body }),
      );
    case 'skill':
      return report(
        context,
        'add skill',
        await createSkill(fileSystem, root, {
          name,
          description,
          body,
          directories: options.directories,
        }),
      );
    case 'command':
      return report(
        context,
        'add command',
        await createCommand(fileSystem, root, { name, description, body }),
      );
  }
};

/** Parses `--set key=value` against the provider's declared field types. */
const parseSet = (
  entries: readonly string[],
  schema: ProviderOverrideSchema,
): { readonly options: Record<string, unknown> } | { readonly error: string } => {
  const options: Record<string, unknown> = {};

  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      return { error: `'--set ${entry}' must be in key=value form.` };
    }
    const key = entry.slice(0, separator).trim();
    const raw = entry.slice(separator + 1);
    const field = schema.fields.find((candidate) => candidate.name === key);
    if (field === undefined) {
      // Not a field this build declares. The document validator reports it as a
      // warning and writes it through, so refusing here would make '--set'
      // stricter than hand-editing the same file. Without a declared type the
      // value is resolved the way YAML resolves the same scalar, which is how
      // it will be read back.
      assign(options, key.split('.'), untypedScalar(raw));
      continue;
    }

    const coerced = coerce(raw, field);
    if (typeof coerced === 'string') {
      return { error: coerced };
    }
    assign(options, key.split('.'), coerced.value);
  }

  return { options };
};

/**
 * Resolves a '--set' value for a field with no declared type.
 *
 * Mirrors YAML scalar resolution rather than always producing a string, so
 * '--set thing=3' and a hand-written 'thing: 3' end up as the same document.
 */
const untypedScalar = (raw: string): string | number | boolean => {
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  const numeric = Number(raw);
  return raw.trim().length > 0 && Number.isFinite(numeric) ? numeric : raw;
};

const coerce = (raw: string, field: OverrideField): { readonly value: unknown } | string => {
  switch (field.type.kind) {
    case 'boolean':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return `'${field.name}' must be true or false.`;

    case 'number': {
      const value = Number(raw);
      return Number.isFinite(value)
        ? { value }
        : `'${field.name}' must be a number, but received '${raw}'.`;
    }

    case 'string-list':
      return {
        value: raw
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      };

    case 'string-or-string-list':
      return raw.includes(',')
        ? {
            value: raw
              .split(',')
              .map((item) => item.trim())
              .filter((item) => item.length > 0),
          }
        : { value: raw };

    case 'map':
    case 'string-map':
    case 'list':
    case 'map-list':
      // No inline object syntax is invented for a structured field: it would be
      // a second configuration language with no documentation behind it.
      return `'${field.name}' is a structured field. Create the override without it, then edit the file.`;

    case 'string':
    case 'enum':
    case 'enum-or-map':
      return { value: raw };
  }
};

const assign = (
  target: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void => {
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (rest.length === 0) {
    target[head] = value;
    return;
  }
  const existing = target[head];
  const child =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  target[head] = child;
  assign(child, rest, value);
};

const schemaFor = (
  adapters: readonly ProviderAdapter[],
  provider: string,
  kind: SourceKind,
): ProviderOverrideSchema | undefined =>
  adapters
    .find((adapter) => adapter.id === provider)
    ?.overrides?.find((schema) => schema.kind === kind);

export const runOverride = async (context: CommandContext): Promise<number> => {
  // The action is already checked for membership during argument parsing, so
  // `create` is the only remaining possibility here.
  const action = context.options.positionals[0];
  if (action === 'list') {
    return runOverrideList(context);
  }
  if (action === 'remove') {
    return runOverrideRemove(context);
  }
  return runOverrideCreate(context);
};

const runOverrideCreate = async (context: CommandContext): Promise<number> => {
  const { fileSystem, root, adapters, streams, options } = context;
  const [, provider, kindArgument, id] = options.positionals;
  const kind = kindArgument as SourceKind;

  if (provider === undefined || id === undefined || !isProviderId(provider)) {
    streams.err(`Unknown provider '${provider ?? ''}'.`);
    return EXIT_FAILED;
  }

  const schema = schemaFor(adapters, provider, kind);
  if (schema === undefined) {
    streams.err(
      `'${provider}' has no provider-specific options for a ${kind}. Nothing to configure.`,
    );
    return EXIT_FAILED;
  }

  const outcome = await analyze(fileSystem, root, adapters);
  if (!outcome.ok) {
    return report(context, 'override create', { ok: false, diagnostics: outcome.diagnostics });
  }
  const target = overrideTargets(outcome.analysis.project.configuration).find(
    (candidate) => candidate.kind === kind && candidate.name === id,
  );
  if (target === undefined) {
    streams.err(`No canonical ${kind} named '${id}' exists.`);
    return EXIT_FAILED;
  }

  const parsed = parseSet(options.set, schema);
  if ('error' in parsed) {
    streams.err(parsed.error);
    return EXIT_FAILED;
  }

  return report(
    context,
    'override create',
    await createOverride(
      fileSystem,
      root,
      { provider, kind, id, options: parsed.options },
      schema,
      target,
      { force: options.force },
    ),
  );
};

const runOverrideRemove = async (context: CommandContext): Promise<number> => {
  const { fileSystem, root, streams, options } = context;
  const [, provider, kindArgument, id] = options.positionals;
  const kind = kindArgument as SourceKind;

  if (provider === undefined || id === undefined || !isProviderId(provider)) {
    streams.err(`Unknown provider '${provider ?? ''}'.`);
    return EXIT_FAILED;
  }

  return report(
    context,
    'override remove',
    await removeOverride(fileSystem, root, provider, kind, id),
  );
};

const runOverrideList = async (context: CommandContext): Promise<number> => {
  const { fileSystem, root, adapters, streams, options } = context;
  const filter = options.positionals[1];

  const rows: { provider: string; kind: SourceKind; id: string; path: string }[] = [];
  for (const adapter of adapters) {
    if (filter !== undefined && adapter.id !== filter) {
      continue;
    }
    for (const schema of adapter.overrides ?? []) {
      const directory = `.ai/providers/${adapter.id}/${sourceDirectory(schema.kind)}`;
      for (const entry of await fileSystem.readDirectory(`${root}/${directory}`)) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.yaml') || entry.name.startsWith('.')) {
          continue;
        }
        const id = entry.name.slice(0, -'.yaml'.length);
        rows.push({
          provider: adapter.id,
          kind: schema.kind,
          id,
          path: overridePath(adapter.id, schema.kind, id),
        });
      }
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));

  if (options.json) {
    streams.out(
      renderJson({
        schema: JSON_SCHEMA_VERSION,
        command: 'override list',
        ok: true,
        overrides: rows,
        diagnostics: [],
      }),
    );
    return EXIT_OK;
  }

  streams.out('AI Config');
  streams.out('');
  if (rows.length === 0) {
    streams.out('No provider overrides are configured.');
    return EXIT_OK;
  }
  for (const row of rows) {
    streams.out(`  ${row.path}`);
  }
  return EXIT_OK;
};

/**
 * Deletes a canonical artifact and every override written for it.
 *
 * The same operation the VS Code view runs behind **Delete…**. It confirms
 * through a modal because it is a click; here the command names the kind and
 * the artifact, which is the confirmation. Both end in `removeArtifact`, so
 * neither can take more or less than the other.
 *
 * The generated files are not removed here. They become orphans the moment the
 * source is gone, and the next `sync` removes them after re-verifying each one
 * still holds the bytes AI Config wrote.
 */
export const runRemove = async (context: CommandContext): Promise<number> => {
  const { fileSystem, root, streams, options } = context;
  const [kindArgument, name] = options.positionals;
  const kind = kindArgument as SourceKind;

  if (name === undefined) {
    streams.err(`Usage: aiconfig remove <instruction|agent|skill|command> <name>.`);
    return EXIT_FAILED;
  }

  const outcome = await removeArtifact(fileSystem, root, kind, name);

  if (options.json) {
    streams.out(
      renderJson({
        schema: JSON_SCHEMA_VERSION,
        command: 'remove',
        ok: outcome.ok,
        removed: outcome.ok ? outcome.removed : null,
        diagnostics: outcome.ok ? [] : outcome.diagnostics.map(jsonDiagnostic),
      }),
    );
    return outcome.ok ? EXIT_OK : EXIT_FAILED;
  }

  if (!outcome.ok) {
    streams.err('AI Config');
    for (const line of renderDiagnostics(outcome.diagnostics, 'error')) {
      streams.err(line);
    }
    return EXIT_FAILED;
  }

  streams.out('AI Config');
  streams.out('');
  if (outcome.removed.length === 0) {
    streams.out(`No ${kind} named '${name}' exists.`);
    return EXIT_OK;
  }
  for (const removed of outcome.removed) {
    streams.out(`Removed ${removed}`);
  }
  streams.out('');
  streams.out('Run: aiconfig sync');
  return EXIT_OK;
};

/** Enables or disables a provider in `.ai/config.yaml`. */
export const runProviders = async (context: CommandContext): Promise<number> => {
  const { fileSystem, root, streams, options } = context;
  const [action, provider] = options.positionals;

  if (provider === undefined || !isProviderId(provider)) {
    streams.err(`Unknown provider '${provider ?? ''}'.`);
    return EXIT_FAILED;
  }

  const outcome =
    action === 'enable'
      ? await enableProvider(fileSystem, root, provider)
      : await disableProvider(fileSystem, root, provider);

  if (options.json) {
    streams.out(
      renderJson({
        schema: JSON_SCHEMA_VERSION,
        command: `providers ${String(action)}`,
        ok: outcome.ok,
        providers: outcome.ok ? outcome.providers : null,
        changed: outcome.ok ? outcome.changed : null,
        diagnostics: outcome.ok ? [] : outcome.diagnostics.map(jsonDiagnostic),
      }),
    );
    return outcome.ok ? EXIT_OK : EXIT_FAILED;
  }

  if (!outcome.ok) {
    streams.err('AI Config');
    for (const line of renderDiagnostics(outcome.diagnostics, 'error')) {
      streams.err(line);
    }
    return EXIT_FAILED;
  }

  streams.out('AI Config');
  streams.out('');
  if (!outcome.changed) {
    streams.out(`'${provider}' is already ${action === 'enable' ? 'enabled' : 'disabled'}.`);
    return EXIT_OK;
  }
  streams.out(`Enabled: ${outcome.providers.length === 0 ? 'none' : outcome.providers.join(', ')}`);
  if (action === 'disable') {
    // Stated rather than left to be discovered: it is what makes re-enabling
    // restore the settings exactly.
    streams.out('');
    streams.out(`Its override files under ${AI_DIRECTORY}/providers/ are kept.`);
  }
  streams.out('');
  streams.out('Run: aiconfig sync');
  return EXIT_OK;
};
