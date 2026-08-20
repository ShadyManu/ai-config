import { describe, expect, it } from 'vitest';

import { discoverConfiguration } from '../src/parse/discover.js';
import { validateConfiguration } from '../src/validate/validate.js';
import { MemoryFileSystem } from '../src/testing/memory-file-system.js';

const discover = async (seed: (fileSystem: MemoryFileSystem) => void) => {
  const fileSystem = new MemoryFileSystem();
  seed(fileSystem);
  return discoverConfiguration(fileSystem, fileSystem.root);
};

const codes = (diagnostics: readonly { code: string }[]): readonly string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

describe('discoverConfiguration', () => {
  it('returns an empty configuration when no content directories exist', async () => {
    const result = await discover(() => {});
    expect(result.configuration).toEqual({
      instructions: [],
      agents: [],
      skills: [],
      commands: [],
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('reads instructions, agents, skills and commands', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/instructions/general.md', '---\ndescription: General\n---\n\nBe careful.\n');
      fs.set('.ai/agents/reviewer.md', '---\ndescription: Reviews code\n---\n\nYou review.\n');
      fs.set(
        '.ai/skills/code-review/SKILL.md',
        '---\nname: code-review\ndescription: Reviews\n---\n\nSteps.\n',
      );
      fs.set('.ai/commands/fix-bug.md', '---\ndescription: Fixes a bug\n---\n\nFix $ARGUMENTS.\n');
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.configuration.instructions.map((i) => i.name)).toEqual(['general']);
    expect(result.configuration.agents.map((a) => a.name)).toEqual(['reviewer']);
    expect(result.configuration.skills.map((s) => s.name)).toEqual(['code-review']);
    expect(result.configuration.commands.map((c) => c.name)).toEqual(['fix-bug']);
  });

  it('sorts collections by name so adapter output is deterministic', async () => {
    const result = await discover((fs) => {
      for (const name of ['zebra', 'alpha', 'middle']) {
        fs.set(`.ai/agents/${name}.md`, `---\ndescription: ${name}\n---\n\nBody.\n`);
      }
    });

    expect(result.configuration.agents.map((a) => a.name)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('parses applyTo as a list or a single string', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/instructions/list.md', '---\napplyTo:\n  - src/**\n  - lib/**\n---\n\nBody.\n');
      fs.set('.ai/instructions/single.md', '---\napplyTo: "**/*.ts"\n---\n\nBody.\n');
      fs.set('.ai/instructions/none.md', '---\ndescription: Global\n---\n\nBody.\n');
    });

    expect(result.diagnostics).toEqual([]);
    const byName = new Map(result.configuration.instructions.map((i) => [i.name, i]));
    expect(byName.get('list')?.applyTo).toEqual(['src/**', 'lib/**']);
    expect(byName.get('single')?.applyTo).toEqual(['**/*.ts']);
    expect(byName.get('none')?.applyTo).toEqual([]);
  });

  it('rejects an empty applyTo rather than treating it as global', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/instructions/scoped.md', '---\napplyTo: []\n---\n\nBody.\n');
    });
    expect(codes(result.diagnostics)).toContain('INSTRUCTION_EMPTY_APPLY_TO');
  });

  it('rejects applyTo patterns that are not repository-relative', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/instructions/a.md', '---\napplyTo: ["/etc/**"]\n---\n\nBody.\n');
      fs.set('.ai/instructions/b.md', '---\napplyTo: ["C:/Windows/**"]\n---\n\nBody.\n');
      fs.set('.ai/instructions/c.md', '---\napplyTo: ["src\\\\**"]\n---\n\nBody.\n');
    });
    expect(codes(result.diagnostics).filter((c) => c === 'INVALID_APPLY_TO')).toHaveLength(3);
  });

  it('rejects unknown frontmatter keys with the line number', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/agents/reviewer.md', '---\ndescription: Reviews\ntools: Read\n---\n\nBody.\n');
    });
    const diagnostic = result.diagnostics.find((d) => d.code === 'UNKNOWN_FRONTMATTER_KEY');
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.line).toBe(3);
    expect(diagnostic?.source).toBe('.ai/agents/reviewer.md');
  });

  it('requires a description on agents and commands', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/agents/reviewer.md', 'Body without frontmatter.\n');
      fs.set('.ai/commands/fix.md', 'Body without frontmatter.\n');
    });
    expect(codes(result.diagnostics).filter((c) => c === 'MISSING_DESCRIPTION')).toHaveLength(2);
    expect(result.configuration.agents).toEqual([]);
    expect(result.configuration.commands).toEqual([]);
  });

  it('parses a command as an explicit-only canonical artifact', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/commands/fix.md', '---\ndescription: Fixes\n---\n\nFix it.\n');
    });

    expect(result.configuration.commands[0]?.name).toBe('fix');
    expect(result.diagnostics).toEqual([]);
  });

  it.each(['automatic', 'explicit', 'manual', 'true'])(
    'rejects legacy invocation: %s',
    async (value) => {
      const result = await discover((fs) => {
        fs.set(
          '.ai/commands/fix.md',
          `---\ndescription: Fixes\ninvocation: ${value}\n---\n\nFix.\n`,
        );
      });

      const diagnostic = result.diagnostics.find((d) => d.code === 'UNKNOWN_FRONTMATTER_KEY');
      expect(diagnostic?.severity).toBe('error');
      expect(diagnostic?.line).toBe(3);
      expect(diagnostic?.message).toContain('invocation');
      expect(result.configuration.commands).toHaveLength(1);
    },
  );

  it.each(['instructions', 'agents'] as const)(
    'rejects invocation on %s, where the concept does not apply',
    async (directory) => {
      const result = await discover((fs) => {
        fs.set(
          `.ai/${directory}/thing.md`,
          '---\ndescription: Thing\ninvocation: explicit\n---\n\nBody.\n',
        );
      });

      // Silently ignoring it would let an author believe the field did
      // something. `invocation` is not a v1 field anywhere: on an instruction
      // or an agent the concept does not exist at all, and on a command it is
      // fixed to explicit by the canonical semantics — which is why the case
      // below rejects it there too.
      const diagnostic = result.diagnostics.find((d) => d.code === 'UNKNOWN_FRONTMATTER_KEY');
      expect(diagnostic?.message).toContain('invocation');
    },
  );

  it('does not require a description on instructions', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/instructions/general.md', 'Just guidance.\n');
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.configuration.instructions[0]?.description).toBeUndefined();
  });

  it('rejects an empty agent body', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/agents/reviewer.md', '---\ndescription: Reviews\n---\n\n\n');
    });
    expect(codes(result.diagnostics)).toContain('AGENT_BODY_EMPTY');
  });

  it('rejects invalid names', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/agents/Reviewer.md', '---\ndescription: x\n---\n\nBody.\n');
      fs.set('.ai/agents/two words.md', '---\ndescription: x\n---\n\nBody.\n');
      fs.set('.ai/agents/trailing-.md', '---\ndescription: x\n---\n\nBody.\n');
    });
    expect(codes(result.diagnostics).filter((c) => c === 'INVALID_NAME')).toHaveLength(3);
  });

  it('rejects a name that is a Windows reserved device name', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/agents/con.md', '---\ndescription: x\n---\n\nBody.\n');
    });
    expect(codes(result.diagnostics)).toContain('INVALID_NAME');
  });

  it('ignores non-markdown files and dotfiles', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/agents/reviewer.md', '---\ndescription: Reviews\n---\n\nBody.\n');
      fs.set('.ai/agents/notes.txt', 'ignored');
      fs.set('.ai/agents/.hidden.md', '---\ndescription: hidden\n---\n\nBody.\n');
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.configuration.agents.map((a) => a.name)).toEqual(['reviewer']);
  });

  it('skips symbolic links with a warning', async () => {
    const result = await discover((fs) => {
      fs.setSymlink('.ai/agents/linked.md');
    });
    const diagnostic = result.diagnostics.find((d) => d.code === 'SYMLINK_SKIPPED');
    expect(diagnostic?.severity).toBe('warning');
  });
});

