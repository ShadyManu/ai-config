import * as path from 'node:path';
import * as vscode from 'vscode';

import type {
  AnalysisResult,
  CompiledArtifact,
  Diagnostic,
  OverrideTarget,
  ProviderAdapter,
  ProviderId,
  SourceKind,
} from '@aiconfig/core';
import {
  AI_DIRECTORY,
  CONFIG_PATH,
  NodeFileSystem,
  analyze,
  clean,
  countBySeverity,
  disableProvider as disableInConfig,
  enableProvider as enableInConfig,
  findExistingProviderTargets,
  hasErrors,
  indexSkillFiles,
  init,
  isInitialized,
  overridePath,
  removeArtifact,
  removeOverride,
  resolveContent,
  restore,
  sync,
} from '@aiconfig/core';
import { createDefaultAdapters } from '@aiconfig/providers';

import { DiagnosticPublisher } from './diagnostics.js';
import type { Logger } from './logger.js';
import { StatusBar } from './status-bar.js';
import { AiConfigTreeProvider } from './tree-view.js';
import { WATCHED_GLOB, isRelevantChange } from './watch.js';
import {
  pickFolderToInitialize,
  promptForWorkspaceRoot,
  resolveRootSilently,
} from './workspace.js';
import {
  addAgent,
  addCommand,
  addInstruction,
  addSkill,
  askToRemoveArtifact,
} from './wizards/artifacts.js';
import { pickProviders } from './wizards/initialize.js';
import type { OverrideCandidate, OverrideWizardContext } from './wizards/overrides.js';
import {
  CUSTOMIZE_DETAIL,
  candidatesFor,
  openFile,
  openOverrideFile,
  targetFor,
  writeOverrides,
} from './wizards/overrides.js';
import { askFields, cancelled } from './wizards/prompts.js';
import {
  countProviderSources,
  providerRemovalDetail,
  providerSourceDirectory,
} from './wizards/providers.js';

export const GENERATED_SCHEME = 'aiconfig-generated';

/** Debounce for `.ai/` bursts: long enough to coalesce a multi-file save. */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Owns extension state and delegates every operation to `@aiconfig/core`.
 *
 * Deliberately thin: it decides *when* to run and *how* to present results, and
 * contains no compilation, ownership or path logic of its own.
 */
export class Controller implements vscode.Disposable {
  private readonly fileSystem = new NodeFileSystem();
  private readonly adapters: readonly ProviderAdapter[] = createDefaultAdapters();
  private readonly diagnostics = new DiagnosticPublisher();
  private readonly statusBar = new StatusBar();
  public readonly tree = new AiConfigTreeProvider();

  private root: string | undefined;
  private analysis: AnalysisResult | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  /**
   * Serializes every operation that reads or writes the repository.
   *
   * A boolean guard on one entry point is not enough: the sync command, the
   * auto-sync inside a refresh, and workspace changes can all overlap, and two
   * concurrent writers racing over the ownership manifest can drop entries —
   * which turns a generated file into an untracked one that blocks every later
   * sync. Everything appends to this chain instead.
   */
  private chain: Promise<void> = Promise.resolve();

  private disposed = false;

  /**
   * Set when several initialized folders remain and none can be preferred.
   *
   * The question is then left open — no root, no UI — until an explicit AI
   * Config command gives a natural moment to ask it.
   */
  private deferredRootChoice = false;

  /**
   * @param version the extension's own version, recorded in the reference
   *   `init` writes so a stale one names the build that produced it.
   */
  public constructor(
    private readonly logger: Logger,
    private readonly version: string,
  ) {
    this.tree.setAdapters(this.adapters);
  }

