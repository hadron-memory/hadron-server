/**
 * #5187 (A5 of #5182; cor:acl:010:02 "a reference into a personal or private memory", cor:api:140:03): an audit
 * with pins. A reference that points into another user's personal or private memory is never altered, scrubbed or
 * deleted, and a reader who cannot read that memory sees what a MISSING target gives, on every surface that follows
 * a link, an edge, an include tag or a node reference:
 *
 *   - following a node reference: the surface's own not-found, naming the caller's reference;
 *   - an edge listing: the far end is absent (MCP) or null (GraphQL), with no far id, URN or name;
 *   - an include tag: the one served notice (GraphQL: the same bytes as a missing target).
 *
 * Strict ownership has no bypass, so the probes are a stranger, an organization OWNER and a platform ADMIN, against
 * a PERSONAL and a PRIVATE target memory. The owner is the positive control (the same reference resolves), and a
 * reference to a node that does not exist is the missing-reference control.
 *
 * The target memory is run in BOTH shapes the schema admits: user-owned (`ownerUserId`, no organization) and
 * org-owned (`organizationId` set, `userId` the owner). Only the second gives an organization OWNER or admin a
 * relation to the target, so only it can catch an arm that admits by organization role (Rodolfo, SEC10).
 *
 * No behaviour changes in this slice. A surface that answers differently is REPORTED on the issue, not fixed here:
 * GraphQL keeps the edge ROW (loc, name, urn) with a null endpoint where MCP drops the edge, and a derived edge
 * loc embeds the far node's loc. Reported on #5187, left as an `it.todo` below, never asserted as correct.
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
const SHAPES = ['user-owned', 'org-owned'] as const;
type Shape = (typeof SHAPES)[number];
let shape: Shape;

const mcp = (u: U) => createTestableMcpServer({ userId: u.id, roles: u.roles, clientId: `user:${u.id}` });
const gctx = (u: U): Context => ({ db, userId: u.id, roles: u.roles });
const mkUser = (tag: string, roles: U['roles']) =>
  db.user.create({ data: { id: generateId(), handle: `${tag}5187-${generateId().slice(-6)}`, githubUsername: `${tag}5187-${generateId().slice(-6)}`, roles } })
    .then((u) => ({ id: u.id, roles }));

async function seed(): Promise<void> {
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
  const kid = await db.node.create({ data: { id: generateId(), memoryId: holder.id, loc: 'src:kid', name: 'Holder Kid', seq: 1, content: 'kid body' } });
  holderNodeIds = { src: src.id, kid: kid.id };

  for (const cls of ['personal', 'private'] as const) {
    const m = await db.memory.create({
      data: shape === 'org-owned'
        ? { id: generateId(), organizationId: org.id, userId: alice.id, class: cls, name: `alice-${cls}`, urn: `refs5187.test:alice-${cls}` }
        : { id: generateId(), ownerUserId: alice.id, userId: alice.id, class: cls, name: `alice-${cls}`, urn: `refs5187.test:alice-${cls}` },
    });
    const n = await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'hidden', name: `${SECRET_NAME} ${cls}`, content: `ALICE_SECRET_${cls}` } });
    targets.push({ cls, memoryId: m.id, urn: m.urn, nodeId: n.id, nodeLoc: 'hidden', name: n.name });
    // The holder's kid points INTO the strict-owner memory (a reference the platform must leave in place), and the
    // strict-owner memory's node points back out to the holder (an incoming edge for the holder's node).
    await db.edge.create({ data: { memoryId: holder.id, sourceId: kid.id, targetId: n.id, name: `into-${cls}`, loc: `src:kid:into-${cls}:hidden` } });
    await db.edge.create({ data: { memoryId: m.id, sourceId: n.id, targetId: kid.id, name: `back-${cls}`, loc: `hidden:back-${cls}:src:kid` } });
  }
}

const leaks = (text: string, t: Target) =>
  [t.nodeId, t.name, `ALICE_SECRET_${t.cls}`, t.urn].filter((s) => text.includes(s));
/** The data of a GraphQL result, asserting it carried no errors, so a failure names the reader. */
const dataOf = (r: { errors?: unknown; data?: unknown }, label: string): any => {
  expect(r.errors, label).toBeUndefined();
  return r.data;
};

