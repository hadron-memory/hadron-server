/** #2245: `cloneAgent` end to end against the contract (R144-R149, R156, R170-R174, R179, R181). */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let adminA: string;
let adminB: string;
let readerA: string;

const ctxFor = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const clone = (userId: string, args: { source: string; target: string; name?: string; slug?: string }) =>
  (resolvers.Mutation as Record<string, (...a: unknown[]) => Promise<any>>).cloneAgent(null, args, ctxFor(userId));
const codeOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as { extensions?: { code?: string } }).extensions?.code ?? (e as Error).name; }
  return 'NO_ERROR';
};

async function user(tag: string) {
  const id = generateId();
  await db.user.create({ data: { id, email: `${tag}-${id}@x.test`, handle: `${tag}${id.slice(-6)}`.toLowerCase() } });
  return id;
}
const org = async (urn: string) => {
  const id = generateId();
  await db.organization.create({ data: { id, name: urn, urn } });
  return { id, urn };
};
const member = (organizationId: string, userId: string, role: 'ADMIN' | 'READER') => db.orgMember.create({ data: { organizationId, userId, role } });

/** An Agent in `o` with a system memory holding a small graph. */
async function sourceAgent(o: { id: string; urn: string }, visibility: 'PUBLIC' | 'ORGANIZATION' | 'PERSONAL', slug = 'src') {
  const memId = generateId();
  await db.memory.create({ data: { id: memId, organizationId: o.id, urn: `${o.urn}:${slug}-system`, name: `${slug} System`, class: 'system', acceptsUploads: false } as never });
  const id = generateId();
  await db.agent.create({ data: { id, organizationId: o.id, urn: `${o.urn}:${slug}`, name: slug, description: 'd', systemMemoryId: memId, visibility, surfaces: ['mcp'], personaRole: 'tester' } });
  const nid = (loc: string) => db.node.create({ data: { id: generateId(), memoryId: memId, loc, name: loc, nodeType: 'page', content: `see ${o.urn}:${slug}-system:${loc}` } as never });
  const a = await nid('a');
  const b = await nid('b');
  await db.edge.create({ data: { id: generateId(), memoryId: memId, sourceId: a.id, targetId: b.id, loc: 'a/e-b', name: 'e' } as never });
  return { id, memId, urn: `${o.urn}:${slug}` };
}

beforeEach(async () => {
  await cleanDb(db);
  orgA = await org('cl-a');
  orgB = await org('cl-b');
  adminA = await user('adma');
  adminB = await user('admb');
  readerA = await user('rdra');
  await member(orgA.id, adminA, 'ADMIN');
  await member(orgB.id, adminB, 'ADMIN');
  await member(orgA.id, readerA, 'READER');
  await member(orgB.id, readerA, 'ADMIN');
});

describe('cloneAgent: success', () => {
  it('a same-org manager clones an ORGANIZATION agent into a PERSONAL draft with an independent system memory', async () => {
    const src = await sourceAgent(orgA, 'ORGANIZATION');
    const out = await clone(adminA, { source: src.urn, target: orgA.urn, name: 'Copy' });
    expect(out.visibility).toBe('PERSONAL');
    expect(out.urn).toBe('cl-a:copy');
    expect(out.clonedFromAgentRef).toBe(src.urn);
    expect(out.systemMemoryId).not.toBe(src.memId);
    const nodes = await db.node.findMany({ where: { memoryId: out.systemMemoryId }, orderBy: { loc: 'asc' } });
    expect(nodes.map((n) => n.loc)).toEqual(['a', 'b']);
    expect(nodes[0].content).toContain('cl-a:copy-system');
    expect(await db.edge.count({ where: { memoryId: out.systemMemoryId } })).toBe(1);
    // Independence: editing the clone never reaches the source.
    await db.node.update({ where: { id: nodes[0].id }, data: { content: 'changed' } });
    expect((await db.node.findFirstOrThrow({ where: { memoryId: src.memId, loc: 'a' } })).content).not.toBe('changed');
    const audit = await db.agentCloneAudit.findMany({ where: { newAgentId: out.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ sourceAgentId: src.id, targetOrgId: orgA.id, actorUserId: adminA, nodeCount: 2, edgeCount: 1 });
  });

  it('a second clone gets a new URN only when named differently; the same name is refused', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    await clone(adminB, { source: src.urn, target: orgB.urn });
    expect(await codeOf(clone(adminB, { source: src.urn, target: orgB.urn }))).toBe('AGENT_URN_TAKEN');
    const second = await clone(adminB, { source: src.urn, target: orgB.urn, slug: 'src-2' });
    expect(second.urn).toBe('cl-b:src-2');
  });

  it('a PUBLIC source clones cross-org for any ADMIN of the target; no grants are carried', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    await db.agentOrgGrant.create({ data: { orgId: orgB.id, agentId: src.id, activatedAt: new Date(Date.now() - 1000) } });
    const out = await clone(adminB, { source: src.urn, target: orgB.urn });
    expect(out.organizationId).toBe(orgB.id);
    expect(await db.agentOrgGrant.count({ where: { agentId: out.id } })).toBe(0);
  });

  it('links stay links and imports are recreated with the target org grant', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const lm = generateId();
    await db.memory.create({ data: { id: lm, organizationId: orgA.id, urn: 'cl-a:k', name: 'k', class: 'knowledge', visibility: 'PUBLIC' } as never });
    await db.agentMemoryItem.create({ data: { agentId: src.id, memoryId: lm, role: 'read' } });
    const dep = await sourceAgent(orgA, 'PUBLIC', 'dep');
    await db.agentOrgGrant.create({ data: { orgId: orgA.id, agentId: dep.id, activatedAt: new Date(Date.now() - 1000) } });
    await db.agentImport.create({ data: { parentAgentId: src.id, importedAgentId: dep.id, position: 100, agentOrgGrantOrgId: orgA.id, agentOrgGrantAgentId: dep.id } });
    const out = await clone(adminB, { source: src.urn, target: orgB.urn });
    expect((await db.agentMemoryItem.findMany({ where: { agentId: out.id } })).map((l) => l.memoryId)).toEqual([lm]);
    const imps = await db.agentImport.findMany({ where: { parentAgentId: out.id } });
    expect(imps.map((i) => i.importedAgentId)).toEqual([dep.id]);
    const grant = await db.agentOrgGrant.findUnique({ where: { orgId_agentId: { orgId: orgB.id, agentId: dep.id } } });
    expect(grant).toBeTruthy();
  });
});

