/**
 * #1177 §5 — the drift classes.
 *
 * New code rather than a port, so there is no Go fixture to compare against
 * and every expectation here is a reading of the spec. That makes the
 * PRECEDENCE cases the valuable ones: each class is easy to produce in
 * isolation and the question that actually decides behaviour is which one wins
 * when several are true at once.
 */
import { describe, it, expect } from 'vitest';
import { classifySkill, pairFileToNode, type FileFacts, type NodeFacts } from './classify.js';
import type { Declaration } from './declaration.js';

const decl = (over: Partial<Declaration> = {}): Declaration => ({
  key: 'exports.claudeSkill',
  host: 'claudeSkill',
  description: 'd. Use when x.',
  name: 'my-skill',
  nameSet: true,
  enable: true,
  enableSet: true,
  ...over,
});

const node = (over: Partial<NodeFacts> = {}): NodeFacts => ({
  id: 'node-1',
  urn: 'hrn:node:acme.com:mem:tasks:x',
  memoryUrn: 'acme.com:mem',
  loc: 'tasks:x',
  declaration: decl(),
  nodeHash: 'aaaaaaaaaaaaaaaa',
  revision: 4,
  ...over,
});

const file = (over: Partial<FileFacts> = {}): FileFacts => ({
  dirName: 'my-skill',
  headerHash: 'aaaaaaaaaaaaaaaa',
  fileHash: 'aaaaaaaaaaaaaaaa',
  headerRevision: 4,
  ...over,
});

describe('each class, produced in isolation', () => {
  it('current — node, header and file all agree', () => {
    expect(classifySkill(node(), file()).class).toBe('current');
  });

  it('stale — the node moved on, the file still matches its own header', () => {
    expect(classifySkill(node({ nodeHash: 'bbbbbbbbbbbbbbbb' }), file()).class).toBe('stale');
  });

  it('stale — provenance names an older node revision even when hashes agree', () => {
    expect(classifySkill(node(), file({ headerRevision: 3 })).class).toBe('stale');
  });

  it('current — an older artifact without rev remains hash-compatible', () => {
    expect(classifySkill(node(), file({ headerRevision: undefined })).class).toBe('current');
  });

  it('locally-edited — the file no longer matches its own header', () => {
    expect(classifySkill(node(), file({ fileHash: 'cccccccccccccccc' })).class).toBe('locally-edited');
  });

  it('locally-edited — extra frontmatter, which the hash cannot see', () => {
    // `render` writes exactly two frontmatter keys, so a third is an edit the
    // header hash has no way to notice: the hash covers the rendered inputs,
    // not the keys somebody added beside them.
    expect(classifySkill(node(), file({ hasExtraFrontmatter: true })).class).toBe('locally-edited');
  });

  it('renamed — the stored name moved, the directory did not', () => {
    const got = classifySkill(node({ declaration: decl({ name: 'new-name' }) }), file());
    expect(got.class).toBe('renamed');
    expect(got.movedFrom).toBe('my-skill');
  });

  it('never-exported — declared, no file', () => {
    expect(classifySkill(node(), null).class).toBe('never-exported');
  });

  it('unhashed — a pre-#580 header carries a source and no hash', () => {
    expect(classifySkill(node(), file({ headerHash: '' })).class).toBe('unhashed');
  });

  it('collision — two declared nodes claim one directory', () => {
    expect(classifySkill(node({ collides: true }), file()).class).toBe('collision');
  });

  it('unavailable — listed but unreadable', () => {
    expect(classifySkill(node({ unavailable: true }), file()).class).toBe('unavailable');
  });

  it('disabled — declared and not switched on', () => {
    expect(classifySkill(node({ declaration: decl({ enable: false }) }), file()).class).toBe('disabled');
  });

  it('disabled applies with NO file — the class is about the declaration', () => {
    // §5.2 promises one row per declared node, and the class describes the
    // DECLARATION while the action describes the file. A disabled declaration
    // with no file is still disabled, not `never-exported`.
    expect(classifySkill(node({ declaration: decl({ enable: false }) }), null).class).toBe('disabled');
  });
});

