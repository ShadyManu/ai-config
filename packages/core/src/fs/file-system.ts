export interface DirectoryEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
}

export interface FileStat {
  readonly size: number;
  /** POSIX executable bit. Always `false` on platforms without file modes. */
  readonly executable: boolean;
}

/**
 * The only filesystem surface core uses.
 *
 * Every method takes an absolute path. Adapters never receive an
 * implementation, which is what makes path safety unbypassable: an adapter has
 * no way to reach the disk at all.
 *
 * Implementations must not throw for "not found"; they return `undefined` or
 * an empty list so callers can distinguish absence from failure without
 * inspecting error codes.
 */
export interface FileSystem {
  readFile: (path: string) => Promise<Buffer | undefined>;
  readDirectory: (path: string) => Promise<readonly DirectoryEntry[]>;
  stat: (path: string) => Promise<FileStat | undefined>;
  exists: (path: string) => Promise<boolean>;

  /**
   * Fully resolves symbolic links, or returns `undefined` if the path does not
   * exist.
   *
   * Lexical path checks cannot see a symbolic link, so containment is verified
   * against the real path before anything is read from or written to a
   * directory. Without this, a committed symlink such as
   * `.claude -> /somewhere/else` would let generated files land outside the
   * repository entirely.
   */
  realPath: (path: string) => Promise<string | undefined>;

  /** Creates `path` and any missing parents. */
  createDirectory: (path: string) => Promise<void>;

  /**
   * Writes atomically: content goes to a temporary file in the destination
   * directory and is renamed over the target, so readers never observe a
   * half-written file.
   */
  writeFileAtomic: (
    path: string,
    content: Buffer,
    options?: { executable?: boolean; exclusive?: boolean },
  ) => Promise<void>;

  /** Removes a file. Never removes a directory, and never recurses. */
  deleteFile: (path: string) => Promise<void>;

  /**
   * Removes `path` only if it is an empty directory, and does nothing
   * otherwise.
   *
   * Deliberately not recursive. Emptiness is the safety property: a directory
   * still holding anything — a file AI Config never generated, a nested
   * directory — is left alone, so no amount of calling this can destroy
   * content. That is what lets generated directories be tidied up without a
   * record of which ones AI Config created.
   */
  deleteEmptyDirectory: (path: string) => Promise<void>;
}
