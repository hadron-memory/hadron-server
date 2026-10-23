/**
 * #1103 — the SDL-description enumeration gate.
 *
 * Two things are tested here, and the second is the one that decides whether
 * the gate survives contact with the team:
 *
 *   1. It catches a partial enumeration — the defect it was built for.
 *   2. It does NOT fire on the cases that merely LOOK like one. A gate that
 *      cries wolf on a documented happy path gets bypassed reflexively, which
 *      is worse than no gate: it trains people past a real finding later.
 *
 * The live SDL is asserted separately by `pnpm check:sdl-enums` in CI. These
 * run the predicate against synthetic schemas, so a fixture cannot go stale
 * with the real one and the boundary cases stay legible.
 */
import { describe, it, expect } from 'vitest';
import { findPartialEnumerations } from '../../../../scripts/check-sdl-enumerations.mjs';

const SET = [
  {
    name: 'TEST_SCOPES',
    source: 'test',
    members: ['mail.read', 'mail.send', 'calendar.read', 'drive.read'] as const,
  },
];

const sdl = (description: string) => `
  type Query {
    """${description}"""
    thing: String
  }
`;

const violations = (description: string) =>
  findPartialEnumerations(sdl(description), SET as never);

describe('catches a partial enumeration', () => {
  it('flags a description listing some members but not all', () => {
    const v = violations('Scopes: mail.read, mail.send, calendar.read.');
    expect(v).toHaveLength(1);
    expect(v[0].missing).toEqual(['drive.read']);
    expect(v[0].coord).toBe('Query.thing');
  });

  it('names EVERY missing member, not just the first', () => {
    // A gate that reports one omission at a time turns a two-line fix into two
    // review rounds.
    const v = violations('Scopes: mail.read, mail.send.');
    expect(v[0].missing).toEqual(['calendar.read', 'drive.read']);
  });

  it('accepts a complete enumeration in any order or punctuation', () => {
    expect(violations('One of {drive.read, mail.send, calendar.read, mail.read}.')).toEqual([]);
  });
});

describe('sees a description wherever GraphQL allows one (#1123 review)', () => {
  /**
   * The collector's first version registered a HAND-LISTED set of node kinds,
   * and so skipped interfaces, unions, scalars and directives in silence — a
   * gate reporting success while missing sites, which is worse than no gate
   * and is the same shape of defect as the hand-maintained scope list it
   * exists to catch.
   *
   * One case per description-bearing kind, because "exhaustive" is a claim and
   * this is what checking it looks like.
   */
  const partial = 'Scopes: mail.read, mail.send, calendar.read.';
  const cases: Array<[string, string]> = [
    ['object field', `type Q { """${partial}""" f: String }`],
    ['object type', `"""${partial}""" type Q { f: String }`],
    ['interface', `"""${partial}""" interface I { f: String }`],
    ['interface field', `interface I { """${partial}""" f: String }`],
    ['union', `type A { x: String }
type B { x: String }
"""${partial}""" union U = A | B`],
    ['scalar', `"""${partial}""" scalar S`],
    ['enum', `"""${partial}""" enum E { A }`],
    ['enum value', `enum E { """${partial}""" A }`],
    ['input object', `"""${partial}""" input In { f: String }`],
    ['input field', `input In { """${partial}""" f: String }`],
    ['argument', `type Q { f("""${partial}""" a: String): String }`],
    ['directive', `"""${partial}""" directive @d on FIELD`],
  ];

  for (const [label, doc] of cases) {
    it(`catches a partial enumeration on a ${label}`, () => {
      const v = findPartialEnumerations(doc, SET as never);
      expect(v, `${label} was not inspected`).toHaveLength(1);
      expect(v[0].missing).toEqual(['drive.read']);
    });
  }

  it('labels a nameless schema definition rather than inheriting the last type', () => {
    // Without its own label the coordinate read `SomeType.undefined` — the
    // violation still found, the author still sent to the wrong place, which
    // for a diagnostic is most of what it is for.
    const doc = `type Q { f: String }\n"""${partial}"""\nschema { query: Q }`;
    const v = findPartialEnumerations(doc, SET as never);
    expect(v).toHaveLength(1);
    expect(v[0].coord).toBe('schema');
  });

  it('names the enclosing FIELD in an argument coordinate', () => {
    // Two fields with the same argument name both reported `Mutation.scopes`
    // — one coordinate for two definitions, which an author cannot act on
    // (#1123 review, Codex P3).
    const doc = `type Mutation {
      foo("""${partial}""" scopes: [String!]!): String
      bar("""${partial}""" scopes: [String!]!): String
    }`;
    const v = findPartialEnumerations(doc, SET as never);
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.coord).sort()).toEqual([
      'Mutation.bar(scopes:)',
      'Mutation.foo(scopes:)',
    ]);
  });

  it('an INPUT-OBJECT field is not an argument, and keeps the plain coordinate', () => {
    // Both are InputValueDefinition; only the one inside a field is an
    // argument. Treating them alike would put a phantom field name on an
    // input-object field.
    //
    // The input object is placed AFTER a type with a field, deliberately. With
    // it first, `fieldName` is null anyway and the test passes whether or not
    // the visitor ever clears it — a spare assertion that cannot tell the two
    // implementations apart. Ordering it this way is what reaches the leak.
    const doc = `type Q { earlier(a: String): String }
    input In { """${partial}""" scopes: [String!]! }`;
    const v = findPartialEnumerations(doc, SET as never);
    expect(v).toHaveLength(1);
    expect(v[0].coord).toBe('In.scopes');
  });

  it('gives a navigable coordinate rather than a bare name', () => {
    const v = findPartialEnumerations(
      `interface I { """${partial}""" f: String }`,
      SET as never,
    );
    expect(v[0].coord).toBe('I.f');
  });
});

