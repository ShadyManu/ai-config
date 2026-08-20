import type {
  AiAgent,
  AiCommand,
  AiConfiguration,
  AiInstruction,
  AiSkill,
  AiSkillFile,
} from '../domain/configuration.js';
import type { DiagnosticCode } from '../domain/codes.js';
import type { Diagnostic } from '../domain/diagnostic.js';
import { byName, compareStrings } from '../domain/ordering.js';
import type { DirectoryEntry, FileSystem } from '../fs/file-system.js';
import { sha256 } from '../manifest/hash.js';
import { checkPathsContained } from '../path/containment.js';
import { checkGeneratedPath, resolveWithinRoot } from '../path/safe-path.js';
import { findFrontmatterKeyLine, parseFrontmatter } from './frontmatter.js';
import { checkName, nameFromFilename } from './name.js';
import { decodeSourceFile } from './text.js';
import { isStringArray } from './yaml.js';

export const AI_DIRECTORY = '.ai';

export const SKILL_ENTRYPOINT = 'SKILL.md';
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

const INSTRUCTION_KEYS = new Set(['name', 'description', 'applyTo']);
const AGENT_KEYS = new Set(['name', 'description']);
const COMMAND_KEYS = new Set(['name', 'description']);

/**
 * A canonical command states developer-invoked intent unless it opts out.
 *
 * This is the semantic `docs/specification.md` §5.4 has always asserted, so the
 * default makes existing files mean exactly what they already claimed.
 */

const CONTENT_DIRECTORIES = ['instructions', 'agents', 'skills', 'commands'] as const;
type ContentDirectory = (typeof CONTENT_DIRECTORIES)[number];

export interface DiscoveryResult {
  readonly configuration: AiConfiguration;
  readonly diagnostics: readonly Diagnostic[];
}

interface Collected<T> {
  readonly items: readonly T[];
  readonly diagnostics: readonly Diagnostic[];
}