describe('cloneAgent: refusals leave nothing behind', () => {
  const counts = async () => [await db.agent.count(), await db.memory.count(), await db.node.count(), await db.agentCloneAudit.count(), await db.agentOrgGrant.count()];

  it('an unreadable source answers exactly as a missing one', async () => {
    const src = await sourceAgent(orgA, 'PERSONAL');
    const missing = await codeOf(clone(adminB, { source: 'cl-a:nope', target: orgB.urn }));
    expect(await codeOf(clone(adminB, { source: src.urn, target: orgB.urn }))).toBe(missing);
  });

  it('a readable but unmanaged non-PUBLIC source is AGENT_NOT_PUBLIC, same-org manager or not', async () => {
    const src = await sourceAgent(orgA, 'ORGANIZATION');
    expect(await codeOf(clone(readerA, { source: src.urn, target: orgB.urn }))).toBe('AGENT_NOT_PUBLIC');
    expect(await codeOf(clone(adminA, { source: src.urn, target: orgB.urn }))).toBe('FORBIDDEN');
  });

  it('a retired source is not found', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    await db.agent.update({ where: { id: src.id }, data: { deletedAt: new Date() } });
    expect(await codeOf(clone(adminB, { source: src.urn, target: orgB.urn }))).toBe(await codeOf(clone(adminB, { source: 'cl-a:nope', target: orgB.urn })));
  });

  it('a user target is CLONE_TARGET_UNSUPPORTED', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const u = await db.user.findUniqueOrThrow({ where: { id: adminB } });
    const before = await counts();
    expect(await codeOf(clone(adminB, { source: src.urn, target: u.handle! }))).toBe('CLONE_TARGET_UNSUPPORTED');
    expect(await counts()).toEqual(before);
  });

  it('an encrypted linked memory is refused', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const lm = generateId();
    await db.memory.create({ data: { id: lm, organizationId: orgA.id, urn: 'cl-a:enc', name: 'enc', class: 'knowledge', isEncrypted: true } as never });
    await db.agentMemoryItem.create({ data: { agentId: src.id, memoryId: lm } });
    const before = await counts();
    expect(await codeOf(clone(adminB, { source: src.urn, target: orgB.urn }))).toBe('CLONE_LINKED_MEMORY_ENCRYPTED');
    expect(await counts()).toEqual(before);
  });

  it('an import whose grant was revoked is refused and the whole clone rolls back', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    const dep = await sourceAgent(orgA, 'ORGANIZATION', 'dep');
    await db.agentOrgGrant.create({ data: { orgId: orgA.id, agentId: dep.id, activatedAt: new Date(Date.now() - 2000), revokedAt: new Date(Date.now() - 1000) } });
    await db.agentImport.create({ data: { parentAgentId: src.id, importedAgentId: dep.id, position: 100, agentOrgGrantOrgId: orgA.id, agentOrgGrantAgentId: dep.id } });
    const before = await counts();
    expect(await codeOf(clone(adminB, { source: src.urn, target: orgB.urn }))).toBe('CLONE_IMPORT_UNUSABLE');
    expect(await counts()).toEqual(before);
  });

  it('a caller who cannot create in the target is refused before the source is read', async () => {
    const src = await sourceAgent(orgA, 'PUBLIC');
    expect(await codeOf(clone(readerA, { source: src.urn, target: orgA.urn }))).toBe('FORBIDDEN');
  });
});
