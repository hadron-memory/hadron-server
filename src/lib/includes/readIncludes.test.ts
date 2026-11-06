/**
 * #2041 S2 — includes resolve on every ordinary read (cor:dmo:150:03/:04/:05),
 * through the GraphQL `Node.content` field. Written red-first on main d49ae8fb.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { BROKEN_INCLUDE_NOTICE } from './resolveNodeContent.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { compileTemplate } from '../template.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const server = new ApolloServer<Context>({ typeDefs, resolvers });
async function run(query: string, ctx: Context, variables?: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental result');
  return res.body.singleResult;
}

let memoryId: string;
let memoryUrn: string;
let foreignUrn: string;
let reader: { id: string };   // reads the local memory only
let outsider: { id: string }; // reads nothing here
const as = (u: { id: string }): Context => ({ db, userId: u.id, roles: [] });
const urn = (loc: string) => `hrn:node:${memoryUrn}:${loc}`;
const mk = (loc: string, content: string | null, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, ...extra } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Rd Org', urn: 'rd.example' } });
  const other = await db.organization.create({ data: { id: generateId(), name: 'Other Org', urn: 'other.example' } });
  reader = await db.user.create({ data: { githubId: 204101, githubUsername: 'rd-reader', handle: 'rd-reader', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 204102, githubUsername: 'rd-out', handle: 'rd-out', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'ADMIN' } });
  const gqlAdmin: Context = { db, userId: reader.id, roles: [] };
  const m = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'rd' }, gqlAdmin);
  memoryId = m.id; memoryUrn = m.urn;
  const fm = await db.memory.create({
    data: { name: 'Foreign', urn: 'other.example:foreign', organizationId: other.id, class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  foreignUrn = fm.urn;
  await db.node.create({ data: { id: generateId(), memoryId: fm.id, loc: 'secret', name: 'secret', content: 'FOREIGN_SECRET' } });
});

const NODE_Q = `query($ref: ID!, $raw: Boolean) { node(ref: $ref, raw: $raw) { content } }`;

describe('Node.content resolves includes (#2041)', () => {
  it('node: resolves a loc include in place; raw:true returns the tag as written', async () => {
    await mk('b', 'B text');
    await mk('a', 'before {{> b}} after');
    expect((await run(NODE_Q, as(reader), { ref: urn('a') })).data).toEqual({ node: { content: 'before B text after' } });
    expect((await run(NODE_Q, as(reader), { ref: urn('a'), raw: true })).data).toEqual({ node: { content: 'before {{> b}} after' } });
  });

  it('nests through a chain, and resolves a URN target the reader can read', async () => {
    await mk('c', 'C');
    await mk('b', '[{{> c}}]');
    await mk('a', '{{> b}}|{{> ' + urn('c') + '}}');
    expect((await run(NODE_Q, as(reader), { ref: urn('a') })).data).toEqual({ node: { content: '[C]|C' } });
  });

  it('missing, deleted and unreadable targets all render the SAME notice', async () => {
    const d = await mk('gone', 'GONE');
    await db.node.update({ where: { id: d.id }, data: { deletedAt: new Date() } });
    await mk('a1', 'x {{> nope}} y');
    await mk('a2', 'x {{> gone}} y');
    await mk('a3', `x {{> hrn:node:${foreignUrn}:secret}} y`);
    const want = `x ${BROKEN_INCLUDE_NOTICE} y`;
    for (const loc of ['a1', 'a2', 'a3']) {
      const out = await run(NODE_Q, as(reader), { ref: urn(loc) });
      expect(out.errors).toBeUndefined();
      expect(out.data).toEqual({ node: { content: want } });
    }
  });

  it('a cycle made after the write, and a too-deep chain, render the notice instead of looping', async () => {
    await mk('a', 'A{{> b}}');
    await mk('b', 'B{{> a}}'); // cycle created directly (a write would be refused)
    const cyc = (await run(NODE_Q, as(reader), { ref: urn('a') })).data as { node: { content: string } };
    expect(cyc.node.content).toBe(`AB${BROKEN_INCLUDE_NOTICE}`);
    for (let i = 0; i < 12; i++) await mk(`d${i}`, i < 11 ? `${i}{{> d${i + 1}}}` : '11');
    const deep = (await run(NODE_Q, as(reader), { ref: urn('d0') })).data as { node: { content: string } };
    expect(deep.node.content).toContain(BROKEN_INCLUDE_NOTICE);
    expect(deep.node.content).not.toContain('11');
  });

  it('raw and resolved aliases in one request never contaminate each other, in either order', async () => {
    await mk('b', 'B');
    await mk('a', '{{> b}}');
    const q = `query($ref: ID!) { node(ref: $ref) { r: content(raw: true) s: content(raw: false) d: content } }`;
    expect((await run(q, as(reader), { ref: urn('a') })).data).toEqual({ node: { r: '{{> b}}', s: 'B', d: 'B' } });
    const q2 = `query($ref: ID!) { node(ref: $ref, raw: true) { s: content(raw: false) d: content r: content(raw: true) } }`;
    expect((await run(q2, as(reader), { ref: urn('a') })).data).toEqual({ node: { s: 'B', d: '{{> b}}', r: '{{> b}}' } });
  });

  it('a nested Node field resolves too (edge targets), not only the query root', async () => {
    await mk('b', 'B');
    const a = await mk('a', '{{> b}}');
    const t = await mk('t', 'T {{> b}}');
    await db.edge.create({ data: { id: generateId(), memoryId, sourceId: a.id, targetId: t.id, loc: 'cites:a:t', name: 'cites' } });
    const q = `query($ref: ID!) { node(ref: $ref) { outgoingEdges { target { content } } } }`;
    expect((await run(q, as(reader), { ref: urn('a') })).data).toEqual({ node: { outgoingEdges: [{ target: { content: 'T B' } }] } });
  });

  it('keeps data variables byte for byte, and leaves chat-message/record bodies literal', async () => {
    await mk('b', 'B');
    await mk('v', 'Hi {{name}} {{> b}}', { data: { name: 'Zed' } });
    expect((await run(NODE_Q, as(reader), { ref: urn('v') })).data).toEqual({ node: { content: 'Hi Zed B' } });
    await mk('m', 'quoted {{> b}}', { nodeType: 'chat-message' });
    await mk('r', 'quoted {{> b}}', { nodeType: 'record' });
    for (const loc of ['m', 'r']) {
      expect((await run(NODE_Q, as(reader), { ref: urn(loc) })).data).toEqual({ node: { content: 'quoted {{> b}}' } });
    }
  });

  it('two readers in one process: A\'s resolved read never reaches B, and an unreadable includer is not found', async () => {
    await mk('b', 'B');
    await mk('a', '{{> b}}');
    expect((await run(NODE_Q, as(reader), { ref: urn('a') })).data).toEqual({ node: { content: 'B' } });
    expect((await run(NODE_Q, as(outsider), { ref: urn('a') })).data).toEqual({ node: null });
  });

  it('reads change nothing stored: content, hash, revision count and approval stay byte-identical', async () => {
    await mk('b', 'B');
    const a = await mk('a', '{{> b}}');
    const before = await db.node.findUniqueOrThrow({ where: { id: a.id } });
    const revs = await db.nodeRevision.count({ where: { nodeId: a.id } });
    for (let i = 0; i < 3; i++) await run(NODE_Q, as(reader), { ref: urn('a') });
    const after = await db.node.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.content).toBe('{{> b}}');
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.revSeq).toBe(before.revSeq);
    expect(after.approvalHash).toBe(before.approvalHash);
    expect(await db.nodeRevision.count({ where: { nodeId: a.id } })).toBe(revs);
  });
});

describe('nodeBatch keeps stored text unless the caller asks (R21 A)', () => {
  const BATCH_Q = `query($refs: [ID!]) { nodeBatch(refs: $refs) { nodes { loc bare: content opted: content(raw: false) stored: content(raw: true) } } }`;
  it('bare content is stored, raw:false resolves, raw:true is stored', async () => {
    await mk('b', 'B');
    await mk('a', '{{> b}}');
    const out = await run(BATCH_Q, as(reader), { refs: [urn('a')] });
    expect(out.errors).toBeUndefined();
    expect(out.data).toEqual({ nodeBatch: { nodes: [{ loc: 'a', bare: '{{> b}}', opted: 'B', stored: '{{> b}}' }] } });
  });
});

describe('MCP content tools resolve includes like GraphQL (#2041)', () => {
  const mcp = (u: { id: string }) => createTestableMcpServer({ userId: u.id, roles: [], clientId: `user:${u.id}` });
  const bodyOf = (text: string) => text.split('\n\n---\n\n').slice(1).join('\n\n---\n\n');

  it('hadron_get_node: resolves by default, raw:true returns the tag, same text as GraphQL', async () => {
    await mk('b', 'B');
    await mk('a', 'x {{> b}} y {{> nope}}');
    const text = await mcp(reader).callToolText('hadron_get_node', { urn: urn('a') });
    expect(bodyOf(text)).toBe(`x B y ${BROKEN_INCLUDE_NOTICE}`);
    const gql = (await run(NODE_Q, as(reader), { ref: urn('a') })).data as { node: { content: string } };
    expect(bodyOf(text)).toBe(gql.node.content);
    expect(bodyOf(await mcp(reader).callToolText('hadron_get_node', { urn: urn('a'), raw: true }))).toBe('x {{> b}} y {{> nope}}');
  });

  it('hadron_get_nodes and hadron_get_next_node resolve; raw:true keeps the stored text', async () => {
    await mk('b', 'B');
    await mk('p', null);
    await mk('p:1', 'first {{> b}}');
    const batch = await mcp(reader).callToolText('hadron_get_nodes', { refs: [urn('p:1')] });
    expect(batch).toContain('first B');
    expect(batch).not.toContain('{{> b}}');
    expect(await mcp(reader).callToolText('hadron_get_nodes', { refs: [urn('p:1')], raw: true })).toContain('first {{> b}}');
    const next = await mcp(reader).callToolText('hadron_get_next_node', { parent: urn('p') });
    expect(bodyOf(next)).toBe('first B');
    expect(bodyOf(await mcp(reader).callToolText('hadron_get_next_node', { parent: urn('p'), raw: true }))).toBe('first {{> b}}');
  });

  it('an include the reader cannot read is the notice on MCP too, identical to a missing one', async () => {
    await mk('a1', `x {{> hrn:node:${foreignUrn}:secret}} y`);
    await mk('a2', 'x {{> nope}} y');
    const a1 = bodyOf(await mcp(reader).callToolText('hadron_get_node', { urn: urn('a1') }));
    const a2 = bodyOf(await mcp(reader).callToolText('hadron_get_node', { urn: urn('a2') }));
    expect(a1).toBe(a2);
    expect(a1).not.toContain('FOREIGN_SECRET');
  });
});

describe('exports (cor:dmo:150:03, R40/R47)', () => {
  it('nodeExport full keeps the include tag for a round trip; full:false resolves like a reader', async () => {
    await mk('b', 'B');
    const a = await mk('a', 'x {{> b}} y');
    const exp = (full: boolean | null) => resolvers.Query.nodeExport({}, { id: a.id, full }, as(reader));
    expect((await exp(true)).data).toContain('x {{> b}} y');
    expect((await exp(null)).data).toContain('x {{> b}} y');
    const presented = (await exp(false)).data as string;
    expect(presented).toContain('x B y');
    expect(presented).not.toContain('{{> b}}');
  });
});

describe('traversal-safe memoization (Xavier GAPS item 3)', () => {
  it('a target reached shallow AND near the depth cap renders per traversal: no cached shallow success bypasses the cap', async () => {
    await mk('z', 'Z');
    await mk('y', 'Y{{> z}}');
    await mk('x', 'X{{> y}}');
    for (let i = 8; i >= 1; i--) await mk(`c${i}`, i === 8 ? '{{> x}}' : `{{> c${i + 1}}}`);
    await mk('root', '{{> x}}|{{> c1}}');
    const out = (await run(NODE_Q, as(reader), { ref: urn('root') })).data as { node: { content: string } };
    // shallow branch: x(1) y(2) z(3). deep branch: c1..c8 = 1..8, x(9) y(10), z would be 11.
    expect(out.node.content).toBe(`XYZ|XY${BROKEN_INCLUDE_NOTICE}`);
  });

  it('a diamond resolves in both branches, and a cycle introduced later still renders the notice at its repeat', async () => {
    await mk('d', 'D');
    await mk('b', 'B{{> d}}');
    await mk('c', 'C{{> d}}');
    await mk('a', '{{> b}}{{> c}}');
    expect(((await run(NODE_Q, as(reader), { ref: urn('a') })).data as { node: { content: string } }).node.content).toBe('BDCD');
    await db.node.update({ where: { memoryId_loc: { memoryId, loc: 'd' } } as never, data: { content: 'D{{> a}}' } }).catch(async () => {
      await db.node.updateMany({ where: { memoryId, loc: 'd' }, data: { content: 'D{{> a}}' } });
    });
    const again = ((await run(NODE_Q, as(reader), { ref: urn('a') })).data as { node: { content: string } }).node.content;
    expect(again).toBe(`BD${BROKEN_INCLUDE_NOTICE}CD${BROKEN_INCLUDE_NOTICE}`);
  });

  it('two revision settings serve two revisions; signed is ignored until signing ships (D7); approved with no approval is the notice', async () => {
    const t = await mk('t', 'v2');
    await db.nodeRevision.create({
      data: { id: generateId(), nodeId: t.id, memoryId, revNo: 1, loc: 't', name: 't', content: 'v1', tags: [] },
    });
    await mk('a', '{{> t}} {{> t rev=1}} {{> t rev=9}} {{> t signed}} {{> t rev=1 signed}} {{> t approved}} {{> t approved signed}}');
    const out = (await run(NODE_Q, as(reader), { ref: urn('a') })).data as { node: { content: string } };
    const N = BROKEN_INCLUDE_NOTICE;
    expect(out.node.content).toBe(`v2 v1 ${N} v2 v1 ${N} ${N}`);
  });

  it('readers with different access in one process never share a result', async () => {
    const org2 = await db.organization.findFirstOrThrow({ where: { urn: 'rd.example' } });
    const second = await db.user.create({ data: { githubId: 204103, githubUsername: 'rd-second', handle: 'rd-second', roles: [] } });
    await db.orgMember.create({ data: { organizationId: org2.id, userId: second.id, role: 'READER' } });
    const foreign = await db.memory.findFirstOrThrow({ where: { urn: foreignUrn } });
    const other = await db.orgMember.findFirstOrThrow({ where: { organizationId: foreign.organizationId! } }).catch(() => null);
    expect(other).toBeNull();
    await mk('a', `{{> hrn:node:${foreignUrn}:secret}}`);
    // the first reader can read neither; grant the second reader the foreign org and read both
    await db.orgMember.create({ data: { organizationId: foreign.organizationId!, userId: second.id, role: 'READER' } });
    const [r1, r2] = await Promise.all([
      run(NODE_Q, as(reader), { ref: urn('a') }),
      run(NODE_Q, as(second), { ref: urn('a') }),
    ]);
    expect(r1.data).toEqual({ node: { content: BROKEN_INCLUDE_NOTICE } });
    expect(r2.data).toEqual({ node: { content: 'FOREIGN_SECRET' } });
  });
});

describe('genuinely sealed targets and the search index (#2041)', () => {
  it('an encrypted target resolves with a live key and is the notice without one; the stored row is an envelope', async () => {
    const { sessionKeyCache } = await import('../sessionKeyCache.js');
    const { generateDataKey } = await import('../crypto.js');
    const { encryptNodeFields } = await import('../nodeCrypto.js');
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'rd.example' } });
    const encMem = await db.memory.create({
      data: { name: 'sealed', urn: 'rd.example:sealed', organizationId: org.id, class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true },
    });
    sessionKeyCache.set('rd-session', encMem.id, generateDataKey());
    const sealed = encryptNodeFields({ content: 'SEALED_TEXT' }, { id: encMem.id, isEncrypted: true });
    const row = await db.node.create({ data: { id: generateId(), memoryId: encMem.id, loc: 'vault', name: 'vault', content: sealed.content } });
    expect(row.content).not.toContain('SEALED_TEXT');
    await mk('a', `{{> hrn:node:${encMem.urn}:vault}}`);
    expect((await run(NODE_Q, as(reader), { ref: urn('a') })).data).toEqual({ node: { content: 'SEALED_TEXT' } });
    sessionKeyCache.clear();
    expect((await run(NODE_Q, as(reader), { ref: urn('a') })).data).toEqual({ node: { content: BROKEN_INCLUDE_NOTICE } });
  });

  it('a phrase only in the included node finds the target and never the includer', async () => {
    await mk('policy', 'zebrafish quarterly obligations');
    await mk('doc', 'See {{> policy}}');
    await run(NODE_Q, as(reader), { ref: urn('doc') }); // a resolved read first
    const hits = await resolvers.Query.findNodes({}, { query: 'zebrafish', mode: 'keyword' } as never, as(reader)) as { nodes?: Array<{ node: { loc: string } }> } | Array<{ node?: { loc: string }; loc?: string }>;
    const locs = JSON.stringify(hits);
    expect(locs).toContain('policy');
    expect(locs).not.toContain('"doc"');
  });
});

describe('the empty-filter render paths (run, chat, session) stay local (#2041 §1.5)', () => {
  it('compileTemplate with no access filter splices same-memory includes but never a foreign URN', async () => {
    await mk('b', 'B');
    const text = `{{> b}} {{> hrn:node:${foreignUrn}:secret}} {{> ${urn('b')}}}`;
    // `{}` means "unrestricted" to the filter, so it must NOT turn a foreign URN into a read.
    expect(await compileTemplate(text, null, memoryId, db, {})).toBe(`B ${BROKEN_INCLUDE_NOTICE} B`);
  });
});

describe('pinned revisions: the live revision and sealed history (Atilla P2-1/P2-2, Jane P2)', () => {
  it('rev=N naming the LIVE revision serves it when no snapshot row exists', async () => {
    const t = await mk('live', 'CURRENT-PIN-TEXT');
    expect(await db.nodeRevision.count({ where: { nodeId: t.id, revNo: t.revSeq } })).toBe(0);
    await mk('a', `{{> live rev=${t.revSeq}}}`);
    expect((await run(NODE_Q, as(reader), { ref: urn('a') })).data).toEqual({ node: { content: 'CURRENT-PIN-TEXT' } });
    await mk('b', `{{> live rev=${t.revSeq + 5}}}`);
    expect((await run(NODE_Q, as(reader), { ref: urn('b') })).data).toEqual({ node: { content: BROKEN_INCLUDE_NOTICE } });
  });

  it('a pin into a sealed memory returns plaintext with the key, the notice without it or with a wrong key, and never an error or an envelope', async () => {
    const { sessionKeyCache } = await import('../sessionKeyCache.js');
    const { generateDataKey } = await import('../crypto.js');
    const { encryptNodeFields } = await import('../nodeCrypto.js');
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'rd.example' } });
    const encMem = await db.memory.create({
      data: { name: 'sealed2', urn: 'rd.example:sealed2', organizationId: org.id, class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true },
    });
    const info = { id: encMem.id, isEncrypted: true };
    sessionKeyCache.set('rd-s', encMem.id, generateDataKey());
    const live = await db.node.create({
      data: { id: generateId(), memoryId: encMem.id, loc: 'vault', name: 'vault', content: encryptNodeFields({ content: 'LIVE-SEALED' }, info).content },
    });
    await db.nodeRevision.create({
      data: { id: generateId(), nodeId: live.id, memoryId: encMem.id, revNo: 1, loc: 'vault', name: 'vault', content: encryptNodeFields({ content: 'PAST-SEALED' }, info).content, tags: [] },
    });
    const stored = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: live.id, revNo: 1 } });
    expect(stored.content).not.toContain('PAST-SEALED');
    await mk('a', `{{> hrn:node:${encMem.urn}:vault rev=1}}|{{> hrn:node:${encMem.urn}:vault}}`);
    expect((await run(NODE_Q, as(reader), { ref: urn('a') })).data).toEqual({ node: { content: 'PAST-SEALED|LIVE-SEALED' } });
    sessionKeyCache.clear();
    expect((await run(NODE_Q, as(reader), { ref: urn('a') })).data).toEqual({ node: { content: `${BROKEN_INCLUDE_NOTICE}|${BROKEN_INCLUDE_NOTICE}` } });
    sessionKeyCache.set('rd-s2', encMem.id, generateDataKey()); // a different key: decrypt fails
    const wrong = await run(NODE_Q, as(reader), { ref: urn('a') });
    expect(wrong.errors).toBeUndefined();
    expect(wrong.data).toEqual({ node: { content: `${BROKEN_INCLUDE_NOTICE}|${BROKEN_INCLUDE_NOTICE}` } });
  });
});

/**
 * #2135 — R77 (cor:dmo:150:02): an include tag written as code is literal text on the
 * SERVED path. The parser already leaves it unspliced; the renderer then handed it to
 * Mustache, which dropped it as a partial with no definition. Written red-first on
 * main b66708bf; each case reads through the owning GraphQL/MCP code, not the parser.
 */
