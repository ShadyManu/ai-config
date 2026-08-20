import type { AnalysisResult, Diagnostic, FileSystem, ProviderAdapter } from '@aiconfig/core';
import {
  AI_DIRECTORY,
  analyze,
  clean,
  countBySeverity,
  findExistingProviderTargets,
  hasErrors,
  init,
  isInitialized,
  renderGenerationRules,
  restore,
  stateOf,
  sync,
} from '@aiconfig/core';

import type { ParsedCommand } from './args.js';
import type { OutputStreams } from './output.js';
import { VERSION } from './version.js';
import { SYMBOL, jsonDiagnostic, pad, pluralize, renderDiagnostics, renderJson } from './output.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/**
 * Version of the `--json` payload shape.
 *
 * Every command emits the same key set whether it succeeded or failed, with
 * `null` for data that could not be produced, so a consumer can read a fixed
 * schema instead of probing for keys.
 */
export const JSON_SCHEMA_VERSION = 1;

export interface CommandContext {
  readonly fileSystem: FileSystem;
  readonly root: string;
  readonly adapters: readonly ProviderAdapter[];
  readonly streams: OutputStreams;
  readonly options: ParsedCommand;
}

export const runInit = async (context: CommandContext): Promise<number> => {
  const { fileSystem, root, adapters, streams, options } = context;

  const available = adapters.map((adapter) => adapter.id);
  const requested = options.providers;
  if (requested !== undefined) {
    const unknown = requested.filter((id) => !(available as readonly string[]).includes(id));
    if (unknown.length > 0) {
      streams.err(
        `Unknown provider${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Available: ${[...available].sort().join(', ')}.`,
      );
      return EXIT_FAILED;
    }
  }

  const enabled =
    requested === undefined ? available : available.filter((id) => requested.includes(id));

  // Looked for before initializing, as the VS Code flow does: a repository that
  // already has provider files is the one case where what happens next is not
  // what a reader expects, and saying so afterwards would be saying it late.
  const existing = await findExistingProviderTargets(
    fileSystem,
    root,
    adapters.filter((adapter) => enabled.includes(adapter.id)),
  );

  const result = await init(fileSystem, root, {
    providers: enabled,
    adapters,
    version: VERSION,
  });

  if (!result.ok) {
    reportFailure(streams, result.diagnostics);
    return EXIT_FAILED;
  }

  streams.out('AI Config');
  streams.out('');
  streams.out(`Created ${AI_DIRECTORY}/`);
  for (const created of result.created) {
    streams.out(`  ${created}`);
  }
  streams.out('');

  if (existing.length > 0) {
    streams.out('This project already contains provider files. They stay yours:');
    for (const entry of existing) {
      streams.out(`  ${entry}`);
    }
    streams.out('');
    streams.out('AI Config has no ownership record for them, so it will not overwrite, delete or');
    streams.out('adopt them. Synchronizing reports them as conflicts until you move or remove');
    streams.out('them yourself.');
    streams.out('');
  }

  streams.out(`Add instructions, agents, skills and commands under ${AI_DIRECTORY}/,`);
  streams.out('then run: aiconfig sync');

  return EXIT_OK;
};