describe('precedence — which class wins when several are true', () => {
  it('locally-edited OUTRANKS disabled', () => {
    // @codex's P1 on cli#627, and the reason is not symmetry: `enable` lives
    // on a SHARED node, so whoever switched it off is often not whoever made
    // the local edit. Letting `disabled` win would destroy their work on
    // someone else's toggle — the precise outcome A1 was ruled to prevent.
    const got = classifySkill(
      node({ declaration: decl({ enable: false }) }),
      file({ fileHash: 'cccccccccccccccc' }),
    );
    expect(got.class).toBe('locally-edited');
  });

  it('unavailable outranks everything, because nothing below it is knowable', () => {
    const got = classifySkill(
      node({ unavailable: true, collides: true, declaration: decl({ enable: false }) }),
      file({ fileHash: 'cccccccccccccccc' }),
    );
    expect(got.class).toBe('unavailable');
  });

  it('a parse failure is NOT a class, and outranks every class below it', () => {
    // @Holger, 2026-09-20: "During the export a failure is reported." The node
    // stays declared; it is the FILE that cannot be read.
    const got = classifySkill(
      node({ declaration: decl({ enable: false }) }),
      file({ parseFailed: true, fileHash: 'cccccccccccccccc' }),
    );
    expect(got.parseFailure).toBe(true);
    expect(got.class).toBeUndefined();
  });

  it('but unavailable still outranks a parse failure', () => {
    // A node that could not be read cannot be said to have a broken file:
    // there is nothing to compare the file against.
    const got = classifySkill(node({ unavailable: true }), file({ parseFailed: true }));
    expect(got.class).toBe('unavailable');
    expect(got.parseFailure).toBeUndefined();
  });

  it('disabled outranks collision', () => {
    // Nothing is written for either, so the more informative answer wins: a
    // disabled node is switched off deliberately, where a collision is a
    // defect two authors must resolve. Reporting "collision" for a node
    // nobody is exporting would send them to fix something that is not firing.
    const got = classifySkill(
      node({ declaration: decl({ enable: false }), collides: true }),
      file(),
    );
    expect(got.class).toBe('disabled');
  });

  it('collision outranks the file-relationship classes', () => {
    const got = classifySkill(node({ nodeHash: 'bbbbbbbbbbbbbbbb', collides: true }), file());
    expect(got.class).toBe('collision');
  });

  it('a locally-edited file with NO header hash is unhashed, not locally-edited', () => {
    // The pre-#580 generation carries no hash, so there is nothing to compare
    // the file against — claiming a hand edit would be an assertion the data
    // cannot support. The export planner independently protects a missing id.
    const got = classifySkill(node(), file({ headerHash: '', fileHash: 'cccccccccccccccc' }));
    expect(got.class).toBe('unhashed');
  });

  it('renamed is decided BEFORE stale — a moved directory is not a content drift', () => {
    const got = classifySkill(
      node({ nodeHash: 'bbbbbbbbbbbbbbbb', declaration: decl({ name: 'new-name' }) }),
      file(),
    );
    expect(got.class).toBe('renamed');
  });
});

