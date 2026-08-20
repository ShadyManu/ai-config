import { parseArgs } from 'node:util';

import type { SourceKind } from '@aiconfig/core';

export type CommandName =
  | 'init'
  | 'sync'
  | 'validate'
  | 'status'
  | 'rules'
  | 'add'
  | 'remove'
  | 'override'
  | 'providers'
  | 'restore'
  | 'clean';

export const COMMAND_NAMES: readonly CommandName[] = [
  'init',
  'sync',
  'validate',
  'status',
  'rules',
  'add',
  'remove',
  'override',
  'providers',
  'restore',
  'clean',
];

export const ARTIFACT_KINDS: readonly SourceKind[] = ['instruction', 'agent', 'skill', 'command'];

export type OverrideAction = 'create' | 'list' | 'remove';

export const OVERRIDE_ACTIONS: readonly OverrideAction[] = ['create', 'list', 'remove'];

export type ProviderAction = 'enable' | 'disable';

export const PROVIDER_ACTIONS: readonly ProviderAction[] = ['enable', 'disable'];

export interface ParsedCommand {
  readonly command: CommandName;
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly check: boolean;
  readonly cwd: string | undefined;
  /** Positional arguments after the command name, already arity-checked. */
  readonly positionals: readonly string[];
  readonly providers: readonly string[] | undefined;
  readonly description: string | undefined;
  readonly bodyFile: string | undefined;
  readonly applyTo: readonly string[];
  readonly directories: readonly string[];
  readonly set: readonly string[];
}

export type ParseOutcome =
  | { readonly kind: 'command'; readonly value: ParsedCommand }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'error'; readonly message: string };

const FLAGS_BY_COMMAND: Readonly<Record<CommandName, readonly string[]>> = {
  init: ['cwd', 'providers'],
  sync: ['dry-run', 'force', 'json', 'cwd'],
  validate: ['check', 'json', 'cwd'],
  status: ['json', 'cwd'],
  rules: ['cwd'],
  add: ['cwd', 'json', 'description', 'body-file', 'apply-to', 'with'],
  remove: ['cwd', 'json'],
  override: ['cwd', 'json', 'force', 'set'],
  providers: ['cwd', 'json'],
  restore: ['cwd', 'json'],
  clean: ['cwd', 'json'],
};

const ALL_FLAGS = [
  'dry-run',
  'force',
  'check',
  'json',
  'cwd',
  'providers',
  'description',
  'body-file',
  'apply-to',
  'with',
  'set',
] as const;

/**
 * Parses CLI arguments.
 *
 * Uses Node's built-in `parseArgs` rather than a dependency: the surface is a
 * handful of commands and flags, which does not justify one.
 */
export const parseCommandLine = (argv: readonly string[]): ParseOutcome => {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        json: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        force: { type: 'boolean' },
        check: { type: 'boolean' },
        cwd: { type: 'string' },
        providers: { type: 'string' },
        description: { type: 'string' },
        'body-file': { type: 'string' },
        'apply-to': { type: 'string', multiple: true },
        with: { type: 'string' },
        set: { type: 'string', multiple: true },
      },
    });
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }

  const { values, positionals } = parsed;

  if (values.help === true || positionals[0] === 'help') {
    return { kind: 'help' };
  }
  if (values.version === true) {
    return { kind: 'version' };
  }

  const [name, ...rest] = positionals;

  if (name === undefined) {
    return { kind: 'help' };
  }
  if (!isCommandName(name)) {
    return {
      kind: 'error',
      message: `Unknown command '${name}'. Available commands: ${COMMAND_NAMES.join(', ')}.`,
    };
  }

  const arity = checkPositionals(name, rest);
  if (arity !== undefined) {
    return { kind: 'error', message: arity };
  }

  // Rejecting a flag the command does not use avoids silently ignoring, say,
  // `aiconfig status --force`, which would read as though it did something.
  const allowed = new Set(FLAGS_BY_COMMAND[name]);
  for (const flag of ALL_FLAGS) {
    if (values[flag] !== undefined && !allowed.has(flag)) {
      return {
        kind: 'error',
        message: `'--${flag}' is not valid for 'aiconfig ${name}'. Supported: ${allowed.size === 0 ? 'none' : [...allowed].map((f) => `--${f}`).join(', ')}.`,
      };
    }
  }

  const providers = values.providers?.split(',').map((value) => value.trim());
  if (providers?.some((value) => value.length === 0) === true) {
    return {
      kind: 'error',
      message: `'--providers' must be a comma-separated list of provider IDs.`,
    };
  }

  return {
    kind: 'command',
    value: {
      command: name,
      json: values.json === true,
      dryRun: values['dry-run'] === true,
      force: values.force === true,
      check: values.check === true,
      cwd: values.cwd,
      positionals: rest,
      providers,
      description: values.description,
      bodyFile: values['body-file'],
      applyTo: values['apply-to'] ?? [],
      directories:
        values.with === undefined
          ? []
          : values.with
              .split(',')
              .map((value) => value.trim())
              .filter((value) => value.length > 0),
      set: values.set ?? [],
    },
  };
};

