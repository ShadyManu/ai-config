import * as path from 'node:path';
import * as vscode from 'vscode';

import type {
  AnalysisResult,
  PlanAction,
  ProviderAdapter,
  ProviderId,
  ProviderReport,
  SourceKind,
} from '@aiconfig/core';
import { overridePath, stateOf } from '@aiconfig/core';

import { candidatesFor, targetFor } from './wizards/overrides.js';

export const DRIFTED_FILE_CONTEXT = 'aiconfig.driftedFile';

/**
 * A canonical artifact row, and the same row when a provider could still
 * configure it.
 *
 * Two values rather than one, because the actions differ: Edit and Delete apply
 * to every artifact and are contributed against both, while **Add Provider
 * Override** matches only the second and disappears once every capable provider
 * already has one. The manifest lists both explicitly instead of matching a
 * prefix — a `when` clause that reads as what it means beats one that needs a
 * regular expression escaped through JSON.
 */
export const ITEM_CONTEXT = 'aiconfig.item';
export const OVERRIDABLE_ITEM_CONTEXT = `${ITEM_CONTEXT}.overridable`;

export const OVERRIDE_CONTEXT = 'aiconfig.override';

/**
 * A provider row, split by whether the project has the provider turned on.
 *
 * The two actions are mutually exclusive — a disabled provider can only be
 * enabled, an enabled one can only be removed — so each binds to its own
 * context value rather than to a shared one gated by a second condition the
 * manifest cannot express.
 */
export const PROVIDER_CONTEXT = 'aiconfig.provider';
export const ENABLED_PROVIDER_CONTEXT = `${PROVIDER_CONTEXT}.enabled`;
export const DISABLED_PROVIDER_CONTEXT = `${PROVIDER_CONTEXT}.disabled`;

export const CONTACT_URL = 'https://manuelraso.dev/contacts';

/** Label of the section the configuration-scoped commands act on. */
const CONFIGURATION_SECTION = 'Configuration';

/** Context value the configuration-scoped context menu binds to. */
export const CONFIGURATION_SECTION_CONTEXT = 'aiconfig.configurationSection';

export type Node =
  | { readonly kind: 'section'; readonly label: string }
  | {
      readonly kind: 'category';
      readonly label: string;
      readonly directory: string;
      readonly count: number;
    }
  | {
      readonly kind: 'item';
      readonly label: string;
      readonly file: string;
      readonly source: SourceKind;
      readonly overrides: readonly ProviderId[];
      /** True when at least one enabled provider could still be configured. */
      readonly overridable: boolean;
    }
  | {
      readonly kind: 'override';
      readonly provider: ProviderId;
      readonly displayName: string;
      readonly source: SourceKind;
      readonly name: string;
    }
  | { readonly kind: 'provider'; readonly provider: ProviderReport }
  | { readonly kind: 'file'; readonly action: PlanAction }
  | { readonly kind: 'contact' };

/** The artifact a tree-view command was invoked for. */
export const commandTargetItem = (target: unknown): Extract<Node, { kind: 'item' }> | undefined =>
  isNode(target) && target.kind === 'item' ? target : undefined;

/** The provider a tree-view command was invoked for. */
export const commandTargetProvider = (
  target: unknown,
): Extract<Node, { kind: 'provider' }> | undefined =>
  isNode(target) && target.kind === 'provider' ? target : undefined;

/** The override a tree-view command was invoked for. */
export const commandTargetOverride = (
  target: unknown,
): Extract<Node, { kind: 'override' }> | undefined =>
  isNode(target) && target.kind === 'override' ? target : undefined;

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && 'kind' in value;

type FileNode = Extract<Node, { kind: 'file' }>;

/**
 * The generated file a view command was invoked for, if any.
 *
 * A command reachable both from a tree item's own `command` and from a
 * `view/item/context` menu is called with two different arguments: clicking the
 * row passes whatever `TreeItem.command.arguments` declares, while an inline
 * menu action passes the *element* `getChildren` produced — VS Code never
 * consults `TreeItem.command` for menu contributions. Accepting only one of the
 * two shapes leaves the inline actions targeting nothing.
 */
export const commandTargetPath = (target: unknown): string | undefined => {
  if (typeof target === 'string') {
    return target;
  }
  return isFileNode(target) ? target.action.path : undefined;
};

const isFileNode = (value: unknown): value is FileNode =>
  typeof value === 'object' &&
  value !== null &&
  'kind' in value &&
  value.kind === 'file' &&
  'action' in value &&
  typeof value.action === 'object' &&
  value.action !== null &&
  'path' in value.action &&
  typeof value.action.path === 'string';

/**
 * The AI Config sidebar.
 *
 * Built from the same analysis the CLI uses, so what is shown here and what
 * `aiconfig status` reports cannot diverge.
 */
