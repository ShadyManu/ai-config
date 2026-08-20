import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { DirectoryEntry, FileStat, FileSystem } from './file-system.js';

/**
 * Error codes that mean "there is nothing here", as opposed to "something went
 * wrong".
 *
 * Only these are absorbed. Everything else — `EACCES`, `EISDIR`, `EPERM`,
 * `EMFILE` — is a real failure and must surface rather than being mistaken for
 * an absent file, which would make AI Config believe it owns nothing and start
 * overwriting or deleting.
 */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG']);

const errorCode = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
};

const isNotEmpty = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ENOTEMPTY' || code === 'EEXIST';
};

const isAbsent = (error: unknown): boolean => {
  const code = errorCode(error);
  return code !== undefined && ABSENT_CODES.has(code);
};

/**
 * Codes Windows reports when a rename cannot replace an existing destination.
 *
 * Windows implements a replacing rename as a delete plus a move, and refuses it
 * while any process holds the destination without granting delete sharing.
 * Virus scanners, search indexers and editors all open a file briefly after it
 * changes, so this happens sporadically to a file AI Config wrote moments ago
 * and is entitled to replace.
 */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 20;

const isTransientOnWindows = (error: unknown): boolean =>
  process.platform === 'win32' && TRANSIENT_CODES.has(errorCode(error) ?? '');

/**
 * Renames over an existing file, working around Windows sharing rules.
 *
 * A plain rename is tried first and is what runs everywhere in practice. When
 * Windows refuses it, the rename is retried a few times, and only then is the
 * destination unlinked first. Removing the destination gives up atomicity for a
 * few microseconds, but the alternative is a sync that fails outright on a file
 * it owns; a reader that hits that window sees the file as absent, which is a
 * state AI Config already reports as pending and repairs on the next sync,
 * whereas a hard failure needs the user to work out that nothing was wrong.
 *
 * On POSIX no fallback runs at all: a rename over an open file succeeds there,
 * so `EPERM` means a real permission problem and must surface immediately.
 */
const renameOver = async (temporary: string, target: string): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(temporary, target);
      return;
    } catch (error) {
      if (!isTransientOnWindows(error) || attempt >= RENAME_ATTEMPTS) {
        if (!isTransientOnWindows(error)) {
          throw error;
        }
        await fs.rm(target, { force: true });
        await fs.rename(temporary, target);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * RENAME_BACKOFF_MS));
    }
  }
};

export class NodeFileSystem implements FileSystem {
  public async readFile(target: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(target);
    } catch (error) {
      if (isAbsent(error)) {
        return undefined;
      }
      // A directory where a file is expected is a legitimate repository state,
      // not a crash: report it as absent so the planner treats the path as an
      // untracked obstruction rather than silently replacing it.
      if (errorCode(error) === 'EISDIR') {
        return undefined;
      }
      throw error;
    }
  }

  public async readDirectory(target: string): Promise<readonly DirectoryEntry[]> {
    let entries;
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch (error) {
      if (isAbsent(error)) {
        return [];
      }
      throw error;
    }

    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isSymbolicLink()
        ? ('symlink' as const)
        : entry.isFile()
          ? ('file' as const)
          : entry.isDirectory()
            ? ('directory' as const)
            : ('other' as const),
    }));
  }

  public async stat(target: string): Promise<FileStat | undefined> {
    try {
      const stats = await fs.stat(target);
      return { size: stats.size, executable: (stats.mode & 0o111) !== 0 };
    } catch (error) {
      if (isAbsent(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async exists(target: string): Promise<boolean> {
    try {
      await fs.lstat(target);
      return true;
    } catch (error) {
      if (isAbsent(error)) {
        return false;
      }
      throw error;
    }
  }

  public async realPath(target: string): Promise<string | undefined> {
    try {
      return await fs.realpath(target);
    } catch (error) {
      if (isAbsent(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async createDirectory(target: string): Promise<void> {
    await fs.mkdir(target, { recursive: true });
  }

  public async writeFileAtomic(
    target: string,
    content: Buffer,
    options?: { executable?: boolean; exclusive?: boolean },
  ): Promise<void> {
    const directory = path.dirname(target);
    await fs.mkdir(directory, { recursive: true });

    // The temporary file must share a directory with the target: rename and
    // link are only atomic within a filesystem, and a system temp directory may
    // be on another.
    const temporary = path.join(directory, `.aiconfig-${randomBytes(6).toString('hex')}.tmp`);

    try {
      await fs.writeFile(temporary, content, options?.executable === true ? { mode: 0o755 } : {});

      if (options?.exclusive === true) {
        // `link` fails with EEXIST if the target appeared between planning and
        // writing, so a file that is not ours is never clobbered — while the
        // content still arrives complete, exactly like the rename path.
        await fs.link(temporary, target);
      } else {
        await renameOver(temporary, target);
      }
    } finally {
      // `rename` consumes the temporary file; `link` does not, and a failed
      // write may leave one behind either way.
      await fs.rm(temporary, { force: true }).catch(() => {
        // A leftover temporary file must not mask the original failure.
      });
    }
  }

  public async deleteFile(target: string): Promise<void> {
    try {
      await fs.unlink(target);
    } catch (error) {
      if (isAbsent(error)) {
        return;
      }
      throw error;
    }
  }

  public async deleteEmptyDirectory(target: string): Promise<void> {
    try {
      await fs.rmdir(target);
    } catch (error) {
      // 'rmdir' refuses a non-empty directory, which is exactly the guarantee
      // being relied on, so that refusal is a normal outcome rather than a
      // failure. A missing directory is equally uninteresting.
      if (isAbsent(error) || isNotEmpty(error)) {
        return;
      }
      throw error;
    }
  }
}
