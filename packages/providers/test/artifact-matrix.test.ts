import { describe, expect, it } from 'vitest';

import type {
  AiConfiguration,
  CapabilityClassification,
  DiagnosticCode,
  ProviderId,
} from '@aiconfig/core';
import { compile } from '@aiconfig/core';

import { createDefaultAdapters } from '../src/index.js';
import {
  EMPTY_CONFIGURATION as EMPTY,
  adapterFor,
  agent,
  command,
  configurationOf,
  instruction,
  skill,
} from './helpers/canonical.js';

/**
 * The generated-output and capability tables in `docs/user-guide.md` and
 * `docs/provider-capabilities.md`, as executable assertions.
 *
 * Every adapter has its own fixture test, but each compiles one repository
 * holding every artifact kind at once. That answers "what does this provider
 * produce for this project?" and not "what does each kind produce, on each
 * provider, on its own?" — which is the question the documentation answers, and
 * the one a reader relies on. Here each kind is compiled in isolation against
 * all four adapters, so the whole 5 × 4 grid is stated in one place and a
 * mapping cannot change without this file changing with it.
 */

/** One row of the documented mapping: what a single kind produces, per provider. */
interface KindCase {
  readonly label: string;
  readonly configuration: AiConfiguration;
  /** Generated paths per provider, exactly — an empty list means nothing. */
  readonly outputs: Readonly<Record<ProviderId, readonly string[]>>;
  /** Compatibility diagnostics per provider, exactly. */
  readonly diagnostics: Readonly<
    Record<ProviderId, readonly { code: DiagnosticCode; capability: CapabilityClassification }[]>
  >;
}

const NO_DIAGNOSTICS: KindCase['diagnostics'] = {
  claude: [],
  codex: [],
  copilot: [],
  opencode: [],
};

const CASES: readonly KindCase[] = [
  {
    label: 'an empty project',
    configuration: EMPTY,
    outputs: { claude: [], codex: [], copilot: [], opencode: [] },
    diagnostics: NO_DIAGNOSTICS,
  },

  {
    label: 'an unscoped instruction',
    configuration: configurationOf({ instructions: [instruction('general')] }),
    outputs: {
      claude: ['.claude/rules/general.md'],
      codex: ['AGENTS.md'],
      copilot: ['.github/copilot-instructions.md'],
      opencode: ['AGENTS.md'],
    },
    diagnostics: NO_DIAGNOSTICS,
  },

  {
    label: 'a path-scoped instruction',
    configuration: configurationOf({ instructions: [instruction('backend', ['backend/**'])] }),
    outputs: {
      claude: ['.claude/rules/backend.md'],
      codex: ['AGENTS.md'],
      // A project whose every instruction is scoped produces no
      // repository-wide Copilot file at all.
      copilot: ['.github/instructions/backend.instructions.md'],
      opencode: ['AGENTS.md'],
    },
    diagnostics: {
      claude: [],
      codex: [{ code: 'INSTRUCTION_SCOPE_NOT_SUPPORTED', capability: 'lossy' }],
      copilot: [],
      opencode: [{ code: 'INSTRUCTION_SCOPE_NOT_SUPPORTED', capability: 'lossy' }],
    },
  },

  {
    label: 'an agent',
    configuration: configurationOf({ agents: [agent('reviewer')] }),
    outputs: {
      claude: ['.claude/agents/reviewer.md'],
      codex: ['.codex/agents/reviewer.toml'],
      copilot: ['.github/agents/reviewer.agent.md'],
      opencode: ['.opencode/agents/reviewer.md'],
    },
    diagnostics: NO_DIAGNOSTICS,
  },

  {
    label: 'a skill',
    configuration: configurationOf({ skills: [skill('code-review')] }),
    outputs: {
      claude: [
        '.claude/skills/code-review/SKILL.md',
        '.claude/skills/code-review/references/checklist.md',
      ],
      codex: [
        '.agents/skills/code-review/SKILL.md',
        '.agents/skills/code-review/references/checklist.md',
      ],
      copilot: [
        '.github/skills/code-review/SKILL.md',
        '.github/skills/code-review/references/checklist.md',
      ],
      opencode: [
        '.opencode/skills/code-review/SKILL.md',
        '.opencode/skills/code-review/references/checklist.md',
      ],
    },
    diagnostics: NO_DIAGNOSTICS,
  },

  {
    label: 'a command',
    configuration: configurationOf({ commands: [command('fix-bug')] }),
    outputs: {
      claude: ['.claude/commands/fix-bug.md'],
      // Codex has no repository-scoped command mechanism, so a command becomes
      // a skill whose sidecar switches implicit selection off.
      codex: ['.agents/skills/fix-bug/SKILL.md', '.agents/skills/fix-bug/agents/openai.yaml'],
      copilot: ['.github/prompts/fix-bug.prompt.md'],
      opencode: ['.opencode/commands/fix-bug.md'],
    },
    diagnostics: {
      claude: [],
      codex: [{ code: 'COMMAND_CONVERTED_TO_SKILL', capability: 'exact' }],
      copilot: [{ code: 'COMMAND_LIMITED_SURFACE', capability: 'lossy' }],
      opencode: [],
    },
  },
];

