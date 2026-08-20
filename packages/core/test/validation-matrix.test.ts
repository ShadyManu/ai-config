import { describe, expect, it } from 'vitest';

import type { DiagnosticCode } from '../src/domain/codes.js';
import type { AiConfiguration } from '../src/domain/configuration.js';
import type { DirectoryEntry } from '../src/fs/file-system.js';
import { discoverConfiguration } from '../src/parse/discover.js';
import { MemoryFileSystem } from '../src/testing/memory-file-system.js';

/**
 * The rules every markdown artifact shares, checked on every kind that has
 * them.
 *
 * Instructions, agents and commands are read through one code path, so a rule
 * written for one of them silently applies to all three — and `discover.test.ts`
 * exercises most of those rules against whichever kind was convenient. That
 * leaves the interesting failure untested: a rule that stops holding for one
 * kind only. Here each rule is stated once and run against all three, so an
 * asymmetry has to be deliberate and declared.
 *
 * Skills are read through their own directory-based path and genuinely differ;
 * the differences that matter are asserted at the end rather than left implicit.
 */

interface KindUnderTest {
  readonly label: string;
  readonly directory: string;
  readonly collection: keyof AiConfiguration;
  /** Whether a description is required, which is the one rule that differs. */
  readonly requiresDescription: boolean;
  readonly emptyBodyCode: DiagnosticCode;
}

const KINDS: readonly KindUnderTest[] = [
  {
    label: 'instruction',
    directory: 'instructions',
    collection: 'instructions',
    requiresDescription: false,
    emptyBodyCode: 'INSTRUCTION_BODY_EMPTY',
  },
  {
    label: 'agent',
    directory: 'agents',
    collection: 'agents',
    requiresDescription: true,
    emptyBodyCode: 'AGENT_BODY_EMPTY',
  },
  {
    label: 'command',
    directory: 'commands',
    collection: 'commands',
    requiresDescription: true,
    emptyBodyCode: 'COMMAND_BODY_EMPTY',
  },
];

const VALID = '---\ndescription: A description\n---\n\nThe body.\n';

const discover = async (seed: (fileSystem: MemoryFileSystem) => void) => {
  const fileSystem = new MemoryFileSystem();
  fileSystem.set('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: [claude]\n');
  seed(fileSystem);
  return discoverConfiguration(fileSystem, fileSystem.root);
};

/** One malformation, and the codes it must produce for each kind. */
interface Case {
  readonly label: string;
  readonly filename: string;
  readonly content: string | Buffer;
  /** A symbolic link rather than a regular file. */
  readonly symlink?: boolean;
  /** Codes expected in order, or a function of the kind when they differ. */
  readonly expected:
    readonly DiagnosticCode[] | ((kind: KindUnderTest) => readonly DiagnosticCode[]);
  /**
   * Whether the artifact still reaches the intermediate representation.
   *
   * Defaults to "only when nothing was reported". A few malformations are
   * reported without discarding the artifact — the error blocks the sync, so
   * nothing reaches a provider either way, and keeping the artifact lets the
   * rest of the file still be validated.
   */
  readonly emitted?: boolean | ((kind: KindUnderTest) => boolean);
}

