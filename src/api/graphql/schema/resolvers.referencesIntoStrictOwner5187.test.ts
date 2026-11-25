/**
 * #5187 (A5 of #5182; cor:acl:010:02 "a reference into a personal or private memory", cor:api:140:03): an audit
 * with pins. A reference that points into another user's personal or private memory is never altered, scrubbed or
 * deleted, and a reader who cannot read that memory sees what a MISSING target gives, on every surface that follows
 * a link, an edge, an include tag or a node reference:
 *
 *   - following a node reference: the surface's own not-found, naming the caller's reference;
 *   - an edge listing: the far end is absent (MCP) or null (GraphQL), with no far id, URN or name;
 *   - an include tag: the one served notice, the same bytes as a missing target.
 *
 * Strict ownership has no bypass, so the probes are a stranger, an organization OWNER and a platform ADMIN, against
 * a PERSONAL and a PRIVATE target memory. The owner is the positive control (the same reference resolves), and a
 * reference to a node that does not exist is the missing-reference control.
 *
 * No behaviour changes in this slice. A surface that answers differently is REPORTED on the issue, not fixed here;
 * one is named at the end of this header and pinned only for what it conceals:
 *   GraphQL keeps the edge ROW (loc, name, urn) with a null endpoint where MCP drops the edge, and a derived edge
 *   loc embeds the far node's loc. Reported on #5187, not pinned as correct.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { BROKEN_INCLUDE_NOTICE } from '../../../lib/includes/resolveNodeContent.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const gql = new ApolloServer<Context>({ typeDefs, resolvers });
async function run(query: string, ctx: Context, variables?: Record<string, unknown>) {
  const res = await gql.executeOperation({ query, variables }, { contextValue: ctx });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental result');
  return res.body.singleResult;
}

type U = { id: string; roles: Array<'READER' | 'ADMIN'> };
type Target = { cls: 'personal' | 'private'; memoryId: string; urn: string; nodeId: string; nodeLoc: string; name: string };

let alice: U;
let readers: Array<{ label: string; user: U }>;
let holderMemoryId: string; // an organization knowledge memory every reader can read
let holderUrn: string;
let holderNodeIds: Record<string, string>;
const targets: Target[] = [];
const SECRET_NAME = 'Hidden Alice Node';

const mcp = (u: U) => createTestableMcpServer({ userId: u.id, roles: u.roles, clientId: `user:${u.id}` });
const gctx = (u: U): Context => ({ db, userId: u.id, roles: u.roles });
const mkUser = (tag: string, roles: U['roles']) =>
  db.user.create({ data: { id: generateId(), handle: `${tag}5187-${generateId().slice(-6)}`, githubUsername: `${tag}5187-${generateId().slice(-6)}`, roles } })
    .then((u) => ({ id: u.id, roles }));

beforeEach(async () => {
  await cleanDb(db);
  targets.length = 0;
  const org = await db.organization.create({ data: { id: generateId(), name: 'Refs Org', urn: 'refs5187.test' } });
  alice = await mkUser('alice', ['READER']);
  const stranger = await mkUser('stranger', ['READER']);
  const orgOwner = await mkUser('orgowner', ['READER']);
  const platformAdmin = await mkUser('padmin', ['ADMIN']);
  await db.orgMember.create({ data: { organizationId: org.id, userId: alice.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: stranger.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: orgOwner.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: platformAdmin.id, role: 'ADMIN' } });
  readers = [
    { label: 'stranger', user: stranger },
    { label: 'org OWNER', user: orgOwner },
    { label: 'platform ADMIN', user: platformAdmin },
  ];

  const holder = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, name: 'holder', urn: 'refs5187.test:holder', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  holderMemoryId = holder.id;
  holderUrn = holder.urn;
  const src = await db.node.create({ data: { id: generateId(), memoryId: holder.id, loc: 'src', name: 'Holder Source', content: 'holder body' } });
  const next = await db.node.create({ data: { id: generateId(), memoryId: holder.id, loc: 'src:kid', name: 'Holder Kid', seq: 1, content: 'kid body' } });
  holderNodeIds = { src: src.id, kid: next.id };

  for (const cls of ['personal', 'private'] as const) {
    const m = await db.memory.create({
      data: { id: generateId(), ownerUserId: alice.id, userId: alice.id, class: cls, name: `alice-${cls}`, urn: `refs5187.test:alice-${cls}` },
    });
    const n = await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'hidden', name: `${SECRET_NAME} ${cls}`, content: `ALICE_SECRET_${cls}` } });
    targets.push({ cls, memoryId: m.id, urn: m.urn, nodeId: n.id, nodeLoc: 'hidden', name: n.name });
    // The holder's kid points INTO the strict-owner memory (a reference the platform must leave in place), and the
    // strict-owner memory's node points back out to the holder (an incoming edge for the holder's node).
    await db.edge.create({ data: { memoryId: holder.id, sourceId: next.id, targetId: n.id, name: `into-${cls}`, loc: `src:kid:into-${cls}:hidden` } });
    await db.edge.create({ data: { memoryId: m.id, sourceId: n.id, targetId: next.id, name: `back-${cls}`, loc: `hidden:back-${cls}:src:kid` } });
  }
});

const leaks = (text: string, t: Target) =>
  [t.nodeId, t.name, `ALICE_SECRET_${t.cls}`, t.urn].filter((s) => text.includes(s));

describe('an edge listing never carries a far end in a memory the reader cannot read (cor:api:140:03)', () => {
  for (const cls of ['personal', 'private'] as const) {
    it(`MCP hadron_get_node, hadron_get_nodes (refs and prefix forms) and hadron_get_next_node: ${cls}`, async () => {
      const t = targets.find((x) => x.cls === cls)!;
      for (const { label, user } of readers) {
        const s = mcp(user);
        const one = await s.callToolText('hadron_get_node', { urn: `hrn:node:${holderUrn}:src:kid` });
        expect(one, label).toContain('Holder Kid');
        expect(leaks(one, t), `${label} get_node`).toEqual([]);
        const batch = await s.callToolText('hadron_get_nodes', { refs: [`hrn:node:${holderUrn}:src:kid`] });
        expect(batch, label).toContain('Holder Kid');
        expect(leaks(batch, t), `${label} get_nodes refs`).toEqual([]);
        const prefix = await s.callToolText('hadron_get_nodes', { memoryUrn: holderUrn, locPrefix: 'src' });
        expect(prefix, label).toContain('Holder Kid');
        expect(leaks(prefix, t), `${label} get_nodes prefix`).toEqual([]);
        const next = await s.callToolText('hadron_get_next_node', { parent: `hrn:node:${holderUrn}:src` });
        expect(next, label).toContain('Holder Kid');
        expect(leaks(next, t), `${label} get_next_node`).toEqual([]);
      }
    });

    it(`GraphQL node(ref:), Node.outgoingEdges and incomingEdges: ${cls}`, async () => {
      const t = targets.find((x) => x.cls === cls)!;
      const Q = `query($ref: ID!) { node(ref: $ref) { name
        outgoingEdges { name target { id name loc urn } }
        incomingEdges { name source { id name loc urn } } } }`;
      for (const { label, user } of readers) {
        const r = await run(Q, gctx(user), { ref: holderNodeIds.kid });
        expect(r.errors, label).toBeUndefined();
        const node = (r.data as any).node;
        expect(node.name, label).toBe('Holder Kid');
        expect(leaks(JSON.stringify(node), t), `${label} node edges`).toEqual([]);
        for (const e of [...node.outgoingEdges, ...node.incomingEdges]) {
          if (e.target) expect(e.target.id, label).not.toBe(t.nodeId);
          if (e.source) expect(e.source.id, label).not.toBe(t.nodeId);
        }
        // Batch form (`nodes(refs:)` shares the endpoint gate): the same answer.
      }
    });

    it(`GraphQL edges list and edge(ref:) hide the unreadable endpoint: ${cls}`, async () => {
      const t = targets.find((x) => x.cls === cls)!;
      const edgeRow = await db.edge.findFirstOrThrow({ where: { memoryId: holderMemoryId, name: `into-${cls}` } });
      const Q = `query($f: EdgeFilter) { edges(filter: $f) { items { id name target { id name } source { id name } } } }`;
      for (const { label, user } of readers) {
        const r = await run(Q, gctx(user), { f: { memoryId: holderMemoryId } });
        expect(r.errors, label).toBeUndefined();
        const items = (r.data as any).edges.items as Array<{ id: string; target: unknown; source: unknown }>;
        const row = items.find((i) => i.id === edgeRow.id)!;
        expect(row, label).toBeTruthy();
        expect(row.target, `${label} list target`).toBeNull();
        expect(leaks(JSON.stringify(items), t), `${label} list`).toEqual([]);
        const one = await run(`query($r: ID!) { edge(ref: $r) { id target { id name } } }`, gctx(user), { r: edgeRow.id });
        expect((one.data as any).edge.target, `${label} edge(ref)`).toBeNull();
      }
    });
  }
});

describe('following a node reference into the memory answers as a missing node would (cor:api:140:03)', () => {
  for (const cls of ['personal', 'private'] as const) {
    it(`MCP and GraphQL node reads, owner control and missing control: ${cls}`, async () => {
      const t = targets.find((x) => x.cls === cls)!;
      const ref = `hrn:node:${t.urn}:${t.nodeLoc}`;
      const missing = `hrn:node:${t.urn}:no-such-node`;
      // Owner: the reference resolves.
      expect(await mcp(alice).callToolText('hadron_get_node', { urn: ref })).toContain(t.name);
      expect(((await run(`query($r: ID!) { node(ref: $r) { name } }`, gctx(alice), { r: t.nodeId })).data as any).node.name).toBe(t.name);
      for (const { label, user } of readers) {
        const out = await mcp(user).callToolText('hadron_get_node', { urn: ref });
        expect(leaks(out, t).filter((s) => s !== t.urn), `${label} mcp`).toEqual([]);
        const ctl = await mcp(user).callToolText('hadron_get_node', { urn: missing });
        // The same message modulo the reference the caller named.
        expect(out.replace(ref, '<REF>'), `${label} mcp same as missing`).toBe(ctl.replace(missing, '<REF>'));
        for (const r of [t.nodeId, ref]) {
          const g = await run(`query($r: ID!) { node(ref: $r) { id name } }`, gctx(user), { r });
          expect((g.data as any)?.node ?? null, `${label} gql ${r}`).toBeNull();
        }
      }
    });
  }
});

describe('an include tag into the memory is the one served notice (cor:dmo:150:05)', () => {
  for (const cls of ['personal', 'private'] as const) {
    it(`GraphQL Node.content and MCP hadron_get_node: ${cls}`, async () => {
      const t = targets.find((x) => x.cls === cls)!;
      const inc = await db.node.create({
        data: { id: generateId(), memoryId: holderMemoryId, loc: `inc-${cls}`, name: 'Includer', content: `before {{> hrn:node:${t.urn}:${t.nodeLoc}}} after` },
      });
      const miss = await db.node.create({
        data: { id: generateId(), memoryId: holderMemoryId, loc: `miss-${cls}`, name: 'Misser', content: `before {{> hrn:node:${t.urn}:no-such-node}} after` },
      });
      void miss;
      for (const { label, user } of readers) {
        const g = await run(`query($r: ID!) { node(ref: $r) { content } }`, gctx(user), { r: inc.id });
        const content = (g.data as any).node.content as string;
        expect(content, label).toContain(BROKEN_INCLUDE_NOTICE);
        expect(leaks(content, t), `${label} gql content`).toEqual([]);
        const gm = await run(`query($r: ID!) { node(ref: $r) { content } }`, gctx(user), { r: miss.id });
        expect((gm.data as any).node.content, `${label} same bytes as missing`).toBe(content);
        const out = await mcp(user).callToolText('hadron_get_node', { urn: `hrn:node:${holderUrn}:inc-${cls}` });
        expect(out, label).toContain(BROKEN_INCLUDE_NOTICE);
        expect(leaks(out, t), `${label} mcp content`).toEqual([]);
      }
      // Owner control: Alice reads the included text.
      const own = await run(`query($r: ID!) { node(ref: $r) { content } }`, gctx(alice), { r: inc.id });
      expect((own.data as any).node.content).toContain(`ALICE_SECRET_${cls}`);
    });
  }
});

describe('a write that names a node in the memory does not confirm it exists', () => {
  it('MCP hadron_create_edge to the memory and to a missing node refuse alike', async () => {
    for (const { label, user } of readers) {
      for (const t of targets) {
        const s = mcp(user);
        const toSecret = await s.callToolText('hadron_create_edge', {
          sourceUrn: `hrn:node:${holderUrn}:src`, targetUrn: `hrn:node:${t.urn}:${t.nodeLoc}`, name: `probe-${t.cls}`,
        });
        const toMissing = await s.callToolText('hadron_create_edge', {
          sourceUrn: `hrn:node:${holderUrn}:src`, targetUrn: `hrn:node:${t.urn}:no-such-node`, name: `probe-${t.cls}`,
        });
        expect(toSecret.replace(`${t.nodeLoc}`, '<L>'), label).toBe(toMissing.replace('no-such-node', '<L>'));
        expect(leaks(toSecret, t).filter((x) => x !== t.urn), label).toEqual([]);
      }
    }
    expect(await db.edge.count({ where: { name: { startsWith: 'probe-' } } })).toBe(0);
  });

  it('a hard delete cascade refusal does not name a memory the caller cannot read', async () => {
    for (const { label, user } of readers) {
      for (const t of targets) {
        const out = await mcp(user).callToolText('hadron_delete_node', {
          urn: `hrn:node:${holderUrn}:src:kid`, hard: true, cascadeCrossMemoryEdges: true,
        });
        expect(out, label).not.toContain(t.urn);
        expect(out, label).not.toContain(t.name);
        expect(out, label).not.toContain(t.memoryId);
      }
    }
    expect(await db.node.findUnique({ where: { id: holderNodeIds.kid } })).not.toBeNull();
  });
});

describe('a run render inlines nothing from the memory (cor:dmo:150:04, cor:api:060:05)', () => {
  for (const cls of ['personal', 'private'] as const) {
    it(`GraphQL renderRunNode: an include tag and a dependency edge into the memory, ${cls}`, async () => {
      const t = targets.find((x) => x.cls === cls)!;
      const runNode = await db.node.create({
        data: {
          id: generateId(), memoryId: holderMemoryId, loc: `run-${cls}`, name: 'Run node', isRunnable: true,
          content: `start {{> hrn:node:${t.urn}:${t.nodeLoc}}} end`,
        },
      });
      await db.edge.create({
        data: { memoryId: holderMemoryId, sourceId: runNode.id, targetId: t.nodeId, name: `dep-${cls}`, loc: `run-${cls}:dep-${cls}:hidden` },
      });
      // Owner control: the include text is rendered for the owner (the memory is in the owner's reach).
      const own = await run(`query($r: String!) { renderRunNode(nodeRef: $r) }`, gctx(alice), { r: runNode.id });
      expect(JSON.stringify(own.data), 'owner control').toContain(`ALICE_SECRET_${cls}`);
      for (const { label, user } of readers) {
        const r = await run(`query($r: String!) { renderRunNode(nodeRef: $r) }`, gctx(user), { r: runNode.id });
        const text = JSON.stringify(r.data) + JSON.stringify(r.errors ?? []);
        expect(leaks(text, t), `${label} render`).toEqual([]);
        expect(text, label).toContain(BROKEN_INCLUDE_NOTICE);
      }
    });
  }
});