interface MarkdownFile {
  readonly name: string;
  readonly sourcePath: string;
  readonly text: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

const error = (
  code: DiagnosticCode,
  message: string,
  source: string,
  line?: number,
): Diagnostic => ({ code, severity: 'error', message, source, line });

const warning = (code: DiagnosticCode, message: string, source: string): Diagnostic => ({
  code,
  severity: 'warning',
  message,
  source,
});

/**
 * Reads `.ai/` into the intermediate representation.
 *
 * Only `.ai/` is traversed. Provider directories are never scanned here — the
 * planner probes exactly the paths it needs, so a large repository costs
 * nothing beyond its canonical configuration.
 */
export const discoverConfiguration = async (
  fileSystem: FileSystem,
  root: string,
): Promise<DiscoveryResult> => {
  // A canonical directory reached through a symbolic link could pull content
  // from outside the repository into every provider's configuration.
  const containment = await checkPathsContained(fileSystem, root, [
    AI_DIRECTORY,
    ...CONTENT_DIRECTORIES.map((directory) => `${AI_DIRECTORY}/${directory}`),
  ]);
  if (containment.length > 0) {
    return {
      configuration: { instructions: [], agents: [], skills: [], commands: [] },
      diagnostics: containment,
    };
  }

  const [instructions, agents, skills, commands] = await Promise.all([
    readInstructions(fileSystem, root),
    readAgents(fileSystem, root),
    readSkills(fileSystem, root),
    readCommands(fileSystem, root),
  ]);

  return {
    // Sorting once here is what makes every adapter's output deterministic
    // without each adapter having to sort for itself.
    configuration: {
      instructions: [...instructions.items].sort(byName),
      agents: [...agents.items].sort(byName),
      skills: [...skills.items].sort(byName),
      commands: [...commands.items].sort(byName),
    },
    // Concatenated in a fixed order rather than appended concurrently, so
    // diagnostics do not depend on which directory read finished first.
    diagnostics: [
      ...instructions.diagnostics,
      ...agents.diagnostics,
      ...skills.diagnostics,
      ...commands.diagnostics,
    ],
  };
};

const sortedEntries = (entries: readonly DirectoryEntry[]): readonly DirectoryEntry[] =>
  [...entries].sort((a, b) => compareStrings(a.name, b.name));

const listMarkdownFiles = async (
  fileSystem: FileSystem,
  root: string,
  directory: ContentDirectory,
  diagnostics: Diagnostic[],
): Promise<readonly MarkdownFile[]> => {
  const relativeDirectory = `${AI_DIRECTORY}/${directory}`;
  const entries = await fileSystem.readDirectory(resolveWithinRoot(root, relativeDirectory));

  const seen = new Set<string>();
  const files: MarkdownFile[] = [];

  for (const entry of sortedEntries(entries)) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.kind === 'symlink') {
      diagnostics.push(
        warning(
          'SYMLINK_SKIPPED',
          `Skipped '${entry.name}': symbolic links are not followed, because their target may lie outside the repository.`,
          `${relativeDirectory}/${entry.name}`,
        ),
      );
      continue;
    }
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) {
      continue;
    }

    const sourcePath = `${relativeDirectory}/${entry.name}`;

    // The name is validated before the path is resolved: an invalid name must
    // produce a diagnostic pointing at the file, not an exception from the path
    // guard.
    const name = nameFromFilename(entry.name);
    const nameCheck = checkName(name);
    if (!nameCheck.ok) {
      diagnostics.push(
        error('INVALID_NAME', `Invalid name '${name}': ${nameCheck.reason}.`, sourcePath),
      );
      continue;
    }
    if (seen.has(name)) {
      diagnostics.push(
        error('DUPLICATE_NAME', `Duplicate ${directory} name '${name}'.`, sourcePath),
      );
      continue;
    }
    seen.add(name);

    const content = await fileSystem.readFile(resolveWithinRoot(root, sourcePath));
    if (content === undefined) {
      continue;
    }

    const decoded = decodeSourceFile(content);
    if (!decoded.ok) {
      diagnostics.push(
        error('UNSUPPORTED_ENCODING', `Could not read the file: ${decoded.reason}.`, sourcePath),
      );
      continue;
    }

    const parsed = parseFrontmatter(decoded.text);
    if (!parsed.ok) {
      diagnostics.push(error(parsed.code, `${parsed.reason}.`, sourcePath, parsed.line));
      continue;
    }

    const declared = parsed.document.frontmatter['name'];
    if (declared !== undefined && declared !== name) {
      const shown = typeof declared === 'string' ? declared : JSON.stringify(declared);
      // Providers disagree about whether the filename or the field wins, so
      // neither is silently preferred.
      diagnostics.push(
        error(
          'NAME_MISMATCH',
          `Frontmatter name '${shown}' does not match the filename '${entry.name}'.`,
          sourcePath,
          findFrontmatterKeyLine(decoded.text, 'name'),
        ),
      );
      continue;
    }

    files.push({
      name,
      sourcePath,
      text: decoded.text,
      frontmatter: parsed.document.frontmatter,
      body: parsed.document.body,
    });
  }

  return files;
};

const reportUnknownKeys = (
  file: MarkdownFile,
  allowed: ReadonlySet<string>,
  diagnostics: Diagnostic[],
): void => {
  for (const key of Object.keys(file.frontmatter)) {
    if (!allowed.has(key)) {
      diagnostics.push(
        error(
          'UNKNOWN_FRONTMATTER_KEY',
          `Unknown frontmatter field '${key}'. Supported fields: ${[...allowed].join(', ')}.`,
          file.sourcePath,
          findFrontmatterKeyLine(file.text, key),
        ),
      );
    }
  }
};

const readDescription = (
  file: MarkdownFile,
  required: boolean,
  diagnostics: Diagnostic[],
): string | undefined => {
  const raw = file.frontmatter['description'];

  if (raw === undefined) {
    if (required) {
      diagnostics.push(
        error(
          'MISSING_DESCRIPTION',
          `Missing required frontmatter field: description.`,
          file.sourcePath,
          1,
        ),
      );
    }
    return undefined;
  }

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    diagnostics.push(
      error(
        'INVALID_DESCRIPTION',
        `'description' must be a non-empty string.`,
        file.sourcePath,
        findFrontmatterKeyLine(file.text, 'description'),
      ),
    );
    return undefined;
  }

  return raw.trim();
};

