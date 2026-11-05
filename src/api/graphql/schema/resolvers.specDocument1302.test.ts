/**
 * #1302 (R218, rulings 0134/0137/0138; cor:spc:030:01/:02) — `Query.specDocument`.
 *
 * A fixture Feature `fx:110` is built through the real mutations (approveNode, updateNode) wherever an
 * approval state is wanted, so the state line is proved against the node's own read, not a hand-set column.
 * The golden is the document below, byte for byte, with the clock and the portal origin fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { specDocumentClock } from './resolvers.specDocument.js';
import { SPEC_DOCUMENT_MAX_NODES, SPEC_DOCUMENT_MAX_BYTES, SPEC_DOCUMENT_MAX_LINK_TARGETS } from '../../../lib/specDocument/limits.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let outsider: { id: string };
let org: { id: string; urn: string };
let other: { id: string; urn: string };
let draft: { id: string; urn: string };
let foreign: { id: string; urn: string };
const savedOrigin = process.env.FRONTEND_URL;

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
const M = resolvers.Mutation as unknown as Record<string, (p: null, a: Record<string, unknown>, c: Context) => Promise<unknown>>;
type Entry = {
  loc: string; urn: string; name: string; revision: number; content: string | null; isPlaceholder: boolean;
  approvalStatus: { state: string; approval: { revision: number } | null };
  mintStatus: { minted: boolean; revision: number | null; hash: string | null };
};
type Doc = { markdown: string; entries: Entry[]; loc: string; memoryId: string };
const read = (loc: string, ctx = as(), memoryRef = draft.id) =>
  (resolvers.Query as unknown as Record<string, (p: null, a: Record<string, unknown>, c: Context) => Promise<Doc>>)
    .specDocument(null, { memoryRef, loc }, ctx);
/** The thrown error as everything a client could observe of it, with the caller's own ref normalised out. */
const refusalOf = async (p: Promise<unknown>, ref?: string) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    const err = e as Error & { extensions?: unknown };
    const json = JSON.stringify({ name: err.name, message: err.message, extensions: err.extensions ?? null });
    return ref ? json.split(ref).join('REF') : json;
  }
};
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) { return String((e as { extensions?: { code?: string } }).extensions?.code ?? (e as Error).name); }
};

const spec = (loc: string, name: string, content: string | null, extra: Record<string, unknown> = {}) => db.node.create({
  data: { id: generateId(), memoryId: draft.id, loc, name, content, role: 'spec', nodeType: 'info', ...extra },
});
const body = (title: string, ...rest: string[]) =>
  `# ${title}\n\n- **Status:** Proposed\n- **Built:** Not built\n\n<div class="spec-core" style="border-radius: 1em 1em 0 0;"></div>\n\n${rest.join('\n\n')}\n\n---\n\n## Where This Came From\n\n- tail of ${title}\n`;
const approve = async (loc: string) => {
  const n = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc } });
  await M.approveNode(null, { nodeRef: n.id }, as());
};
const edit = async (loc: string, content: string) => {
  const n = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc } });
  // A raw write: the revision resolver reconciles it, the way `node(...)` does for any out-of-band change.
  await db.node.update({ where: { id: n.id }, data: { content } });
};