const CASES: readonly Case[] = [
  {
    label: 'a well-formed artifact',
    filename: 'reviewer.md',
    content: VALID,
    expected: [],
  },
  {
    label: 'an unknown frontmatter field',
    filename: 'reviewer.md',
    content: '---\ndescription: A description\nunknownField: value\n---\n\nThe body.\n',
    expected: ['UNKNOWN_FRONTMATTER_KEY'],
    // Everything else about the file is valid, so it is still parsed; the
    // error is what stops it reaching a provider.
    emitted: true,
  },
  {
    label: 'a frontmatter name that disagrees with the filename',
    filename: 'reviewer.md',
    content: '---\nname: something-else\ndescription: A description\n---\n\nThe body.\n',
    expected: ['NAME_MISMATCH'],
  },
  {
    label: 'a name that is not lowercase-hyphenated',
    filename: 'Not_Valid.md',
    content: VALID,
    expected: ['INVALID_NAME'],
  },
  {
    label: 'a Windows reserved device name',
    filename: 'con.md',
    content: VALID,
    expected: ['INVALID_NAME'],
  },
  {
    label: 'a name beyond the length limit',
    filename: `${'a'.repeat(65)}.md`,
    content: VALID,
    expected: ['INVALID_NAME'],
  },
  {
    label: 'unterminated frontmatter',
    filename: 'reviewer.md',
    content: '---\ndescription: A description\n\nThe body.\n',
    expected: ['FRONTMATTER_UNTERMINATED'],
  },
  {
    label: 'frontmatter that is not valid YAML',
    filename: 'reviewer.md',
    content: '---\ndescription: [unclosed\n---\n\nThe body.\n',
    expected: ['FRONTMATTER_INVALID_YAML'],
  },
  {
    label: 'frontmatter that is not a mapping',
    filename: 'reviewer.md',
    content: '---\n- a list\n---\n\nThe body.\n',
    expected: ['FRONTMATTER_NOT_A_MAP'],
  },
  {
    label: 'a description that is not a string',
    filename: 'reviewer.md',
    content: '---\ndescription: 42\n---\n\nThe body.\n',
    expected: ['INVALID_DESCRIPTION'],
    // An instruction may have no description at all, so it survives losing a
    // malformed one. An agent or command cannot.
    emitted: (kind) => !kind.requiresDescription,
  },
  {
    label: 'a blank description',
    filename: 'reviewer.md',
    content: '---\ndescription: "   "\n---\n\nThe body.\n',
    expected: ['INVALID_DESCRIPTION'],
    emitted: (kind) => !kind.requiresDescription,
  },
  {
    label: 'a missing description',
    filename: 'reviewer.md',
    content: '---\n---\n\nThe body.\n',
    // The one documented asymmetry: an instruction may omit it.
    expected: (kind) => (kind.requiresDescription ? ['MISSING_DESCRIPTION'] : []),
  },
  {
    label: 'an empty body',
    filename: 'reviewer.md',
    content: '---\ndescription: A description\n---\n\n',
    expected: (kind) => [kind.emptyBodyCode],
  },
  {
    label: 'a body of whitespace only',
    filename: 'reviewer.md',
    content: '---\ndescription: A description\n---\n\n   \n\t\n',
    expected: (kind) => [kind.emptyBodyCode],
  },
  {
    label: 'an empty body and a missing description',
    filename: 'reviewer.md',
    content: '---\n---\n\n',
    expected: (kind) =>
      kind.requiresDescription ? ['MISSING_DESCRIPTION', kind.emptyBodyCode] : [kind.emptyBodyCode],
  },
  {
    label: 'a UTF-16 encoded file',
    filename: 'reviewer.md',
    content: Buffer.from(`\uFEFF${VALID}`, 'utf16le'),
    expected: ['UNSUPPORTED_ENCODING'],
  },
  {
    label: 'a symbolic link',
    filename: 'reviewer.md',
    content: '',
    symlink: true,
    expected: ['SYMLINK_SKIPPED'],
  },
];

const codesOf = (kind: KindUnderTest, testCase: Case): readonly DiagnosticCode[] =>
  typeof testCase.expected === 'function' ? testCase.expected(kind) : testCase.expected;

const emittedBy = (kind: KindUnderTest, testCase: Case): boolean => {
  if (testCase.emitted === undefined) {
    return codesOf(kind, testCase).length === 0;
  }
  return typeof testCase.emitted === 'function' ? testCase.emitted(kind) : testCase.emitted;
};

describe('canonical validation, on every markdown artifact kind', () => {
  for (const testCase of CASES) {
    for (const kind of KINDS) {
      const expected = codesOf(kind, testCase);
      const sourcePath = `.ai/${kind.directory}/${testCase.filename}`;

      it(`${kind.label}: ${testCase.label} → ${expected.length === 0 ? 'accepted' : expected.join(', ')}`, async () => {
        const result = await discover((fileSystem) => {
          if (testCase.symlink === true) {
            fileSystem.setSymlink(sourcePath);
            return;
          }
          fileSystem.set(sourcePath, testCase.content);
        });

        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([...expected]);

        // Every diagnostic points at the file the author has to open.
        for (const diagnostic of result.diagnostics) {
          expect(diagnostic.source).toBe(sourcePath);
        }

        // Whether the artifact still reaches the intermediate representation.
        // It never reaches a provider while an error stands, but a half-read
        // artifact must not be assembled from fields that failed validation.
        expect(result.configuration[kind.collection]).toHaveLength(
          emittedBy(kind, testCase) ? 1 : 0,
        );
      });
    }
  }
});