export class AiConfigTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;

  private analysis: AnalysisResult | undefined;
  private root: string | undefined;
  private adapters: readonly ProviderAdapter[] = [];

  /** Adapters are needed to know which providers can configure an artifact. */
  public setAdapters(adapters: readonly ProviderAdapter[]): void {
    this.adapters = adapters;
  }

  public update(root: string | undefined, analysis: AnalysisResult | undefined): void {
    this.root = root;
    this.analysis = analysis;
    this.changed.fire(undefined);
  }

  public dispose(): void {
    this.changed.dispose();
  }

  public getChildren(node?: Node): Node[] {
    const analysis = this.analysis;
    if (analysis === undefined) {
      return [];
    }

    if (node === undefined) {
      return [
        { kind: 'section', label: CONFIGURATION_SECTION },
        { kind: 'section', label: 'Providers' },
        { kind: 'contact' },
      ];
    }

    switch (node.kind) {
      case 'section':
        return node.label === CONFIGURATION_SECTION
          ? configurationCategories(analysis)
          : analysis.providers.map((provider) => ({ kind: 'provider' as const, provider }));

      case 'category':
        return configurationItems(analysis, this.adapters, node.directory);

      case 'provider':
        // Only files needing attention are listed; a fully synced provider does
        // not need every generated path enumerated.
        return node.provider.actions
          .filter((action) => stateOf(action) !== 'synced')
          .map((action) => ({ kind: 'file' as const, action }));

      case 'item':
        return node.overrides.map((provider) => ({
          kind: 'override' as const,
          provider,
          displayName:
            this.adapters.find((adapter) => adapter.id === provider)?.displayName ?? provider,
          source: node.source,
          name: node.label,
        }));

      case 'override':
      case 'file':
      case 'contact':
        return [];
    }
  }

  public getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'section': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        // Only the configuration section carries the destructive actions, so it
        // needs a context value the menu can distinguish from other sections.
        item.contextValue =
          node.label === CONFIGURATION_SECTION ? CONFIGURATION_SECTION_CONTEXT : 'aiconfig.section';
        return item;
      }

      case 'category': {
        const item = new vscode.TreeItem(
          node.label,
          node.count === 0
            ? vscode.TreeItemCollapsibleState.None
            : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = String(node.count);
        item.iconPath = new vscode.ThemeIcon('folder');
        return item;
      }

      case 'item': {
        const item = new vscode.TreeItem(
          node.label,
          // Collapsible only when there is something inside, so a project with
          // no overrides looks exactly as it did before.
          node.overrides.length === 0
            ? vscode.TreeItemCollapsibleState.None
            : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon('file');
        item.resourceUri = this.uriFor(node.file);
        // Two context values, one a suffix of the other: Edit and Delete are
        // contributed against the prefix and are always offered, while "Add
        // Provider Override" matches only the longer one and disappears once
        // every capable provider already has one.
        item.contextValue = node.overridable ? OVERRIDABLE_ITEM_CONTEXT : ITEM_CONTEXT;
        item.command = {
          command: 'vscode.open',
          title: 'Open',
          arguments: [this.uriFor(node.file)],
        };
        return item;
      }

      case 'override': {
        const relativePath = overridePath(node.provider, node.source, node.name);
        const item = new vscode.TreeItem(
          `${node.displayName} override`,
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('settings-gear');
        item.resourceUri = this.uriFor(relativePath);
        item.contextValue = OVERRIDE_CONTEXT;
        item.tooltip = `${relativePath}\n\nProvider-specific settings only. '${node.name}' is still compiled to every enabled provider.`;
        item.command = {
          command: 'vscode.open',
          title: 'Edit Override',
          arguments: [this.uriFor(relativePath)],
        };
        return item;
      }

      case 'provider': {
        const { provider } = node;
        const hasDetail = provider.actions.some((action) => stateOf(action) !== 'synced');
        const item = new vscode.TreeItem(
          provider.displayName,
          hasDetail
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        item.description = `${provider.status}${provider.enabled ? ` · ${String(provider.fileCount)}` : ''}`;
        item.iconPath = providerIcon(provider);
        item.contextValue = provider.enabled ? ENABLED_PROVIDER_CONTEXT : DISABLED_PROVIDER_CONTEXT;
        item.tooltip = providerTooltip(provider, this.analysis?.diagnostics ?? []);
        return item;
      }

      case 'file': {
        const { action } = node;
        const state = stateOf(action);
        const item = new vscode.TreeItem(action.path, vscode.TreeItemCollapsibleState.None);
        item.description = `${state}${action.executable === true ? ' · executable' : ''}`;
        item.resourceUri = this.uriFor(action.path);
        item.iconPath = new vscode.ThemeIcon(
          state === 'drift' ? 'diff-modified' : 'circle-outline',
        );

        if (state === 'drift') {
          // Only a drifted file has both a generated version to compare against
          // and a restore that makes sense.
          item.contextValue = DRIFTED_FILE_CONTEXT;
          item.command = {
            command: 'aiconfig.showDiff',
            title: 'Show Diff',
            arguments: [action.path],
          };
        }

        return item;
      }

      case 'contact': {
        const item = new vscode.TreeItem(
          'Found a bug or have a suggestion? Get in touch →',
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('arrow-right');
        item.tooltip = 'Get in touch';
        item.command = {
          command: 'vscode.open',
          title: 'Get in touch',
          arguments: [vscode.Uri.parse(CONTACT_URL)],
        };
        return item;
      }
    }
  }

  private uriFor(relativePath: string): vscode.Uri {
    const root = this.root ?? '';
    return vscode.Uri.file(path.join(root, ...relativePath.split('/')));
  }
}

/**
 * Alphabetical, matching the **Add** menu and `.ai/` itself on disk.
 *
 * Any order is arbitrary; only one is the same everywhere the four kinds are
 * listed, which is what lets a reader find one without scanning.
 */
const configurationCategories = (analysis: AnalysisResult): Node[] => {
  const { configuration } = analysis.project;
  return [
    { kind: 'category', label: 'Agents', directory: 'agents', count: configuration.agents.length },
    {
      kind: 'category',
      label: 'Commands',
      directory: 'commands',
      count: configuration.commands.length,
    },
    {
      kind: 'category',
      label: 'Instructions',
      directory: 'instructions',
      count: configuration.instructions.length,
    },
    { kind: 'category', label: 'Skills', directory: 'skills', count: configuration.skills.length },
  ];
};

const KIND_BY_DIRECTORY: Readonly<Record<string, SourceKind>> = {
  instructions: 'instruction',
  agents: 'agent',
  skills: 'skill',
  commands: 'command',
};

const configurationItems = (
  analysis: AnalysisResult,
  adapters: readonly ProviderAdapter[],
  directory: string,
): Node[] => {
  const { configuration } = analysis.project;
  const kind = KIND_BY_DIRECTORY[directory];
  if (kind === undefined) {
    return [];
  }

  const entries: { readonly name: string; readonly file: string }[] =
    kind === 'instruction'
      ? configuration.instructions.map((item) => ({ name: item.name, file: item.sourcePath }))
      : kind === 'agent'
        ? configuration.agents.map((item) => ({ name: item.name, file: item.sourcePath }))
        : kind === 'skill'
          ? configuration.skills.map((item) => ({
              name: item.name,
              file: `${item.sourcePath}/SKILL.md`,
            }))
          : configuration.commands.map((item) => ({ name: item.name, file: item.sourcePath }));

  return entries.map((entry) => {
    const overrides = [...analysis.project.overlays.values()]
      .filter((overlay) =>
        overlay.overrides.some((override) => override.kind === kind && override.id === entry.name),
      )
      .map((overlay) => overlay.provider)
      .sort();

    const target = targetFor(configuration, kind, entry.name);
    const remaining =
      target === undefined
        ? []
        : candidatesFor(adapters, analysis.project.enabled, target).filter(
            (candidate) => !overrides.includes(candidate.adapter.id),
          );

    return {
      kind: 'item' as const,
      label: entry.name,
      file: entry.file,
      source: kind,
      overrides,
      overridable: remaining.length > 0,
    };
  });
};

const providerIcon = (provider: ProviderReport): vscode.ThemeIcon => {
  switch (provider.status) {
    case 'synced':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    case 'warning':
      return new vscode.ThemeIcon('info');
    case 'pending':
      return new vscode.ThemeIcon('sync');
    case 'drift':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    case 'conflict':
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'disabled':
      return new vscode.ThemeIcon('circle-slash');
  }
};

const providerTooltip = (
  provider: ProviderReport,
  diagnostics: readonly AnalysisResult['diagnostics'][number][],
): string => {
  const capability = diagnostics.filter(
    (diagnostic) => diagnostic.provider === provider.id && diagnostic.capability !== undefined,
  );
  const detail = capability
    .map(
      (diagnostic) =>
        `${diagnostic.capability}: ${diagnostic.source ?? 'provider'} — ${diagnostic.message}`,
    )
    .join('\n');
  const suffix = detail === '' ? '' : `\n\nCapability details:\n${detail}`;
  switch (provider.status) {
    case 'synced':
      return `Up to date.${suffix}`;
    case 'warning':
      return `Up to date, with compatibility notes.${suffix}`;
    case 'pending':
      return `Changes are waiting to be synchronized.${suffix}`;
    case 'drift':
      return `A generated file was modified outside AI Config.${suffix}`;
    case 'conflict':
      return `A target file exists that AI Config does not own.${suffix}`;
    case 'error':
      return `Compilation reported an error.${suffix}`;
    case 'disabled':
      return `Disabled in .ai/config.yaml.${suffix}`;
  }
};