const readInstructions = async (
  fileSystem: FileSystem,
  root: string,
): Promise<Collected<AiInstruction>> => {
  const diagnostics: Diagnostic[] = [];
  const files = await listMarkdownFiles(fileSystem, root, 'instructions', diagnostics);
  const items: AiInstruction[] = [];

  for (const file of files) {
    reportUnknownKeys(file, INSTRUCTION_KEYS, diagnostics);
    const description = readDescription(file, false, diagnostics);
    const applyTo = readApplyTo(file, diagnostics);

    if (file.body.trim().length === 0) {
      diagnostics.push(
        error('INSTRUCTION_BODY_EMPTY', `Instruction body is empty.`, file.sourcePath),
      );
      continue;
    }

    items.push({
      name: file.name,
      description,
      applyTo,
      body: file.body.trim(),
      sourcePath: file.sourcePath,
    });
  }

  return { items, diagnostics };
};

const readApplyTo = (file: MarkdownFile, diagnostics: Diagnostic[]): readonly string[] => {
  const raw = file.frontmatter['applyTo'];
  if (raw === undefined) {
    return [];
  }

  const line = findFrontmatterKeyLine(file.text, 'applyTo');
  const patterns = typeof raw === 'string' ? [raw] : raw;

  if (!isStringArray(patterns)) {
    diagnostics.push(
      error(
        'INVALID_APPLY_TO',
        `'applyTo' must be a string or a list of strings.`,
        file.sourcePath,
        line,
      ),
    );
    return [];
  }

  if (patterns.length === 0) {
    // "Applies to nothing" is never the intent; omitting the field is.
    diagnostics.push(
      error(
        'INSTRUCTION_EMPTY_APPLY_TO',
        `'applyTo' is empty. Remove the field to apply the instruction everywhere.`,
        file.sourcePath,
        line,
      ),
    );
    return [];
  }

  const cleaned: string[] = [];
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed.length === 0) {
      diagnostics.push(
        error('INVALID_APPLY_TO', `'applyTo' contains an empty pattern.`, file.sourcePath, line),
      );
      continue;
    }
    if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed) || trimmed.includes('\\')) {
      diagnostics.push(
        error(
          'INVALID_APPLY_TO',
          `'applyTo' pattern '${trimmed}' must be a repository-relative POSIX glob.`,
          file.sourcePath,
          line,
        ),
      );
      continue;
    }
    cleaned.push(trimmed);
  }

  return cleaned;
};

const readAgents = async (fileSystem: FileSystem, root: string): Promise<Collected<AiAgent>> => {
  const diagnostics: Diagnostic[] = [];
  const files = await listMarkdownFiles(fileSystem, root, 'agents', diagnostics);
  const items: AiAgent[] = [];

  for (const file of files) {
    reportUnknownKeys(file, AGENT_KEYS, diagnostics);
    const description = readDescription(file, true, diagnostics);

    if (file.body.trim().length === 0) {
      diagnostics.push(
        error(
          'AGENT_BODY_EMPTY',
          `Agent body is empty. The body becomes the agent's system prompt.`,
          file.sourcePath,
        ),
      );
      continue;
    }

    if (description === undefined) {
      continue;
    }

    items.push({
      name: file.name,
      description,
      body: file.body.trim(),
      sourcePath: file.sourcePath,
    });
  }

  return { items, diagnostics };
};

const readCommands = async (
  fileSystem: FileSystem,
  root: string,
): Promise<Collected<AiCommand>> => {
  const diagnostics: Diagnostic[] = [];
  const files = await listMarkdownFiles(fileSystem, root, 'commands', diagnostics);
  const items: AiCommand[] = [];

  for (const file of files) {
    reportUnknownKeys(file, COMMAND_KEYS, diagnostics);
    const description = readDescription(file, true, diagnostics);

    if (file.body.trim().length === 0) {
      diagnostics.push(
        error(
          'COMMAND_BODY_EMPTY',
          `Command body is empty. The body becomes the prompt template.`,
          file.sourcePath,
        ),
      );
      continue;
    }

    if (description === undefined) {
      continue;
    }

    items.push({
      name: file.name,
      description,
      body: file.body.trim(),
      sourcePath: file.sourcePath,
    });
  }

  return { items, diagnostics };
};