describe('canonical validation: reported positions', () => {
  const withLine: readonly {
    label: string;
    content: string;
    code: DiagnosticCode;
    line: number;
  }[] = [
    {
      label: 'an unknown field',
      content: '---\ndescription: A description\nunknownField: value\n---\n\nThe body.\n',
      code: 'UNKNOWN_FRONTMATTER_KEY',
      line: 3,
    },
    {
      label: 'a name mismatch',
      content: '---\ndescription: A description\nname: other\n---\n\nThe body.\n',
      code: 'NAME_MISMATCH',
      line: 3,
    },
    {
      label: 'an invalid description',
      content: '---\nname: reviewer\ndescription: 42\n---\n\nThe body.\n',
      code: 'INVALID_DESCRIPTION',
      line: 3,
    },
  ];

  for (const entry of withLine) {
    for (const kind of KINDS) {
      it(`${kind.label}: reports the line of ${entry.label}`, async () => {
        const result = await discover((fileSystem) => {
          fileSystem.set(`.ai/${kind.directory}/reviewer.md`, entry.content);
        });

        const diagnostic = result.diagnostics.find((candidate) => candidate.code === entry.code);
        expect(diagnostic?.line).toBe(entry.line);
      });
    }
  }
});

describe('canonical validation: what is ignored rather than reported', () => {
  for (const kind of KINDS) {
    it(`${kind.label}: ignores dotfiles and files that are not markdown`, async () => {
      const result = await discover((fileSystem) => {
        fileSystem.set(`.ai/${kind.directory}/.hidden.md`, VALID);
        fileSystem.set(`.ai/${kind.directory}/notes.txt`, 'plain text');
        fileSystem.set(`.ai/${kind.directory}/README`, 'no extension');
      });

      expect(result.diagnostics).toEqual([]);
      expect(result.configuration[kind.collection]).toEqual([]);
    });

    it(`${kind.label}: keeps reading after a bad file, so one error does not hide the rest`, async () => {
      const result = await discover((fileSystem) => {
        fileSystem.set(`.ai/${kind.directory}/broken.md`, '---\n- a list\n---\n\nThe body.\n');
        fileSystem.set(`.ai/${kind.directory}/reviewer.md`, VALID);
      });

      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        'FRONTMATTER_NOT_A_MAP',
      ]);
      expect(result.configuration[kind.collection]).toHaveLength(1);
    });
  }
});

describe('canonical validation: instruction scoping', () => {
  const scoping: readonly {
    label: string;
    applyTo: string;
    expected: readonly DiagnosticCode[];
  }[] = [
    { label: 'a single glob as a string', applyTo: "applyTo: 'src/**'", expected: [] },
    { label: 'a list of globs', applyTo: 'applyTo:\n  - "src/**"\n  - "test/**"', expected: [] },
    { label: 'an empty list', applyTo: 'applyTo: []', expected: ['INSTRUCTION_EMPTY_APPLY_TO'] },
    { label: 'an absolute path', applyTo: "applyTo: '/src/**'", expected: ['INVALID_APPLY_TO'] },
    {
      label: 'a Windows drive path',
      applyTo: "applyTo: 'C:/src/**'",
      expected: ['INVALID_APPLY_TO'],
    },
    {
      label: 'a backslash separator',
      applyTo: "applyTo: 'src\\\\**'",
      expected: ['INVALID_APPLY_TO'],
    },
    { label: 'an empty pattern', applyTo: "applyTo: '   '", expected: ['INVALID_APPLY_TO'] },
    {
      label: 'a value that is not a string',
      applyTo: 'applyTo: 42',
      expected: ['INVALID_APPLY_TO'],
    },
    {
      label: 'a list holding a non-string',
      applyTo: 'applyTo:\n  - 42',
      expected: ['INVALID_APPLY_TO'],
    },
  ];

  for (const entry of scoping) {
    it(`${entry.label} → ${entry.expected.length === 0 ? 'accepted' : entry.expected.join(', ')}`, async () => {
      const result = await discover((fileSystem) => {
        fileSystem.set(
          '.ai/instructions/backend.md',
          `---\ndescription: Backend rules\n${entry.applyTo}\n---\n\nThe body.\n`,
        );
      });

      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([...entry.expected]);
      // A rejected scope never silently becomes "applies everywhere": the
      // instruction is still parsed, but the sync is blocked by the error.
      expect(result.configuration.instructions).toHaveLength(1);
    });
  }
});