export const runSync = async (context: CommandContext): Promise<number> => {
  const { fileSystem, root, adapters, streams, options } = context;

  const outcome = await sync(fileSystem, root, adapters, {
    dryRun: options.dryRun,
    force: options.force,
  });

  if (!outcome.ok) {
    if (options.json) {
      streams.out(
        renderJson({
          schema: JSON_SCHEMA_VERSION,
          command: 'sync',
          ok: false,
          applied: false,
          summary: null,
          providers:
            outcome.analysis === undefined ? null : outcome.analysis.providers.map(providerJson),
          diagnostics: outcome.diagnostics.map(jsonDiagnostic),
          executableContent:
            outcome.analysis === undefined ? null : executableJson(outcome.analysis),
        }),
      );
    } else {
      reportFailure(streams, outcome.diagnostics);
    }
    return EXIT_FAILED;
  }

  const { analysis, summary, applied, diagnostics, removedOverrides } = outcome.result;

  if (options.json) {
    streams.out(
      renderJson({
        schema: JSON_SCHEMA_VERSION,
        command: 'sync',
        ok: true,
        applied,
        summary,
        providers: analysis.providers.map(providerJson),
        diagnostics: diagnostics.map(jsonDiagnostic),
        removedOverrides,
        executableContent: executableJson(analysis),
      }),
    );
    return EXIT_OK;
  }

  streams.out('AI Config');
  streams.out('');

  if (analysis.providers.length === 0) {
    streams.out('No providers are enabled.');
    streams.out(`Enable one under 'providers' in ${AI_DIRECTORY}/config.yaml.`);
    return EXIT_OK;
  }

  const width = Math.max(...analysis.providers.map((provider) => provider.displayName.length)) + 4;
  for (const provider of analysis.providers) {
    const marker =
      provider.status === 'synced' || provider.status === 'pending' ? SYMBOL.ok : SYMBOL.warning;
    streams.out(
      `${marker} ${pad(provider.displayName, width)}${pluralize(provider.fileCount, 'file')}`,
    );
  }

  for (const line of renderDiagnostics(diagnostics, 'warning')) {
    streams.out(line);
  }

  streams.out('');
  if (!applied) {
    reportExecutableMaterialization(streams, analysis);
    streams.out(
      `Dry run: ${pluralize(summary.written, 'file')} would be written, ${pluralize(summary.deleted, 'file')} deleted.`,
    );
    streams.out('Nothing was modified.');
  } else if (summary.written === 0 && summary.deleted === 0 && removedOverrides.length === 0) {
    streams.out('Already synchronized.');
  } else {
    streams.out(
      `Synchronized: ${pluralize(summary.written, 'file')} written, ${pluralize(summary.deleted, 'file')} deleted.`,
    );
    // Named one by one rather than counted: these are the author's files, and
    // the only ones under `.ai/` a synchronization ever removes.
    for (const removed of removedOverrides) {
      streams.out(`Removed ${removed}, which no longer refines anything.`);
    }
  }

  return EXIT_OK;
};

export const runValidate = async (context: CommandContext): Promise<number> => {
  const { fileSystem, root, adapters, streams, options } = context;

  const outcome = await analyze(fileSystem, root, adapters);
  if (!outcome.ok) {
    if (options.json) {
      streams.out(
        renderJson({
          schema: JSON_SCHEMA_VERSION,
          command: 'validate',
          ok: false,
          counts: null,
          diagnostics: outcome.diagnostics.map(jsonDiagnostic),
          executableContent: null,
        }),
      );
    } else {
      reportFailure(streams, outcome.diagnostics);
    }
    return EXIT_FAILED;
  }

  const analysis = outcome.analysis;
  // Validation deliberately ignores drift: it checks the canonical source, and
  // `aiconfig status` is what reports the state of generated files.
  const diagnostics = analysis.diagnostics;
  const errors = countBySeverity(diagnostics, 'error');
  const warnings = countBySeverity(diagnostics, 'warning');

  if (options.json) {
    streams.out(
      renderJson({
        schema: JSON_SCHEMA_VERSION,
        command: 'validate',
        ok: errors === 0,
        counts: {
          instructions: analysis.project.configuration.instructions.length,
          agents: analysis.project.configuration.agents.length,
          skills: analysis.project.configuration.skills.length,
          commands: analysis.project.configuration.commands.length,
          errors,
          warnings,
        },
        diagnostics: diagnostics.map(jsonDiagnostic),
        executableContent: executableJson(analysis),
      }),
    );
    return errors > 0 || (options.check && warnings > 0) ? EXIT_FAILED : EXIT_OK;
  }

  const configuration = analysis.project.configuration;
  streams.out('AI Config');
  streams.out('');
  streams.out(`${SYMBOL.ok} ${pluralize(configuration.instructions.length, 'instruction')}`);
  streams.out(`${SYMBOL.ok} ${pluralize(configuration.agents.length, 'agent')}`);
  streams.out(`${SYMBOL.ok} ${pluralize(configuration.skills.length, 'skill')}`);
  streams.out(`${SYMBOL.ok} ${pluralize(configuration.commands.length, 'command')}`);
  reportExecutableContent(streams, analysis);

  // `validate` is a diagnostic report, so it renders every severity. `sync`
  // reports actions and stays at errors and warnings.
  for (const severity of ['error', 'warning', 'info'] as const) {
    for (const line of renderDiagnostics(diagnostics, severity)) {
      streams.out(line);
    }
  }

  const notes = countBySeverity(diagnostics, 'info');
  const withNotes = (summary: string): string =>
    notes === 0 ? summary : `${summary} ${pluralize(notes, 'note')}.`;

  streams.out('');
  if (errors > 0) {
    streams.out(
      withNotes(
        `Validation failed: ${pluralize(errors, 'error')}, ${pluralize(warnings, 'warning')}.`,
      ),
    );
    return EXIT_FAILED;
  }
  if (warnings > 0) {
    streams.out(withNotes(`Validation passed with ${pluralize(warnings, 'warning')}.`));
    // Notes never fail `--check`: they report a fact, not a problem.
    return options.check ? EXIT_FAILED : EXIT_OK;
  }
  if (notes > 0) {
    streams.out(`Validation passed with ${pluralize(notes, 'note')}.`);
    return EXIT_OK;
  }

  streams.out('Validation passed.');
  return EXIT_OK;
};