beforeEach(async () => {
  await cleanDb(db);
  process.env.FRONTEND_URL = 'https://portal.example';
  specDocumentClock.now = () => new Date('2026-11-04T10:12:34.000Z');
  org = await db.organization.create({ data: { id: generateId(), name: 'Doc Org', urn: 'doc1302.example' } });
  other = await db.organization.create({ data: { id: generateId(), name: 'Other Org', urn: 'other1302.example' } });
  admin = await db.user.create({ data: { githubId: 130201, githubUsername: 'doc-admin', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 130202, githubUsername: 'doc-outsider', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: other.id, userId: outsider.id, role: 'ADMIN' } });
  draft = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs', draftCorpus: true }, as());
  foreign = await resolvers.Mutation.createMemory(null, { orgId: other.id, name: 'secret' }, as(outsider.id));
});
afterEach(() => {
  if (savedOrigin === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = savedOrigin;
  specDocumentClock.now = () => new Date();
});

/** The fixture Feature: three types, a nested part of another type, retired, draft, changed-since-approval, placeholder, old name. */
async function buildFixture() {
  const secret = await db.node.create({ data: { id: generateId(), memoryId: foreign.id, loc: 'zz:01', name: 'TOPSECRET NAME', content: 'TOPSECRET BODY' } });
  await spec('fx:200:01', 'Rule: Outside the document', body('Rule: Outside the document', 'x'));
  await spec('fx:110', 'Feature: The action register', body(
    'Feature: The action register [fx:110]',
    '## What It\'s For',
    'See [[fx:110:01|a code]], [[fx:110:03]], [[fx:200:01|outside]], [[fx:200:01]], [[fx:110|itself]],'
      + ` [[hrn:node:${foreign.urn}:zz:01|hidden]], [[hrn:node:${foreign.urn}:zz:01]] and [[fx:999:99|gone]].`,
  ));
  await spec('fx:110:01', 'Definition: A code', body(
    'Definition: A code', '## What It Means', 'A code is a name.', '### Open Questions, Need Ruling', '- Do events share one code space?',
  ));
  await spec('fx:110:02', 'Rule: A warning never changes a call', body('Rule: A warning never changes a call', '## The Rule', 'Never.'));
  await spec('fx:110:02:01', 'Operation: Nested operation', body('Operation: Nested operation', 'Nested body.'));
  await spec('fx:110:03', 'Rule: Which worker acts', body('Rule: Which worker acts', 'Original text.'));
  await spec('fx:110:04', 'Rule: An earlier routing rule', body('Rule: An earlier routing rule', 'Old text.'), { tags: ['superseded'] });
  await spec('fx:110:05', 'Entity: Reserved', null, { isPlaceholder: true });
  await spec('fx:110:06', 'fx:110:06 — An older name', body('An older name', 'Older body.'));
  await spec('fx:110:a', 'Rule: Lowercase sibling', body('Rule: Lowercase sibling', 'a'));
  await spec('fx:110:B', 'Rule: Uppercase sibling', body('Rule: Uppercase sibling', 'B'));
  await spec('fx:110:09', 'Rule: Positioned last by loc', body('Rule: Positioned last by loc', 'Positioned.'), { seq: 1 });
  await spec('fx:1100', 'Rule: Not a part', body('Rule: Not a part', 'z'));
  await approve('fx:110:03');
  await edit('fx:110:03', body('Rule: Which worker acts', 'Changed text.'));
  await approve('fx:110:04');
  const retired = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'fx:110:04' } });
  const successor = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: 'fx:110:03' } });
  await db.node.update({ where: { id: retired.id }, data: { mintedAt: new Date('2026-11-01T00:00:00Z'), mintedRevNo: 1, mintedHash: 'h', mintedByInfo: 't' } });
  await db.edge.create({ data: { memoryId: draft.id, sourceId: retired.id, targetId: successor.id, loc: `${retired.id}:superseded-by:fx:110:03`, name: 'superseded-by' } });
  return { secret };
}