describe('canonical validation: where skills deliberately differ', () => {
  it('preserves frontmatter fields it does not know, unlike every other kind', async () => {
    // A skill directory is copied byte-for-byte to every provider, so a field
    // AI Config does not recognize may well be one the provider does. The
    // other kinds are re-serialized, and an unknown field there has nowhere to
    // go — which is why they report it.
    const result = await discover((fileSystem) => {
      fileSystem.set(
        '.ai/skills/code-review/SKILL.md',
        '---\nname: code-review\ndescription: Reviews a change\nlicense: MIT\nallowed-tools: Read\n---\n\nThe steps.\n',
      );
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.configuration.skills[0]?.entrypointKeys).toEqual([
      'name',
      'description',
      'license',
      'allowed-tools',
    ]);
  });

  it('requires the name field, which the other kinds take from the filename', async () => {
    const result = await discover((fileSystem) => {
      fileSystem.set(
        '.ai/skills/code-review/SKILL.md',
        '---\ndescription: Reviews\n---\n\nSteps.\n',
      );
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['SKILL_NAME_MISSING']);
  });

  it('reports a directory with no entrypoint, which has no equivalent elsewhere', async () => {
    const result = await discover((fileSystem) => {
      fileSystem.set('.ai/skills/code-review/references/checklist.md', '# Checklist\n');
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['SKILL_MISSING']);
    expect(result.configuration.skills).toEqual([]);
  });

  it('shares the name and description rules with every other kind', async () => {
    const mismatch = await discover((fileSystem) => {
      fileSystem.set(
        '.ai/skills/code-review/SKILL.md',
        '---\nname: other\ndescription: Reviews\n---\n\nSteps.\n',
      );
    });
    expect(mismatch.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['NAME_MISMATCH']);

    const overlong = await discover((fileSystem) => {
      fileSystem.set(
        '.ai/skills/code-review/SKILL.md',
        `---\nname: code-review\ndescription: ${'x'.repeat(1025)}\n---\n\nSteps.\n`,
      );
    });
    expect(overlong.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'SKILL_DESCRIPTION_LENGTH',
    ]);
  });
});

/**
 * Every way a skill directory can be wrong.
 *
 * A skill is the one artifact AI Config copies rather than re-serializes, so it
 * is read through its own directory-walking path with its own diagnostics,
 * several of which guard portability and traversal rather than authoring
 * mistakes. Those are the ones nobody writes a test for by hand, and they are
 * the ones that decide what leaves the repository.
 */

/** The codes the skill reader owns. Stated so the table cannot leave one out. */
const SKILL_CODES: readonly DiagnosticCode[] = [
  'SKILL_MISSING',
  'SKILL_FRONTMATTER_MISSING',
  'SKILL_NAME_INVALID',
  'SKILL_NAME_MISSING',
  'SKILL_DESCRIPTION_MISSING',
  'SKILL_DESCRIPTION_LENGTH',
  'SKILL_ENTRYPOINT_NOT_A_FILE',
  'SKILL_FILE_UNSAFE_NAME',
  'SKILL_SYMLINK_SKIPPED',
  'SKILL_DEPTH_EXCEEDED',
];

const VALID_SKILL = '---\nname: code-review\ndescription: Reviews a change\n---\n\nSteps.\n';

/** A path nested one level beyond the traversal limit. */
const TOO_DEEP = Array.from({ length: 17 }, (_unused, index) => `d${String(index)}`).join('/');

interface SkillCase {
  readonly label: string;
  readonly seed: (fileSystem: MemoryFileSystem) => void;
  readonly expected: readonly DiagnosticCode[];
  /** Whether the skill still reaches the intermediate representation. */
  readonly collected: boolean;
}

const SKILL_CASES: readonly SkillCase[] = [
  {
    label: 'a well-formed skill',
    seed: (fileSystem) => {
      fileSystem.set('.ai/skills/code-review/SKILL.md', VALID_SKILL);
    },
    expected: [],
    collected: true,
  },
  {
    label: 'a directory with no entrypoint',
    seed: (fileSystem) => {
      fileSystem.set('.ai/skills/code-review/references/checklist.md', '# Checklist\n');
    },
    expected: ['SKILL_MISSING'],
    collected: false,
  },
  {
    label: 'an entrypoint with no frontmatter',
    seed: (fileSystem) => {
      fileSystem.set('.ai/skills/code-review/SKILL.md', 'Steps, but no frontmatter.\n');
    },
    expected: ['SKILL_FRONTMATTER_MISSING'],
    collected: false,
  },
  {
    label: 'a directory name that is not a canonical name',
    seed: (fileSystem) => {
      fileSystem.set('.ai/skills/Code_Review/SKILL.md', VALID_SKILL);
    },
    expected: ['SKILL_NAME_INVALID'],
    collected: false,
  },
  {
    label: 'an entrypoint with no name',
    seed: (fileSystem) => {
      fileSystem.set('.ai/skills/code-review/SKILL.md', '---\ndescription: Reviews\n---\n\nS.\n');
    },
    expected: ['SKILL_NAME_MISSING'],
    collected: false,
  },
  {
    label: 'an entrypoint with no description',
    seed: (fileSystem) => {
      fileSystem.set('.ai/skills/code-review/SKILL.md', '---\nname: code-review\n---\n\nS.\n');
    },
    expected: ['SKILL_DESCRIPTION_MISSING'],
    collected: false,
  },
  {
    label: 'a description beyond the documented limit',
    seed: (fileSystem) => {
      fileSystem.set(
        '.ai/skills/code-review/SKILL.md',
        `---\nname: code-review\ndescription: ${'x'.repeat(1025)}\n---\n\nS.\n`,
      );
    },
    expected: ['SKILL_DESCRIPTION_LENGTH'],
    collected: false,
  },
  {
    // Following it would parse a file that may sit outside the repository,
    // while the copy step would refuse to include it.
    label: 'an entrypoint that is a symbolic link',
    seed: (fileSystem) => {
      fileSystem.setSymlink('.ai/skills/code-review/SKILL.md');
    },
    expected: ['SKILL_ENTRYPOINT_NOT_A_FILE'],
    collected: false,
  },
  {
    label: 'a skill directory that is a symbolic link',
    seed: (fileSystem) => {
      fileSystem.setSymlink('.ai/skills/code-review');
    },
    expected: ['SKILL_SYMLINK_SKIPPED'],
    collected: false,
  },
  {
    // A supporting file may be named anything, so the name is checked against
    // the same rules as any generated path rather than assumed portable.
    label: 'a supporting file named after a Windows device',
    seed: (fileSystem) => {
      fileSystem.set('.ai/skills/code-review/SKILL.md', VALID_SKILL);
      fileSystem.set('.ai/skills/code-review/aux.md', 'Notes.\n');
    },
    expected: ['SKILL_FILE_UNSAFE_NAME'],
    collected: true,
  },
  {
    label: 'a supporting file that is a symbolic link',
    seed: (fileSystem) => {
      fileSystem.set('.ai/skills/code-review/SKILL.md', VALID_SKILL);
      fileSystem.setSymlink('.ai/skills/code-review/notes.md');
    },
    expected: ['SKILL_SYMLINK_SKIPPED'],
    collected: true,
  },
  {
    label: 'a directory tree deeper than the traversal limit',
    seed: (fileSystem) => {
      fileSystem.set('.ai/skills/code-review/SKILL.md', VALID_SKILL);
      fileSystem.set(`.ai/skills/code-review/${TOO_DEEP}/buried.md`, 'Too deep.\n');
    },
    expected: ['SKILL_DEPTH_EXCEEDED'],
    collected: true,
  },
];

describe('skill validation', () => {
  it('covers every diagnostic the skill reader can raise', () => {
    const covered = new Set(SKILL_CASES.flatMap((testCase) => testCase.expected));
    expect(SKILL_CODES.filter((code) => !covered.has(code))).toEqual([]);
  });

  for (const testCase of SKILL_CASES) {
    it(`${testCase.label} → ${testCase.expected.length === 0 ? 'accepted' : testCase.expected.join(', ')}`, async () => {
      const result = await discover(testCase.seed);

      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        ...testCase.expected,
      ]);
      expect(result.configuration.skills).toHaveLength(testCase.collected ? 1 : 0);

      // Every skill diagnostic points inside the skills tree, which is where
      // the author has to look.
      for (const diagnostic of result.diagnostics) {
        expect(diagnostic.source?.startsWith('.ai/skills/'), diagnostic.code).toBe(true);
      }
    });
  }

  it('leaves out only the file that cannot travel, not the skill', async () => {
    const result = await discover((fileSystem) => {
      fileSystem.set('.ai/skills/code-review/SKILL.md', VALID_SKILL);
      fileSystem.set('.ai/skills/code-review/aux.md', 'Notes.\n');
      fileSystem.set('.ai/skills/code-review/references/checklist.md', '# Checklist\n');
    });

    expect(result.configuration.skills[0]?.files.map((file) => file.relativePath)).toEqual([
      'SKILL.md',
      'references/checklist.md',
    ]);
  });

  it('reports the traversal limit as a warning, not an error', async () => {
    // Content that deep is almost certainly not meant for a provider, but
    // refusing the whole skill over it would be worse than trimming it.
    const result = await discover((fileSystem) => {
      fileSystem.set('.ai/skills/code-review/SKILL.md', VALID_SKILL);
      fileSystem.set(`.ai/skills/code-review/${TOO_DEEP}/buried.md`, 'Too deep.\n');
    });

    expect(result.diagnostics[0]?.severity).toBe('warning');
    expect(result.configuration.skills[0]?.files.map((file) => file.relativePath)).toEqual([
      'SKILL.md',
    ]);
  });
});