const readSkills = async (fileSystem: FileSystem, root: string): Promise<Collected<AiSkill>> => {
  const diagnostics: Diagnostic[] = [];
  const skillsRoot = `${AI_DIRECTORY}/skills`;
  const entries = await fileSystem.readDirectory(resolveWithinRoot(root, skillsRoot));
  const items: AiSkill[] = [];
  const seen = new Set<string>();

  for (const entry of sortedEntries(entries)) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.kind === 'symlink') {
      diagnostics.push(
        warning(
          'SKILL_SYMLINK_SKIPPED',
          `Skipped skill '${entry.name}': symbolic links are not followed.`,
          `${skillsRoot}/${entry.name}`,
        ),
      );
      continue;
    }
    if (entry.kind !== 'directory') {
      continue;
    }

    const skill = await readSkill(fileSystem, root, entry.name, seen, diagnostics);
    if (skill !== undefined) {
      items.push(skill);
    }
  }

  return { items, diagnostics };
};

const readSkill = async (
  fileSystem: FileSystem,
  root: string,
  directoryName: string,
  seen: Set<string>,
  diagnostics: Diagnostic[],
): Promise<AiSkill | undefined> => {
  const sourcePath = `${AI_DIRECTORY}/skills/${directoryName}`;
  const entrypointPath = `${sourcePath}/${SKILL_ENTRYPOINT}`;

  const nameCheck = checkName(directoryName);
  if (!nameCheck.ok) {
    diagnostics.push(
      error(
        'SKILL_NAME_INVALID',
        `Invalid skill name '${directoryName}': ${nameCheck.reason}.`,
        sourcePath,
      ),
    );
    return undefined;
  }
  if (seen.has(directoryName)) {
    diagnostics.push(
      error('DUPLICATE_NAME', `Duplicate skill name '${directoryName}'.`, sourcePath),
    );
    return undefined;
  }
  seen.add(directoryName);

  const entries = await fileSystem.readDirectory(resolveWithinRoot(root, sourcePath));
  const entrypointEntry = entries.find((entry) => entry.name === SKILL_ENTRYPOINT);

  if (entrypointEntry === undefined) {
    diagnostics.push(
      error(
        'SKILL_MISSING',
        `Skill '${directoryName}' has no ${SKILL_ENTRYPOINT}. Every skill directory must contain one.`,
        sourcePath,
      ),
    );
    return undefined;
  }

  if (entrypointEntry.kind !== 'file') {
    // Reading through a link would parse a file outside the repository, and the
    // copy step would refuse to include it, producing a skill with no
    // entrypoint. Refusing here keeps the two consistent.
    diagnostics.push(
      error(
        'SKILL_ENTRYPOINT_NOT_A_FILE',
        `${SKILL_ENTRYPOINT} must be a regular file, not a ${entrypointEntry.kind}.`,
        entrypointPath,
      ),
    );
    return undefined;
  }

  const entrypoint = await fileSystem.readFile(resolveWithinRoot(root, entrypointPath));
  if (entrypoint === undefined) {
    diagnostics.push(
      error('SKILL_MISSING', `${SKILL_ENTRYPOINT} could not be read.`, entrypointPath),
    );
    return undefined;
  }

  const decoded = decodeSourceFile(entrypoint);
  if (!decoded.ok) {
    diagnostics.push(
      error('UNSUPPORTED_ENCODING', `Could not read the file: ${decoded.reason}.`, entrypointPath),
    );
    return undefined;
  }

  const parsed = parseFrontmatter(decoded.text);
  if (!parsed.ok) {
    diagnostics.push(error(parsed.code, `${parsed.reason}.`, entrypointPath, parsed.line));
    return undefined;
  }

  if (!parsed.document.hasFrontmatter) {
    diagnostics.push(
      error(
        'SKILL_FRONTMATTER_MISSING',
        `${SKILL_ENTRYPOINT} must start with YAML frontmatter containing 'name' and 'description'.`,
        entrypointPath,
        1,
      ),
    );
    return undefined;
  }

  const frontmatter = parsed.document.frontmatter;

  const declaredName = frontmatter['name'];
  if (typeof declaredName !== 'string' || declaredName.length === 0) {
    diagnostics.push(
      error('SKILL_NAME_MISSING', `Missing required frontmatter field: name.`, entrypointPath, 2),
    );
    return undefined;
  }
  if (declaredName !== directoryName) {
    diagnostics.push(
      error(
        'NAME_MISMATCH',
        `Frontmatter name '${declaredName}' does not match the skill directory name '${directoryName}'.`,
        entrypointPath,
        2,
      ),
    );
    return undefined;
  }

  const description = frontmatter['description'];
  if (typeof description !== 'string' || description.trim().length === 0) {
    diagnostics.push(
      error(
        'SKILL_DESCRIPTION_MISSING',
        `Missing required frontmatter field: description.`,
        entrypointPath,
        2,
      ),
    );
    return undefined;
  }
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    diagnostics.push(
      error(
        'SKILL_DESCRIPTION_LENGTH',
        `'description' is ${String(description.length)} characters; the maximum is ${String(SKILL_DESCRIPTION_MAX_LENGTH)}.`,
        entrypointPath,
        2,
      ),
    );
    return undefined;
  }

  const files = await collectSkillFiles(fileSystem, root, sourcePath, '', diagnostics);

  if (!files.some((file) => file.relativePath === SKILL_ENTRYPOINT)) {
    // Every provider requires the entrypoint, so shipping the supporting files
    // without it would generate a skill none of them can load.
    diagnostics.push(
      error(
        'SKILL_EMPTY',
        `Skill '${directoryName}' could not be assembled because ${SKILL_ENTRYPOINT} was not collected.`,
        entrypointPath,
      ),
    );
    return undefined;
  }

  return {
    name: directoryName,
    description: description.trim(),
    files,
    sourcePath,
    entrypointText: decoded.text,
    entrypointKeys: Object.keys(frontmatter),
  };
};