for (const shapeName of SHAPES) {
  describe(`target memory is ${shapeName}`, () => {
    beforeEach(async () => {
      shape = shapeName;
      await seed();
    });

    describe('an edge listing never carries a far end in a memory the reader cannot read (cor:api:140:03)', () => {
      for (const cls of ['personal', 'private'] as const) {
        it(`MCP hadron_get_node, hadron_get_nodes (refs and prefix forms) and hadron_get_next_node: ${cls}`, async () => {
          const t = targets.find((x) => x.cls === cls)!;
          const kid = `hrn:node:${holderUrn}:src:kid`;
          // Owner control: the owner of the target sees the edge's far end, so a surface that stopped listing edges
          // cannot pass the readers' absence checks below.
          const own = await mcp(alice).callToolText('hadron_get_node', { urn: kid });
          expect(own, 'owner').toContain(t.name);
          expect(own, 'owner sees the edge').toContain(`into-${cls}`);
          for (const { label, user } of readers) {
            const s = mcp(user);
            const one = await s.callToolText('hadron_get_node', { urn: kid });
            expect(one, label).toContain('Holder Kid');
            expect(leaks(one, t), `${label} get_node`).toEqual([]);
            // MCP drops the whole edge (a documented difference from GraphQL, reported on #5187).
            expect(one, `${label} edge dropped`).not.toContain(`into-${cls}`);
            const batch = await s.callToolText('hadron_get_nodes', { refs: [kid] });
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
          // Owner control: the far end resolves for the owner.
          const ownNode = dataOf(await run(Q, gctx(alice), { ref: holderNodeIds.kid }), 'owner').node;
          expect(ownNode.outgoingEdges.find((e: any) => e.name === `into-${cls}`)?.target?.name, 'owner outgoing').toBe(t.name);
          expect(ownNode.incomingEdges.find((e: any) => e.name === `back-${cls}`)?.source?.name, 'owner incoming').toBe(t.name);
          for (const { label, user } of readers) {
            const node = dataOf(await run(Q, gctx(user), { ref: holderNodeIds.kid }), label).node;
            expect(node.name, label).toBe('Holder Kid');
            expect(leaks(JSON.stringify(node), t), `${label} node edges`).toEqual([]);
            // GraphQL keeps the edge row with a null far end (the other half of the reported difference).
            expect(node.outgoingEdges.find((e: any) => e.name === `into-${cls}`), `${label} outgoing row`).toMatchObject({ target: null });
          }
        });

        it(`GraphQL edges list and edge(ref:) hide the unreadable endpoint: ${cls}`, async () => {
          const t = targets.find((x) => x.cls === cls)!;
          const edgeRow = await db.edge.findFirstOrThrow({ where: { memoryId: holderMemoryId, name: `into-${cls}` } });
          const Q = `query($f: EdgeFilter) { edges(filter: $f) { items { id name target { id name } source { id name } } } }`;
          const One = `query($r: ID!) { edge(ref: $r) { id target { id name } } }`;
          // Owner control.
          const ownList = dataOf(await run(Q, gctx(alice), { f: { memoryId: holderMemoryId } }), 'owner').edges.items as Array<{ id: string; target: { name: string } | null }>;
          expect(ownList.find((i) => i.id === edgeRow.id)?.target?.name, 'owner list').toBe(t.name);
          expect(dataOf(await run(One, gctx(alice), { r: edgeRow.id }), 'owner').edge.target?.name, 'owner edge(ref)').toBe(t.name);
          for (const { label, user } of readers) {
            const items = dataOf(await run(Q, gctx(user), { f: { memoryId: holderMemoryId } }), label).edges.items as Array<{ id: string; target: unknown }>;
            const row = items.find((i) => i.id === edgeRow.id)!;
            expect(row, label).toBeTruthy();
            expect(row.target, `${label} list target`).toBeNull();
            expect(leaks(JSON.stringify(items), t), `${label} list`).toEqual([]);
            const one = dataOf(await run(One, gctx(user), { r: edgeRow.id }), label);
            expect(one.edge.target, `${label} edge(ref)`).toBeNull();
          }
        });
      }

      // Reported on #5187 (details with the security seat, not here), never asserted as correct: GraphQL keeps an edge
      // row whose far end, or whose holding memory, the reader cannot read, where MCP drops the edge. Wired when
      // Victor/Holger rule which answer holds.
      it.todo('GraphQL edge rows whose holder or far end the reader cannot read are absent, as on MCP (reported on #5187)');
    });

    describe('following a node reference into the memory answers as a missing node would (cor:api:140:03)', () => {
      for (const cls of ['personal', 'private'] as const) {
        it(`MCP and GraphQL node reads, owner control and missing control: ${cls}`, async () => {
          const t = targets.find((x) => x.cls === cls)!;
          const ref = `hrn:node:${t.urn}:${t.nodeLoc}`;
          const missing = `hrn:node:${t.urn}:no-such-node`;
          const missingId = generateId();
          const NODE = `query($r: ID!) { node(ref: $r) { id name } }`;
          // Owner: the reference resolves.
          expect(await mcp(alice).callToolText('hadron_get_node', { urn: ref })).toContain(t.name);
          expect(dataOf(await run(NODE, gctx(alice), { r: t.nodeId }), 'owner').node.name).toBe(t.name);
          for (const { label, user } of readers) {
            const out = await mcp(user).callToolText('hadron_get_node', { urn: ref });
            expect(leaks(out, t).filter((s) => s !== t.urn), `${label} mcp`).toEqual([]);
            const ctl = await mcp(user).callToolText('hadron_get_node', { urn: missing });
            // The same message modulo the reference the caller named.
            expect(out.replace(ref, '<REF>'), `${label} mcp same as missing`).toBe(ctl.replace(missing, '<REF>'));
            // GraphQL: a reference into the memory answers exactly as a reference to nothing, errors included, so a
            // FORBIDDEN or other error that confirmed the node would fail here.
            const control = await run(NODE, gctx(user), { r: missingId });
            const controlUrn = await run(NODE, gctx(user), { r: missing });
            for (const [r, ctlRes] of [[t.nodeId, control], [ref, controlUrn]] as const) {
              const g = await run(NODE, gctx(user), { r });
              expect(g.errors, `${label} gql errors ${r}`).toEqual(ctlRes.errors);
              expect(g.data, `${label} gql data ${r}`).toEqual(ctlRes.data);
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
          const CONTENT = `query($r: ID!) { node(ref: $r) { content } }`;
          for (const { label, user } of readers) {
            const content = dataOf(await run(CONTENT, gctx(user), { r: inc.id }), label).node.content as string;
            expect(content, label).toContain(BROKEN_INCLUDE_NOTICE);
            expect(leaks(content, t), `${label} gql content`).toEqual([]);
            expect(dataOf(await run(CONTENT, gctx(user), { r: miss.id }), label).node.content, `${label} same bytes as missing`).toBe(content);
            const out = await mcp(user).callToolText('hadron_get_node', { urn: `hrn:node:${holderUrn}:inc-${cls}` });
            expect(out, label).toContain(BROKEN_INCLUDE_NOTICE);
            expect(leaks(out, t), `${label} mcp content`).toEqual([]);
          }
          // Owner control: Alice reads the included text.
          expect(dataOf(await run(CONTENT, gctx(alice), { r: inc.id }), 'owner').node.content).toContain(`ALICE_SECRET_${cls}`);
        });
      }
    });

    describe('a write that names a node in the memory does not confirm it exists', () => {
      it('MCP hadron_create_edge to the memory and to a missing node refuse alike', async () => {
        for (const { label, user } of readers) {
          for (const t of targets) {
            const s = mcp(user);
            const secretUrn = `hrn:node:${t.urn}:${t.nodeLoc}`;
            const missingUrn = `hrn:node:${t.urn}:no-such-node`;
            const toSecret = await s.callToolText('hadron_create_edge', { sourceUrn: `hrn:node:${holderUrn}:src`, targetUrn: secretUrn, name: `probe-${t.cls}` });
            const toMissing = await s.callToolText('hadron_create_edge', { sourceUrn: `hrn:node:${holderUrn}:src`, targetUrn: missingUrn, name: `probe-${t.cls}` });
            expect(toSecret.split(secretUrn).join('<REF>'), label).toBe(toMissing.split(missingUrn).join('<REF>'));
            expect(toSecret, label).toContain('not found');
            expect(leaks(toSecret, t).filter((x) => x !== t.urn), label).toEqual([]);
          }
        }
        expect(await db.edge.count({ where: { name: { startsWith: 'probe-' } } })).toBe(0);
      });

      it('a hard delete cascade is refused without naming a memory the caller cannot read, and alters nothing', async () => {
        const rows = () => db.edge.count({ where: { OR: [{ name: { startsWith: 'into-' } }, { name: { startsWith: 'back-' } }] } });
        const before = await rows();
        expect(before).toBe(4);
        for (const { label, user } of readers) {
          const out = await mcp(user).callToolText('hadron_delete_node', {
            urn: `hrn:node:${holderUrn}:src:kid`, hard: true, cascadeCrossMemoryEdges: true,
          });
          expect(out, `${label} refused`).toContain('Nothing was deleted');
          for (const t of targets) expect(leaks(out, t), `${label} names ${t.cls}`).toEqual([]);
          // Per reader, so an early success cannot hide behind a later iteration: the node and every reference stay.
          expect(await db.node.findUnique({ where: { id: holderNodeIds.kid } }), `${label} node kept`).not.toBeNull();
          expect(await rows(), `${label} references kept`).toBe(before);
        }
      });
    });

    describe('a run render inlines nothing from the memory (cor:dmo:150:04, cor:api:060:05)', () => {
      for (const cls of ['personal', 'private'] as const) {
        it(`GraphQL renderRunNode: an include tag and a dependency edge into the memory, ${cls}`, async () => {
          const t = targets.find((x) => x.cls === cls)!;
          // The dependency edge points at its OWN node with its own marker, so the owner control shows each path
          // renders (an ignored `dep-*` edge would not be hidden by the include's marker).
          const dep = await db.node.create({
            data: { id: generateId(), memoryId: t.memoryId, loc: 'hidden-dep', name: `${SECRET_NAME} dep ${cls}`, content: `ALICE_SECRET_${cls}_DEP` },
          });
          const runNode = await db.node.create({
            data: {
              id: generateId(), memoryId: holderMemoryId, loc: `run-${cls}`, name: 'Run node', isRunnable: true,
              content: `start {{> hrn:node:${t.urn}:${t.nodeLoc}}} end`,
            },
          });
          await db.edge.create({
            data: { memoryId: holderMemoryId, sourceId: runNode.id, targetId: dep.id, name: `dep-${cls}`, loc: `run-${cls}:dep-${cls}:hidden-dep` },
          });
          const RENDER = `query($r: String!) { renderRunNode(nodeRef: $r) }`;
          const own = JSON.stringify(dataOf(await run(RENDER, gctx(alice), { r: runNode.id }), 'owner'));
          expect(own, 'owner include').toContain(`ALICE_SECRET_${cls}`);
          expect(own, 'owner dependency').toContain(`ALICE_SECRET_${cls}_DEP`);
          for (const { label, user } of readers) {
            const text = JSON.stringify(dataOf(await run(RENDER, gctx(user), { r: runNode.id }), label));
            expect(leaks(text, t), `${label} render`).toEqual([]);
            expect(text, `${label} dependency`).not.toContain(`${SECRET_NAME} dep`);
            expect(text, label).toContain(BROKEN_INCLUDE_NOTICE);
          }
        });
      }
    });
  });
}