/**
 * What the reader does when the filesystem misbehaves.
 *
 * `FileSystem` is an interface, and the reader is written not to trust it: two
 * of its diagnostics cannot be provoked through a well-behaved implementation
 * at all. `DUPLICATE_NAME` guards against a directory listing that reports one
 * entry twice; `SKILL_EMPTY` against an entrypoint that vanishes between being
 * listed and being collected, which on a real filesystem is a file deleted
 * mid-scan.
 *
 * Both are reachable in production and unreachable from a fixture, so they are
 * driven from a filesystem that behaves that way on purpose. Without this the
 * two branches would be permanently untested and quietly rot.
 */
describe('canonical validation: an unreliable filesystem', () => {
  const seedValid = (fileSystem: MemoryFileSystem): void => {
    fileSystem.set('.ai/config.yaml', 'schema: 1\nproviders:\n  enabled: [claude]\n');
  };

  class RepeatingDirectory extends MemoryFileSystem {
    public constructor(private readonly repeated: string) {
      super();
    }

    public override async readDirectory(target: string): Promise<readonly DirectoryEntry[]> {
      const entries = await super.readDirectory(target);
      return target.replace(/\\/g, '/').endsWith(this.repeated)
        ? [...entries, ...entries]
        : entries;
    }
  }

  it('reports a repeated markdown artifact rather than reading it twice', async () => {
    const fileSystem = new RepeatingDirectory('.ai/agents');
    seedValid(fileSystem);
    fileSystem.set('.ai/agents/reviewer.md', '---\ndescription: Reviews\n---\n\nYou review.\n');

    const result = await discoverConfiguration(fileSystem, fileSystem.root);

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['DUPLICATE_NAME']);
    expect(result.configuration.agents).toHaveLength(1);
  });

  it('reports a repeated skill directory rather than collecting it twice', async () => {
    const fileSystem = new RepeatingDirectory('.ai/skills');
    seedValid(fileSystem);
    fileSystem.set('.ai/skills/code-review/SKILL.md', VALID_SKILL);

    const result = await discoverConfiguration(fileSystem, fileSystem.root);

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['DUPLICATE_NAME']);
    expect(result.configuration.skills).toHaveLength(1);
  });

  it('refuses a skill whose entrypoint disappears while it is being collected', async () => {
    class VanishingEntrypoint extends MemoryFileSystem {
      private reads = 0;

      public override readFile(target: string): Promise<Buffer | undefined> {
        if (target.replace(/\\/g, '/').endsWith('/SKILL.md')) {
          this.reads += 1;
          // The first read is the entrypoint parse; the second is the copy
          // step collecting the same file.
          if (this.reads > 1) {
            return Promise.resolve(undefined);
          }
        }
        return super.readFile(target);
      }
    }

    const fileSystem = new VanishingEntrypoint();
    seedValid(fileSystem);
    fileSystem.set('.ai/skills/code-review/SKILL.md', VALID_SKILL);

    const result = await discoverConfiguration(fileSystem, fileSystem.root);

    // A skill assembled without its entrypoint would be copied to every
    // provider and loadable by none, so it is refused rather than shipped.
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['SKILL_EMPTY']);
    expect(result.configuration.skills).toEqual([]);
  });
});
