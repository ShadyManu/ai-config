import type { FileContent } from '../adapter/adapter.js';
import type { AiConfiguration } from '../domain/configuration.js';
import type { FileSystem } from '../fs/file-system.js';
import { resolveWithinRoot } from '../path/safe-path.js';

export interface ResolvedContent {
  readonly bytes: Buffer;
  readonly executable: boolean;
}

export interface SkillFileLocation {
  readonly sourcePath: string;
  readonly executable: boolean;
}

/** Indexes skill files by `<skill>/<relative path>` for content resolution. */
export const indexSkillFiles = (
  configuration: AiConfiguration,
): ReadonlyMap<string, SkillFileLocation> => {
  const index = new Map<string, SkillFileLocation>();
  for (const skill of configuration.skills) {
    for (const file of skill.files) {
      index.set(`${skill.name}/${file.relativePath}`, {
        sourcePath: `${skill.sourcePath}/${file.relativePath}`,
        executable: file.executable,
      });
    }
  }
  return index;
};

/**
 * Materializes the bytes a generated file would contain.
 *
 * Shared by the writer and by editor integrations that need to show a diff, so
 * what a user is shown is exactly what a sync would write.
 */
export const resolveContent = async (
  fileSystem: FileSystem,
  root: string,
  content: FileContent,
  skillFiles: ReadonlyMap<string, SkillFileLocation>,
): Promise<ResolvedContent> => {
  if (content.kind === 'text') {
    return { bytes: Buffer.from(content.value, 'utf8'), executable: false };
  }

  const key = `${content.ref.skill}/${content.ref.relativePath}`;
  const skillFile = skillFiles.get(key);
  if (skillFile === undefined) {
    throw new Error(`skill file '${key}' is no longer part of the configuration`);
  }

  const source = await fileSystem.readFile(resolveWithinRoot(root, skillFile.sourcePath));
  if (source === undefined) {
    throw new Error(`skill file '${skillFile.sourcePath}' could not be read`);
  }

  return { bytes: source, executable: skillFile.executable };
};