export const runStatus = async (context: CommandContext): Promise<number> => {
  const { fileSystem, root, adapters, streams, options } = context;

  if (!(await isInitialized(fileSystem, root))) {
    if (options.json) {
      streams.out(
        renderJson({
          schema: JSON_SCHEMA_VERSION,
          command: 'status',
          initialized: false,
          ok: true,
          providers: null,
          files: null,
          executableContent: null,
          diagnostics: [],
        }),
      );
    } else {
      streams.out('AI Config');
      streams.out('');
      streams.out('Not initialized.');
      streams.out('');
      streams.out("Run 'aiconfig init' to create a .ai/ directory.");
    }
    return EXIT_OK;
  }

  const outcome = await analyze(fileSystem, root, adapters);
  if (!outcome.ok) {
    if (options.json) {
      streams.out(
        renderJson({
          schema: JSON_SCHEMA_VERSION,
          command: 'status',
          initialized: true,
          ok: false,
          providers: null,
          files: null,
          executableContent: null,
          diagnostics: outcome.diagnostics.map(jsonDiagnostic),
        }),
      );
    } else {
      reportFailure(streams, outcome.diagnostics);
    }
    return EXIT_FAILED;
  }

  const analysis = outcome.analysis;

  if (options.json) {
    streams.out(
      renderJson({
        schema: JSON_SCHEMA_VERSION,
        command: 'status',
        initialized: true,
        ok: !hasErrors(analysis.diagnostics),
        providers: analysis.providers.map(providerJson),
        files: analysis.plan.actions.map((action) => ({
          path: action.path,
          state: stateOf(action),
          providers: [...action.providers],
          extension: action.extension ?? null,
          executable: action.executable ?? false,
        })),
        diagnostics: analysis.diagnostics.map(jsonDiagnostic),
        executableContent: executableJson(analysis),
      }),
    );
    // The exit code and the 'ok' field must agree, or CI cannot rely on either.
    return hasErrors(analysis.diagnostics) ? EXIT_FAILED : EXIT_OK;
  }

  streams.out('AI Config');
  streams.out('');

  if (analysis.providers.length === 0) {
    streams.out('No providers are enabled.');
    return EXIT_OK;
  }

  const nameWidth = Math.max(
    16,
    ...analysis.providers.map((provider) => provider.displayName.length + 2),
  );
  streams.out(`${pad('Provider', nameWidth)}${pad('Status', 12)}Files`);
  streams.out('-'.repeat(nameWidth + 12 + 5));

  for (const provider of analysis.providers) {
    streams.out(
      `${pad(provider.displayName, nameWidth)}${pad(provider.status, 12)}${String(provider.fileCount)}`,
    );
  }
  reportExecutableContent(streams, analysis);

  const attention = analysis.plan.actions.filter((action) => stateOf(action) !== 'synced');
  if (attention.length > 0) {
    streams.out('');
    streams.out('Files needing attention:');
    for (const action of attention) {
      streams.out(`  ${pad(stateOf(action), 10)}${action.path}`);
    }
  }

  // Like `validate`, `status` reports state rather than actions, so notes are
  // shown here too.
  for (const severity of ['error', 'warning', 'info'] as const) {
    for (const line of renderDiagnostics(analysis.diagnostics, severity)) {
      streams.out(line);
    }
  }

  return hasErrors(analysis.diagnostics) ? EXIT_FAILED : EXIT_OK;
};

const providerJson = (provider: AnalysisResult['providers'][number]): Record<string, unknown> => ({
  id: provider.id,
  displayName: provider.displayName,
  status: provider.status,
  files: provider.fileCount,
});

const reportFailure = (streams: OutputStreams, diagnostics: readonly Diagnostic[]): void => {
  streams.err('AI Config');
  for (const severity of ['error', 'warning'] as const) {
    for (const line of renderDiagnostics(diagnostics, severity)) {
      streams.err(line);
    }
  }
};