describe('does NOT fire on the cases that only look like one', () => {
  it('a single member is documenting a field, not enumerating a set', () => {
    // The two-member floor. "Grant scope: drive.read." appears on several real
    // fields and is correct; firing on it would gate the documented happy path.
    expect(violations('Grant scope: drive.read.')).toEqual([]);
    expect(violations('Requires mail.send.')).toEqual([]);
  });

  it('a member ending a SENTENCE still counts as present', () => {
    // The first draft of the token boundary excluded a following '.' outright,
    // and so reported drive.read missing from a description that ended with
    // "…, drive.read." — a member reported absent from the very sentence
    // listing it. Found by running the gate against correct data.
    expect(violations('Scopes: mail.read, mail.send, calendar.read, drive.read.')).toEqual([]);
  });

  it('a LONGER value that merely starts with a member does not count', () => {
    // calendar.readonly is a real adjacent value. Counting it as calendar.read
    // would let a genuinely partial list pass — the gate failing OPEN, which is
    // the direction that matters.
    const v = violations('Scopes: mail.read, mail.send, calendar.readonly, drive.read.');
    expect(v).toHaveLength(1);
    expect(v[0].missing).toEqual(['calendar.read']);
  });

  it('a member embedded in a longer token does not count', () => {
    expect(violations('See xmail.read and ymail.send for details.')).toEqual([]);
  });

  it('descriptions that name the TYPE instead cannot drift', () => {
    // The remedy the gate recommends, and it must not itself be flagged.
    expect(violations('scopes must be a subset of ConnectionGrantScope.')).toEqual([]);
  });
});

describe('#2302 coordinate-scoped ordinary-word sets', () => {
  it('detects the omitted decision family in Node.role using the live governed-role list', () => {
    const doc = 'type Node { "Governed families: review, spec." role: String }';
    expect(findPartialEnumerations(doc).filter(v => v.set === 'GOVERNED_ROLES')).toMatchObject([
      { coord: 'Node.role', missing: ['decision'] },
    ]);
  });

  it('detects a missing work kind at the worklog contract', () => {
    const doc = 'type Query { "kind must be one of pr, issue, commit, branch." teamWorkItems: String }';
    expect(findPartialEnumerations(doc).filter(v => v.set === 'WORK_KINDS')).toMatchObject([
      { coord: 'Query.teamWorkItems', missing: ['repo'] },
    ]);
  });

  it('does not let owner/repo examples hide an omitted repo kind', () => {
    const doc = 'type Mutation { "Canonical owner/repo#N. kind must be one of pr, issue, commit, branch; ref is canonical." recordTeamWork: String }';
    expect(findPartialEnumerations(doc).filter(v => v.set === 'WORK_KINDS')).toMatchObject([
      { coord: 'Mutation.recordTeamWork', missing: ['repo'] },
    ]);
  });

  it('checks a promised kind list even when reduced to one member', () => {
    const doc = 'type Query { "kind must be one of pr." teamWorkItems: String }';
    expect(findPartialEnumerations(doc).filter(v => v.set === 'WORK_KINDS')).toMatchObject([
      { coord: 'Query.teamWorkItems', missing: ['issue', 'commit', 'branch', 'repo'] },
    ]);
  });

  it('does not treat unrelated ordinary-word prose as either closed enumeration', () => {
    const doc = 'type Query { "An issue, branch and commit can carry a review or spec." other: String }';
    expect(findPartialEnumerations(doc)).toEqual([]);
  });
});

