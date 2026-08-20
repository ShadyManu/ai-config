import type { Diagnostic } from '../domain/diagnostic.js';
import type { ProviderId } from '../domain/provider.js';
import { PROVIDER_IDS } from '../domain/provider.js';
import type { FileSystem } from '../fs/file-system.js';
import { CONFIG_PATH, SUPPORTED_SCHEMA_VERSION, parseConfig } from '../parse/config.js';
import { decodeSourceText } from '../parse/text.js';
import { resolveWithinRoot } from '../path/safe-path.js';

export type ProviderToggleOutcome =
  | { readonly ok: true; readonly providers: readonly ProviderId[]; readonly changed: boolean }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Rewrites `providers.enabled` in place.
 *
 * A targeted line splice rather than a re-serialization, so the comment header
 * `init` writes and anything else the user added survive. Comments and sibling
 * keys inside the `providers` block are stepped over rather than treated as a
 * dead end: they are exactly the content the fallback would destroy, so letting
 * them force the fallback defeated the point of splicing at all.
 *
 * The result is parsed back and checked against the intended set; if the splice
 * could not find its anchors the whole file is re-rendered instead, which loses
 * comments but can never produce a `config.yaml` that means something other
 * than what was asked.
 */
export const withProviders = (text: string, providers: readonly ProviderId[]): string => {
  const wanted = [...new Set(providers)].sort();
  const spliced = splice(text, wanted);
  if (spliced !== undefined && matches(spliced, wanted)) {
    return spliced;
  }
  return render(text, wanted);
};

const matches = (text: string, wanted: readonly ProviderId[]): boolean => {
  const parsed = parseConfig(text, PROVIDER_IDS);
  if (parsed.config === undefined) {
    return false;
  }
  const actual = [...parsed.config.providers].sort();
  return actual.length === wanted.length && actual.every((id, index) => id === wanted[index]);
};

const PROVIDERS_KEY = /^providers\s*:\s*(.*)$/;
const ENABLED_KEY = /^(\s+)enabled\s*:\s*(.*)$/;
const LIST_ITEM = /^(\s*)-\s*(\S+)\s*$/;
const COMMENT = /^\s*#/;
const LEADING_SPACES = /^ */;

interface EnabledKey {
  readonly index: number;
  readonly indent: string;
}

const splice = (text: string, wanted: readonly ProviderId[]): string | undefined => {
  const lines = text.split('\n');

  const providersIndex = lines.findIndex((line) => PROVIDERS_KEY.test(line));
  if (providersIndex === -1) {
    return undefined;
  }

  const enabled = findEnabled(lines, providersIndex);
  if (enabled === undefined) {
    return undefined;
  }

  const end = endOfList(lines, enabled.index);
  const replacement =
    wanted.length === 0
      ? [`${enabled.indent}enabled: []`]
      : [`${enabled.indent}enabled:`, ...wanted.map((id) => `${enabled.indent}  - ${id}`)];

  return [...lines.slice(0, enabled.index), ...replacement, ...lines.slice(end)].join('\n');
};

/**
 * Locates `providers.enabled` within the block opening at `providersIndex`.
 *
 * Only a key at the block's own indentation is accepted. An `enabled:` nested
 * deeper belongs to some other key — `providers.settings.copilot.enabled`, for
 * instance — and rewriting that would change a setting no caller asked about.
 * Everything indented further is therefore skipped, not matched.
 *
 * Indentation is counted in spaces alone. A tab-indented file is not valid YAML
 * here, so treating it as unindented sends it down the re-render path, where
 * the parse-back check decides whether anything can be done with it at all.
 */