const MAX_SKILL_DEPTH = 16;

const collectSkillFiles = async (
  fileSystem: FileSystem,
  root: string,
  skillPath: string,
  relativePrefix: string,
  diagnostics: Diagnostic[],
  depth = 0,
): Promise<readonly AiSkillFile[]> => {
  if (depth > MAX_SKILL_DEPTH) {
    diagnostics.push(
      warning(
        'SKILL_DEPTH_EXCEEDED',
        `Skipped contents below ${String(MAX_SKILL_DEPTH)} levels of nesting.`,
        `${skillPath}/${relativePrefix}`,
      ),
    );
    return [];
  }

  const directoryPath = relativePrefix.length === 0 ? skillPath : `${skillPath}/${relativePrefix}`;
  const entries = await fileSystem.readDirectory(resolveWithinRoot(root, directoryPath));
  const files: AiSkillFile[] = [];

  for (const entry of sortedEntries(entries)) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const relativePath =
      relativePrefix.length === 0 ? entry.name : `${relativePrefix}/${entry.name}`;

    if (entry.kind === 'symlink') {
      diagnostics.push(
        warning(
          'SKILL_SYMLINK_SKIPPED',
          `Skipped '${relativePath}': symbolic links are not followed, because their target may lie outside the repository.`,
          `${skillPath}/${relativePath}`,
        ),
      );
      continue;
    }

    if (entry.kind === 'directory') {
      files.push(
        ...(await collectSkillFiles(
          fileSystem,
          root,
          skillPath,
          relativePath,
          diagnostics,
          depth + 1,
        )),
      );
      continue;
    }

    if (entry.kind !== 'file') {
      continue;
    }

    // A supporting file may be named anything the author likes, so it is
    // checked rather than assumed safe: a name that cannot become a path on
    // every platform is reported, not thrown.
    const pathCheck = checkGeneratedPath(`${skillPath}/${relativePath}`);
    if (!pathCheck.ok) {
      diagnostics.push(
        error(
          'SKILL_FILE_UNSAFE_NAME',
          `Skipped '${relativePath}': ${pathCheck.reason}.`,
          `${skillPath}/${SKILL_ENTRYPOINT}`,
        ),
      );
      continue;
    }

    const absolute = resolveWithinRoot(root, pathCheck.path);
    const [content, stat] = await Promise.all([
      fileSystem.readFile(absolute),
      fileSystem.stat(absolute),
    ]);
    if (content === undefined) {
      continue;
    }

    files.push({
      relativePath,
      sha256: sha256(content),
      size: content.byteLength,
      executable: stat?.executable ?? false,
    });
  }

  return files.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
};