describe('pairing a file to a node (§4a)', () => {
  const a = node({ id: 'id-a', urn: 'hrn:node:acme.com:mem:tasks:a', memoryUrn: 'acme.com:mem', loc: 'tasks:a' });
  const b = node({ id: 'id-b', urn: 'hrn:node:acme.com:mem:tasks:b', memoryUrn: 'acme.com:mem', loc: 'tasks:b' });

  it('pairs by ID, so a loc rename reads as the same skill', () => {
    // The whole point of §4a: `moveNode` keeps the id and changes the URN, so
    // URN-only pairing would split one skill into an orphan plus a fresh
    // export — two directories with near-identical trigger text, both firing.
    const f = file({ headerId: 'id-a', headerSource: 'hrn:node:acme.com:mem:tasks:OLD' });
    expect(pairFileToNode(f, [a, b])?.id).toBe('id-a');
  });

  it('falls back to the URN when the header predates the id', () => {
    const f = file({ headerId: '', headerSource: 'hrn:node:acme.com:mem:tasks:b' });
    expect(pairFileToNode(f, [a, b])?.id).toBe('id-b');
  });

  it('does NOT fall back to the URN when an id is present and resolves to nothing', () => {
    // The id is the stronger key. Falling back would pair a file with whatever
    // node happens to sit at its old address — which after a move is a
    // DIFFERENT node that merely reused the loc.
    const f = file({ headerId: 'id-gone', headerSource: 'hrn:node:acme.com:mem:tasks:a' });
    expect(pairFileToNode(f, [a, b])).toBeNull();
  });

  it('is an orphan when neither key resolves', () => {
    expect(pairFileToNode(file({ headerId: '', headerSource: 'hrn:node:x:y:z' }), [a, b])).toBeNull();
    expect(pairFileToNode(file({ headerId: '', headerSource: '' }), [a, b])).toBeNull();
  });

  it.each([
    ['the `::` grammar', 'acme.com::mem::tasks:b'],
    ['a v1 `urn:node:` prefix', 'urn:node:acme.com::mem::tasks:b'],
    ['a mixed `hrn:node:` + `::` form', 'hrn:node:acme.com::mem::tasks:b'],
  ])('D-2026-09-24-A (#1309): the URN fallback accepts %s', (_label, headerSource) => {
    // A pre-§4a header names its node in whatever spelling the exporter of the
    // day wrote; the spelling is not part of the address.
    expect(pairFileToNode(file({ headerId: '', headerSource }), [a, b])?.id).toBe('id-b');
  });

  describe('pairs by the IDENTITY the address names, never by the emitted string (@codex P1, PR #1310)', () => {
    // Two DIFFERENT nodes whose emitted URNs are the same string: the emitter
    // flattens a compound memory. A string match cannot tell them apart; a
    // wrong pair against a disabled declaration plans REMOVE without --force.
    const compound = node({ id: 'id-compound', urn: 'hrn:node:acme.com:mem:tasks:b', memoryUrn: 'acme.com::mem::tasks', loc: 'b' });
    const plain = node({ id: 'id-plain', urn: 'hrn:node:acme.com:mem:tasks:b', memoryUrn: 'acme.com:mem', loc: 'tasks:b' });
    const pair = (headerSource: string, nodes = [compound, plain]) =>
      pairFileToNode(file({ headerId: '', headerSource }), nodes)?.id ?? null;

    it('each unambiguous spelling reaches its own node', () => {
      expect(pair('hrn:node:acme.com::mem::tasks::b')).toBe('id-compound');
      expect(pair('acme.com::mem::tasks:b')).toBe('id-plain');
    });

    it('the flat string is read the way the platform parser reads it — not as whichever node emits it', () => {
      expect(pair('hrn:node:acme.com:mem:tasks:b')).toBe('id-plain');
      // With only the compound node declared, the flat string does NOT name it:
      // unpaired (an orphan, kept), rather than paired by coincidence.
      expect(pair('hrn:node:acme.com:mem:tasks:b', [compound])).toBeNull();
    });
  });

  it('a FRAGMENT addresses part of a node, so it never pairs a whole-node file (@copilot, PR #1310)', () => {
    for (const headerSource of ['acme.com::mem::tasks:b#data', 'hrn:node:acme.com:mem:tasks:b#data']) {
      expect(pairFileToNode(file({ headerId: '', headerSource }), [a, b]), headerSource).toBeNull();
    }
    // CONTROL: the same address without the fragment pairs.
    expect(pairFileToNode(file({ headerId: '', headerSource: 'acme.com::mem::tasks:b' }), [a, b])?.id).toBe('id-b');
  });

  it('…widening the spelling never widens the identity rule', () => {
    // An id-bearing file still pairs by id alone, whatever its source says.
    expect(pairFileToNode(file({ headerId: 'id-gone', headerSource: 'acme.com::mem::tasks:a' }), [a, b])).toBeNull();
    // Not a node URN at all: unpaired, and no throw.
    for (const headerSource of ['not a urn', 'tasks:b', 'hrn:memory:acme.com:mem', '::::']) {
      expect(pairFileToNode(file({ headerId: '', headerSource }), [a, b]), headerSource).toBeNull();
    }
  });

  it('CONTROL: the pairer can return both answers over one node set', () => {
    // Otherwise every assertion above would hold for a function that always
    // returns null.
    const hit = pairFileToNode(file({ headerId: 'id-a' }), [a, b]);
    const miss = pairFileToNode(file({ headerId: 'nope' }), [a, b]);
    expect(hit).not.toBeNull();
    expect(miss).toBeNull();
  });
});