describe('the document (acceptance 1, 1a-1e, 2)', () => {
  it('renders the confirmed shape byte for byte', async () => {
    await buildFixture();
    const doc = await read('fx:110');
    expect(doc.markdown).toBe(GOLDEN(draft.urn, foreign.urn));
  });

  it('entries follow the document order, the Feature first, and carry each node\'s own revision and states (acceptance 7)', async () => {
    await buildFixture();
    const doc = await read('fx:110');
    // The Feature, then the type groups (Definitions, Entities, Rules, Operations, Other), citation order inside.
    expect(doc.entries.map((e) => e.loc)).toEqual([
      'fx:110', 'fx:110:01', 'fx:110:05', 'fx:110:09', 'fx:110:02', 'fx:110:03', 'fx:110:04', 'fx:110:a', 'fx:110:B',
      'fx:110:02:01', 'fx:110:06',
    ]);
    const byLoc = new Map(doc.entries.map((e) => [e.loc, e]));
    for (const e of doc.entries) {
      const row = await db.node.findFirstOrThrow({ where: { memoryId: draft.id, loc: e.loc } });
      expect(e.revision).toBe(row.revSeq);
      expect(e.urn).toBe(`hrn:node:${draft.urn.replace(/::/g, ':')}:${e.loc}`);
    }
    expect(byLoc.get('fx:110:03')!.approvalStatus).toMatchObject({ state: 'SUPERSEDED', approval: { revision: 1 } });
    expect(byLoc.get('fx:110:03')!.revision).toBeGreaterThan(1);
    expect(byLoc.get('fx:110:04')!.approvalStatus).toMatchObject({ state: 'APPROVED', approval: { revision: 1 } });
    expect(byLoc.get('fx:110:04')!.mintStatus).toMatchObject({ minted: true, revision: 1 });
    expect(byLoc.get('fx:110:01')!.approvalStatus.state).toBe('NOT_APPROVED');
    expect(byLoc.get('fx:110:05')).toMatchObject({ isPlaceholder: true, content: null });
  });

  it('groups by type, then citation order: positioned first, locale order (a before B), nested part in its own group', async () => {
    await buildFixture();
    const md = (await read('fx:110')).markdown;
    const at = (s: string) => md.indexOf(s);
    const heads = ['# Definitions', '# Rules', '# Operations', '# Other specs'];
    expect(heads.map(at)).toEqual([...heads.map(at)].sort((a, b) => a - b));
    expect(heads.every((h) => at(h) > 0)).toBe(true);
    // Entity placeholder group sits between Definitions and Rules.
    expect(at('# Entities')).toBeGreaterThan(at('# Definitions'));
    expect(at('# Entities')).toBeLessThan(at('# Rules'));
    const rules = ['fx:110:09', 'fx:110:02', 'fx:110:03', 'fx:110:04', 'fx:110:a', 'fx:110:B'].map((l) => md.indexOf(`[${l}]\n`));
    expect(rules.every((i) => i > 0)).toBe(true);
    expect(rules).toEqual([...rules].sort((a, b) => a - b));
    // The nested Operation is not under its Rule parent.
    expect(at('[fx:110:02:01]')).toBeGreaterThan(at('# Operations'));
    expect(at('## Operation: Nested operation')).toBeGreaterThan(at('# Operations'));
  });

  it('drops scaffolding and each part\'s tail, and ends with the Feature\'s tail (1d)', async () => {
    await buildFixture();
    const md = (await read('fx:110')).markdown;
    expect(md).not.toContain('spec-core');
    expect(md).not.toContain('tail of Definition');
    expect(md).not.toContain('tail of Rule');
    expect(md.endsWith('\n\n## Where This Came From\n\n- tail of Feature: The action register [fx:110]\n')).toBe(true);
    expect(md.indexOf('## Where This Came From')).toBeGreaterThan(md.indexOf('# Other specs'));
    expect(md.match(/Where This Came From/g)).toHaveLength(1);
  });
});