const PROVIDERS: readonly ProviderId[] = createDefaultAdapters()
  .map((adapter) => adapter.id)
  .sort();

describe('generated output, per artifact kind and provider', () => {
  for (const testCase of CASES) {
    for (const provider of PROVIDERS) {
      it(`${provider} generates the documented files for ${testCase.label}`, () => {
        const result = compile(testCase.configuration, [adapterFor(provider)]);

        expect(result.artifacts.map((artifact) => artifact.path)).toEqual(
          [...testCase.outputs[provider]].sort(),
        );
        // Every file is attributed to the adapter that produced it, whatever
        // else is enabled.
        for (const artifact of result.artifacts) {
          expect(artifact.providers).toEqual([provider]);
        }
      });

      it(`${provider} reports the documented capability for ${testCase.label}`, () => {
        const result = compile(testCase.configuration, [adapterFor(provider)]);
        const expected = testCase.diagnostics[provider];

        expect(
          result.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            capability: diagnostic.capability,
          })),
        ).toEqual([...expected]);

        // A reduction in fidelity is never silent, and never an error: the
        // artifact still reaches the provider.
        expect(result.diagnostics.every((diagnostic) => diagnostic.severity !== 'error')).toBe(
          true,
        );
        for (const diagnostic of result.diagnostics) {
          expect(diagnostic.provider).toBe(provider);
          expect(diagnostic.source).not.toBeUndefined();
        }
      });
    }
  }
});

describe('generated output: composition', () => {
  const everything = configurationOf({
    instructions: [instruction('general'), instruction('backend', ['backend/**'])],
    agents: [agent('reviewer')],
    skills: [skill('code-review')],
    commands: [command('fix-bug')],
  });

  it('produces exactly the union of what each kind produces alone', () => {
    // Compiling several kinds together must not add, drop or move a file
    // compared with compiling each on its own — the aggregate files are the
    // only place kinds meet, and they meet by concatenation.
    for (const provider of PROVIDERS) {
      const union = new Set(CASES.flatMap((testCase) => testCase.outputs[provider]));
      const combined = compile(everything, [adapterFor(provider)]);

      expect([...combined.artifacts.map((artifact) => artifact.path)].sort(), provider).toEqual(
        [...union].sort(),
      );
    }
  });

  it('reports exactly the union of what each kind reports alone', () => {
    for (const provider of PROVIDERS) {
      const expected = CASES.flatMap((testCase) =>
        testCase.diagnostics[provider].map((entry) => entry.code),
      ).sort();
      const combined = compile(everything, [adapterFor(provider)]);

      expect(combined.diagnostics.map((diagnostic) => diagnostic.code).sort(), provider).toEqual(
        expected,
      );
    }
  });

  it('ends every generated text file with exactly one newline', () => {
    for (const provider of PROVIDERS) {
      for (const artifact of compile(everything, [adapterFor(provider)]).artifacts) {
        if (artifact.content.kind !== 'text') {
          continue;
        }
        expect(artifact.content.value.endsWith('\n'), artifact.path).toBe(true);
        expect(artifact.content.value.endsWith('\n\n'), artifact.path).toBe(false);
      }
    }
  });

  it('compiles deterministically for every kind and provider', () => {
    for (const testCase of CASES) {
      for (const provider of PROVIDERS) {
        const first = compile(testCase.configuration, [adapterFor(provider)]);
        const second = compile(testCase.configuration, [adapterFor(provider)]);
        expect(JSON.stringify(second), `${provider}: ${testCase.label}`).toBe(
          JSON.stringify(first),
        );
      }
    }
  });
});

describe('generated output: skill payloads', () => {
  it('references canonical bytes rather than re-serializing them, on every provider', () => {
    // A skill is the user's own directory. Copying it verbatim is what keeps a
    // field a provider understands and AI Config does not from being dropped.
    const configuration = configurationOf({ skills: [skill('code-review')] });

    for (const provider of PROVIDERS) {
      for (const artifact of compile(configuration, [adapterFor(provider)]).artifacts) {
        expect(artifact.content.kind, `${provider}: ${artifact.path}`).toBe('copy');
        if (artifact.content.kind === 'copy') {
          expect(artifact.content.ref.skill).toBe('code-review');
        }
        // The hash is the canonical file's, so identical payloads across four
        // providers are never re-read or re-hashed.
        expect(artifact.hash.startsWith('sha256:code-review-')).toBe(true);
      }
    }
  });
});