  /** Queues `operation` behind everything already scheduled. */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      if (this.disposed) {
        return;
      }
      try {
        await operation();
      } catch (error) {
        this.logger.error('Unexpected failure.', error);
        this.statusBar.setFailed('an unexpected error occurred; see the AI Config output');
      }
    });
    // Keep the chain alive regardless of outcome; failures are handled above.
    this.chain = next;
    return next;
  }

  public async start(): Promise<void> {
    await this.enqueue(() => this.runRefresh());
  }

  public currentRoot(): string | undefined {
    return this.root;
  }

  public currentAnalysis(): AnalysisResult | undefined {
    return this.analysis;
  }

  /**
   * Re-reads `.ai/` and updates the UI, synchronizing first when there is
   * something valid to write.
   *
   * The returned promise resolves only after the refresh has actually run, so
   * a caller that needs a fresh analysis — Validate, Show Status — can await it
   * and trust the result.
   *
   * This is the explicit path: it is allowed to ask which folder to use. The
   * watcher schedules `runRefresh` directly instead, so no background event can
   * raise a prompt.
   */
  public async refresh(): Promise<void> {
    await this.resolveDeferredRootChoice();
    await this.enqueue(() => this.runRefresh());
  }

  private async runRefresh(): Promise<void> {
    await this.chooseRootSilently();

    const analysis = await this.loadAndPublish();

    if (analysis !== undefined && this.shouldSyncOnSave(analysis)) {
      await this.runSync({ silent: true });
      // Publish again: the analysis above describes the state *before* the
      // sync, so leaving it would show pending work that no longer exists.
      await this.loadAndPublish();
    }
  }

  /**
   * Re-takes the workspace choice, silently, before every refresh.
   *
   * This runs on the watcher's path too, so it must not show UI. It matters
   * most when the selected folder's `.ai/config.yaml` disappears: staying on a
   * folder that is no longer initialized would hide another folder that still
   * is. When the remaining folders leave a genuine choice, the root is cleared
   * and the question deferred rather than asked.
   */
  private async chooseRootSilently(): Promise<void> {
    const previous = this.root;
    const resolution = await resolveRootSilently(this.fileSystem, previous);

    this.root = resolution.kind === 'selected' ? resolution.root : undefined;
    this.deferredRootChoice = resolution.kind === 'ambiguous';

    if (this.root === previous) {
      return;
    }

    // Only on a real change: recreating the watcher needlessly would open a
    // window in which events are missed.
    this.installWatcher();

    if (resolution.kind === 'ambiguous') {
      this.logger.info(
        `${previous ?? 'The selected folder'} is no longer initialized, and several initialized folders remain. AI Config will ask which to use on the next command.`,
      );
    } else if (this.root !== undefined && previous !== undefined) {
      this.logger.info(`${previous} is no longer initialized; switched to ${this.root}.`);
    }
  }

  /**
   * Puts a deferred workspace choice to the user.
   *
   * Called only from commands the user invoked: the ambiguity is created by a
   * background event, but asking about it is always a response to an action. A
   * dismissed pick leaves the choice deferred, so the next command asks again.
   */
  private async resolveDeferredRootChoice(): Promise<void> {
    if (!this.deferredRootChoice) {
      return;
    }

    const chosen = await promptForWorkspaceRoot(this.fileSystem);
    if (chosen === undefined) {
      return;
    }

    await this.enqueue(async () => {
      this.deferredRootChoice = false;
      this.root = chosen;
      this.installWatcher();
      await this.runRefresh();
    });
  }

  /** Reads and validates the configuration, then updates every UI surface. */
  private async loadAndPublish(): Promise<AnalysisResult | undefined> {
    const root = this.root;

    if (root === undefined) {
      this.analysis = undefined;
      this.diagnostics.clear();
      this.tree.update(undefined, undefined);
      if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
        this.statusBar.setUnavailable();
      } else {
        this.statusBar.setNotInitialized();
      }
      return undefined;
    }

    if (!(await isInitialized(this.fileSystem, root))) {
      this.analysis = undefined;
      this.diagnostics.clear();
      this.tree.update(root, undefined);
      this.statusBar.setNotInitialized();
      return undefined;
    }

    const outcome = await analyze(this.fileSystem, root, this.adapters);

    if (!outcome.ok) {
      this.analysis = undefined;
      this.diagnostics.publish(root, outcome.diagnostics);
      this.tree.update(root, undefined);
      this.statusBar.setFailed(
        outcome.diagnostics[0]?.message ?? 'configuration could not be read',
      );
      this.logger.error(`Analysis failed: ${outcome.diagnostics[0]?.message ?? 'unknown error'}`);
      return undefined;
    }

    this.analysis = outcome.analysis;
    this.diagnostics.publish(root, outcome.analysis.diagnostics);
    this.tree.update(root, outcome.analysis);
    this.statusBar.setAnalysis(outcome.analysis);

    this.logger.info(
      `Configuration loaded: ${summarize(outcome.analysis)}; ${String(countBySeverity(outcome.analysis.diagnostics, 'error'))} errors, ${String(countBySeverity(outcome.analysis.diagnostics, 'warning'))} warnings.`,
    );

    return outcome.analysis;
  }

  private shouldSyncOnSave(analysis: AnalysisResult): boolean {
    if (hasErrors(analysis.diagnostics)) {
      return false;
    }
    // Nothing to do, and writing anyway would churn the manifest.
    return analysis.plan.actions.some(
      (action) => action.kind !== 'unchanged' && action.kind !== 'blocked',
    );
  }

  /** The `AI Config: Synchronize` command. */
  public async synchronize(options: { force?: boolean } = {}): Promise<void> {
    await this.resolveDeferredRootChoice();
    await this.enqueue(async () => {
      await this.runSync(options);
      await this.loadAndPublish();
    });
  }

  /**
   * Runs a synchronization, reporting whether it was applied.
   *
   * The boolean is what lets a caller that synchronizes as one step of a larger
   * operation — enabling or removing a provider — avoid announcing a result the
   * synchronization never produced. `runSync` has already told the user why it
   * could not run, so the caller only has to stop.
   */
  private async runSync(options: { force?: boolean; silent?: boolean } = {}): Promise<boolean> {
    const root = this.root;
    if (root === undefined) {
      void vscode.window.showWarningMessage('AI Config: no initialized workspace folder.');
      return false;
    }

    this.logger.info(`Sync started${options.force === true ? ' (force)' : ''}.`);

    try {
      const outcome = await sync(this.fileSystem, root, this.adapters, {
        force: options.force ?? false,
      });

      if (!outcome.ok) {
        this.logger.error('Sync blocked.');
        for (const diagnostic of outcome.diagnostics) {
          this.logger.info(`  ${diagnostic.code} ${diagnostic.source ?? ''} ${diagnostic.message}`);
        }
        await this.reportBlocked(outcome.diagnostics);
        return false;
      }

      const { summary } = outcome.result;
      this.logger.info(
        `Sync complete: ${String(summary.written)} written, ${String(summary.deleted)} deleted, ${String(summary.unchanged)} unchanged.`,
      );
      // The only files under `.ai/` a synchronization removes, so each one is
      // named in the log rather than folded into a count.
      for (const removed of outcome.result.removedOverrides) {
        this.logger.info(`Removed ${removed}, which no longer refines anything.`);
      }

      if (options.silent !== true) {
        const providers = outcome.result.analysis.providers.filter((provider) => provider.enabled);
        void vscode.window.showInformationMessage(
          `AI Config synchronized — ${String(summary.written)} file${summary.written === 1 ? '' : 's'} across ${String(providers.length)} provider${providers.length === 1 ? '' : 's'}.`,
        );
      }

      return true;
    } catch (error) {
      this.logger.error('Sync failed unexpectedly.', error);
      void vscode.window.showErrorMessage(
        'AI Config: synchronization failed. See the AI Config output for details.',
      );
      return false;
    }
  }

  /**
   * Removes every generated file, keeping the canonical sources.
   *
   * Nothing regenerates on its own afterwards — there is no sync-on-save — so
   * the repository stays free of provider files until the next Synchronize.
   */
  public async deleteGenerated(): Promise<void> {
    await this.resolveDeferredRootChoice();
    const confirmed = await vscode.window.showWarningMessage(
      'Delete every file AI Config generated?',
      {
        modal: true,
        detail:
          'Your .ai/ sources are not touched, so you can regenerate later with Synchronize. Any edit you made directly to a generated file is lost.',
      },
      'Delete',
    );
    if (confirmed !== 'Delete') {
      return;
    }

    await this.enqueue(async () => {
      if (await this.removeGenerated()) {
        void vscode.window.showInformationMessage(
          'AI Config: every generated file was removed. Run Synchronize to rebuild them.',
        );
      }
      await this.loadAndPublish();
    });
  }

  /**
   * Removes AI Config from the project entirely: the generated files, then the
   * canonical `.ai/` directory.
   *
   * `.ai/` holds work the author wrote, not output AI Config can recreate, so
   * this is the one operation that destroys something unrecoverable. Two things
   * follow from that. The confirmation counts what is about to be lost rather
   * than describing it vaguely, and the directory goes to the system trash
   * through the editor's own filesystem API, which makes the step reversible
   * outside the editor.
   *
   * Core deliberately offers no recursive delete — its `deleteFile` never
   * touches a directory — so the recursion lives here, against a path the
   * workspace root already bounds, rather than being added to a domain API that
   * every other operation would then inherit.
   */
  public async removeProject(): Promise<void> {
    await this.resolveDeferredRootChoice();
    const root = this.root;
    if (root === undefined) {
      return;
    }

    const configuration = this.analysis?.project.configuration;
    const counts =
      configuration === undefined
        ? 'every instruction, agent, skill and command you have written'
        : [
            `${String(configuration.instructions.length)} instruction(s)`,
            `${String(configuration.agents.length)} agent(s)`,
            `${String(configuration.skills.length)} skill(s)`,
            `${String(configuration.commands.length)} command(s)`,
          ].join(', ');

    const confirmed = await vscode.window.showWarningMessage(
      'Remove AI Config from this project?',
      {
        modal: true,
        detail: `Deletes every generated file and the whole .ai/ directory, containing ${counts}. The directory goes to the system trash, and this cannot be undone from the editor.`,
      },
      'Remove',
    );
    if (confirmed !== 'Remove') {
      return;
    }

    await this.enqueue(async () => {
      if (!(await this.removeGenerated())) {
        return;
      }

      const directory = vscode.Uri.file(path.join(root, AI_DIRECTORY));
      try {
        await vscode.workspace.fs.delete(directory, { recursive: true, useTrash: true });
        this.logger.info(`Removed ${AI_DIRECTORY}/.`);
      } catch (error) {
        this.logger.error(`Could not remove ${AI_DIRECTORY}/.`, error);
        void vscode.window.showErrorMessage(
          `AI Config: the generated files were removed, but ${AI_DIRECTORY}/ could not be deleted.`,
        );
        await this.loadAndPublish();
        return;
      }

      void vscode.window.showInformationMessage(
        'AI Config: removed from this project. Run Initialize Project to start again.',
      );
      await this.loadAndPublish();
    });
  }

  /**
   * Turns a provider on and generates its files in one step.
   *
   * Enabling alone would leave the view reporting a provider as enabled while
   * nothing had been written for it, so the two halves of what the user asked
   * for are one operation. The synchronization is silent because the message
   * below already reports it, and two notifications for one click is one too
   * many.
   */
  public async enableProvider(provider: ProviderId): Promise<void> {
    await this.resolveDeferredRootChoice();
    const root = this.root;
    if (root === undefined) {
      return;
    }

    await this.enqueue(async () => {
      const outcome = await enableInConfig(this.fileSystem, root, provider);
      if (!outcome.ok) {
        void vscode.window.showWarningMessage(
          `AI Config: ${outcome.diagnostics[0]?.message ?? 'the provider could not be enabled.'}`,
        );
        return;
      }

      this.logger.info(`Enabled ${provider} in ${CONFIG_PATH}.`);
      const synchronized = await this.runSync({ silent: true });
      await this.loadAndPublish();

      if (synchronized) {
        void vscode.window.showInformationMessage(
          `AI Config: ${this.displayNameOf(provider)} is enabled, and its files were generated.`,
        );
      }
    });
  }

  /**
   * Removes a provider from the project entirely: its entry in `config.yaml`,
   * the files generated for it, and the provider-specific sources written for
   * it.
   *
   * The order is what makes this safe. Disabling first turns the generated
   * files into orphans, which the planner deletes only after re-verifying each
   * one still holds the bytes AI Config wrote — a file edited since is refused
   * there rather than discarded here. The authored files under
   * `.ai/providers/` are touched only once that has succeeded, so a
   * synchronization that could not run costs the user nothing: re-enabling the
   * provider restores the project exactly as it was.
   *
   * Those authored files go to the system trash rather than being unlinked.
   * They are work the user wrote, and are treated as `.ai/` itself is when the
   * whole project is removed.
   */
  public async removeProvider(provider: ProviderId): Promise<void> {
    await this.resolveDeferredRootChoice();
    const root = this.root;
    const analysis = this.analysis;
    if (root === undefined || analysis === undefined) {
      return;
    }

    const report = analysis.providers.find((candidate) => candidate.id === provider);
    if (report?.enabled !== true) {
      return;
    }

    if (!(await this.confirmProviderRemoval(root, provider, report.displayName))) {
      return;
    }

    await this.enqueue(async () => {
      const outcome = await disableInConfig(this.fileSystem, root, provider);
      if (!outcome.ok) {
        void vscode.window.showWarningMessage(
          `AI Config: ${outcome.diagnostics[0]?.message ?? 'the provider could not be disabled.'}`,
        );
        return;
      }

      this.logger.info(`Disabled ${provider} in ${CONFIG_PATH}.`);

      if (!(await this.runSync({ silent: true }))) {
        // `runSync` has already said why. The provider stays disabled and its
        // sources stay on disk, which is the recoverable half of the state.
        await this.loadAndPublish();
        return;
      }

      const removedSources = await this.removeProviderSources(root, provider);
      await this.loadAndPublish();

      if (removedSources) {
        void vscode.window.showInformationMessage(
          `AI Config: ${report.displayName} was removed from this project.`,
        );
      }
    });
  }

  /** Says exactly what removing this provider deletes, before anything is. */
  private async confirmProviderRemoval(
    root: string,
    provider: ProviderId,
    displayName: string,
  ): Promise<boolean> {
    const sources = await countProviderSources(this.fileSystem, root, provider);

    const confirmed = await vscode.window.showWarningMessage(
      `Remove ${displayName} from this project?`,
      { modal: true, detail: providerRemovalDetail(displayName, provider, sources) },
      'Remove',
    );

    return confirmed === 'Remove';
  }

  /**
   * Deletes the provider's own directory under `.ai/providers/`, then prunes
   * the parent when nothing is left in it.
   *
   * `deleteEmptyDirectory` refuses a directory that still holds a file, so the
   * prune can never take another provider's work with it. `init` creates no
   * provider directories on purpose — an empty `.ai/providers/` would claim
   * something is configured when nothing is.
   */
  private async removeProviderSources(root: string, provider: ProviderId): Promise<boolean> {
    const relative = providerSourceDirectory(provider);
    const absolute = path.join(root, ...relative.split('/'));

    if (await this.fileSystem.exists(absolute)) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(absolute), {
          recursive: true,
          useTrash: true,
        });
        this.logger.info(`Removed ${relative}/.`);
      } catch (error) {
        this.logger.error(`Could not remove ${relative}/.`, error);
        void vscode.window.showWarningMessage(
          `AI Config: ${provider} was disabled and its generated files were removed, but ${relative}/ could not be deleted.`,
        );
        return false;
      }
    }

    try {
      await this.fileSystem.deleteEmptyDirectory(path.join(root, AI_DIRECTORY, 'providers'));
    } catch (error) {
      // Tidying is not worth failing a removal that already succeeded.
      this.logger.info(`${AI_DIRECTORY}/providers/ was left in place: ${String(error)}`);
    }

    return true;
  }

  private displayNameOf(provider: ProviderId): string {
    return this.adapters.find((adapter) => adapter.id === provider)?.displayName ?? provider;
  }

  /**
   * Deletes everything the manifest records, reporting failure to the user.
   *
   * A forced sync runs first because `clean` refuses to delete a generated file
   * that was edited afterwards; the confirmation both callers show has already
   * said those edits are lost, so reclaiming them here is what the user agreed
   * to rather than a silent overreach.
   *
   * That sync failing is reported rather than stepped over. It fails on exactly
   * the conditions that make deletion unsafe — a refused output path above all —
   * and running `clean` anyway would ask it to remove files whose state the
   * analysis just declared it could not establish.
   */
  private async removeGenerated(): Promise<boolean> {
    const root = this.root;
    if (root === undefined) {
      return false;
    }

    const prepared = await sync(this.fileSystem, root, this.adapters, { force: true });

    const outcome = prepared.ok
      ? await clean(this.fileSystem, root, this.adapters)
      : ({ ok: false, diagnostics: prepared.diagnostics } as const);
    if (!outcome.ok) {
      this.logger.error('Could not remove the generated files.');
      for (const diagnostic of outcome.diagnostics) {
        this.logger.info(`  ${diagnostic.code} ${diagnostic.source ?? ''} ${diagnostic.message}`);
      }
      const choice = await vscode.window.showErrorMessage(
        'AI Config: could not remove every generated file.',
        'Show Details',
      );
      if (choice === 'Show Details') {
        this.logger.show();
      }
      return false;
    }

    this.logger.info(`Removed ${String(outcome.result.summary.deleted)} generated file(s).`);
    return true;
  }

  private async reportBlocked(diagnostics: readonly Diagnostic[]): Promise<void> {
    if (diagnostics.some((diagnostic) => diagnostic.code === 'ORPHAN_MODIFIED')) {
      // Never offer to overwrite here: an orphan has no canonical source, so
      // removing it would be unrecoverable. The user has to decide.
      const choice = await vscode.window.showWarningMessage(
        'AI Config: a generated file is no longer produced by any provider but has been edited, so it was left alone.',
        'Show Details',
      );
      if (choice === 'Show Details') {
        this.logger.show();
      }
      return;
    }

    if (diagnostics.some((diagnostic) => diagnostic.code === 'DRIFT_BLOCKS_WRITE')) {
      const choice = await vscode.window.showWarningMessage(
        'AI Config: some generated files were modified outside AI Config.',
        'Show Details',
        'Overwrite Changes',
      );
      if (choice === 'Show Details') {
        this.logger.show();
      } else if (choice === 'Overwrite Changes') {
        // Queued rather than awaited: this runs inside the chain already, so
        // awaiting another chained operation would deadlock.
        void this.synchronize({ force: true });
      }
      return;
    }

    const blocking = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    // A diagnostic that names a canonical file can be opened directly. Offered
    // first because acting on the problem is more useful than reading the log.
    const actions =
      blocking?.source === undefined ? ['Show Details'] : ['Go to File', 'Show Details'];
    const choice = await vscode.window.showErrorMessage(
      `AI Config: ${blocking?.message ?? 'synchronization was blocked.'}`,
      ...actions,
    );
    if (choice === 'Show Details') {
      this.logger.show();
    } else if (choice === 'Go to File' && blocking?.source !== undefined) {
      await this.reveal(blocking.source, blocking.line, blocking.column);
    }
  }

  /**
   * Opens a canonical source file at the position a diagnostic reports.
   *
   * Core reports 1-based positions because that is what the CLI prints; VS Code
   * positions are 0-based.
   */
  private async reveal(source: string, line?: number, column?: number): Promise<void> {
    const root = this.root;
    if (root === undefined) {
      return;
    }

    const uri = vscode.Uri.file(path.join(root, ...source.split('/')));
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const position = new vscode.Position(
        Math.max(0, (line ?? 1) - 1),
        Math.max(0, (column ?? 1) - 1),
      );
      await vscode.window.showTextDocument(document, {
        selection: new vscode.Range(position, position),
      });
    } catch (error) {
      this.logger.error(`Could not open '${source}'.`, error);
      void vscode.window.showErrorMessage(`AI Config: could not open '${source}'.`);
    }
  }

  /**
   * Restores one drifted file to its generated content.
   *
   * Scoped to a single path on purpose: the command is an inline action on one
   * tree item labelled "Restore Generated File". Running a repository-wide
   * forced sync from it would overwrite every drifted file at once, which is
   * not what the affordance promises.
   */
  public async restoreFile(relativePath: string): Promise<void> {
    const root = this.root;
    const analysis = this.analysis;
    if (root === undefined || analysis === undefined) {
      return;
    }

    const stillGenerated = analysis.artifacts.some((artifact) => artifact.path === relativePath);
    if (!stillGenerated) {
      void vscode.window.showWarningMessage(
        `AI Config: '${relativePath}' is no longer generated, so there is nothing to restore.`,
      );
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Replace '${relativePath}' with the version AI Config generates? Your changes to that file will be lost.`,
      { modal: true },
      'Restore',
    );
    if (confirmed !== 'Restore') {
      return;
    }

    await this.enqueue(async () => {
      const outcome = await restore(this.fileSystem, root, this.adapters, [relativePath]);

      if (!outcome.ok) {
        this.logger.error(`Could not restore '${relativePath}'.`);
        for (const diagnostic of outcome.diagnostics) {
          this.logger.info(`  ${diagnostic.code} ${diagnostic.message}`);
        }
        void vscode.window.showErrorMessage(
          `AI Config: could not restore '${relativePath}'. See the AI Config output.`,
        );
      } else {
        this.logger.info(`Restored ${relativePath}.`);
      }

      await this.loadAndPublish();
    });
  }

  public async initialize(): Promise<void> {
    const folder = await pickFolderToInitialize();
    if (folder === undefined) {
      void vscode.window.showWarningMessage('AI Config: open a folder before initializing.');
      return;
    }

    const providers = await pickProviders(this.adapters);
    if (providers === undefined) {
      return;
    }

    if (!(await this.confirmUntrackedProviderFiles(folder, providers))) {
      return;
    }

    const result = await init(this.fileSystem, folder, {
      providers,
      adapters: this.adapters,
      version: this.version,
    });
    if (!result.ok) {
      void vscode.window.showWarningMessage(
        `AI Config: ${result.diagnostics[0]?.message ?? 'could not initialize.'}`,
      );
      return;
    }

    this.logger.info(`Initialized ${folder}.`);
    await this.enqueue(async () => {
      this.root = folder;
      this.installWatcher();
      await this.runRefresh();
    });

    const configuration = vscode.Uri.file(path.join(folder, '.ai', 'config.yaml'));
    await vscode.window.showTextDocument(configuration);
  }

  /**
   * Warns before initializing a project that already contains provider files.
   *
   * This is the state a repository is left in when `.ai/` is deleted, and the
   * one an existing Claude Code or Copilot setup starts from. AI Config takes
   * none of those files: without `.ai/.generated.json` it cannot prove it wrote
   * any of them, and identical content would prove nothing either. They stay
   * the user's, they are never overwritten or removed, and synchronization will
   * report them as `UNTRACKED_TARGET_EXISTS` conflicts until the user resolves
   * them by hand. Saying so before `.ai/` exists is the only honest moment:
   * afterwards the conflicts arrive with no explanation of where they came
   * from.
   *
   * Returns whether initialization should go ahead.
   */
  private async confirmUntrackedProviderFiles(
    folder: string,
    providers: readonly ProviderId[],
  ): Promise<boolean> {
    const selected = this.adapters.filter((adapter) => providers.includes(adapter.id));
    const existing = await findExistingProviderTargets(this.fileSystem, folder, selected);

    if (existing.length === 0) {
      return true;
    }

    this.logger.info(`Existing provider files in ${folder}, which AI Config will not touch:`);
    for (const entry of existing) {
      this.logger.info(`  ${entry}`);
    }

    const choice = await vscode.window.showWarningMessage(
      'AI Config: this project already contains provider files.',
      {
        modal: true,
        detail: `${existing.join('\n')}\n\nAI Config has no ownership record for this project, so it cannot tell whether it wrote these files. They stay yours: they will not be overwritten, deleted or adopted, and synchronizing will report them as conflicts until you move or remove them yourself.\n\nThe same list is in the AI Config output.`,
      },
      'Initialize Anyway',
      'Show Details',
    );

    if (choice === 'Show Details') {
      // Cancels: reviewing those files and initializing on top of them are not
      // things to do at the same time. The output stays open for the review.
      this.logger.show();
      void vscode.window.showInformationMessage(
        'AI Config: initialization cancelled. Run it again once you have reviewed those files.',
      );
      return false;
    }

    return choice === 'Initialize Anyway';
  }

  /**
   * The context the guided flows run against.
   *
   * `refresh` is queued rather than awaited inside the chain: a wizard runs
   * outside `enqueue` because it waits on the user, and re-entering the chain
   * from inside it would deadlock.
   */
  private wizardContext(root: string): OverrideWizardContext {
    return {
      root,
      fileSystem: this.fileSystem,
      adapters: this.adapters,
      enabled: this.analysis?.project.enabled ?? [],
      refresh: () => this.refresh(),
    };
  }

  /** The four guided Add Artifact flows. */
  public async addArtifact(kind: SourceKind): Promise<void> {
    await this.resolveDeferredRootChoice();

    const root = this.root;
    if (root === undefined || this.analysis === undefined) {
      void vscode.window.showWarningMessage(
        'AI Config: initialize this workspace before adding configuration.',
      );
      return;
    }

    const context = this.wizardContext(root);
    switch (kind) {
      case 'instruction':
        return addInstruction(context);
      case 'agent':
        return addAgent(context);
      case 'skill':
        return addSkill(context);
      case 'command':
        return addCommand(context);
    }
  }

  /**
   * Adds a provider override to an artifact that already exists.
   *
   * Only providers with real options for this artifact are offered, and one
   * that already has an override is left out — editing that one is what the
   * override's own Edit action is for.
   */
  /** Opens the canonical file, which is where an artifact is edited. */
  public async editArtifact(file: string): Promise<void> {
    const root = this.root;
    if (root === undefined) {
      return;
    }
    await openFile(root, file);
  }

  /**
   * Deletes a canonical artifact and every override written for it.
   *
   * The overrides go with it because they cannot outlive it: an override whose
   * target no longer exists refines nothing, and is reported as
   * `OVERRIDE_TARGET_MISSING` on every run until someone deletes it. Deleting
   * the canonical file by hand leaves exactly that behind, and this action is
   * what makes doing it completely a single click.
   *
   * The generated provider files are not deleted here. The synchronization that
   * follows removes them as orphans, which verifies each one still holds the
   * bytes AI Config wrote before removing it — so a generated file somebody had
   * edited is reported rather than discarded.
   */
  public async deleteArtifact(kind: SourceKind, name: string): Promise<void> {
    const root = this.root;
    if (root === undefined) {
      return;
    }

    if (!(await askToRemoveArtifact(kind, name))) {
      return;
    }

    await this.enqueue(async () => {
      const outcome = await removeArtifact(this.fileSystem, root, kind, name);
      if (!outcome.ok) {
        void vscode.window.showWarningMessage(
          `AI Config: ${outcome.diagnostics[0]?.message ?? `the ${kind} could not be deleted.`}`,
        );
        return;
      }
      for (const removed of outcome.removed) {
        this.logger.info(`Deleted ${removed}`);
      }
      // Synchronizing here rather than leaving it to the watcher: the generated
      // files are stale the instant the source is gone, and the view should not
      // show them as belonging to something that no longer exists.
      await this.runSync();
      await this.loadAndPublish();
    });
  }

  public async addOverride(kind: SourceKind, name: string): Promise<void> {
    const root = this.root;
    const analysis = this.analysis;
    if (root === undefined || analysis === undefined) {
      return;
    }

    const target = targetFor(analysis.project.configuration, kind, name);
    if (target === undefined) {
      return;
    }

    const existing = new Set(
      [...analysis.project.overlays.values()]
        .filter((overlay) =>
          overlay.overrides.some((override) => override.kind === kind && override.id === name),
        )
        .map((overlay) => overlay.provider),
    );

    const candidates = candidatesFor(this.adapters, analysis.project.enabled, target).filter(
      (candidate) => !existing.has(candidate.adapter.id),
    );

    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(
        `AI Config: no provider-specific options are available for this ${kind}.`,
      );
      return;
    }

    const chosen = await vscode.window.showQuickPick(
      candidates.map((candidate) => ({
        label: candidate.adapter.displayName,
        description: candidate.adapter.id,
        detail: `${String(candidate.schema.fields.length)} ${candidate.adapter.displayName}-specific setting${candidate.schema.fields.length === 1 ? '' : 's'}`,
      })),
      {
        title: `Customize this ${kind} for one provider`,
        placeHolder: CUSTOMIZE_DETAIL,
        ignoreFocusOut: true,
      },
    );
    if (chosen === undefined) {
      return;
    }

    const candidate = candidates.find((entry) => entry.adapter.id === chosen.description);
    if (candidate === undefined) {
      return;
    }

    await this.scaffoldOverride(root, candidate, target);
  }

  /** Asks which settings to scaffold, writes the template, and opens it. */
  private async scaffoldOverride(
    root: string,
    candidate: OverrideCandidate,
    target: OverrideTarget,
  ): Promise<void> {
    const fields = await askFields(candidate.schema, candidate.adapter.displayName);
    if (cancelled(fields)) {
      return;
    }
    if (fields.length === 0) {
      void vscode.window.showInformationMessage(
        `AI Config: nothing was selected, so no ${candidate.adapter.displayName} override was created for '${target.name}'.`,
      );
      return;
    }

    const context = this.wizardContext(root);
    const created = await writeOverrides(context, target, [{ candidate, fields }]);
    await this.refresh();

    for (const createdPath of created) {
      await openFile(root, createdPath);
    }
  }

  /**
   * Opens an existing override for editing.
   *
   * Once an override exists the YAML file is the editing surface: it carries
   * every supported setting, its own documentation, and whatever the author has
   * already written. Reconstructing that as a sequence of questions could only
   * show less, and would have to overwrite the file to save an answer.
   *
   * This is why there is one action and not two. An earlier **Open Override**
   * sat beside **Edit Override** doing exactly the same thing, which asked the
   * reader to look for a difference that was never there.
   */
  public async editOverride(provider: ProviderId, kind: SourceKind, name: string): Promise<void> {
    const root = this.root;
    if (root === undefined) {
      return;
    }
    await openOverrideFile(root, provider, kind, name);
  }

  public async removeOverride(provider: ProviderId, kind: SourceKind, name: string): Promise<void> {
    const root = this.root;
    if (root === undefined) {
      return;
    }

    const relativePath = overridePath(provider, kind, name);
    const confirmed = await vscode.window.showWarningMessage(
      `Remove '${relativePath}'? The canonical ${kind} '${name}' is not changed, and stays compiled to every enabled provider.`,
      { modal: true },
      'Remove',
    );
    if (confirmed !== 'Remove') {
      return;
    }

    await this.enqueue(async () => {
      const outcome = await removeOverride(this.fileSystem, root, provider, kind, name);
      if (!outcome.ok) {
        void vscode.window.showWarningMessage(
          `AI Config: ${outcome.diagnostics[0]?.message ?? 'the override could not be removed.'}`,
        );
      }
      await this.loadAndPublish();
    });
  }

  /** The content a generated file would have, for the diff editor. */
  public async generatedContent(relativePath: string): Promise<string | undefined> {
    const root = this.root;
    const analysis = this.analysis;
    if (root === undefined || analysis === undefined) {
      return undefined;
    }

    const artifact: CompiledArtifact | undefined = analysis.artifacts.find(
      (candidate) => candidate.path === relativePath,
    );
    if (artifact === undefined) {
      return undefined;
    }

    try {
      const resolved = await resolveContent(
        this.fileSystem,
        root,
        artifact.content,
        indexSkillFiles(analysis.project.configuration),
      );
      return resolved.bytes.toString('utf8');
    } catch (error) {
      this.logger.error(`Could not render the generated version of '${relativePath}'.`, error);
      return undefined;
    }
  }

  private installWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;

    const root = this.root;
    if (root === undefined) {
      return;
    }

    // Only `.ai/` is watched. Watching generated output would create a loop, and
    // provider directories are not the source of truth.
    const pattern = new vscode.RelativePattern(vscode.Uri.file(root), WATCHED_GLOB);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const onChange = (uri: vscode.Uri): void => {
      if (!isRelevantChange(root, uri.fsPath)) {
        return;
      }
      this.scheduleRefresh();
    };

    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);

    this.watcher = watcher;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      // Deliberately not `refresh()`: a filesystem event must never raise a
      // workspace prompt.
      void this.enqueue(() => this.runRefresh());
    }, REFRESH_DEBOUNCE_MS);
  }

  /**
   * Adding or removing a workspace folder is not an AI Config action either, so
   * this too re-resolves silently.
   */
  public async reselectWorkspace(): Promise<void> {
    await this.enqueue(() => this.runRefresh());
  }

  public dispose(): void {
    this.disposed = true;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.watcher?.dispose();
    this.tree.dispose();
    this.diagnostics.dispose();
    this.statusBar.dispose();
  }
}

const summarize = (analysis: AnalysisResult): string => {
  const { configuration } = analysis.project;
  return `${String(configuration.instructions.length)} instructions, ${String(configuration.agents.length)} agents, ${String(configuration.skills.length)} skills, ${String(configuration.commands.length)} commands`;
};