const findEnabled = (lines: readonly string[], providersIndex: number): EnabledKey | undefined => {
  let blockIndent: number | undefined;

  for (let index = providersIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0 || COMMENT.test(line)) {
      continue;
    }

    const indent = indentWidth(line);
    if (indent === 0) {
      // A key at the top level closes the `providers` block.
      return undefined;
    }

    blockIndent ??= indent;
    if (indent > blockIndent) {
      continue;
    }
    if (indent < blockIndent) {
      // Indented, yet shallower than the block's own keys: malformed enough
      // that a targeted edit cannot be trusted.
      return undefined;
    }

    const match = ENABLED_KEY.exec(line);
    if (match !== null) {
      return { index, indent: match[1] ?? '  ' };
    }
  }

  return undefined;
};

/**
 * Finds the first line after the `enabled` list.
 *
 * A blank or comment line belongs to the list only when another item follows;
 * otherwise it introduces whatever comes next and has to survive the splice. A
 * comment sitting between two items cannot: the list is rewritten from the
 * resolved set, so an annotation attached to one entry has nowhere left to go.
 */
const endOfList = (lines: readonly string[], enabledIndex: number): number => {
  let end = enabledIndex + 1;

  while (end < lines.length) {
    const line = lines[end] ?? '';
    if (LIST_ITEM.test(line)) {
      end += 1;
      continue;
    }
    if ((line.trim().length === 0 || COMMENT.test(line)) && hasMoreItems(lines, end + 1)) {
      end += 1;
      continue;
    }
    break;
  }

  return end;
};

const hasMoreItems = (lines: readonly string[], from: number): boolean => {
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0 || COMMENT.test(line)) {
      continue;
    }
    return LIST_ITEM.test(line);
  }
  return false;
};

const indentWidth = (line: string): number => LEADING_SPACES.exec(line)?.[0].length ?? 0;

const render = (text: string, wanted: readonly ProviderId[]): string => {
  const parsed = parseConfig(text, PROVIDER_IDS);
  const version = parsed.config?.schema ?? SUPPORTED_SCHEMA_VERSION;
  const lines = [`schema: ${String(version)}`, '', 'providers:'];
  if (wanted.length === 0) {
    lines.push('  enabled: []');
  } else {
    lines.push('  enabled:');
    for (const id of wanted) {
      lines.push(`    - ${id}`);
    }
  }
  lines.push('');
  return lines.join('\n');
};

/**
 * Enables a provider.
 *
 * No directory is created for it. `.ai/providers/<provider>/` appears when an
 * override is actually written there, for the same reason `init` creates none:
 * a directory in the tree says settings exist for that provider, and an empty
 * one says it while being false. Scaffolding an override creates the path it
 * needs, so nothing depends on the directory being there first.
 */
export const enableProvider = async (
  fileSystem: FileSystem,
  root: string,
  provider: ProviderId,
): Promise<ProviderToggleOutcome> => toggle(fileSystem, root, provider, true);

/** Disables a provider. Its override files under `.ai/providers/` are kept. */
export const disableProvider = async (
  fileSystem: FileSystem,
  root: string,
  provider: ProviderId,
): Promise<ProviderToggleOutcome> => toggle(fileSystem, root, provider, false);

const toggle = async (
  fileSystem: FileSystem,
  root: string,
  provider: ProviderId,
  enabled: boolean,
): Promise<ProviderToggleOutcome> => {
  const absolute = resolveWithinRoot(root, CONFIG_PATH);
  const content = await fileSystem.readFile(absolute);
  if (content === undefined) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'NOT_INITIALIZED',
          severity: 'error',
          message: `No ${CONFIG_PATH} found. Run 'aiconfig init' to create one.`,
          source: CONFIG_PATH,
        },
      ],
    };
  }

  const text = decodeSourceText(content);
  const parsed = parseConfig(text, PROVIDER_IDS);
  if (parsed.config === undefined) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }

  const current = new Set(parsed.config.providers);
  if (current.has(provider) === enabled) {
    return { ok: true, providers: [...current].sort(), changed: false };
  }

  if (enabled) {
    current.add(provider);
  } else {
    current.delete(provider);
  }
  const providers = [...current].sort();

  await fileSystem.writeFileAtomic(absolute, Buffer.from(withProviders(text, providers), 'utf8'));

  return { ok: true, providers, changed: true };
};