const checkPositionals = (command: CommandName, rest: readonly string[]): string | undefined => {
  switch (command) {
    case 'init':
    case 'sync':
    case 'validate':
    case 'status':
    case 'rules':
    case 'clean':
      return rest.length === 0 ? undefined : `Unexpected argument '${rest[0] ?? ''}'.`;

    case 'remove': {
      const [kind, name, ...extra] = rest;
      if (kind === undefined || !(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
        return `Usage: aiconfig remove <${ARTIFACT_KINDS.join('|')}> <name>.`;
      }
      if (name === undefined) {
        return `Usage: aiconfig remove ${kind} <name>.`;
      }
      return extra.length === 0 ? undefined : `Unexpected argument '${extra[0] ?? ''}'.`;
    }

    case 'providers': {
      const [action, provider, ...extra] = rest;
      if (action === undefined || !(PROVIDER_ACTIONS as readonly string[]).includes(action)) {
        return `Usage: aiconfig providers <${PROVIDER_ACTIONS.join('|')}> <provider>.`;
      }
      if (provider === undefined) {
        return `Usage: aiconfig providers ${action} <provider>.`;
      }
      return extra.length === 0 ? undefined : `Unexpected argument '${extra[0] ?? ''}'.`;
    }

    case 'restore': {
      const [target, ...extra] = rest;
      if (target === undefined) {
        return 'Usage: aiconfig restore <generated-file-path>.';
      }
      return extra.length === 0 ? undefined : `Unexpected argument '${extra[0] ?? ''}'.`;
    }

    case 'add': {
      const [kind, name, ...extra] = rest;
      if (kind === undefined || !(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
        return `Usage: aiconfig add <${ARTIFACT_KINDS.join('|')}> <name> [options].`;
      }
      if (name === undefined) {
        return `Usage: aiconfig add ${kind} <name> [options].`;
      }
      return extra.length === 0 ? undefined : `Unexpected argument '${extra[0] ?? ''}'.`;
    }

    case 'override': {
      const [action, ...args] = rest;
      if (action === undefined || !(OVERRIDE_ACTIONS as readonly string[]).includes(action)) {
        return `Usage: aiconfig override <${OVERRIDE_ACTIONS.join('|')}> [arguments].`;
      }
      if (action === 'list') {
        return args.length <= 1 ? undefined : `Unexpected argument '${args[1] ?? ''}'.`;
      }
      if (args.length < 3) {
        return `Usage: aiconfig override ${action} <provider> <${ARTIFACT_KINDS.join('|')}> <id>.`;
      }
      const kind = args[1];
      if (kind === undefined || !(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
        return `Unknown artifact kind '${kind ?? ''}'. Supported: ${ARTIFACT_KINDS.join(', ')}.`;
      }
      return args.length === 3 ? undefined : `Unexpected argument '${args[3] ?? ''}'.`;
    }
  }
};

const isCommandName = (value: string): value is CommandName =>
  (COMMAND_NAMES as readonly string[]).includes(value);

export const HELP_TEXT = `AI Config - one configuration, every AI coding assistant.

Usage:
  aiconfig <command> [options]

Commands:
  init                 Create a .ai/ directory in this repository
  sync                 Compile .ai/ into provider configuration
  validate             Check .ai/ for errors and provider compatibility warnings
  status               Report provider synchronization state
  rules                Print what is generated where, and what each provider accepts
  add <kind> <name>    Create a canonical instruction, agent, skill or command
  remove <kind> <name> Delete an artifact and every override written for it
  override <action>    Create, list or remove provider-specific options
  providers <action>   Enable or disable a provider
  restore <path>       Replace one generated file with the version AI Config makes
  clean                Remove every file AI Config generated, keeping .ai/

Scaffolding:
  aiconfig add instruction <name> --description <text> [--apply-to <glob>]...
  aiconfig add agent       <name> --description <text> [--body-file <path>]
  aiconfig add skill       <name> --description <text> [--with references,scripts]
  aiconfig add command     <name> --description <text> [--body-file <path>]

  aiconfig remove <instruction|agent|skill|command> <name>

  aiconfig override create <provider> <kind> <id> [--set key=value]... [--force]
  aiconfig override list   [provider]
  aiconfig override remove <provider> <kind> <id>

  aiconfig providers enable  <provider>
  aiconfig providers disable <provider>

Options:
  --cwd <dir>          Run as if started in <dir>
  --providers <list>   Comma-separated providers to enable (init)
  --description <text> Artifact description (add)
  --body-file <path>   Read the artifact body from a file, or - for stdin (add)
  --apply-to <glob>    Limit an instruction to matching paths; repeatable (add)
  --with <list>        Comma-separated skill directories to create (add skill)
  --set <key=value>    Set one provider option; repeatable (override create)
  --dry-run            Report what sync would do without writing (sync)
  --force              Replace AI Config's own generated files when they have
                       been modified (sync); replace an override that already
                       exists (override create). Never replaces a file AI Config
                       did not write.
  --check              Exit non-zero if there are warnings as well as errors (validate)
  --json               Emit machine-readable output (every command but init and rules)
  -h, --help           Show this help
  -v, --version        Show the version

Documentation: https://github.com/ShadyManu/ai-config`;
