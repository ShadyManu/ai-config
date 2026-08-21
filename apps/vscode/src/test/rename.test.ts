import * as assert from 'node:assert/strict';

import type { AiConfiguration, AnalysisResult, NameMismatch, SourceKind } from '@aiconfig/core';

import type { RenameDirection } from '../rename-direction.js';
import {
  decideRenameDirection,
  detectedRenames,
  identitiesOf,
  mergeRenames,
  questionKey,
} from '../rename-direction.js';

const mismatch = (kind: SourceKind, pathName: string, declaredName: string): NameMismatch => ({
  kind,
  pathName,
  declaredName,
  sourcePath: kind === 'skill' ? `.ai/skills/${pathName}/SKILL.md` : `.ai/${kind}s/${pathName}.md`,
});

const known = (...identities: readonly string[]): ReadonlySet<string> => new Set(identities);

/**
 * Which half of a rename the author performed.
 *
 * The wrong answer here is not a cosmetic one: assume the frontmatter always
 * wins and renaming a directory in the explorer gets renamed back, over and
 * over, with no way to stop it. The input space is four cases and they are
 * enumerated rather than sampled.
 */
suite('following a rename', () => {
  const CASES: readonly {
    readonly what: string;
    readonly before: ReadonlySet<string>;
    readonly expected: RenameDirection;
  }[] = [
    {
      what: 'the frontmatter was edited, so the old name is still the path',
      before: known('skill:scouts'),
      expected: 'rename-path',
    },
    {
      what: 'the directory was renamed, so the old name is still in the frontmatter',
      before: known('skill:scout'),
      expected: 'align-name',
    },
    {
      what: 'neither name was there before, so nothing says which was edited',
      before: known('skill:something-else'),
      expected: 'ask',
    },
    {
      what: 'both names are real artifacts, which no rename can resolve',
      before: known('skill:scouts', 'skill:scout'),
      expected: 'ask',
    },
  ];

  for (const { what, before, expected } of CASES) {
    test(`${expected} when ${what}`, () => {
      assert.equal(decideRenameDirection(mismatch('skill', 'scouts', 'scout'), before), expected);
    });
  }

  test('never confuses two kinds that happen to share a name', () => {
    // `agent:review` existing says nothing about a skill called `review`.
    assert.equal(
      decideRenameDirection(mismatch('skill', 'reviews', 'review'), known('agent:reviews')),
      'ask',
    );
  });

  test('identifies a question by both names, so a new mistake is asked about again', () => {
    assert.equal(questionKey(mismatch('skill', 'scouts', 'scout')), 'skill:scouts:scout');
    assert.notEqual(
      questionKey(mismatch('skill', 'scouts', 'scout')),
      questionKey(mismatch('skill', 'scouts', 'scouting')),
    );
  });
});

/**
 * A rename that leaves no evidence in the file.
 *
 * An instruction, agent or command scaffolded by AI Config carries no `name`
 * field, so renaming its file is indistinguishable from deleting one artifact
 * and creating another — and that cost the author every provider override
 * written for it, deleted as an orphan by the next synchronization.
 *
 * Content is the identity that survives, and these enumerate what does and does
 * not count as evidence of one.
 */