describe('links (1e)', () => {
  it('in-document is an anchor, outside is a portal URL, an unreadable or missing target is plain text with none of its name', async () => {
    await buildFixture();
    const md = (await read('fx:110')).markdown;
    expect(md).toContain('[a code](#fx-110-01)');
    expect(md).toContain('[Rule: Which worker acts](#fx-110-03)');
    expect(md).toContain(`[outside](https://portal.example/app/u/hrn:node:${draft.urn}:fx:200:01)`);
    expect(md).toContain(`[Rule: Outside the document](https://portal.example/app/u/hrn:node:${draft.urn}:fx:200:01)`);
    expect(md).toContain('See [a code]');
    expect(md).toContain('itself,');
    expect(md).toContain('hidden, hrn:node:');
    expect(md).toContain('gone.');
    expect(md).not.toContain('TOPSECRET');
    expect(md).not.toContain(`app/u/hrn:node:${foreign.urn}`);
  });

  it('with no portal origin an outside link is plain text', async () => {
    await buildFixture();
    delete process.env.FRONTEND_URL;
    const md = (await read('fx:110')).markdown;
    expect(md).toContain('See [a code](#fx-110-01), [Rule: Which worker acts](#fx-110-03), outside, fx:200:01,');
    expect(md).not.toContain('portal.example');
  });
});