describe('literal include examples in Markdown code (#2135)', () => {
  const mcp = (u: { id: string }) => createTestableMcpServer({ userId: u.id, roles: [], clientId: `user:${u.id}` });
  const bodyOf = (text: string) => text.split('\n\n---\n\n').slice(1).join('\n\n---\n\n');
  const read = async (loc: string) =>
    ((await run(NODE_Q, as(reader), { ref: urn(loc) })).data as { node: { content: string } }).node.content;

  const LITERALS: Array<[string, string]> = [
    ['an inline span', 'see `{{> b}}` for syntax'],
    ['a multi-line inline span', 'see `{{> b}}\nand more` end'],
    ['a double-backtick span', 'see ``{{> b}}`` for syntax'],
    ['a backtick fence with an info string', 'before\n```md title\n{{> b}}\n```\nafter'],
    ['a backtick fence closed by a longer fence', 'before\n```\n{{> b rev=1}}\n`````\nafter'],
    ['a tilde fence', 'before\n~~~\n{{> b}}\n~~~\nafter'],
    ['an indented block', 'before\n\n    {{> b}}\n\nafter'],
    ['malformed include-looking text', 'see `{{> nope rev=x}}` and\n```\n{{> hrn:node:bad}}\n```'],
  ];

  it.each(LITERALS)('%s survives the served read byte for byte', async (_name, stored) => {
    await mk('b', 'B');
    await mk('a', stored);
    expect(await read('a')).toBe(stored);
    expect((await run(NODE_Q, as(reader), { ref: urn('a'), raw: true })).data).toEqual({ node: { content: stored } });
  });

  it('a literal example and an active include in one node: the example stays, the include splices', async () => {
    await mk('b', 'B');
    await mk('a', '`{{> b}}` real: {{> b}}');
    expect(await read('a')).toBe('`{{> b}}` real: B');
  });

  it('variables still render across the node while the example survives', async () => {
    await mk('b', 'B');
    await mk('v', 'Hi {{name}} `{{> b}}`', { data: { name: 'Zed' } });
    expect(await read('v')).toBe('Hi Zed `{{> b}}`');
  });

  it('a stored malformed ACTIVE tag no longer costs the node its literal examples', async () => {
    await mk('b', 'B');
    await mk('a', 'keep `{{> b}}` here {{> b rev=x}}');
    expect(await read('a')).toBe('keep `{{> b}}` here ');
  });

  it('an example inside an included node survives, nested one level further down too', async () => {
    await mk('c', 'syntax: `{{> b}}`');
    await mk('b', 'B');
    await mk('mid', 'mid {{> c}}');
    await mk('a', 'top {{> mid}} {{> b}}');
    expect(await read('a')).toBe('top mid syntax: `{{> b}}` B');
  });

  it('a revision-pinned include carries its example too', async () => {
    await mk('b', 'B');
    const c = await mk('c', 'v1 `{{> b}}`');
    await db.nodeRevision.create({
      data: { id: generateId(), nodeId: c.id, memoryId, revNo: 1, loc: 'c', name: 'c', content: 'old `{{> b}}`', tags: [] },
    });
    await mk('a', '{{> c rev=1}} | {{> c}}');
    expect(await read('a')).toBe('old `{{> b}}` | v1 `{{> b}}`');
  });

  it('code is judged per source node: an included node that ends mid-fence does not turn the includer\'s next tag into code', async () => {
    await mk('b', 'B');
    await mk('open', 'start\n```\nunterminated');
    await mk('a', '{{> open}}\n{{> b}}');
    expect(await read('a')).toBe('start\n```\nunterminated\nB');
    // and the includer's own literal example after such an include is still literal
    await mk('a2', '{{> open}}\n`{{> b}}`');
    expect(await read('a2')).toBe('start\n```\nunterminated\n`{{> b}}`');
  });

  it('text that merely looks like a protection marker is not corrupted', async () => {
    await mk('b', 'B');
    const looksLike = '\u0001hrn-lit-0000\u0001 `{{> b}}` \u0001';
    await mk('a', looksLike);
    expect(await read('a')).toBe(looksLike);
  });

  it('reads change nothing stored for a node holding examples', async () => {
    await mk('b', 'B');
    const a = await mk('a', 'x `{{> b}}` y');
    const before = await db.node.findUniqueOrThrow({ where: { id: a.id } });
    const revs = await db.nodeRevision.count({ where: { nodeId: a.id } });
    for (let i = 0; i < 3; i++) await read('a');
    const after = await db.node.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.content).toBe('x `{{> b}}` y');
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.revSeq).toBe(before.revSeq);
    expect(await db.nodeRevision.count({ where: { nodeId: a.id } })).toBe(revs);
  });

  it('MCP hadron_get_node, hadron_get_nodes and hadron_get_next_node serve the same text as GraphQL', async () => {
    await mk('b', 'B');
    await mk('p', null);
    const stored = 'use `{{> b}}`\n```\n{{> b}}\n```\nthen {{> b}}';
    await mk('p:1', stored);
    const served = 'use `{{> b}}`\n```\n{{> b}}\n```\nthen B';
    expect(await read('p:1')).toBe(served);
    expect(bodyOf(await mcp(reader).callToolText('hadron_get_node', { urn: urn('p:1') }))).toBe(served);
    expect(bodyOf(await mcp(reader).callToolText('hadron_get_node', { urn: urn('p:1'), raw: true }))).toBe(stored);
    const batch = await mcp(reader).callToolText('hadron_get_nodes', { refs: [urn('p:1')] });
    expect(batch).toContain(served);
    expect(await mcp(reader).callToolText('hadron_get_nodes', { refs: [urn('p:1')], raw: true })).toContain(stored);
    expect(bodyOf(await mcp(reader).callToolText('hadron_get_next_node', { parent: urn('p') }))).toBe(served);
    expect(bodyOf(await mcp(reader).callToolText('hadron_get_next_node', { parent: urn('p'), raw: true }))).toBe(stored);
  });

  it('the include-only read (mode includes) is unchanged: literal stays, active splices, variables untouched', async () => {
    await mk('b', 'B');
    const stored = '`{{> b}}` {{> b}} {{name}}';
    const a = await mk('a', stored, { data: { name: 'Zed' } });
    const { resolveNodeContent } = await import('./resolveNodeContent.js');
    expect(await resolveNodeContent(as(reader), a, { mode: 'includes' })).toBe('`{{> b}}` B {{name}}');
  });
});