suite('recognizing a rename by what the artifact says', () => {
  const agent = (name: string, body: string): AiConfiguration['agents'][number] => ({
    name,
    description: 'Reviews',
    body,
    sourcePath: `.ai/agents/${name}.md`,
  });

  const configuration = (
    agents: readonly AiConfiguration['agents'][number][],
    commands: readonly AiConfiguration['commands'][number][] = [],
  ): AiConfiguration => ({ instructions: [], agents, skills: [], commands });

  test('matches an artifact that only changed name', () => {
    assert.deepEqual(
      detectedRenames(
        configuration([agent('reviewer', 'You review.')]),
        configuration([agent('auditor', 'You review.')]),
      ),
      [{ kind: 'agent', from: 'reviewer', to: 'auditor' }],
    );
  });

  test('says nothing when the content changed too', () => {
    // Renamed and edited in one save. Reporting a rename here would be a guess,
    // and the cost of guessing wrong is one artifact wearing another's settings.
    assert.deepEqual(
      detectedRenames(
        configuration([agent('reviewer', 'You review.')]),
        configuration([agent('auditor', 'You review carefully.')]),
      ),
      [],
    );
  });

  test('says nothing when two artifacts read exactly the same', () => {
    // A copy and a rename look identical from here, so neither is evidence.
    assert.deepEqual(
      detectedRenames(
        configuration([agent('reviewer', 'Same.'), agent('checker', 'Same.')]),
        configuration([agent('auditor', 'Same.'), agent('checker', 'Same.')]),
      ),
      [],
    );
  });

  test('says nothing about an artifact that was simply deleted', () => {
    // Deleting an artifact still takes its overrides with it, which is what
    // Delete… and `aiconfig remove` have always done.
    assert.deepEqual(
      detectedRenames(configuration([agent('reviewer', 'You review.')]), configuration([])),
      [],
    );
  });

  test('says nothing about one that was simply added', () => {
    assert.deepEqual(
      detectedRenames(configuration([]), configuration([agent('auditor', 'New.')])),
      [],
    );
  });

  test('never matches across kinds', () => {
    const command = {
      name: 'reviewer',
      description: 'Reviews',
      body: 'You review.',
      sourcePath: '.ai/commands/reviewer.md',
    };
    assert.deepEqual(
      detectedRenames(
        configuration([agent('reviewer', 'You review.')]),
        configuration([], [command]),
      ),
      [],
    );
  });

  test('says nothing before there is a previous refresh to compare against', () => {
    assert.deepEqual(detectedRenames(undefined, configuration([agent('auditor', 'New.')])), []);
  });

  test('follows several renames in one save', () => {
    assert.deepEqual(
      detectedRenames(
        configuration([agent('one', 'First.'), agent('two', 'Second.')]),
        configuration([agent('uno', 'First.'), agent('due', 'Second.')]),
      ),
      [
        { kind: 'agent', from: 'one', to: 'uno' },
        { kind: 'agent', from: 'two', to: 'due' },
      ],
    );
  });
});

suite('two sources of evidence for one rename', () => {
  const rename = (from: string, to: string) => ({ kind: 'agent' as const, from, to });

  test('keeps a rename only the editor reported', () => {
    assert.deepEqual(mergeRenames([rename('reviewer', 'auditor')], []), [
      rename('reviewer', 'auditor'),
    ]);
  });

  test('keeps a rename only the content matched', () => {
    assert.deepEqual(mergeRenames([], [rename('reviewer', 'auditor')]), [
      rename('reviewer', 'auditor'),
    ]);
  });

  test('prefers what the editor reported when the two disagree', () => {
    // The editor states a fact; matching two snapshots infers one. A conflict
    // means the inference matched the wrong artifact, and following both would
    // move the overrides somewhere nobody asked for.
    assert.deepEqual(
      mergeRenames([rename('reviewer', 'auditor')], [rename('reviewer', 'checker')]),
      [rename('reviewer', 'auditor')],
    );
  });

  test('reports one rename once when both sources agree', () => {
    assert.deepEqual(
      mergeRenames([rename('reviewer', 'auditor')], [rename('reviewer', 'auditor')]),
      [rename('reviewer', 'auditor')],
    );
  });

  test('keeps renames of different artifacts side by side', () => {
    assert.deepEqual(mergeRenames([rename('one', 'uno')], [rename('two', 'due')]), [
      rename('one', 'uno'),
      rename('two', 'due'),
    ]);
  });
});

suite('the names a refresh remembers', () => {
  const analysis = (): AnalysisResult =>
    ({
      project: {
        configuration: {
          instructions: [{ name: 'general' }],
          agents: [{ name: 'reviewer' }],
          skills: [{ name: 'scouts' }],
          commands: [{ name: 'ship' }],
        },
      },
    }) as unknown as AnalysisResult;

  test('records every canonical name, tagged with its kind', () => {
    assert.deepEqual([...identitiesOf(analysis())].sort(), [
      'agent:reviewer',
      'command:ship',
      'instruction:general',
      'skill:scouts',
    ]);
  });

  test('remembers nothing when there is no analysis, so the next mismatch is asked about', () => {
    // A project that fails to load must not let a stale set decide a rename.
    assert.deepEqual([...identitiesOf(undefined)], []);
  });
});
