import * as path from 'node:path';

import type { DirectoryEntry, FileStat, FileSystem } from '../fs/file-system.js';

interface MemoryFile {
  readonly content: Buffer;
  readonly executable: boolean;
  readonly symlink: boolean;
}

/**
 * In-memory {@link FileSystem} for unit tests.
 *
 * Keeps the suite fast, order-independent and completely isolated from the
 * developer's real provider configuration. Filesystem-specific behaviour
 * (atomic rename, real permissions) is covered by the integration tests, which
 * use the Node implementation against a temporary directory.
 */
export class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, MemoryFile>();
  private readonly directories = new Set<string>();

  public constructor(public readonly root = path.resolve('/repo')) {
    this.directories.add(this.normalize(this.root));
  }

  private normalize(target: string): string {
    return path.resolve(target).split(path.sep).join('/');
  }

  /** Seeds a file using a path relative to the root. */
  public set(
    relativePath: string,
    content: string | Buffer,
    options?: { executable?: boolean },
  ): void {
    const absolute = this.normalize(path.join(this.root, relativePath));
    this.ensureParents(absolute);
    this.files.set(absolute, {
      content: typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
      executable: options?.executable ?? false,
      symlink: false,
    });
  }

  /** Seeds an entry that reports as a symbolic link. */
  public setSymlink(relativePath: string): void {
    const absolute = this.normalize(path.join(this.root, relativePath));
    this.ensureParents(absolute);
    this.files.set(absolute, { content: Buffer.alloc(0), executable: false, symlink: true });
  }

  /** Reads a file using a path relative to the root, or `undefined`. */
  public get(relativePath: string): string | undefined {
    const file = this.files.get(this.normalize(path.join(this.root, relativePath)));
    return file === undefined ? undefined : file.content.toString('utf8');
  }

  public has(relativePath: string): boolean {
    return this.files.has(this.normalize(path.join(this.root, relativePath)));
  }

  /** Every file path relative to the root, sorted. */
  public paths(): readonly string[] {
    const prefix = `${this.normalize(this.root)}/`;
    return [...this.files.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
  }

  private ensureParents(absolute: string): void {
    let current = path.posix.dirname(absolute);
    while (!this.directories.has(current)) {
      this.directories.add(current);
      const parent = path.posix.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  public readFile(target: string): Promise<Buffer | undefined> {
    const file = this.files.get(this.normalize(target));
    return Promise.resolve(file === undefined || file.symlink ? undefined : file.content);
  }

  public readDirectory(target: string): Promise<readonly DirectoryEntry[]> {
    const prefix = `${this.normalize(target)}/`;
    const entries = new Map<string, DirectoryEntry>();

    for (const [filePath, file] of this.files) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }
      const remainder = filePath.slice(prefix.length);
      const separator = remainder.indexOf('/');
      if (separator === -1) {
        entries.set(remainder, {
          name: remainder,
          kind: file.symlink ? 'symlink' : 'file',
        });
      } else {
        const name = remainder.slice(0, separator);
        entries.set(name, { name, kind: 'directory' });
      }
    }

    for (const directory of this.directories) {
      if (!directory.startsWith(prefix)) {
        continue;
      }
      const remainder = directory.slice(prefix.length);
      const name = remainder.split('/')[0];
      if (name !== undefined && name.length > 0 && !entries.has(name)) {
        entries.set(name, { name, kind: 'directory' });
      }
    }

    return Promise.resolve([...entries.values()]);
  }

  public stat(target: string): Promise<FileStat | undefined> {
    const file = this.files.get(this.normalize(target));
    if (file !== undefined) {
      return Promise.resolve({ size: file.content.byteLength, executable: file.executable });
    }
    if (this.directories.has(this.normalize(target))) {
      return Promise.resolve({ size: 0, executable: false });
    }
    return Promise.resolve(undefined);
  }

  public exists(target: string): Promise<boolean> {
    const normalized = this.normalize(target);
    return Promise.resolve(this.files.has(normalized) || this.directories.has(normalized));
  }

  /**
   * No entry in this filesystem is a real symbolic link, so a path resolves to
   * itself. Symlink escape is covered by the integration tests, which use the
   * Node implementation against a temporary directory.
   */
  public realPath(target: string): Promise<string | undefined> {
    const normalized = this.normalize(target);
    if (this.files.has(normalized) || this.directories.has(normalized)) {
      return Promise.resolve(path.resolve(target));
    }
    return Promise.resolve(undefined);
  }

  public createDirectory(target: string): Promise<void> {
    const normalized = this.normalize(target);
    this.directories.add(normalized);
    this.ensureParents(`${normalized}/placeholder`);
    return Promise.resolve();
  }

  public writeFileAtomic(
    target: string,
    content: Buffer,
    options?: { executable?: boolean; exclusive?: boolean },
  ): Promise<void> {
    const absolute = this.normalize(target);
    if (options?.exclusive === true && this.files.has(absolute)) {
      return Promise.reject(
        Object.assign(new Error(`EEXIST: file already exists, link '${target}'`), {
          code: 'EEXIST',
        }),
      );
    }
    this.ensureParents(absolute);
    this.files.set(absolute, {
      content,
      executable: options?.executable ?? false,
      symlink: false,
    });
    return Promise.resolve();
  }

  public deleteFile(target: string): Promise<void> {
    this.files.delete(this.normalize(target));
    return Promise.resolve();
  }

  public deleteEmptyDirectory(target: string): Promise<void> {
    const directory = this.normalize(target);
    const prefix = `${directory}/`;
    for (const existing of this.files.keys()) {
      if (existing.startsWith(prefix)) {
        return Promise.resolve();
      }
    }
    this.directories.delete(directory);
    return Promise.resolve();
  }
}
