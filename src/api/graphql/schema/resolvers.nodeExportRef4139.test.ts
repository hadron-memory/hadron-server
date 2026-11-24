/**
 * #4139 (entity refs S3): nodeExport takes `ref` (PK or URN, cor:api:140) behind the SAME node-read gate as
 * node(ref:). Adopting that gate WIDENS the export: an App key or userless run exports PUBLIC knowledge read-only
 * (cor:acl:010:01, cor:dmo:150:03), a re-authorization event (cor:api:140:01). Refusals are NODE_NOT_FOUND
 * (cor:api:140:03), one identical answer for every miss.
 *
 * Ruling on the breaking contract change (restated here because a diff-only read cannot see the PR
 * body): the `id` → `ref` hard rename and the `NOT_FOUND` → `NODE_NOT_FOUND` refusal rename are by design
 * (Holger's #775 rulings; Bruce, coordinator, team chat #134801, restated #135959 — the same ordered hard break
 * as entity-refs S1-S3, precedent 0274): no deprecated old-name alias, and the callers are the named lockstep
 * companions hadron-cli#2899 and hadron-portal#2472. A grep of this repo found no other `nodeExport` call site,
 * so the absence of caller changes in this diff is the ruled design, not an omission.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, GraphQLObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { memoryAccessFilter } from './resolvers.helpers.js';
import { typeDefs } from './typeDefs.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { testRunAgentId } from '../../../test/runAgent.js';
import { drainNodeUsage } from '../../../lib/usageRecorder.js';
import { AmbiguousLegacyUrnError, NodeNotFoundError } from '../../../lib/entityRef/errors.js';

const Q = resolvers.Query as any;
const LOC = 'docs:entry';
const urn = (m: { urn: string }, loc = LOC) => `hrn:node:${m.urn}:${loc}`;
let f: Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const s = generateId().toLowerCase();
  const orgA = await db.organization.create({ data: { name: 'Reader org', urn: `reader-${s}.example` } });
  const orgB = await db.organization.create({ data: { name: 'Owner org', urn: `owner-${s}.example` } });
  const { app, appKey } = await createDbAppWithKey(db, 'reader4139', orgA.id);
  const memory = async (slug: string, extra: Record<string, unknown> = {}) => {
    const m = await db.memory.create({
      data: { name: slug, urn: `${orgB.urn}:${slug}`, class: 'knowledge', visibility: 'PUBLIC', organizationId: orgB.id, ...extra },
    });
    const node = await db.node.create({ data: { memoryId: m.id, loc: LOC, name: `n ${slug}`, content: `secret ${slug}`, nodeType: 'record' } });
    return { ...m, nodeId: node.id };
  };
  const pub = await memory('pub');
  const orgVisible = await memory('orgvis', { visibility: 'ORGANIZATION' });
  const { app: otherApp } = await createDbAppWithKey(db, 'other4139', orgB.id);
  const appScoped = await memory('appscoped', { appId: otherApp.id }); // PUBLIC knowledge, but another App's
  // #4763: a PUBLIC node with an edge and an include tag into a memory the userless caller cannot read.
  const hub = await db.node.create({
    data: { memoryId: pub.id, loc: 'docs:hub', name: 'hub', nodeType: 'record', content: 'hub body' },
  });
  // No nodeType on purpose: INCLUDE_LITERAL_NODE_TYPES (e.g. 'record') serve content as stored, so the include tag would never
  // resolve and the include pins below would pass vacuously. The positive control below proves it resolves.
  const inc = await db.node.create({
    data: { memoryId: pub.id, loc: 'docs:inc', name: 'inc', content: 'before {{> ' + `hrn:node:${orgVisible.urn}:${LOC}` + '}} after' },
  });
  await db.edge.create({
    data: { id: generateId(), memoryId: pub.id, sourceId: hub.id, targetId: orgVisible.nodeId, loc: 'docs:hub:link:orgvis', name: 'link', priority: 1 },
  });
  const sibling = await db.node.create({ data: { memoryId: pub.id, loc: 'docs:sibling', name: 'sibling', nodeType: 'record', content: 'sib' } });
  await db.edge.create({
    data: { id: generateId(), memoryId: pub.id, sourceId: hub.id, targetId: sibling.id, loc: 'docs:hub:link:sibling', name: 'link', priority: 2 },
  });
  const gone = await db.node.create({ data: { memoryId: pub.id, loc: 'docs:gone', name: 'gone', content: 'x', nodeType: 'record', deletedAt: new Date() } });
  const schedule = await db.agentSchedule.create({
    data: { id: generateId(), organizationId: orgA.id, appId: app.id, name: 'S', cron: '* * * * *', entryNodeUrn: `hrn:node:${pub.urn}:${LOC}` },
  });
  const run = await db.appRun.create({
    data: { id: generateId(), organizationId: orgA.id, appId: app.id, agentId: await testRunAgentId(db, orgA.id, app.id), userId: null, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn },
  });
  const runPrincipal = { db, ...runAuthContext(run) } as Context;
  const keyPrincipal = { db, appId: app.id, appKeyId: appKey.id, roles: [] } as unknown as Context;
  const stranger = await db.user.create({ data: { id: generateId(), githubId: 41390, githubUsername: 'stranger4139' } });
  const strangerCtx = { db, roles: ['READER'], userId: stranger.id } as Context;
  // A platform ADMIN in its own right: a REAL user row that CARRIES the ADMIN role (node(ref:)'s reconciled read
  // re-validates platform roles from the user row, authorizedTx readLiveContext — a context that merely asserts
  // the role for a row that lacks it is demoted there) and holds no OrgMember row anywhere (asserted in the ADMIN
  // pin below), so its reach comes from the ADMIN branch of getAccessibleMemoryIds, not from an org in-list.
  const admin = await db.user.create({ data: { id: generateId(), githubId: 41392, githubUsername: 'admin4139', roles: ['ADMIN'] } });
  const adminCtx = { db, roles: ['ADMIN'], userId: admin.id } as Context;
  // A real member of the owning org: reads BOTH the PUBLIC memory and the org-visible one (the positive control).
  const owner = await db.user.create({ data: { id: generateId(), githubId: 41391, githubUsername: 'owner4139' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: owner.id, role: 'OWNER' } });
  const ownerCtx = { db, roles: ['READER'], userId: owner.id } as Context;
  return { ownerCtx, orgB, pub, orgVisible, appScoped, hub, inc, sibling, gone, runPrincipal, keyPrincipal, strangerCtx, adminCtx, admin, app, appKey };
}
async function rejection(p: Promise<unknown>) {
  try { await p; return null; } catch (err) {
    return { message: (err as Error).message, code: (err as { code?: string }).code ?? (err as { extensions?: { code?: string } }).extensions?.code ?? null };
  }
}
beforeEach(async () => { await cleanDb(db); f = await fixture(); });

describe('#4139 nodeExport(ref:)', () => {
  it('exports by node URN and by PK', async () => {
    for (const ref of [urn(f.pub), f.pub.nodeId]) {
      const out = await Q.nodeExport({}, { ref, format: 'MD', full: true }, f.adminCtx);
      expect(out.data).toContain('secret pub');
    }
  });

  it('the SDL names `ref`, and `id` is no longer an argument', () => {
    const field = (buildSchema(typeDefs).getType('Query') as GraphQLObjectType).getFields().nodeExport;
    const names = field.args.map((a) => a.name);
    expect(names).toContain('ref');
    expect(names).not.toContain('id');
  });

  describe('the widening (cor:acl:010:01): a userless principal exports PUBLIC knowledge', () => {
    it.each(['keyPrincipal', 'runPrincipal'] as const)('%s exports it by URN and by PK, read-only', async who => {
      for (const ref of [urn(f.pub), f.pub.nodeId]) {
        const out = await Q.nodeExport({}, { ref }, f[who]);
        expect(out.data).toContain('secret pub');
      }
    });
    it.each(['keyPrincipal', 'runPrincipal'] as const)('%s asking for a non-public node gets the refusal an unknown ref gets', async who => {
      const unknown = await rejection(Q.nodeExport({}, { ref: `hrn:node:${f.orgB.urn}:nosuchmemory:${LOC}` }, f[who]));
      const refused = await Promise.all([urn(f.orgVisible), f.orgVisible.nodeId].map(ref => rejection(Q.nodeExport({}, { ref }, f[who]))));
      expect(unknown).toMatchObject({ code: 'NODE_NOT_FOUND' });
      for (const r of refused) expect(r).toMatchObject({ code: 'NODE_NOT_FOUND', message: expect.any(String) });
      // The message is the typed error's own text for THAT ref: nothing else varies.
      const refs = [urn(f.orgVisible), f.orgVisible.nodeId];
      refused.forEach((r, i) => expect(r!.message).toEqual(new NodeNotFoundError(refs[i]!).message));
    });
  });

  describe('parity with node(ref:): export refuses exactly when node(ref:) answers null', () => {
    const nonexistentPk = generateId();
    const cases: Array<[string, () => string]> = [
      ['an unreadable node by PK', () => f.orgVisible.nodeId],
      ['an unreadable node by URN', () => urn(f.orgVisible)],
      ['an unknown ref', () => `hrn:node:${f.orgB.urn}:pub:no:such`],
      ['a soft-deleted node by URN', () => urn(f.pub, 'docs:gone')],
      ['a soft-deleted node by PK', () => f.gone.id],
      ['a nonexistent PK', () => nonexistentPk],
    ];
    it.each(cases)('%s', async (_name, ref) => {
      expect(await Q.node({}, { ref: ref() }, f.strangerCtx)).toBeNull();
      expect(await rejection(Q.nodeExport({}, { ref: ref() }, f.strangerCtx))).toMatchObject({ code: 'NODE_NOT_FOUND' });
    });
    it('a readable node: both answer', async () => {
      expect(await Q.node({}, { ref: urn(f.pub) }, f.strangerCtx)).not.toBeNull();
      expect((await Q.nodeExport({}, { ref: urn(f.pub) }, f.strangerCtx)).data).toContain('secret pub');
    });
    it('every miss shape answers one identical refusal (code and message modulo the echoed ref)', async () => {
      const out = await Promise.all(cases.map(([, ref]) => rejection(Q.nodeExport({}, { ref: ref() }, f.strangerCtx))));
      out.forEach((r, i) => expect(r!.message).toEqual(new NodeNotFoundError(cases[i]![1]()).message));
      expect(new Set(out.map((r) => r!.code))).toEqual(new Set(['NODE_NOT_FOUND']));
    });
  });

  describe('userless principals on PUBLIC knowledge: what else must not leak or break', () => {
    it.each(['keyPrincipal', 'runPrincipal'] as const)('%s: a soft-deleted node, PUBLIC knowledge scoped to another App and a nonexistent PK all refuse as NODE_NOT_FOUND', async who => {
      for (const ref of [urn(f.pub, 'docs:gone'), f.gone.id, urn(f.appScoped), f.appScoped.nodeId, generateId()]) {
        expect(await rejection(Q.nodeExport({}, { ref }, f[who]))).toMatchObject({ code: 'NODE_NOT_FOUND' });
      }
    });
    it.each(['keyPrincipal', 'runPrincipal'] as const)('%s: an edge into a memory it cannot read is absent, an edge into a readable one stays (JSON and MD)', async who => {
      for (const format of ['JSON', 'MD'] as const) {
        const out = await Q.nodeExport({}, { ref: urn(f.pub, 'docs:hub'), format }, f[who]);
        expect(out.data).toContain('docs:sibling');
        expect(out.data).not.toContain(f.orgVisible.nodeId);
        expect(out.data).not.toContain('docs:entry');
        expect(out.data).not.toContain(f.orgVisible.urn);
        expect(out.data).not.toContain('secret orgvis');
      }
    });
    // The edge-rendering formats crossed with `full` mechanically (every branch of renderNodeExport that reads
    // edges): MD and JSON. PDF is not crossed — it renders the same markdown body and reads no edges, and `full`
    // does not apply to it.
    it('a list-gated user (not only a userless principal) loses an edge into a memory they cannot read; a reader of both keeps it', async () => {
      for (const [format, full] of (['JSON', 'MD'] as const).flatMap((format) => ([true, false] as const).map((full) => [format, full] as const))) {
        const out = await Q.nodeExport({}, { ref: urn(f.pub, 'docs:hub'), format, full }, f.strangerCtx);
        expect(out.data).toContain('docs:sibling');
        expect(out.data).not.toContain(f.orgVisible.nodeId);
        expect(out.data).not.toContain(f.orgVisible.urn);
        expect(out.data).not.toContain('secret orgvis');
      }
    });
    it('an org member reads and exports BOTH memories through the shared gate (an ordinary in-list reader)', async () => {
      for (const [m, text] of [[f.pub, 'secret pub'], [f.orgVisible, 'secret orgvis']] as const) {
        expect(await Q.node({}, { ref: urn(m) }, f.ownerCtx)).not.toBeNull();
        expect((await Q.nodeExport({}, { ref: urn(m) }, f.ownerCtx)).data).toContain(text);
      }
    });
    // The invariant the fail-closed helper (nodeReadMemoryAllowed, resolvers.query.node.ts) rests on, stated here so a diff-only
    // reader sees it: memoryAccessFilter returns { memoryId: { in: ids } } for EVERY caller, ADMIN included,
    // and never an unrestricted shape. So a shape that is not an in-list is not a case that exists, and failing closed on it denies nobody.
    it('ADMIN is not denied by the fail-closed gate: an ADMIN caller reads and exports both the PUBLIC and the org-visible memory', async () => {
      // The ADMIN context is a platform ADMIN in its own right, not an org member: pinned here so the export above
      // proves the ADMIN branch of the gate, not an ordinary membership in-list.
      expect(await db.orgMember.count({ where: { userId: f.admin.id } })).toBe(0);
      for (const [m, text] of [[f.pub, 'secret pub'], [f.orgVisible, 'secret orgvis']] as const) {
        expect(await Q.node({}, { ref: urn(m) }, f.adminCtx)).not.toBeNull();
        expect((await Q.nodeExport({}, { ref: urn(m) }, f.adminCtx)).data).toContain(text);
        expect((await Q.nodeExport({}, { ref: m.nodeId }, f.adminCtx)).data).toContain(text);
      }
      const withEdge = await Q.nodeExport({}, { ref: urn(f.pub, 'docs:hub'), format: 'JSON' }, f.adminCtx);
      expect(withEdge.data).toContain(f.orgVisible.nodeId);
    });
    // The same invariant pinned at its source: every principal kind getAccessibleMemoryIds has a branch for answers
    // the in-list shape, so the fail-closed branch denies nobody. (There is no separate system/internal principal
    // branch; an impersonated key folds into the sessionless-key branch.)
    it('memoryAccessFilter answers an in-list for every principal kind', async () => {
      const sessionKeyCtx = { db, appId: f.app.id, appKeyId: f.appKey.id, sessionId: generateId(), roles: [] } as unknown as Context;
      const kinds: Array<[string, Context]> = [
        ['a pure App key with an active session', sessionKeyCtx],
        ['a platform ADMIN', f.adminCtx],
        ['a pure App key without a session', f.keyPrincipal],
        ['an ordinary user', f.strangerCtx],
        ['a userless run', f.runPrincipal],
        ['an unauthenticated caller', { db } as Context],
      ];
      for (const [kind, ctx] of kinds) {
        const filter = await memoryAccessFilter(ctx);
        expect(Object.keys(filter), kind).toEqual(['memoryId']);
        expect(Object.keys(filter.memoryId as object), kind).toEqual(['in']);
        expect((filter.memoryId as { in: unknown[] }).in, kind).toBeInstanceOf(Array);
      }
    });
    it('a reader who CAN read the target memory still sees the edge', async () => {
      const out = await Q.nodeExport({}, { ref: urn(f.pub, 'docs:hub'), format: 'JSON' }, f.ownerCtx);
      expect(out.data).toContain(f.orgVisible.nodeId);
    });
    // The loop's null-target guard. Edge.target is a REQUIRED relation with onDelete: Cascade
    // (prisma/schema.prisma), so a hydrated edge with no target row cannot occur — the guard is
    // defensive. Pinned by doctoring the export's own hydration include to carry one, so the
    // export SKIPS it (never renders it, never crashes on it) while the real readable edges stay.
    it('an edge with no target row is skipped, not rendered (defensive: the required FK makes the shape impossible)', async () => {
      const hub = await db.node.findUniqueOrThrow({ where: { id: f.hub.id } });
      const doctored = {
        ...hub,
        outgoingEdges: [
          { id: 'edge-null-target', memoryId: f.pub.id, sourceId: f.hub.id, loc: 'docs:hub:phantom-edge', name: 'phantom', priority: 3, target: null },
        ],
      };
      const original = db.node.findUnique.bind(db.node);
      const spy = vi.spyOn(db.node, 'findUnique').mockImplementation((async (args: { include?: { outgoingEdges?: unknown }; where?: { id?: string } }) => {
        // Only the export's own hydration query carries the outgoingEdges include; every other
        // findUnique in the flow (ref resolution) sees the real client.
        if (args?.include?.outgoingEdges && args.where?.id === f.hub.id) return doctored;
        return original(args as never);
      }) as never);
      try {
        const out = await Q.nodeExport({}, { ref: f.hub.id, format: 'JSON' }, f.ownerCtx);
        expect(out.data).not.toContain('phantom');
        expect(out.data).not.toContain('edge-null-target');
        expect(out.data).toContain('docs:hub'); // the node itself rendered
      } finally {
        spy.mockRestore();
      }
    });
    it.each(['keyPrincipal', 'runPrincipal'] as const)('%s: an include tag into an unreadable memory does not export that memory\'s text (full:false resolves, full:true keeps the tag)', async who => {
      // Positive controls: a reader of both memories DOES get the text on full:false, and the raw tag on full:true,
      // so the negatives below cannot pass because the tag never resolves or full is mapped differently.
      const control = await Q.nodeExport({}, { ref: urn(f.pub, 'docs:inc'), format: 'MD', full: false }, f.ownerCtx);
      expect(control.data).toContain('secret orgvis');
      const rawControl = await Q.nodeExport({}, { ref: urn(f.pub, 'docs:inc'), format: 'MD', full: true }, f.ownerCtx);
      expect(rawControl.data).toContain('{{> ');
      const resolved = await Q.nodeExport({}, { ref: urn(f.pub, 'docs:inc'), format: 'MD', full: false }, f[who]);
      expect(resolved.data).not.toContain('secret orgvis');
      // Policy: full:true is the restore export, so it keeps the PUBLIC author's OWN tag, which names the target's
      // URN and loc; node(ref:) shows the same stored text to the same caller. What must not leave is the TARGET's text.
      const raw = await Q.nodeExport({}, { ref: urn(f.pub, 'docs:inc'), format: 'MD', full: true }, f[who]);
      expect(raw.data).not.toContain('secret orgvis');
    });
    // UsageEvent is attributed by memoryId only (no organization column), so attribution is asserted by memory.
    // A PUBLIC memory that is not knowledge cannot exist (chk_memory_group_visibility), so the other-App PUBLIC case stands in.
    it.each(['keyPrincipal', 'runPrincipal'] as const)('%s: the export records the same read usage event node(ref:) does (none lost, none to another memory)', async who => {
      const count = (memoryId: string) => db.usageEvent.count({ where: { memoryId } });
      const scope = { memoryId: { in: [f.pub.id, f.orgVisible.id] } };
      await drainNodeUsage(db);
      await db.usageEvent.deleteMany({ where: scope });
      await Q.node({}, { ref: urn(f.pub) }, f[who]);
      await drainNodeUsage(db);
      const viaNode = await count(f.pub.id);
      await db.usageEvent.deleteMany({ where: scope });
      await Q.nodeExport({}, { ref: urn(f.pub) }, f[who]);
      await drainNodeUsage(db);
      expect(viaNode).toBeGreaterThan(0);
      expect(await count(f.pub.id)).toBe(viaNode);
      expect(await count(f.orgVisible.id)).toBe(0);
    });
  });

  describe('a globally ambiguous legacy URN: nodeExport answers exactly as node(ref:) does (cor:urn:030:01/:02)', () => {
    const claim = async (urn: string, nodeIds: string[]) => {
      await db.urnAlias.createMany({ data: nodeIds.map((entityId) => ({
        urn, entityType: 'NODE' as const, entityId, reason: 'RENAME' as const, replacedByUrn: `${urn}-new`,
      })) });
    };
    it('a caller who can read NO claimant gets the NODE_NOT_FOUND an unknown ref gets, not the ambiguity', async () => {
      const second = await db.node.create({ data: { memoryId: f.orgVisible.id, loc: 'docs:second', name: 's', content: 'x', nodeType: 'record' } });
      const old = `${f.orgVisible.urn}:shared-old`;
      await claim(old, [f.orgVisible.nodeId, second.id]);
      for (const ctx of [f.strangerCtx, f.keyPrincipal, f.runPrincipal]) {
        expect(await rejection(Q.nodeExport({}, { ref: old }, ctx))).toMatchObject({ code: 'NODE_NOT_FOUND' });
        expect(await Q.node({}, { ref: old }, ctx)).toBeNull();
      }
    });
    it('a caller who can read a claimant gets the ambiguity from BOTH surfaces, and the wire message does not name the hidden claimant', async () => {
      const old = `${f.pub.urn}:shared-old`;
      await claim(old, [f.sibling.id, f.orgVisible.nodeId]);
      await expect(Q.node({}, { ref: old }, f.strangerCtx)).rejects.toBeInstanceOf(AmbiguousLegacyUrnError);
      const refused = await Q.nodeExport({}, { ref: old }, f.strangerCtx).then(() => null, (e: unknown) => e);
      expect(refused).toBeInstanceOf(AmbiguousLegacyUrnError);
      // What reaches the wire is the message and the echoed ref only (formatError drops candidateNodeIds).
      expect((refused as Error).message).not.toContain(f.orgVisible.nodeId);
      expect((refused as AmbiguousLegacyUrnError).ref).toBe(old);
    });
  });

  it('a malformed (wrong-type) URN does not read as another entity', async () => {
    expect(await rejection(Q.nodeExport({}, { ref: `hrn:memory:${f.orgB.urn}:pub` }, f.adminCtx))).toMatchObject({ code: 'NODE_NOT_FOUND' });
  });
});