describe('refusals (acceptance 3, 4, 8, 9)', () => {
  it('an unreadable and a missing memory answer byte for byte alike, by ID and by URN', async () => {
    await buildFixture();
    const byId = [foreign.id, generateId()];
    const unreadableId = await refusalOf(read('zz:01', as(), byId[0]), byId[0]);
    const missingId = await refusalOf(read('zz:01', as(), byId[1]), byId[1]);
    expect(unreadableId).not.toBe('NO_ERROR');
    expect(unreadableId).toBe(missingId);
    const unreadableUrn = `hrn:mem:${foreign.urn}`;
    const missingUrn = `hrn:mem:${other.urn}:no-such`;
    const a = await refusalOf(read('zz:01', as(), unreadableUrn), unreadableUrn);
    const b = await refusalOf(read('zz:01', as(), missingUrn), missingUrn);
    expect(a).not.toBe('NO_ERROR');
    expect(a).toBe(b);
  });

  it('a deleted spec and a never-written loc answer the same', async () => {
    await buildFixture();
    await db.node.updateMany({ where: { memoryId: draft.id, loc: 'fx:110:06' }, data: { deletedAt: new Date() } });
    const deleted = await refusalOf(read('fx:110:06'), 'fx:110:06');
    const never = await refusalOf(read('fx:110:77'), 'fx:110:77');
    expect(deleted).not.toBe('NO_ERROR');
    expect(deleted).toBe(never);
  });

  it('a citation does not cover a sibling that merely starts with it (fx:110 vs fx:1100)', async () => {
    await buildFixture();
    const doc = await read('fx:110');
    expect(doc.entries.map((e) => e.loc)).not.toContain('fx:1100');
    expect(doc.markdown).not.toContain('Not a part');
  });

  it('a readable encrypted memory refuses with the named code; an unreadable one answers as missing', async () => {
    await buildFixture();
    await db.memory.update({ where: { id: draft.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    expect(await codeOf(read('fx:110'))).toBe('SPEC_CORPUS_ENCRYPTED_UNSUPPORTED');
    await db.memory.update({ where: { id: foreign.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    const missingRef = generateId();
    const unreadable = await refusalOf(read('zz:01', as(), foreign.id), foreign.id);
    expect(unreadable).not.toContain('ENCRYPTED');
    expect(unreadable).toBe(await refusalOf(read('zz:01', as(), missingRef), missingRef));
  });

  it('over the cap it refuses with the cap named, and never returns part of the document', async () => {
    await spec('big:1', 'Feature: Big', 'root');
    await db.node.createMany({
      data: Array.from({ length: SPEC_DOCUMENT_MAX_NODES }, (_, i) => ({
        id: generateId(), memoryId: draft.id, loc: `big:1:${i + 1}`, name: `Rule: R${i}`, content: 'x', role: 'spec', nodeType: 'info',
      })),
    });
    const err = await read('big:1').catch((e) => e as { extensions: { code: string; cap: number } });
    expect(err).toMatchObject({ extensions: { code: 'SPEC_DOCUMENT_TOO_LARGE', cap: SPEC_DOCUMENT_MAX_NODES } });
  });
});

describe('review round 1 (#3535 LOCAL, SECURITY, UX)', () => {
  it('a loc with a LIKE wildcard covers only its own subtree (a_b does not pull aXb:02)', async () => {
    await spec('a_b', 'Feature: Under', 'root');
    await spec('a_b:01', 'Rule: Mine', 'mine');
    await spec('aXb:02', 'Rule: Not mine', 'theirs');
    await spec('a%b:03', 'Rule: Percent sibling', 'theirs');
    const doc = await read('a_b');
    expect(doc.entries.map((e) => e.loc)).toEqual(['a_b', 'a_b:01']);
    expect(doc.markdown).not.toContain('Not mine');
  });

  it('a descendant of the same loc in another memory is never read', async () => {
    await spec('fx:110', 'Feature: Mine', 'root');
    await db.node.create({ data: { id: generateId(), memoryId: foreign.id, loc: 'fx:110:01', name: 'Rule: Foreign', content: 'FOREIGNBODY', role: 'spec', nodeType: 'info' } });
    const doc = await read('fx:110');
    expect(doc.entries.map((e) => e.loc)).toEqual(['fx:110']);
    expect(doc.markdown).not.toContain('FOREIGN');
  });

  it('a superseded-by pointer into a memory the caller cannot read is omitted', async () => {
    await spec('fx:110', 'Feature: Mine', 'root');
    const old = await spec('fx:110:01', 'Rule: Old', 'old', { tags: ['superseded'] });
    const target = await db.node.create({ data: { id: generateId(), memoryId: foreign.id, loc: 'zz:99', name: 'SECRETTARGET', content: 'x' } });
    await db.edge.create({ data: { memoryId: draft.id, sourceId: old.id, targetId: target.id, loc: `${old.id}:superseded-by:zz:99`, name: 'superseded-by' } });
    const doc = await read('fx:110');
    expect(doc.markdown).not.toContain('zz:99');
    expect(doc.markdown).not.toContain('SECRETTARGET');
    expect(doc.markdown).toContain('Superseded.');
  });

  it('a cap race: rows inserted after the first look are still refused, never rendered', async () => {
    await spec('big:1', 'Feature: Big', 'root');
    await db.node.createMany({
      data: Array.from({ length: SPEC_DOCUMENT_MAX_NODES - 1 }, (_, i) => ({
        id: generateId(), memoryId: draft.id, loc: `big:1:${i + 1}`, name: `Rule: R${i}`, content: 'x', role: 'spec', nodeType: 'info',
      })),
    });
    // Exactly at the cap: allowed. One more arrives: refused. The refusal comes from the fetched set itself.
    expect((await read('big:1')).entries).toHaveLength(SPEC_DOCUMENT_MAX_NODES);
    await spec(`big:1:${SPEC_DOCUMENT_MAX_NODES}`, 'Rule: One more', 'x');
    expect(await read('big:1').catch((e) => e)).toMatchObject({ extensions: { code: 'SPEC_DOCUMENT_TOO_LARGE', limit: 'nodes' } });
  });

  it('the descendant read is bounded in the statement itself (a concurrent insert cannot widen it)', async () => {
    await spec('fx:110', 'Feature: Mine', 'root');
    const spy = vi.spyOn(db.node, 'findMany');
    try {
      await read('fx:110');
      const taken = spy.mock.calls.map((c) => (c[0] as { take?: number } | undefined)?.take);
      expect(taken).toContain(SPEC_DOCUMENT_MAX_NODES);
    } finally { spy.mockRestore(); }
  });

  it('the bound counts what entries serve (includes resolved), though a superseded part shows no Markdown', async () => {
    await spec('src:1', 'Rule: Big source', 'y'.repeat(900_000));
    await spec('srv:1', 'Feature: Served', 'root');
    for (let i = 1; i <= 3; i += 1) {
      await spec(`srv:1:${i}`, `Rule: Old ${i}`, '{{> src:1}}', { tags: ['superseded'] });
    }
    expect(await read('srv:1').catch((e) => e)).toMatchObject({ extensions: { code: 'SPEC_DOCUMENT_TOO_LARGE', limit: 'bytes' } });
  });

  it('the bound is UTF-8 bytes, not characters', async () => {
    await spec('eur:1', 'Feature: Euro', 'root');
    await spec('eur:1:1', 'Rule: Euro', '€'.repeat(Math.ceil(SPEC_DOCUMENT_MAX_BYTES / 3) + 10));
    expect(await read('eur:1').catch((e) => e)).toMatchObject({ extensions: { code: 'SPEC_DOCUMENT_TOO_LARGE', limit: 'bytes' } });
  });

  it('too many distinct links refuse before any is resolved', async () => {
    await spec('lnk:1', 'Feature: Links', 'root');
    const links = Array.from({ length: SPEC_DOCUMENT_MAX_LINK_TARGETS + 1 }, (_, i) => `[[nowhere:${i}]]`).join(' ');
    await spec('lnk:1:1', 'Rule: Links', links);
    expect(await read('lnk:1').catch((e) => e)).toMatchObject({ extensions: { code: 'SPEC_DOCUMENT_TOO_LARGE', limit: 'links' } });
  });

  it('a deleted descendant is not part of the document', async () => {
    await spec('del:1', 'Feature: Del', 'root');
    await spec('del:1:1', 'Rule: Gone', 'gone', { deletedAt: new Date() });
    expect((await read('del:1')).entries.map((e) => e.loc)).toEqual(['del:1']);
  });

  it('over the byte bound it refuses with the named code and shortens nothing', async () => {
    await spec('fat:1', 'Feature: Fat', 'root');
    await spec('fat:1:1', 'Rule: Fat', 'x'.repeat(SPEC_DOCUMENT_MAX_BYTES + 1));
    expect(await read('fat:1').catch((e) => e)).toMatchObject({ extensions: { code: 'SPEC_DOCUMENT_TOO_LARGE', limit: 'bytes' } });
  });
});

describe('includes (acceptance 6)', () => {
  it('a body including a node from a memory the caller cannot read shows the broken-include notice and none of its text or name', async () => {
    const { secret } = await (async () => {
      const s = await db.node.create({ data: { id: generateId(), memoryId: foreign.id, loc: 'zz:inc', name: 'TOPSECRET INCLUDE NAME', content: 'TOPSECRET INCLUDE TEXT' } });
      return { secret: s };
    })();
    await spec('inc:1', 'Feature: Includes', 'root');
    await spec('inc:1:01', 'Rule: Includer', `# Rule: Includer\n\n- **Status:** Proposed\n\nBefore {{> hrn:node:${foreign.urn}:${secret.loc}}} after.\n`);
    const doc = await read('inc:1');
    expect(doc.markdown).toContain('Before [Include unavailable] after.');
    expect(doc.markdown).not.toContain('TOPSECRET');
    expect(JSON.stringify(doc.entries)).not.toContain('TOPSECRET');
  });
});

describe('approval and mint records (acceptance 7)', () => {
  it('carry the record, and a backfilled mint reads minted with no revision or hash', async () => {
    await spec('rec:1', 'Feature: Records', 'root');
    await spec('rec:1:01', 'Rule: Backfilled', body('Rule: Backfilled', 'b'));
    await approve('rec:1:01');
    await db.node.updateMany({ where: { memoryId: draft.id, loc: 'rec:1:01' }, data: { mintedAt: new Date('2026-10-01T00:00:00Z'), mintedByInfo: 'backfill', mintedRevNo: null, mintedHash: null } });
    const doc = await read('rec:1');
    const e = doc.entries.find((x) => x.loc === 'rec:1:01')!;
    expect(e.approvalStatus).toMatchObject({ state: 'APPROVED', approval: { revision: 1 } });
    expect(e.mintStatus).toMatchObject({ minted: true, revision: null, hash: null });
    expect(doc.markdown).toContain('Approval: APPROVED (rev 1) · Mint: minted');
  });
});

describe('the gate (acceptance 3)', () => {
  it('a caller with no read of the memory gets no document', async () => {
    await buildFixture();
    expect(await codeOf(read('fx:110', as(outsider.id)))).not.toBe('NO_ERROR');
  });
});

/** The confirmed document for the fixture, reviewed against cor:spc:030:02 and rulings 0134/0137/0138; any drift fails the golden pin. */
function GOLDEN(memoryUrn: string, foreignUrn: string): string {
  const mem = memoryUrn.replace(/::/g, ':');
  const foreignMem = foreignUrn.replace(/::/g, ':');
  return `# Feature: The action register [fx:110]

${mem} · rendered 2026-11-04T10:12Z

Readiness: 11 specs · 1 approved · 1 minted · 1 superseded · open questions in fx:110:01

- **Status:** Proposed
- **Built:** Not built

## What It's For

See [a code](#fx-110-01), [Rule: Which worker acts](#fx-110-03), [outside](https://portal.example/app/u/hrn:node:${mem}:fx:200:01), [Rule: Outside the document](https://portal.example/app/u/hrn:node:${mem}:fx:200:01), itself, hidden, hrn:node:${foreignMem}:zz:01 and gone.

# Definitions

<a id="fx-110-01"></a>

## Definition: A code [fx:110:01]
Approval: NOT_APPROVED · Mint: unminted

- **Status:** Proposed
- **Built:** Not built

### What It Means

A code is a name.

#### Open Questions, Need Ruling

- Do events share one code space?

# Entities

<a id="fx-110-05"></a>

## Entity: Reserved [fx:110:05]
Approval: NOT_APPROVED · Mint: unminted

Placeholder.

# Rules

<a id="fx-110-09"></a>

## Rule: Positioned last by loc [fx:110:09]
Approval: NOT_APPROVED · Mint: unminted

- **Status:** Proposed
- **Built:** Not built

Positioned.

<a id="fx-110-02"></a>

## Rule: A warning never changes a call [fx:110:02]
Approval: NOT_APPROVED · Mint: unminted

- **Status:** Proposed
- **Built:** Not built

### The Rule

Never.

<a id="fx-110-03"></a>

## Rule: Which worker acts [fx:110:03]
Approval: CHANGED SINCE APPROVAL (rev 1) · Mint: unminted

- **Status:** Proposed
- **Built:** Not built

Changed text.

<a id="fx-110-04"></a>

## Rule: An earlier routing rule [fx:110:04]
Approval: APPROVED (rev 1) · Mint: minted

Superseded by fx:110:03.

<a id="fx-110-a"></a>

## Rule: Lowercase sibling [fx:110:a]
Approval: NOT_APPROVED · Mint: unminted

- **Status:** Proposed
- **Built:** Not built

a

<a id="fx-110-B"></a>

## Rule: Uppercase sibling [fx:110:B]
Approval: NOT_APPROVED · Mint: unminted

- **Status:** Proposed
- **Built:** Not built

B

# Operations

<a id="fx-110-02-01"></a>

## Operation: Nested operation [fx:110:02:01]
Approval: NOT_APPROVED · Mint: unminted

- **Status:** Proposed
- **Built:** Not built

Nested body.

# Other specs

<a id="fx-110-06"></a>

## fx:110:06 — An older name
Approval: NOT_APPROVED · Mint: unminted

- **Status:** Proposed
- **Built:** Not built

Older body.

## Where This Came From

- tail of Feature: The action register [fx:110]
`;
}