// #2303: ordinary enum words are watched only at their owning description.
describe('S3 live host/member description lists (#2303)', () => {
  it('detects an omitted skill host at its input coordinate', () => {
    expect(findPartialEnumerations('input SkillPlanInput { """Supported hosts: claudeSkill, futureSkill.""" host: String }')
      .some(v => v.coord === 'SkillPlanInput.host' && v.missing.includes('codexSkill'))).toBe(true);
  });
  it('detects an omitted member role without watching incidental prose', () => {
    expect(findPartialEnumerations('"""Roles: reader, writer. Subject to owner protection.""" enum MemoryMemberRole { reader writer owner }')
      .some(v => v.coord === 'MemoryMemberRole' && v.missing.includes('owner'))).toBe(true);
    expect(findPartialEnumerations('"""The reader and writer share a document.""" type Other { id: ID }')).toEqual([]);
  });
});

describe('#2305 process-credential provider list', () => {
  const at = (text: string, field = 'createAiServiceConfig') =>
    `type Mutation { """${text}""" ${field}: String }`;

  it('detects an omitted eligible provider using the production predicate', () => {
    expect(findPartialEnumerations(at('Eligible process-credential providers: openai, anthropic; no endpoint.')))
      .toMatchObject([{ coord: 'Mutation.createAiServiceConfig', set: 'PROCESS_CREDENTIAL_PROVIDERS', missing: ['bedrock'] }]);
  });

  it('does not let a provider outside the promised list mask its omission', () => {
    expect(findPartialEnumerations(at('Eligible process-credential providers: openai; bedrock and anthropic appear elsewhere.')))
      .toMatchObject([{ set: 'PROCESS_CREDENTIAL_PROVIDERS', missing: ['anthropic', 'bedrock'] }]);
  });

  it('accepts the complete eligible list and ignores unrelated provider prose', () => {
    expect(findPartialEnumerations(at('Eligible process-credential providers: bedrock, openai, anthropic; no endpoint.'))).toEqual([]);
    expect(findPartialEnumerations(at('Only openai and anthropic examples.', 'other'))).toEqual([]);
  });
});

describe('#2304 commentable-class list', () => {
  const at = (text: string, field = 'createComment') =>
    `type Mutation { """${text}""" ${field}: String }`;

  it('catches an omitted commentable class from the live class set', () => {
    expect(findPartialEnumerations(at('Commentable classes: app, knowledge, personal, group; no private.')))
      .toMatchObject([{ coord: 'Mutation.createComment', set: 'COMMENTABLE_CLASSES', missing: ['system'] }]);
  });

  it('does not let classes outside the promised list mask omissions', () => {
    expect(findPartialEnumerations(at('Commentable classes: app; system, knowledge, personal and group appear elsewhere.')))
      .toMatchObject([{ set: 'COMMENTABLE_CLASSES', missing: ['knowledge', 'personal', 'group', 'system'] }]);
  });

  it('accepts the complete list and ignores unrelated ordinary class words', () => {
    expect(findPartialEnumerations(at('Commentable classes: app, knowledge, personal, group, system; private is refused.'))).toEqual([]);
    expect(findPartialEnumerations(at('An app has personal and group data.', 'other'))).toEqual([]);
  });
});

describe('#2304 reserved object-field list', () => {
  it('does not let an incidental type example hide an omitted reserved field', () => {
    const doc = 'type Mutation { "Reserved object field names: id; type is the collection argument." createObject: String }';
    expect(findPartialEnumerations(doc)).toMatchObject([
      { coord: 'Mutation.createObject', set: 'RESERVED_OBJECT_KEYS', missing: ['type'] },
    ]);
  });

  it('accepts the live reserved list and ignores other uses of id/type', () => {
    expect(findPartialEnumerations('type Mutation { "Reserved object field names: id, type; both refused." createObject: String }')).toEqual([]);
    expect(findPartialEnumerations('type Query { "An id field and a type name." other: String }')).toEqual([]);
  });
});