describe('discoverConfiguration: skills', () => {
  it('collects supporting files with hashes', async () => {
    const result = await discover((fs) => {
      fs.set(
        '.ai/skills/create-endpoint/SKILL.md',
        '---\nname: create-endpoint\ndescription: Scaffolds\n---\n\nSteps.\n',
      );
      fs.set('.ai/skills/create-endpoint/references/api.md', 'Reference material.\n');
      fs.set('.ai/skills/create-endpoint/scripts/run.sh', '#!/bin/sh\n', { executable: true });
    });

    expect(result.diagnostics).toEqual([]);
    const skill = result.configuration.skills[0];
    expect(skill?.files.map((f) => f.relativePath)).toEqual([
      'SKILL.md',
      'references/api.md',
      'scripts/run.sh',
    ]);
    expect(skill?.files.every((f) => f.sha256.startsWith('sha256:'))).toBe(true);
    expect(skill?.files.find((f) => f.relativePath === 'scripts/run.sh')?.executable).toBe(true);
  });

  it('reports a skill directory with no SKILL.md', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/skills/broken/notes.md', 'No entrypoint.\n');
    });
    expect(codes(result.diagnostics)).toContain('SKILL_MISSING');
    expect(result.configuration.skills).toEqual([]);
  });

  it('requires name and description in SKILL.md frontmatter', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/skills/no-name/SKILL.md', '---\ndescription: Missing name\n---\n\nBody.\n');
      fs.set('.ai/skills/no-description/SKILL.md', '---\nname: no-description\n---\n\nBody.\n');
    });
    expect(codes(result.diagnostics)).toContain('SKILL_NAME_MISSING');
    expect(codes(result.diagnostics)).toContain('SKILL_DESCRIPTION_MISSING');
  });

  it('rejects a frontmatter name that disagrees with the directory name', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/skills/actual/SKILL.md', '---\nname: different\ndescription: x\n---\n\nBody.\n');
    });
    expect(codes(result.diagnostics)).toContain('NAME_MISMATCH');
  });

  it('rejects a description longer than the canonical maximum', async () => {
    const result = await discover((fs) => {
      fs.set(
        '.ai/skills/verbose/SKILL.md',
        `---\nname: verbose\ndescription: ${'x'.repeat(1025)}\n---\n\nBody.\n`,
      );
    });
    expect(codes(result.diagnostics)).toContain('SKILL_DESCRIPTION_LENGTH');
  });

  it('preserves unknown SKILL.md frontmatter keys without complaint', async () => {
    // Providers each accept fields the others ignore, so skills are the one
    // place unknown keys are not an error.
    const result = await discover((fs) => {
      fs.set(
        '.ai/skills/portable/SKILL.md',
        '---\nname: portable\ndescription: x\nlicense: MIT\nallowed-tools: Read\n---\n\nBody.\n',
      );
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.configuration.skills).toHaveLength(1);
  });

  it('skips symbolic links inside a skill directory', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/skills/linked/SKILL.md', '---\nname: linked\ndescription: x\n---\n\nBody.\n');
      fs.setSymlink('.ai/skills/linked/scripts/escape.sh');
    });
    expect(codes(result.diagnostics)).toContain('SKILL_SYMLINK_SKIPPED');
    expect(result.configuration.skills[0]?.files.map((f) => f.relativePath)).toEqual(['SKILL.md']);
  });
});

describe('validateConfiguration', () => {
  it('rejects a skill and a command sharing a name', async () => {
    const result = await discover((fs) => {
      fs.set('.ai/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: x\n---\n\nBody.\n');
      fs.set('.ai/commands/deploy.md', '---\ndescription: x\n---\n\nBody.\n');
    });

    const diagnostics = validateConfiguration(result.configuration);
    expect(codes(diagnostics)).toEqual(['DUPLICATE_INVOCABLE_NAME']);
    expect(diagnostics[0]?.source).toBe('.ai/commands/deploy.md');
  });

  it('allows an agent and a skill to share a name', async () => {
    // They live in different namespaces in every provider.
    const result = await discover((fs) => {
      fs.set('.ai/skills/review/SKILL.md', '---\nname: review\ndescription: x\n---\n\nBody.\n');
      fs.set('.ai/agents/review.md', '---\ndescription: x\n---\n\nBody.\n');
    });

    expect(validateConfiguration(result.configuration)).toEqual([]);
  });
});
