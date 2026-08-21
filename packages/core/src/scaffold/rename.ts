import type { SourceKind } from '../domain/configuration.js';
import { sourceDirectory } from '../domain/configuration.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import { compareStrings } from '../domain/ordering.js';
import type { FileSystem } from '../fs/file-system.js';
import { AI_DIRECTORY, SKILL_ENTRYPOINT } from '../parse/discover.js';
import { findFrontmatterKeyLine, parseFrontmatter } from '../parse/frontmatter.js';
import { checkName, nameFromFilename } from '../parse/name.js';
import { decodeSourceFile } from '../parse/text.js';
import { resolveWithinRoot } from '../path/safe-path.js';

const PROVIDERS_ROOT = `${AI_DIRECTORY}/providers`;

/** One path this operation moved. */
export interface RenamedPath {
  readonly from: string;
  readonly to: string;
}

export type RenameOutcome =
  | { readonly ok: true; readonly moved: readonly RenamedPath[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** A canonical artifact whose declared name and location disagree. */
export interface NameMismatch {
  readonly kind: SourceKind;
  /** The name taken from the file or directory. */
  readonly pathName: string;
  /** The name written in the frontmatter. */
  readonly declaredName: string;
  /** The file the `name` field is in. */
  readonly sourcePath: string;
}

const error = (code: Diagnostic['code'], message: string, source: string): Diagnostic => ({
  code,
  severity: 'error',
  message,
  source,
});

/**
 * Where a canonical artifact lives, and where its name is written down.
 *
 * A skill is a directory whose name is the artifact's, with the name repeated
 * inside `SKILL.md`; everything else is a single file whose stem is the name,
 * with an optional `name` field inside it. One concept, two layouts.
 */
const locate = (
  kind: SourceKind,
  name: string,
): { readonly path: string; readonly entrypoint: string } => {
  const base = `${AI_DIRECTORY}/${sourceDirectory(kind)}/${name}`;
  return kind === 'skill'
    ? { path: base, entrypoint: `${base}/${SKILL_ENTRYPOINT}` }
    : { path: `${base}.md`, entrypoint: `${base}.md` };
};

/**
 * Renames a canonical artifact, and everything that was named after it.
 *
 * Changing `name` in the frontmatter used to be unrecoverable in practice: the
 * field and the path disagreed, `NAME_MISMATCH` dropped the artifact from the
 * configuration, and the author had to rename the file, rename the directory
 * and rename every override by hand to get back to a valid project. All of that
 * is one operation here, because it was always one intention.
 *
 * Provider overrides move with it. An override is addressed by the artifact's
 * name — `.ai/providers/claude/skills/<name>.yaml` — so leaving one behind
 * would silently stop it applying and then report it as refining nothing.
 *
 * Nothing moves until every move has been checked, so a rename that cannot
 * complete leaves the project exactly as it was rather than half renamed.
 */
export const renameArtifact = async (
  fileSystem: FileSystem,
  root: string,
  kind: SourceKind,
  from: string,
  to: string,
): Promise<RenameOutcome> => {
  const source = locate(kind, from);
  const target = locate(kind, to);

  for (const [name, where] of [
    [from, source.path],
    [to, target.path],
  ] as const) {
    const check = checkName(name);
    if (!check.ok) {
      // A name is also a path segment. Refusing it here keeps a crafted one
      // from reaching the path guard as an exception.
      return {
        ok: false,
        diagnostics: [error('INVALID_NAME', `Invalid name '${name}': ${check.reason}.`, where)],
      };
    }
  }

  if (from === to) {
    // Not an error: the caller asked for the name to be `to`, and it is. The
    // frontmatter is still aligned, which is the half that may be out of step.
    await alignFrontmatterName(fileSystem, root, source.entrypoint, to);
    return { ok: true, moved: [] };
  }

  if (!(await fileSystem.exists(resolveWithinRoot(root, source.path)))) {
    return {
      ok: false,
      diagnostics: [
        error(
          'RENAME_SOURCE_MISSING',
          `There is no ${kind} named '${from}' to rename: '${source.path}' does not exist.`,
          source.path,
        ),
      ],
    };
  }

  const moves: readonly RenamedPath[] = [
    { from: source.path, to: target.path },
    ...(await overrideMoves(fileSystem, root, kind, from, to)),
  ];

  const blocked = await firstOccupied(fileSystem, root, moves);
  if (blocked !== undefined) {
    return {
      ok: false,
      diagnostics: [
        error(
          'RENAME_TARGET_EXISTS',
          `'${blocked}' already exists, so '${from}' cannot be renamed to '${to}'. Choose another name, or remove what is already there.`,
          blocked,
        ),
      ],
    };
  }

  for (const move of moves) {
    await fileSystem.rename(resolveWithinRoot(root, move.from), resolveWithinRoot(root, move.to));
  }

  // Last, and against the moved file: the field has to agree with where the
  // artifact now is, whichever of the two the author actually edited.
  await alignFrontmatterName(fileSystem, root, target.entrypoint, to);

  return { ok: true, moved: moves };
};

/**
 * Completes a rename whose canonical file has already moved.
 *
 * The other half of {@link renameArtifact}. When the author renamed the file or
 * the directory themselves — in the explorer, or with `git mv` — the artifact is
 * already at `to` and nothing needs moving there. Two things are still at `from`
 * and would be lost: the `name` field inside the file, which now disagrees with
 * where the file is, and every provider override, which is addressed by name.
 *
 * Overriding an artifact and then renaming its file used to delete the override.
 * Nothing noticed the rename, so the override refined an artifact that no longer
 * existed, and older synchronization removed it as an orphan — silently
 * destroying a file the author had written. That is what `from` is for; the
 * current synchronization also preserves an orphan when no rename is known.
 */
export const alignArtifactName = async (
  fileSystem: FileSystem,
  root: string,
  kind: SourceKind,
  from: string,
  to: string,
): Promise<RenameOutcome> => {
  const { path, entrypoint } = locate(kind, to);

  for (const [name, where] of [
    [from, locate(kind, from).path],
    [to, path],
  ] as const) {
    const check = checkName(name);
    if (!check.ok) {
      return {
        ok: false,
        diagnostics: [error('INVALID_NAME', `Invalid name '${name}': ${check.reason}.`, where)],
      };
    }
  }

  if (!(await fileSystem.exists(resolveWithinRoot(root, entrypoint)))) {
    return {
      ok: false,
      diagnostics: [
        error(
          'RENAME_SOURCE_MISSING',
          `There is no ${kind} named '${to}': '${entrypoint}' does not exist.`,
          entrypoint,
        ),
      ],
    };
  }

  const moves = from === to ? [] : await overrideMoves(fileSystem, root, kind, from, to);
  const blocked = await firstOccupied(fileSystem, root, moves);
  if (blocked !== undefined) {
    return {
      ok: false,
      diagnostics: [
        error(
          'RENAME_TARGET_EXISTS',
          `'${blocked}' already exists, so the override for '${from}' cannot follow the ${kind} to '${to}'. Merge the two files, or remove one of them.`,
          blocked,
        ),
      ],
    };
  }

  for (const move of moves) {
    await fileSystem.rename(resolveWithinRoot(root, move.from), resolveWithinRoot(root, move.to));
  }

  await alignFrontmatterName(fileSystem, root, entrypoint, to);
  return { ok: true, moved: moves };
};

/**
 * Reads the disagreement a `NAME_MISMATCH` reports, from the file it names.
 *
 * Returned as data rather than parsed back out of the diagnostic message: a
 * caller that has to resolve the mismatch needs both names, and recovering them
 * from prose would break the first time the wording changed.
 */
export const readNameMismatch = async (
  fileSystem: FileSystem,
  root: string,
  sourcePath: string,
): Promise<NameMismatch | undefined> => {
  const located = fromSourcePath(sourcePath);
  if (located === undefined) {
    return undefined;
  }

  const content = await fileSystem.readFile(resolveWithinRoot(root, located.entrypoint));
  if (content === undefined) {
    return undefined;
  }

  const decoded = decodeSourceFile(content);
  if (!decoded.ok) {
    return undefined;
  }

  const parsed = parseFrontmatter(decoded.text);
  if (!parsed.ok) {
    return undefined;
  }

  const declared = parsed.document.frontmatter['name'];
  if (typeof declared !== 'string' || declared === located.pathName) {
    return undefined;
  }

  return {
    kind: located.kind,
    pathName: located.pathName,
    declaredName: declared,
    sourcePath: located.entrypoint,
  };
};

const KIND_OF_DIRECTORY: Readonly<Record<string, SourceKind>> = {
  instructions: 'instruction',
  agents: 'agent',
  skills: 'skill',
  commands: 'command',
};

/** A canonical artifact, identified by where it sits under `.ai/`. */
export interface CanonicalArtifact {
  readonly kind: SourceKind;
  readonly name: string;
}

/**
 * The artifact a canonical path *is*, if it is one.
 *
 * Matches the artifact's own path — `.ai/skills/scouts`, `.ai/agents/x.md` —
 * rather than a file inside it, so a caller holding a path that just moved can
 * say which artifact moved. Anything else is `undefined`: a file inside a skill,
 * a provider override, `config.yaml`, a path outside `.ai/`.
 */
export const canonicalArtifactAt = (relativePath: string): CanonicalArtifact | undefined => {
  const segments = relativePath.split('/');
  const [base, directory, third] = segments;
  const kind = directory === undefined ? undefined : KIND_OF_DIRECTORY[directory];

  if (base !== AI_DIRECTORY || kind === undefined || third === undefined) {
    return undefined;
  }

  if (kind === 'skill') {
    // The directory itself, which is what an editor reports when a folder is
    // renamed: one event for the folder, none for the files inside it.
    return segments.length === 3 ? { kind, name: third } : undefined;
  }

  return segments.length === 3 && third.endsWith('.md')
    ? { kind, name: nameFromFilename(third) }
    : undefined;
};

interface LocatedSource {
  readonly kind: SourceKind;
  readonly pathName: string;
  readonly entrypoint: string;
}

/** Recovers the kind and the path-derived name from a canonical file path. */
const fromSourcePath = (sourcePath: string): LocatedSource | undefined => {
  const segments = sourcePath.split('/');
  const [base, directory, third, fourth] = segments;
  const kind = directory === undefined ? undefined : KIND_OF_DIRECTORY[directory];

  if (base !== AI_DIRECTORY || kind === undefined || third === undefined) {
    return undefined;
  }

  if (kind === 'skill') {
    return segments.length === 4 && fourth === SKILL_ENTRYPOINT
      ? { kind, pathName: third, entrypoint: sourcePath }
      : undefined;
  }

  return segments.length === 3 && third.endsWith('.md')
    ? { kind, pathName: nameFromFilename(third), entrypoint: sourcePath }
    : undefined;
};

/**
 * Replaces the value of the `name` field, and nothing else.
 *
 * Surgical on purpose. The file is the author's, and re-serializing the
 * frontmatter would reorder keys, change quoting, or drop a field AI Config
 * does not model — so one line is rewritten and the rest of the file is copied
 * through untouched. A file with no `name` field is left alone: for an
 * instruction, agent or command the field is optional, and its absence already
 * means "take the name from the filename".
 */
const alignFrontmatterName = async (
  fileSystem: FileSystem,
  root: string,
  entrypoint: string,
  name: string,
): Promise<void> => {
  const absolute = resolveWithinRoot(root, entrypoint);
  const content = await fileSystem.readFile(absolute);
  if (content === undefined) {
    return;
  }

  const decoded = decodeSourceFile(content);
  if (!decoded.ok) {
    return;
  }

  const line = findFrontmatterKeyLine(decoded.text, 'name');
  if (line === undefined) {
    return;
  }

  // Split the raw text rather than the normalized one, so a file saved with
  // CRLF endings or a byte order mark comes back byte-identical apart from the
  // single line that changed.
  const lines = content.toString('utf8').split('\n');
  const existing = lines[line - 1];
  if (existing === undefined) {
    return;
  }

  const rewritten = `name: ${name}${existing.endsWith('\r') ? '\r' : ''}`;
  if (rewritten === existing) {
    return;
  }

  lines[line - 1] = rewritten;
  await fileSystem.writeFileAtomic(absolute, Buffer.from(lines.join('\n'), 'utf8'));
};

/**
 * Every override file named after the artifact, and where each one moves to.
 *
 * The provider directories are read rather than taken from the registered
 * provider list, exactly as removal does: an override left by a provider this
 * build does not know is still named after this artifact, and leaving it behind
 * would break it just as silently.
 */
const overrideMoves = async (
  fileSystem: FileSystem,
  root: string,
  kind: SourceKind,
  from: string,
  to: string,
): Promise<readonly RenamedPath[]> => {
  const providersRoot = resolveWithinRoot(root, PROVIDERS_ROOT);
  if (!(await fileSystem.exists(providersRoot))) {
    return [];
  }

  const directory = sourceDirectory(kind);
  const moves: RenamedPath[] = [];

  for (const entry of await fileSystem.readDirectory(providersRoot)) {
    if (entry.kind !== 'directory') {
      continue;
    }
    const base = `${PROVIDERS_ROOT}/${entry.name}/${directory}`;
    const candidate = `${base}/${from}.yaml`;
    if (await fileSystem.exists(resolveWithinRoot(root, candidate))) {
      moves.push({ from: candidate, to: `${base}/${to}.yaml` });
    }
  }

  return moves.sort((a, b) => compareStrings(a.from, b.from));
};

/** The first destination that is already taken, if any. */
const firstOccupied = async (
  fileSystem: FileSystem,
  root: string,
  moves: readonly RenamedPath[],
): Promise<string | undefined> => {
  for (const move of moves) {
    if (await fileSystem.exists(resolveWithinRoot(root, move.to))) {
      return move.to;
    }
  }
  return undefined;
};