const executableJson = (
  analysis: AnalysisResult,
): readonly {
  readonly path: string;
  readonly providers: readonly string[];
  readonly extension: string | null;
  readonly executable: true;
}[] =>
  analysis.artifacts
    .filter((artifact) => artifact.executable === true)
    .map((artifact) => ({
      path: artifact.path,
      providers: artifact.providers,
      extension: artifact.extension ?? null,
      executable: true,
    }));

const reportExecutableContent = (streams: OutputStreams, analysis: AnalysisResult): void => {
  const content = executableJson(analysis);
  if (content.length === 0) return;
  streams.out('');
  streams.out('Executable provider content:');
  for (const entry of content)
    streams.out(`  ${entry.path} (${entry.extension ?? 'core artifact'})`);
};

const reportExecutableMaterialization = (
  streams: OutputStreams,
  analysis: AnalysisResult,
): void => {
  const files = analysis.plan.actions.filter(
    (action) =>
      action.executable === true &&
      (action.kind === 'create' || action.kind === 'restore' || action.kind === 'update'),
  );
  if (files.length === 0) return;

  streams.out('Executable files to materialize:');
  for (const file of files) streams.out(`  ${file.path} (${file.extension ?? 'core artifact'})`);
  streams.out('');
};

/**
 * Prints the reference `init` writes into `.ai/`.
 *
 * Printed rather than rewritten in place: a synchronization never writes into
 * `.ai/`, and a command that quietly replaced a file the author may have edited
 * would be the one exception. Redirect it to refresh the file after an upgrade:
 *
 *     aiconfig rules > .ai/generation-rules.md
 */
export const runRules = (context: CommandContext): number => {
  const { adapters, streams } = context;
  // Trimmed because `out` adds the newline. Redirecting this must produce a
  // file byte-identical to the one `init` writes, which a test asserts.
  streams.out(renderGenerationRules(adapters, VERSION).trimEnd());
  return EXIT_OK;
};

/**
 * Removes every file AI Config generated, leaving `.ai/` untouched.
 *
 * The same operation the VS Code view runs behind **Delete Generated Files**.
 * There is no CLI equivalent of **Remove AI Config from This Project**: that
 * one also deletes `.ai/`, and the extension can send it to the system trash
 * where a CLI could only unlink it. Deleting canonical sources irrecoverably is
 * not something this command should make easy — `rm -r .ai` after this says the
 * same thing, and says it deliberately.
 */
export const runClean = async (context: CommandContext): Promise<number> => {
  const { fileSystem, root, adapters, streams, options } = context;

  const outcome = await clean(fileSystem, root, adapters);

  if (options.json) {
    streams.out(
      renderJson({
        schema: JSON_SCHEMA_VERSION,
        command: 'clean',
        ok: outcome.ok,
        summary: outcome.ok ? outcome.result.summary : null,
        diagnostics: (outcome.ok ? outcome.result.diagnostics : outcome.diagnostics).map(
          jsonDiagnostic,
        ),
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
  streams.out(`Removed ${pluralize(outcome.result.summary.deleted, 'generated file')}.`);
  streams.out(`${AI_DIRECTORY}/ is untouched; run 'aiconfig sync' to generate again.`);
  return EXIT_OK;
};

/**
 * Replaces one generated file with the content AI Config generates for it.
 *
 * Scoped to a single path, like the **Restore Generated File** action it
 * mirrors: `sync --force` is the repository-wide form, and conflating the two
 * would make this overwrite every drifted file at once.
 */
export const runRestore = async (context: CommandContext): Promise<number> => {
  const { fileSystem, root, adapters, streams, options } = context;
  const target = options.positionals[0];

  if (target === undefined) {
    streams.err('Usage: aiconfig restore <generated-file-path>.');
    return EXIT_FAILED;
  }

  // Accepted as typed, including with Windows separators: the path comes from
  // a shell, where tab completion produces backslashes on Windows, while every
  // path AI Config records is POSIX.
  const relative = target.replaceAll('\\', '/');
  const outcome = await restore(fileSystem, root, adapters, [relative]);

  if (options.json) {
    streams.out(
      renderJson({
        schema: JSON_SCHEMA_VERSION,
        command: 'restore',
        ok: outcome.ok,
        summary: outcome.ok ? outcome.result.summary : null,
        diagnostics: (outcome.ok ? outcome.result.diagnostics : outcome.diagnostics).map(
          jsonDiagnostic,
        ),
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
  streams.out(`Restored ${relative}`);
  return EXIT_OK;
};
