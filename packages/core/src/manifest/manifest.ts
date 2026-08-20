import type { Diagnostic } from '../domain/diagnostic.js';
import type { FileSystem } from '../fs/file-system.js';
import { checkGeneratedPath, resolveWithinRoot } from '../path/safe-path.js';
import { isPlainObject, isStringArray } from '../parse/yaml.js';

export const MANIFEST_PATH = '.ai/.generated.json';
export const MANIFEST_VERSION = 1;

export interface ManifestEntry {
  /** Repository-relative POSIX path of a generated file. */
  readonly path: string;
  /**
   * Provider identifiers that own the file.
   *
   * Deliberately plain strings, not the closed `ProviderId` union: a manifest
   * written by a newer AI Config that knows a fifth provider must stay
   * readable. Failing to parse it would make AI Config believe it owns nothing
   * and block every path as untracked.
   */
  readonly providers: readonly string[];
  /** Canonical source, e.g. `agents/reviewer`, or `null` for aggregates. */
  readonly source: string | null;
  readonly hash: string;
  readonly ownership?: 'managed' | 'external';
  readonly extension?: string | null;
  readonly executable?: boolean;
}

export interface Manifest {
  readonly version: number;
  readonly entries: readonly ManifestEntry[];
}

export const EMPTY_MANIFEST: Manifest = { version: MANIFEST_VERSION, entries: [] };

export interface ManifestReadResult {
  readonly manifest: Manifest;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Reads the generated-file manifest.
 *
 * A missing, unreadable or malformed manifest yields an empty manifest with a
 * warning. Failing this way means AI Config owns nothing, so it refuses to
 * overwrite existing provider files rather than deleting them: the cost is lost
 * cleanup, never lost user data.
 *
 * A manifest from a *future* format version is an error instead, because
 * proceeding could delete files whose ownership semantics changed.
 */
export const readManifest = async (
  fileSystem: FileSystem,
  root: string,
): Promise<ManifestReadResult> => {
  const content = await fileSystem.readFile(resolveWithinRoot(root, MANIFEST_PATH));
  if (content === undefined) {
    return { manifest: EMPTY_MANIFEST, diagnostics: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8')) as unknown;
  } catch {
    return { manifest: EMPTY_MANIFEST, diagnostics: [unreadable('it is not valid JSON')] };
  }

  if (!isPlainObject(parsed)) {
    return { manifest: EMPTY_MANIFEST, diagnostics: [unreadable('it is not a JSON object')] };
  }

  const version = parsed['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return {
      manifest: EMPTY_MANIFEST,
      diagnostics: [unreadable(`'version' is missing or invalid`)],
    };
  }
  if (version > MANIFEST_VERSION) {
    return {
      manifest: EMPTY_MANIFEST,
      diagnostics: [
        {
          code: 'UNSUPPORTED_MANIFEST_VERSION',
          severity: 'error',
          message: `${MANIFEST_PATH} was written by a newer version of AI Config (manifest version ${String(version)}; this version supports ${String(MANIFEST_VERSION)}). Upgrade AI Config rather than risking deletion of files it no longer understands.`,
          source: MANIFEST_PATH,
        },
      ],
    };
  }

  const rawEntries = parsed['entries'];
  if (!Array.isArray(rawEntries)) {
    return {
      manifest: EMPTY_MANIFEST,
      diagnostics: [unreadable(`'entries' is missing or invalid`)],
    };
  }

  const entries: ManifestEntry[] = [];
  for (const raw of rawEntries) {
    const entry = parseEntry(raw);
    if (entry === undefined) {
      return {
        manifest: EMPTY_MANIFEST,
        diagnostics: [unreadable('it contains a malformed entry')],
      };
    }
    entries.push(entry);
  }

  return { manifest: { version, entries: sortEntries(entries) }, diagnostics: [] };
};

const unreadable = (reason: string): Diagnostic => ({
  code: 'MANIFEST_UNREADABLE',
  severity: 'warning',
  message: `Ignoring ${MANIFEST_PATH} because ${reason}. AI Config will not modify existing provider files until it is regenerated.`,
  source: MANIFEST_PATH,
});

const parseEntry = (raw: unknown): ManifestEntry | undefined => {
  if (!isPlainObject(raw)) {
    return undefined;
  }

  const path = raw['path'];
  const providers = raw['providers'];
  const source = raw['source'];
  const hash = raw['hash'];
  const ownership = raw['ownership'] ?? 'managed';
  const extension = raw['extension'] ?? null;
  const executable = raw['executable'] ?? false;

  if (typeof path !== 'string' || !checkGeneratedPath(path).ok) {
    return undefined;
  }
  if (!isStringArray(providers)) {
    return undefined;
  }
  if (source !== null && typeof source !== 'string') {
    return undefined;
  }
  if (typeof hash !== 'string' || hash.length === 0) {
    return undefined;
  }
  if (
    (ownership !== 'managed' && ownership !== 'external') ||
    (extension !== null && typeof extension !== 'string') ||
    typeof executable !== 'boolean'
  )
    return undefined;

  return {
    path,
    providers: [...providers].sort(),
    source,
    hash,
    ownership,
    extension,
    executable,
  };
};

const sortEntries = (entries: readonly ManifestEntry[]): readonly ManifestEntry[] =>
  [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** Serializes a manifest deterministically, with a trailing newline. */
export const serializeManifest = (manifest: Manifest): string => {
  const payload = {
    version: manifest.version,
    entries: sortEntries(manifest.entries).map((entry) => ({
      path: entry.path,
      providers: [...entry.providers].sort(),
      source: entry.source,
      hash: entry.hash,
      ownership: entry.ownership,
      extension: entry.extension,
      executable: entry.executable,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
};

export const manifestIndex = (manifest: Manifest): ReadonlyMap<string, ManifestEntry> =>
  new Map(manifest.entries.map((entry) => [entry.path, entry]));
