/**
 * #1349 — attaching a memory to an agent is a GRANT to the agent's App
 * audience, so its gate must be a gate on the MEMORY, not only on the agent
 * (`findings:installing-an-agent-is-a-read-grant`: "an attach operation's gate
 * is a read gate on the attached entity").
 *
 * Before the fix, `addMemoryToAgent` / `updateAgentMemoryRole` checked only
 * that the caller administers the agent. Any user owning an agent could attach
 * another tenant's memory by its guessable URN, and the agent's App key then
 * read — and with `role: "read-write"`, WROTE — that memory's nodes, because
 * `AgentMemoryItem` is the sole knowledge-memory write cap (`cor:dmo:050:09`)
 * and every access fold trusts the row.
 *
 * Real HTTP, real keys. Each case asserts the SECURE outcome at BOTH ends: the
 * mutation's answer, and what the attached App key can then actually do.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { mintUserApiKey } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

type GqlError = { message: string; extensions?: Record<string, unknown> };
type Gql = { status: number; data: Record<string, any> | null | undefined; errors: GqlError[] | undefined };

const ATTACH = `mutation($g: ID!, $m: ID!, $r: String) { addMemoryToAgent(agentRef: $g, memoryRef: $m, role: $r) { id } }`;
const SET_ROLE = `mutation($g: ID!, $m: ID!, $r: String!) { updateAgentMemoryRole(agentRef: $g, memoryRef: $m, role: $r) { id } }`;
const READ = `query($r: ID!) { node(ref: $r) { content } }`;
const WRITE = `mutation($i: UpdateNodeInput!) { updateNode(input: $i) { id } }`;

let server: Server;
let baseUrl: string;
let suffix: string;
const key: Record<string, string> = {};
const mem: Record<string, { id: string; urn: string; nodeId: string }> = {};
let victimOrgId: string;
let attackerOrgId: string;
let dualOrgId: string;
let attackerUserId: string;
let attacker2UserId: string;
let dualUserId: string;
let reader2UserId: string;
let publicAgentId: string;

async function gql(k: string, query: string, variables: Record<string, unknown>): Promise<Gql> {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${k}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: Record<string, any> | null; errors?: GqlError[] };
  return { status: response.status, data: body.data, errors: body.errors };
}

const code = (r: Gql) => r.errors?.[0]?.extensions?.code;

/** A fresh agent installed in a fresh App of `orgId`, so cases never share an audience. */
async function agentWithApp(orgId: string, label: string) {
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: orgId, name: label, urn: `ag-${label}-${suffix}` } as never,
  });
  const { app, rawKey } = await createDbAppWithKey(db, `app-${label}`, orgId);
  await createDbAppAgent(db, app.id, agent.id);
  return { agentId: agent.id, appKey: rawKey };
}

async function readsContent(appKey: string, target: string) {
  const r = await gql(appKey, READ, { r: mem[target]!.nodeId });
  return r.data?.node?.content ?? null;
}

async function writes(appKey: string, target: string) {
  const r = await gql(appKey, WRITE, { i: { id: mem[target]!.nodeId, content: `tampered-${Math.random()}` } });
  return !r.errors;
}

beforeAll(async () => {
  await cleanDb(db);
  suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const mkOrg = (label: string) =>
    db.organization.create({ data: { id: generateId(), name: label, urn: `${label}-${suffix}` } });
  const mkUser = (label: string) =>
    db.user.create({ data: { id: generateId(), handle: `${label}-${suffix}`, githubUsername: `${label}-${suffix}` } });
  const victimOrg = await mkOrg('victim');
  const attackerOrg = await mkOrg('attacker');
  const dualOrg = await mkOrg('dual');
  victimOrgId = victimOrg.id;
  attackerOrgId = attackerOrg.id;
  dualOrgId = dualOrg.id;

  const victim = await mkUser('victim');
  const attacker = await mkUser('attacker');
  const dual = await mkUser('dual'); // READER in the victim org, OWNER of their own
  await db.orgMember.create({ data: { organizationId: victimOrg.id, userId: victim.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: attackerOrg.id, userId: attacker.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { organizationId: victimOrg.id, userId: dual.id, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: dualOrg.id, userId: dual.id, role: 'OWNER' } });

  const mint = async (userId: string) =>
    (await mintUserApiKey(db, { userId, label: 'k', createdBy: userId, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
  key.victim = await mint(victim.id);
  key.attacker = await mint(attacker.id);
  const attacker2 = await mkUser('attacker2');
  await db.orgMember.create({ data: { organizationId: attackerOrg.id, userId: attacker2.id, role: 'ADMIN' } });
  key.attacker2 = await mint(attacker2.id);
  attackerUserId = attacker.id;
  attacker2UserId = attacker2.id;
  dualUserId = dual.id;
  const reader2 = await mkUser('reader2');
  reader2UserId = reader2.id;
  key.reader2 = await mint(reader2.id);
  key.dual = await mint(dual.id);

  const victimApp = await db.app.create({
    data: { id: generateId(), organizationId: victimOrg.id, urn: `${victimOrg.urn}:vapp`, name: 'victim app' } as never,
  });
  const mkMem = async (label: string, data: Record<string, unknown>) => {
    const m = await db.memory.create({ data: { id: generateId(), urn: `${data.urnRoot}:${label}`, name: label, ...data, urnRoot: undefined } as never });
    const n = await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'payroll', name: 'p', content: `${label} SECRET` } });
    mem[label] = { id: m.id, urn: `hrn:mem:${data.urnRoot}:${label}`, nodeId: n.id };
  };
  // Org-visible knowledge in the victim org: readable by its members only.
  await mkMem('orgKnowledge', { urnRoot: victimOrg.urn, organizationId: victimOrg.id, class: 'knowledge', visibility: 'ORGANIZATION' });
  // PUBLIC knowledge in the victim org: readable by everyone, writable by nobody outside.
  await mkMem('publicKnowledge', { urnRoot: victimOrg.urn, organizationId: victimOrg.id, class: 'knowledge', visibility: 'PUBLIC' });
  // App-scoped knowledge: an org member may open the RECORD, but its content
  // is readable only through the victim App (#653).
  await mkMem('appScoped', { urnRoot: victimOrg.urn, organizationId: victimOrg.id, class: 'knowledge', visibility: 'ORGANIZATION', appId: victimApp.id });
  // The victim's personal memory.
  await mkMem('personal', { urnRoot: victimOrg.urn, class: 'personal', visibility: null, userId: victim.id, ownerUserId: victim.id });
  // The SAME-TENANT shape: another App's app-scoped knowledge memory in the
  // attacker's own org. #653 isolates it from every org-wide gate, so even the
  // org's admins can neither read nor write it (measured) — yet they pass the
  // agent gate for agents in this org.
  const siblingApp = await db.app.create({
    data: { id: generateId(), organizationId: attackerOrg.id, urn: `${attackerOrg.urn}:sibling`, name: 'sibling app' } as never,
  });
  await mkMem('siblingAppScoped', { urnRoot: attackerOrg.urn, organizationId: attackerOrg.id, class: 'knowledge', visibility: 'ORGANIZATION', appId: siblingApp.id });
  // The attacker's OWN knowledge memory — the legitimate case.
  await mkMem('ownKnowledge', { urnRoot: attackerOrg.urn, organizationId: attackerOrg.id, class: 'knowledge', visibility: 'ORGANIZATION' });

  await mkMem('ownPublic', { urnRoot: attackerOrg.urn, organizationId: attackerOrg.id, class: 'knowledge', visibility: 'PUBLIC' });
  publicAgentId = (await db.agent.create({
    data: { id: generateId(), organizationId: attackerOrg.id, name: 'published', urn: `${attackerOrg.urn}:published`, visibility: 'PUBLIC' } as never,
  })).id;
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('#1349 — legitimate attaches keep working', () => {
  it('an org admin attaches their own org memory read-only; the App key reads it', async () => {
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'own-read');
    const r = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.ownKnowledge!.urn, r: 'read' });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(await readsContent(appKey, 'ownKnowledge')).toBe('ownKnowledge SECRET');
    expect(await writes(appKey, 'ownKnowledge')).toBe(false);
  });

  it('an org admin attaches their own org memory read-write; the App key writes it', async () => {
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'own-rw');
    const r = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.ownKnowledge!.urn, r: 'read-write' });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(await writes(appKey, 'ownKnowledge')).toBe(true);
  });

  it('anyone may attach a PUBLIC memory read-only (no audience is widened)', async () => {
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'public-read');
    const r = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.publicKnowledge!.urn, r: 'read' });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(await readsContent(appKey, 'publicKnowledge')).toBe('publicKnowledge SECRET');
  });
});

describe('#1349 — an attach cannot grant what the caller does not hold', () => {
  it('an outsider cannot attach another org memory, and it answers like a missing one', async () => {
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'outsider-read');
    const existing = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.orgKnowledge!.urn, r: 'read' });
    const missingRef = `hrn:mem:victim-${suffix}:no-such-memory`;
    const missing = await gql(key.attacker!, ATTACH, { g: agentId, m: missingRef, r: 'read' });
    expect(code(existing)).toBe('MEMORY_NOT_FOUND');
    expect(JSON.stringify(existing).split(mem.orgKnowledge!.urn).join('<REF>')).toBe(
      JSON.stringify(missing).split(missingRef).join('<REF>'),
    );
    expect(await db.agentMemoryItem.count({ where: { agentId } })).toBe(0);
    expect(await readsContent(appKey, 'orgKnowledge')).toBeNull();
  });

  it('an outsider cannot attach another org memory read-write, and cannot write it', async () => {
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'outsider-rw');
    const r = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.orgKnowledge!.urn, r: 'read-write' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await writes(appKey, 'orgKnowledge')).toBe(false);
  });

  it('a record-readable, content-unreadable memory cannot be amplified to another App', async () => {
    // `dual` is a READER in the victim org: they can open the app-scoped
    // memory's RECORD but not its nodes. Attaching it to their own agent must
    // not hand those nodes to their App audience.
    const { agentId, appKey } = await agentWithApp(dualOrgId, 'dual-appscoped');
    const r = await gql(key.dual!, ATTACH, { g: agentId, m: mem.appScoped!.urn, r: 'read' });
    expect(r.errors).toHaveLength(1);
    expect(await db.agentMemoryItem.count({ where: { agentId } })).toBe(0);
    expect(await readsContent(appKey, 'appScoped')).toBeNull();
  });

  it('read-only access to a memory does not let its reader mint a read-write attachment', async () => {
    // `dual` may READ the victim org's knowledge memory (org READER) but not
    // write it. Administering their own agent must not upgrade that.
    const { agentId, appKey } = await agentWithApp(dualOrgId, 'dual-rw');
    const r = await gql(key.dual!, ATTACH, { g: agentId, m: mem.orgKnowledge!.urn, r: 'read-write' });
    expect(r.errors).toHaveLength(1);
    expect(await writes(appKey, 'orgKnowledge')).toBe(false);
  });

  it('same tenant, read-only grant: a record-readable but content-unreadable memory is still refused', async () => {
    // Isolates the CONTENT gate from the RECORD gate. The attacker is org
    // OWNER, so `canReadMemoryRecord`'s org-member fast path admits this
    // memory's record — but #653 excludes its NODES from the content gate, and
    // an attach grants content. Same tenant and role `read`, so neither the
    // tenancy rule nor the write check can catch it: only the content gate can.
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'sibling-read');
    const r = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.siblingAppScoped!.urn, r: 'read' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await readsContent(appKey, 'siblingAppScoped')).toBeNull();
  });

  it('same tenant: an org admin cannot amplify a sibling App\'s isolated memory to their own agent', async () => {
    // Preconditions, measured rather than assumed: the caller can neither read
    // nor write this memory directly, so any access the attachment confers is
    // amplification, not a capability they already hold. A tenancy filter (C1)
    // cannot see this case — memory and agent share an org.
    const directRead = await gql(key.attacker!, READ, { r: mem.siblingAppScoped!.nodeId });
    expect(directRead.data?.node ?? null, 'precondition: no direct read').toBeNull();
    const directWrite = await gql(key.attacker!, WRITE, { i: { id: mem.siblingAppScoped!.nodeId, content: 'direct' } });
    expect(directWrite.errors, 'precondition: no direct write').toHaveLength(1);
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'sibling-rw');
    const r = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.siblingAppScoped!.urn, r: 'read-write' });
    expect(r.errors).toHaveLength(1);
    expect(await readsContent(appKey, 'siblingAppScoped')).toBeNull();
    expect(await writes(appKey, 'siblingAppScoped')).toBe(false);
  });

  it('a PUBLIC memory attached read-only cannot be escalated to read-write', async () => {
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'public-escalate');
    const attach = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.publicKnowledge!.urn, r: 'read' });
    expect(attach.errors, JSON.stringify(attach.errors)).toBeUndefined();
    const escalate = await gql(key.attacker!, SET_ROLE, { g: agentId, m: mem.publicKnowledge!.urn, r: 'read-write' });
    expect(escalate.errors).toHaveLength(1);
    expect((await db.agentMemoryItem.findFirst({ where: { agentId } }))?.role).toBe('read');
    expect(await writes(appKey, 'publicKnowledge')).toBe(false);
  });

  it('attaching a PUBLIC memory read-write directly is refused', async () => {
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'public-rw');
    const r = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.publicKnowledge!.urn, r: 'read-write' });
    expect(r.errors).toHaveLength(1);
    expect(await writes(appKey, 'publicKnowledge')).toBe(false);
  });

  it('a personal memory refusal does not disclose it to a non-owner', async () => {
    const { agentId } = await agentWithApp(attackerOrgId, 'personal');
    const r = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.personal!.urn, r: 'read' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(JSON.stringify(r)).not.toContain(mem.personal!.id);
  });

  it('an unknown role value is refused, not stored', async () => {
    const { agentId } = await agentWithApp(attackerOrgId, 'bad-role');
    const r = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.ownKnowledge!.urn, r: 'write' });
    expect(code(r)).toBe('BAD_USER_INPUT');
    expect(await db.agentMemoryItem.count({ where: { agentId } })).toBe(0);
  });
});

describe('#1349 — the actor stamp on a re-role (@Ada, chat #1825)', () => {
  it('a successful re-role stamps the acting user, and a refused one leaves the row untouched', async () => {
    const { agentId } = await agentWithApp(attackerOrgId, 'actor-stamp');
    const attach = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.ownKnowledge!.urn, r: 'read' });
    expect(attach.errors, JSON.stringify(attach.errors)).toBeUndefined();
    const created = await db.agentMemoryItem.findFirstOrThrow({ where: { agentId } });
    expect(created.createdBy).toBe(attackerUserId);

    // A SUCCESSFUL re-role, performed by a DIFFERENT user (the org's second
    // admin), must name that user — not the original creator. Asserting the
    // source assignment alone would pass even if the stamp recorded the wrong
    // principal, which is the point of using a second actor here.
    const ok = await gql(key.attacker2!, SET_ROLE, { g: agentId, m: mem.ownKnowledge!.urn, r: 'read-write' });
    expect(ok.errors, JSON.stringify(ok.errors)).toBeUndefined();
    const escalated = await db.agentMemoryItem.findFirstOrThrow({ where: { agentId } });
    expect(escalated.role).toBe('read-write');
    expect(escalated.updatedBy).toBe(attacker2UserId);
    expect(escalated.createdBy).toBe(attackerUserId);

    // A REFUSED re-role must leave role AND actor exactly as they were — a
    // rejected escalation that still stamped an actor would misattribute the
    // row to whoever last tried.
    const refused = await gql(key.dual!, SET_ROLE, { g: agentId, m: mem.ownKnowledge!.urn, r: 'read' });
    expect(refused.errors).toHaveLength(1);
    const after = await db.agentMemoryItem.findFirstOrThrow({ where: { agentId } });
    expect(after.role).toBe('read-write');
    expect(after.updatedBy).toBe(attacker2UserId);
    expect(after.updatedAt).toEqual(escalated.updatedAt);
  });
});

describe('#1349 — the agent\'s AUDIENCE, not just the memory\'s tenancy (@codex, PR #1357)', () => {
  it('P1: a PUBLIC agent may not hold read-write knowledge, even its owner\'s own', async () => {
    // A PUBLIC agent's audience is every org that installs it, and PUBLIC is a
    // READ audience. Measured before this guard: a foreign App key holding only
    // an AgentOrgGrant overwrote the publisher's own node.
    const r = await gql(key.attacker!, ATTACH, { g: publicAgentId, m: mem.ownPublic!.urn, r: 'read-write' });
    expect(code(r)).toBe('FORBIDDEN');
    expect(r.errors![0]!.extensions?.reason).toBe('PUBLIC_AGENT_READ_WRITE');
    expect(await db.agentMemoryItem.count({ where: { agentId: publicAgentId } })).toBe(0);
  });

  it('an app-scoped memory is refused at the READ gate, so the attach order cannot matter', async () => {
    // Raised in review as an order-dependence: attach-then-publish would
    // succeed for an app-scoped item while publish-then-attach is refused.
    // Measured, the first half does not happen — an app-scoped memory is
    // content-unreadable by every user principal in its own right (#653 keeps
    // it out of the org gates, and App-derived reach is excluded by design), so
    // BOTH orders refuse and the invariant is single-valued. This case exists to
    // keep that refuted premise refuted.
    const ownApp2 = await db.app.create({
      data: { id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:ownapp2`, name: 'own app 2' } as never,
    });
    const scoped = await db.memory.create({
      data: {
        id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:scopedrw`,
        name: 'scopedrw', class: 'knowledge', visibility: 'ORGANIZATION', appId: ownApp2.id,
      } as never,
    });
    await db.node.create({ data: { id: generateId(), memoryId: scoped.id, loc: 'payroll', name: 'p', content: 'APP-SCOPED RW' } });
    const urn = `hrn:mem:attacker-${suffix}:scopedrw`;

    const nonPublic = await agentWithApp(attackerOrgId, 'scoped-nonpublic');
    const pubAgent = await db.agent.create({
      data: { id: generateId(), organizationId: attackerOrgId, name: 'pub2', urn: `attacker-${suffix}:pub2`, visibility: 'PUBLIC' } as never,
    });
    await db.appAgent.create({ data: { appId: ownApp2.id, agentId: pubAgent.id } as never });

    // Order A: attach to a NON-public agent first.
    const a = await gql(key.attacker!, ATTACH, { g: nonPublic.agentId, m: urn, r: 'read-write' });
    // Order B: attach to an already-PUBLIC agent.
    const b = await gql(key.attacker!, ATTACH, { g: pubAgent.id, m: urn, r: 'read-write' });
    // Same answer either way, and it is the read gate's, not the audience rule's.
    expect(code(a)).toBe('MEMORY_NOT_FOUND');
    expect(code(b)).toBe('MEMORY_NOT_FOUND');
    expect(await db.agentMemoryItem.count({ where: { memoryId: scoped.id } })).toBe(0);
  });

  it('P1: an agent holding read-write knowledge may not BECOME public', async () => {
    // The same rule from the other side — either end can move.
    const { agentId } = await agentWithApp(attackerOrgId, 'becomes-public');
    const attach = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.ownKnowledge!.urn, r: 'read-write' });
    expect(attach.errors, JSON.stringify(attach.errors)).toBeUndefined();
    const r = await gql(key.attacker!, `mutation($r: ID!) { updateAgent(ref: $r, visibility: PUBLIC) { id visibility } }`, { r: agentId });
    expect(JSON.stringify(r.errors)).toMatch(/read-write knowledge/i);
    expect((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).visibility).not.toBe('PUBLIC');
  });

  it('P1: narrowing a memory out of PUBLIC revokes the foreign links it justified', async () => {
    // The cross-tenant PUBLIC exception is evaluated once, at attach time. When
    // the owner later narrows visibility, every access fold would keep trusting
    // the stored row — measured before this sweep, the foreign App read the
    // content unchanged afterwards.
    const { agentId, appKey } = await agentWithApp(dualOrgId, 'public-narrow');
    const attach = await gql(key.dual!, ATTACH, { g: agentId, m: mem.publicKnowledge!.urn, r: 'read' });
    expect(attach.errors, JSON.stringify(attach.errors)).toBeUndefined();
    expect(await readsContent(appKey, 'publicKnowledge')).toBe('publicKnowledge SECRET');

    const narrow = await gql(key.victim!, `mutation($id: ID!) { updateMemory(id: $id, visibility: ORGANIZATION) { id visibility } }`, { id: mem.publicKnowledge!.id });
    expect(narrow.errors, JSON.stringify(narrow.errors)).toBeUndefined();
    expect(await readsContent(appKey, 'publicKnowledge')).toBeNull();
    const row = await db.agentMemoryItem.findFirstOrThrow({ where: { agentId } });
    expect(row.deletedAt).not.toBeNull();

    // The owner's OWN links survive — they never depended on PUBLIC.
    const { agentId: ownAgent } = await agentWithApp(victimOrgId, 'victim-own');
    const ownAttach = await gql(key.victim!, ATTACH, { g: ownAgent, m: mem.publicKnowledge!.urn, r: 'read' });
    expect(ownAttach.errors, JSON.stringify(ownAttach.errors)).toBeUndefined();
    await gql(key.victim!, `mutation($id: ID!) { updateMemory(id: $id, visibility: ORGANIZATION) { id } }`, { id: mem.publicKnowledge!.id });
    expect((await db.agentMemoryItem.findFirstOrThrow({ where: { agentId: ownAgent } })).deletedAt).toBeNull();
  });
});

describe('#1349 — the checks are serialized with the writes they depend on (@codex, PR #1357)', () => {
  it('an org TRANSFER revokes the links that belonged to the source tenant', async () => {
    // The revocation used to fire only on a visibility change, and classified
    // tenancy from the PRE-update row — so a transfer left the source tenant's
    // links looking same-tenant against the org the memory had just left.
    //
    // Self-contained: a transfer needs ADMIN on BOTH orgs, so this builds its
    // own pair rather than borrowing the suite's principals.
    const srcOrg = await db.organization.create({ data: { id: generateId(), name: 'src', urn: `src-${suffix}` } });
    const dstOrg = await db.organization.create({ data: { id: generateId(), name: 'dst', urn: `dst-${suffix}` } });
    const mover = await db.user.create({ data: { id: generateId(), handle: `mover-${suffix}`, githubUsername: `mover-${suffix}` } });
    await db.orgMember.create({ data: { organizationId: srcOrg.id, userId: mover.id, role: 'ADMIN' } });
    await db.orgMember.create({ data: { organizationId: dstOrg.id, userId: mover.id, role: 'ADMIN' } });
    const moverKey = (await mintUserApiKey(db, { userId: mover.id, label: 'k', createdBy: mover.id, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;

    const moving = await db.memory.create({
      data: {
        id: generateId(), organizationId: srcOrg.id, urn: `${srcOrg.urn}:moving`,
        name: 'moving', class: 'knowledge', visibility: 'ORGANIZATION',
      } as never,
    });
    const movingNode = await db.node.create({ data: { id: generateId(), memoryId: moving.id, loc: 'payroll', name: 'p', content: 'MOVING SECRET' } });
    mem.moving = { id: moving.id, urn: `hrn:mem:${srcOrg.urn}:moving`, nodeId: movingNode.id };

    const { agentId, appKey } = await agentWithApp(srcOrg.id, 'transfer-src');
    const attach = await gql(moverKey, ATTACH, { g: agentId, m: mem.moving.urn, r: 'read' });
    expect(attach.errors, JSON.stringify(attach.errors)).toBeUndefined();
    expect(await readsContent(appKey, 'moving')).toBe('MOVING SECRET');

    // Transfer to the other org. Visibility is NOT supplied — the trigger the
    // first version of this sweep missed entirely.
    const moved = await gql(moverKey, `mutation($id: ID!, $o: ID!) { updateMemory(id: $id, organizationId: $o) { id } }`, { id: moving.id, o: dstOrg.id });
    expect(moved.errors, JSON.stringify(moved.errors)).toBeUndefined();
    expect(await readsContent(appKey, 'moving')).toBeNull();
    expect((await db.agentMemoryItem.findFirstOrThrow({ where: { agentId } })).deletedAt).not.toBeNull();
  });

  it('transferring a PUBLIC memory revokes the now-foreign WRITABLE link but keeps foreign reads', async () => {
    // PUBLIC justifies a cross-tenant READ and nothing more. A PUBLIC memory
    // carrying a same-tenant read-write item and then transferred left that
    // item live and writable from what had become a foreign tenant, because
    // the sweep returned early on "still PUBLIC".
    const srcOrg = await db.organization.create({ data: { id: generateId(), name: 'psrc', urn: `psrc-${suffix}` } });
    const dstOrg = await db.organization.create({ data: { id: generateId(), name: 'pdst', urn: `pdst-${suffix}` } });
    const mover = await db.user.create({ data: { id: generateId(), handle: `pmv-${suffix}`, githubUsername: `pmv-${suffix}` } });
    await db.orgMember.create({ data: { organizationId: srcOrg.id, userId: mover.id, role: 'ADMIN' } });
    await db.orgMember.create({ data: { organizationId: dstOrg.id, userId: mover.id, role: 'ADMIN' } });
    const moverKey = (await mintUserApiKey(db, { userId: mover.id, label: 'k', createdBy: mover.id, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;

    const pub = await db.memory.create({
      data: {
        id: generateId(), organizationId: srcOrg.id, urn: `${srcOrg.urn}:pubmove`,
        name: 'pubmove', class: 'knowledge', visibility: 'PUBLIC',
      } as never,
    });
    const node = await db.node.create({ data: { id: generateId(), memoryId: pub.id, loc: 'payroll', name: 'p', content: 'PUBLIC MOVING' } });
    mem.pubmove = { id: pub.id, urn: `hrn:mem:${srcOrg.urn}:pubmove`, nodeId: node.id };

    // A writable link from the memory's own tenant — legitimate today.
    const { agentId: writer, appKey: writerKey } = await agentWithApp(srcOrg.id, 'pub-writer');
    expect((await gql(moverKey, ATTACH, { g: writer, m: mem.pubmove.urn, r: 'read-write' })).errors).toBeUndefined();
    // And a foreign READ link, justified by PUBLIC.
    const { agentId: reader, appKey: readerKey } = await agentWithApp(dualOrgId, 'pub-reader');
    expect((await gql(key.dual!, ATTACH, { g: reader, m: mem.pubmove.urn, r: 'read' })).errors).toBeUndefined();
    expect(await writes(writerKey, 'pubmove')).toBe(true);

    // Transfer. The memory stays PUBLIC; only its tenant changes.
    const moved = await gql(moverKey, `mutation($id: ID!, $o: ID!) { updateMemory(id: $id, organizationId: $o) { id visibility } }`, { id: pub.id, o: dstOrg.id });
    expect(moved.errors, JSON.stringify(moved.errors)).toBeUndefined();
    expect(moved.data!.updateMemory.visibility).toBe('PUBLIC');

    // The writable link is now foreign and must be gone…
    expect((await db.agentMemoryItem.findFirstOrThrow({ where: { agentId: writer } })).deletedAt).not.toBeNull();
    expect(await writes(writerKey, 'pubmove')).toBe(false);
    // …while the foreign READ link is still justified by PUBLIC.
    expect((await db.agentMemoryItem.findFirstOrThrow({ where: { agentId: reader } })).deletedAt).toBeNull();
    // Non-null rather than the original bytes: the legitimate write above
    // changed them, and what matters here is that the read link survived.
    expect(await readsContent(readerKey, 'pubmove')).not.toBeNull();
  });

  it('a refused publication does not mutate a system memory on the way out', async () => {
    // Combined `visibility: PUBLIC` + first `systemMemoryId`: the promotion
    // runs in its own transaction, so a congruence rejection that came only
    // from the locked recheck left the target memory converted to
    // class='system' with its visibility cleared, attached to nothing.
    const { agentId } = await agentWithApp(attackerOrgId, 'orphan-guard');
    const attach = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.ownKnowledge!.urn, r: 'read-write' });
    expect(attach.errors, JSON.stringify(attach.errors)).toBeUndefined();
    const brain = await db.memory.create({
      data: {
        id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:brain`,
        name: 'brain', class: 'knowledge', visibility: 'ORGANIZATION',
      } as never,
    });

    const r = await gql(key.attacker!, `mutation($r: ID!, $m: String!) { updateAgent(ref: $r, visibility: PUBLIC, systemMemoryId: $m) { id } }`, { r: agentId, m: brain.id });
    expect(JSON.stringify(r.errors)).toMatch(/read-write knowledge/i);

    const after = await db.memory.findUniqueOrThrow({ where: { id: brain.id } });
    expect(after.class).toBe('knowledge');
    expect(after.visibility).toBe('ORGANIZATION');
    expect((await db.agent.findUniqueOrThrow({ where: { id: agentId } })).systemMemoryId).toBeNull();
  });

  it('a refused publication does not rename the agent\'s system memory either', async () => {
    // What the early fail-fast is actually load-bearing for, now that the
    // promotion is deferred into the deciding transaction (#1364): the
    // system-memory URN sync commits its OWN transaction BEFORE the deciding
    // one. Without the fail-fast, a refused publication combined with a rename
    // would move the system memory's URN and then refuse, leaving the memory
    // renamed under an agent that never was.
    const { agentId } = await agentWithApp(attackerOrgId, 'urnsync-guard');
    const sysMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: attackerOrgId,
        // MUST be exactly `${agent.urn}-system`: the sync only touches a
        // system memory still on the derived pattern, so an org-prefixed urn
        // here would skip it and the test would pass without the guard.
        urn: `ag-urnsync-guard-${suffix}-system`,
        name: 'sys', class: 'system', visibility: null,
      } as never,
    });
    await db.agent.update({ where: { id: agentId }, data: { systemMemoryId: sysMem.id, urn: `ag-urnsync-guard-${suffix}` } });
    const attach = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.ownKnowledge!.urn, r: 'read-write' });
    expect(attach.errors, JSON.stringify(attach.errors)).toBeUndefined();

    const before = await db.memory.findUniqueOrThrow({ where: { id: sysMem.id } });
    const r = await gql(key.attacker!, `mutation($r: ID!, $u: String!, $n: String!) { updateAgent(ref: $r, visibility: PUBLIC, urn: $u, name: $n) { id } }`, { r: agentId, u: `renamed-${suffix}`, n: 'Renamed Agent' });
    expect(JSON.stringify(r.errors)).toMatch(/read-write knowledge/i);
    const after = await db.memory.findUniqueOrThrow({ where: { id: sysMem.id } });
    // Neither the URN sync nor the NAME sync may have run: both committed
    // their own transactions BEFORE the deciding one, so a refused publication
    // used to leave the system memory renamed under an unchanged agent.
    expect(after.urn).toBe(before.urn);
    expect(after.name).toBe(before.name);
  });

  it('a NEW attach racing publication cannot leave a mutated system memory behind', async () => {
    // #1364: the fail-fast alone is not enough. A link added between the
    // fail-fast and the locked decision makes the decision REFUSE — and the
    // promotion write must still not have happened. Deferring the write into
    // the deciding transaction is what makes refusal and promotion atomic.
    for (let i = 0; i < 6; i++) {
      const { agentId } = await agentWithApp(attackerOrgId, `orphan-race-${i}`);
      const brain = await db.memory.create({
        data: {
          id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:brain-${i}`,
          name: `brain-${i}`, class: 'knowledge', visibility: 'ORGANIZATION',
        } as never,
      });

      await Promise.allSettled([
        gql(key.attacker!, ATTACH, { g: agentId, m: mem.ownKnowledge!.urn, r: 'read-write' }),
        gql(key.attacker!, `mutation($r: ID!, $m: String!) { updateAgent(ref: $r, visibility: PUBLIC, systemMemoryId: $m) { id } }`, { r: agentId, m: brain.id }),
      ]);

      const agentRow = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
      const brainRow = await db.memory.findUniqueOrThrow({ where: { id: brain.id } });
      // Whichever won: the promotion happened if and only if the agent kept it.
      if (agentRow.systemMemoryId !== brain.id) {
        expect(brainRow.class, `iteration ${i}: promoted an orphan`).toBe('knowledge');
        expect(brainRow.visibility).toBe('ORGANIZATION');
      }
      // And the invariant this PR exists for still holds.
      const link = await db.agentMemoryItem.findFirst({ where: { agentId, deletedAt: null } });
      if (agentRow.visibility === 'PUBLIC') {
        expect(link?.role, `iteration ${i}: PUBLIC agent holding read-write knowledge`).not.toBe('read-write');
      }
    }
  });

  it('a read-write link to a SOFT-DELETED memory does not block publishing the agent', async () => {
    // Such an item grants nothing — every access fold excludes deleted
    // memories — so counting it permanently refused publication.
    const doomed = await db.memory.create({
      data: {
        id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:doomed`,
        name: 'doomed', class: 'knowledge', visibility: 'PUBLIC',
      } as never,
    });
    const { agentId } = await agentWithApp(attackerOrgId, 'deleted-mem');
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId, memoryId: doomed.id, role: 'read-write' } });
    await db.memory.update({ where: { id: doomed.id }, data: { deletedAt: new Date() } });

    const r = await gql(key.attacker!, `mutation($r: ID!) { updateAgent(ref: $r, visibility: PUBLIC) { id visibility } }`, { r: agentId });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data!.updateAgent.visibility).toBe('PUBLIC');
  });

  it('a concurrent attach and narrowing cannot both win', async () => {
    // The race: the attach reads the memory while PUBLIC, the narrowing finds
    // no link to revoke, and the attach then persists a grant from its stale
    // snapshot. Run repeatedly with no delay between the two calls so the
    // interleaving actually occurs; the row lock makes either order safe.
    for (let i = 0; i < 6; i++) {
      const pub = await db.memory.create({
        data: {
          id: generateId(), organizationId: victimOrgId, urn: `victim-${suffix}:race-${i}`,
          name: `race-${i}`, class: 'knowledge', visibility: 'PUBLIC',
        } as never,
      });
      const node = await db.node.create({ data: { id: generateId(), memoryId: pub.id, loc: 'payroll', name: 'p', content: 'RACE SECRET' } });
      mem[`race${i}`] = { id: pub.id, urn: `hrn:mem:victim-${suffix}:race-${i}`, nodeId: node.id };
      const { agentId, appKey } = await agentWithApp(dualOrgId, `race-${i}`);

      await Promise.allSettled([
        gql(key.dual!, ATTACH, { g: agentId, m: mem[`race${i}`]!.urn, r: 'read' }),
        gql(key.victim!, `mutation($id: ID!) { updateMemory(id: $id, visibility: ORGANIZATION) { id } }`, { id: pub.id }),
      ]);

      const finalVisibility = (await db.memory.findUniqueOrThrow({ where: { id: pub.id } })).visibility;
      const link = await db.agentMemoryItem.findFirst({ where: { agentId, deletedAt: null } });
      // The invariant, whichever order won: a live foreign link implies the
      // memory is still PUBLIC. A non-public memory must have no live foreign
      // link, and the foreign App must not read it.
      if (finalVisibility !== 'PUBLIC') {
        expect(link, `iteration ${i}: live foreign link on a non-public memory`).toBeNull();
        expect(await readsContent(appKey, `race${i}`)).toBeNull();
      }
    }
  });

  it('a NEW attach racing publication cannot slip a disqualifying link past it', async () => {
    // The case the agent-row lock exists for, and the one the memory locks
    // cannot cover: the memory being attached is not in the agent's link set
    // when publication reads it, so publication never locks that row. Only the
    // AGENT lock serializes them. (Without this case, dropping that lock left
    // the suite green — the other race tests attach BEFORE racing, so the
    // memory lock alone was enough. A green mutant indicts the test.)
    for (let i = 0; i < 6; i++) {
      const priv = await db.memory.create({
        data: {
          id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:newattach-${i}`,
          name: `newattach-${i}`, class: 'knowledge', visibility: 'ORGANIZATION',
        } as never,
      });
      await db.node.create({ data: { id: generateId(), memoryId: priv.id, loc: 'payroll', name: 'p', content: 'X' } });
      const { agentId } = await agentWithApp(attackerOrgId, `newattach-${i}`);

      await Promise.allSettled([
        gql(key.attacker!, ATTACH, { g: agentId, m: `hrn:mem:attacker-${suffix}:newattach-${i}`, r: 'read' }),
        gql(key.attacker!, `mutation($r: ID!) { updateAgent(ref: $r, visibility: PUBLIC) { id } }`, { r: agentId }),
      ]);

      const agentRow = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
      const link = await db.agentMemoryItem.findFirst({ where: { agentId, memoryId: priv.id, deletedAt: null } });
      if (agentRow.visibility === 'PUBLIC') {
        expect(link, `iteration ${i}: PUBLIC agent linking non-public knowledge attached mid-publication`).toBeNull();
      }
    }
  });

  it('a concurrent narrowing and agent publication cannot both win', async () => {
    // cor:acl:080:03: a PUBLIC agent references only PUBLIC knowledge. The
    // race: narrowing passes its "any PUBLIC agent linking this?" check while
    // the publication passes its "is every linked memory PUBLIC?" check, and
    // both commit — a PUBLIC agent holding non-public knowledge.
    for (let i = 0; i < 6; i++) {
      const pub = await db.memory.create({
        data: {
          id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:pubrace2-${i}`,
          name: `pubrace2-${i}`, class: 'knowledge', visibility: 'PUBLIC',
        } as never,
      });
      await db.node.create({ data: { id: generateId(), memoryId: pub.id, loc: 'payroll', name: 'p', content: 'X' } });
      const { agentId } = await agentWithApp(attackerOrgId, `narrowpub-${i}`);
      const attach = await gql(key.attacker!, ATTACH, { g: agentId, m: `hrn:mem:attacker-${suffix}:pubrace2-${i}`, r: 'read' });
      expect(attach.errors, JSON.stringify(attach.errors)).toBeUndefined();

      await Promise.allSettled([
        gql(key.attacker!, `mutation($id: ID!) { updateMemory(id: $id, visibility: ORGANIZATION) { id } }`, { id: pub.id }),
        gql(key.attacker!, `mutation($r: ID!) { updateAgent(ref: $r, visibility: PUBLIC) { id } }`, { r: agentId }),
      ]);

      const agentRow = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
      const memRow = await db.memory.findUniqueOrThrow({ where: { id: pub.id } });
      const link = await db.agentMemoryItem.findFirst({ where: { agentId, deletedAt: null } });
      if (agentRow.visibility === 'PUBLIC' && link) {
        expect(memRow.visibility, `iteration ${i}: PUBLIC agent linking non-public knowledge`).toBe('PUBLIC');
      }
    }
  });

  it('a concurrent read-write re-role and agent publication cannot both win', async () => {
    for (let i = 0; i < 6; i++) {
      const { agentId } = await agentWithApp(attackerOrgId, `pubrace-${i}`);
      const attach = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.ownPublic!.urn, r: 'read' });
      expect(attach.errors, JSON.stringify(attach.errors)).toBeUndefined();

      await Promise.allSettled([
        gql(key.attacker!, SET_ROLE, { g: agentId, m: mem.ownPublic!.urn, r: 'read-write' }),
        gql(key.attacker!, `mutation($r: ID!) { updateAgent(ref: $r, visibility: PUBLIC) { id } }`, { r: agentId }),
      ]);

      const agentRow = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
      const link = await db.agentMemoryItem.findFirst({ where: { agentId, deletedAt: null } });
      // The invariant: a PUBLIC agent never holds a read-write item.
      if (agentRow.visibility === 'PUBLIC') {
        expect(link?.role, `iteration ${i}: PUBLIC agent holding read-write knowledge`).not.toBe('read-write');
      }
    }
  });
});

describe("#1349 — the caller must hold it in their OWN right (@codex, PR #1357)", () => {
  it('a memory readable only through another App cannot be laundered into a second App', async () => {
    // The finding my own gate's comment got wrong: stripping ctx.appId does NOT
    // strip App-derived reach, because getAccessibleMemoryIds' user branch
    // folds in EVERY App the user can reach.
    //
    // SAME TENANT on purpose. Cross-tenant would be refused by the tenancy rule
    // whatever the read gate said, and the test would pass without pinning
    // anything — which is exactly how the first version of this case masked the
    // bug it was written for.
    const appB = await db.app.create({
      data: { id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:appB`, name: 'app B' } as never,
    });
    const bMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:bmem`,
        name: 'bmem', class: 'knowledge', visibility: 'ORGANIZATION', appId: appB.id,
      } as never,
    });
    const bNode = await db.node.create({ data: { id: generateId(), memoryId: bMem.id, loc: 'payroll', name: 'p', content: 'APP B SECRET' } });
    mem.appShared = { id: bMem.id, urn: `hrn:mem:attacker-${suffix}:bmem`, nodeId: bNode.id };
    const bAgent = await db.agent.create({
      data: { id: generateId(), organizationId: attackerOrgId, name: 'bagent', urn: `attacker-${suffix}:bagent` } as never,
    });
    await db.appAgent.create({ data: { appId: appB.id, agentId: bAgent.id } as never });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: bAgent.id, memoryId: bMem.id, role: 'read' } });
    // `reader2` participates in App B — that App participation is the ONLY path
    // by which they reach this memory: #653 keeps app-scoped rows out of every
    // org-wide gate, so their org READER role gives them nothing here.
    await db.appMember.create({ data: { appId: appB.id, userId: reader2UserId, role: 'member' } as never });
    await db.orgMember.create({ data: { organizationId: attackerOrgId, userId: reader2UserId, role: 'ADMIN' } });

    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'launder');
    const r = await gql(key.reader2!, ATTACH, { g: agentId, m: mem.appShared.urn, r: 'read' });
    expect(r.errors, 'App-derived reach must not satisfy the attachment gate').toHaveLength(1);
    expect(await db.agentMemoryItem.count({ where: { agentId } })).toBe(0);
    expect(await readsContent(appKey, 'appShared')).toBeNull();
  });

  it('a PUBLIC column on a USER-OWNED memory is not a public audience', async () => {
    // `visibility = PUBLIC` alone does not make a cross-tenant attach legal: a
    // spec-047 user-owned row is owner-only whatever the column says.
    //
    // The OWNER is the caller here, deliberately. They can read it, so the read
    // gate cannot be what refuses — only the audience rule can. An app-scoped
    // PUBLIC row would have been masked by the read gate instead.
    const owned = await db.memory.create({
      data: {
        id: generateId(), ownerUserId: attackerUserId, userId: null, organizationId: null,
        urn: `attacker-${suffix}:ownedpublic`, name: 'ownedpublic',
        class: 'knowledge', visibility: 'PUBLIC',
      } as never,
    });
    await db.node.create({ data: { id: generateId(), memoryId: owned.id, loc: 'payroll', name: 'p', content: 'X' } });
    // Precondition: the owner really can read it, so the refusal is about the
    // audience and not about access.
    const ownerRead = await gql(key.attacker!, `query($m: ID!) { memory(ref: $m) { id } }`, { m: owned.id });
    expect(ownerRead.data?.memory, 'precondition: the owner can open it').not.toBeNull();

    const { agentId } = await agentWithApp(attackerOrgId, 'ownedpublic-attach');
    const r = await gql(key.attacker!, ATTACH, { g: agentId, m: owned.id, r: 'read' });
    expect(r.errors).toHaveLength(1);
    expect(r.errors![0]!.extensions?.reason).toBe('CROSS_TENANT_ATTACH');
    expect(await db.agentMemoryItem.count({ where: { agentId } })).toBe(0);
  });

  it('a PUBLIC read-write app-scoped link does not block publishing the agent', async () => {
    // The mirror image, and a FALSE REFUSAL rather than a hole: the covered-set
    // exclusions keep app-scoped links out of a PUBLIC agent's public surface,
    // so the writable-link guard must not count one. The sibling congruence
    // checks already allow the link; two guards disagreeing is the drift.
    const ownApp = await db.app.create({
      data: { id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:ownapp`, name: 'own app' } as never,
    });
    const appScoped = await db.memory.create({
      data: {
        id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:ownappmem`,
        name: 'ownappmem', class: 'knowledge', visibility: 'PUBLIC', appId: ownApp.id,
      } as never,
    });
    const { agentId } = await agentWithApp(attackerOrgId, 'appscoped-rw');
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId, memoryId: appScoped.id, role: 'read-write' } });

    const r = await gql(key.attacker!, `mutation($r: ID!) { updateAgent(ref: $r, visibility: PUBLIC) { id visibility } }`, { r: agentId });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data!.updateAgent.visibility).toBe('PUBLIC');
  });

  it('two agents cannot concurrently claim the SAME memory as their system memory', async () => {
    // The other half of the locked re-validation: not one agent racing itself
    // over two memories, but two agents racing over one memory. Only the
    // in-transaction other-claimant check stops both pointers landing.
    for (let i = 0; i < 6; i++) {
      const { agentId: a1 } = await agentWithApp(attackerOrgId, `claim-a-${i}`);
      const { agentId: a2 } = await agentWithApp(attackerOrgId, `claim-b-${i}`);
      const brain = await db.memory.create({
        data: { id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:shared-brain-${i}`, name: `sb-${i}`, class: 'knowledge', visibility: 'ORGANIZATION' } as never,
      });
      await Promise.allSettled([
        gql(key.attacker!, `mutation($r: ID!, $m: String!) { updateAgent(ref: $r, systemMemoryId: $m) { id } }`, { r: a1, m: brain.id }),
        gql(key.attacker!, `mutation($r: ID!, $m: String!) { updateAgent(ref: $r, systemMemoryId: $m) { id } }`, { r: a2, m: brain.id }),
      ]);
      const claimants = await db.agent.count({ where: { id: { in: [a1, a2] }, systemMemoryId: brain.id } });
      expect(claimants, `iteration ${i}: one memory claimed by two agents`).toBeLessThanOrEqual(1);
    }
  });

  it('two concurrent first-attach promotions cannot both claim a system memory', async () => {
    // The validations run before the lock as a cheap early refusal; the
    // authoritative pass is inside the deciding transaction. Without it, two
    // calls could each see systemMemoryId as null and both promote.
    for (let i = 0; i < 6; i++) {
      const { agentId } = await agentWithApp(attackerOrgId, `race-promote-${i}`);
      const a = await db.memory.create({
        data: { id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:brainA-${i}`, name: `bA-${i}`, class: 'knowledge', visibility: 'ORGANIZATION' } as never,
      });
      const b = await db.memory.create({
        data: { id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:brainB-${i}`, name: `bB-${i}`, class: 'knowledge', visibility: 'ORGANIZATION' } as never,
      });
      await Promise.allSettled([
        gql(key.attacker!, `mutation($r: ID!, $m: String!) { updateAgent(ref: $r, systemMemoryId: $m) { id } }`, { r: agentId, m: a.id }),
        gql(key.attacker!, `mutation($r: ID!, $m: String!) { updateAgent(ref: $r, systemMemoryId: $m) { id } }`, { r: agentId, m: b.id }),
      ]);
      const promoted = await db.memory.findMany({ where: { id: { in: [a.id, b.id] }, class: 'system' }, select: { id: true } });
      const agentRow = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
      expect(promoted.length, `iteration ${i}: both targets promoted`).toBeLessThanOrEqual(1);
      if (promoted.length === 1) {
        expect(agentRow.systemMemoryId, `iteration ${i}: promoted a memory the agent does not point at`).toBe(promoted[0]!.id);
      }
    }
  });
});

describe('#1349 — containment: pre-existing rows are STILL LIVE (residual exposure)', () => {
  // These two pin the EXPOSURE, not a desired behaviour, and they are the
  // reason this PR is `Refs #1349`, not `Closes`. The write gate above stops
  // new over-grants; it cannot reach a row minted before it, because every
  // access fold (foldAgentIntoAccessMap, the App branch of
  // getAccessibleMemoryIds, sessionScopedMemoryIds, resolveAssetTargetMemoryId,
  // chat target selection, scopes) trusts the stored row.
  //
  // Containment is a SEPARATE decision, deliberately deferred until a read-only
  // production audit sizes it (Holger's ruling, 2026-09-25 — the audit is
  // approved, its operator not yet named). Asserting the current behaviour
  // rather than skipping keeps the residual exposure visible in the suite and
  // makes these tests FAIL THE MOMENT containment ships — at which point invert
  // them to the secure expectation (`toBeNull()` / `toBe(false)`) and close the
  // issue. A green suite here means "not yet contained", never "safe".
  it('a pre-existing read row to an unreachable memory STILL grants read — pending containment', async () => {
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'legacy-read');
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId, memoryId: mem.orgKnowledge!.id, role: 'read' } });
    expect(await readsContent(appKey, 'orgKnowledge')).toBe('orgKnowledge SECRET');
  });

  it('a pre-existing read-write row to an unreachable memory STILL grants write — pending containment', async () => {
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'legacy-rw');
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId, memoryId: mem.orgKnowledge!.id, role: 'read-write' } });
    expect(await writes(appKey, 'orgKnowledge')).toBe(true);
  });
});

describe('#1349 — Holger\'s cross-tenant ruling (2026-09-25)', () => {
  it('PUBLIC is a READ audience even for a platform admin who can write it', async () => {
    // Pins the read-only half of the PUBLIC exception on its own. For any other
    // caller the write-capability check would also refuse, masking it; a
    // platform ADMIN can write the memory, so only this rule decides.
    const admin = await db.user.create({
      data: { id: generateId(), handle: `padmin-${suffix}`, githubUsername: `padmin-${suffix}`, roles: ['ADMIN'] },
    });
    const adminKey = (await mintUserApiKey(db, { userId: admin.id, label: 'k', createdBy: admin.id, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
    // Its OWN PUBLIC memory: the shared `publicKnowledge` fixture is narrowed out
    // of PUBLIC by earlier cases in this file, which masked this test in the
    // full-file run while it passed alone (found by the mutation harness).
    const pub = await db.memory.create({
      data: {
        id: generateId(), organizationId: victimOrgId, urn: `victim-${suffix}:padminpub`,
        name: 'padminpub', class: 'knowledge', visibility: 'PUBLIC',
      } as never,
    });
    expect((await db.memory.findUniqueOrThrow({ where: { id: pub.id } })).visibility, 'precondition: PUBLIC').toBe('PUBLIC');
    const { agentId } = await agentWithApp(attackerOrgId, 'padmin-public-rw');
    const r = await gql(adminKey, ATTACH, { g: agentId, m: `hrn:mem:victim-${suffix}:padminpub`, r: 'read-write' });
    expect(r.errors?.[0]?.extensions?.reason).toBe('CROSS_TENANT_ATTACH');
    expect(await db.agentMemoryItem.count({ where: { agentId } })).toBe(0);
  });

  it('a caller who CAN read another tenant\'s memory still may not attach it', async () => {
    // `dual` reads the victim org's knowledge memory as a member, so this is
    // not an existence question — the refusal is allowed to be actionable.
    // Ruled REFUSE, matching attachMemoryToApp's ORGANIZATION_MISMATCH and the
    // PUBLIC-only cross-org subscription rule.
    const { agentId, appKey } = await agentWithApp(dualOrgId, 'dual-crossorg');
    const r = await gql(key.dual!, ATTACH, { g: agentId, m: mem.orgKnowledge!.urn, r: 'read' });
    expect(code(r)).toBe('FORBIDDEN');
    expect(r.errors![0]!.extensions?.reason).toBe('CROSS_TENANT_ATTACH');
    expect(await readsContent(appKey, 'orgKnowledge')).toBeNull();
  });
});

describe("#1357 — the same-App attach (Holger's ruling, 2026-09-26)", () => {
  // An authorized caller may attach an App's own memory, READ-ONLY, to another
  // agent installed in that same App — explicit checks, no cross-App shortcut,
  // and the row confers no ambient authority of its own.
  let appX: { id: string };
  let appXKey: string;
  let appYKey: string;
  let secondAgentId: string;

  beforeAll(async () => {
    ({ app: appX, rawKey: appXKey } = await createDbAppWithKey(db, 'same-app-x', attackerOrgId));
    const y = await createDbAppWithKey(db, 'same-app-y', attackerOrgId);
    appYKey = y.rawKey;
    const scoped = await db.memory.create({
      data: {
        id: generateId(), organizationId: attackerOrgId, appId: appX.id, urn: `attacker-${suffix}:xknow`,
        name: 'xknow', class: 'knowledge', visibility: 'ORGANIZATION',
      } as never,
    });
    const n = await db.node.create({ data: { id: generateId(), memoryId: scoped.id, loc: 'payroll', name: 'p', content: 'APP X KNOWLEDGE' } });
    mem.appX = { id: scoped.id, urn: `hrn:mem:attacker-${suffix}:xknow`, nodeId: n.id };
    // The SECOND agent, installed in App X — and in App Y too, so the
    // no-ambient-authority case below has an App to leak into.
    secondAgentId = (await db.agent.create({
      data: { id: generateId(), organizationId: attackerOrgId, name: 'second', urn: `attacker-${suffix}:second` } as never,
    })).id;
    await createDbAppAgent(db, appX.id, secondAgentId);
    await createDbAppAgent(db, y.app.id, secondAgentId);
    // Precondition, measured: App X's key cannot read the memory before the attach.
    expect(await readsContent(appXKey, 'appX'), 'precondition').toBeNull();
  });

  it('an org admin attaches App X knowledge read-only to a second agent installed in App X', async () => {
    const r = await gql(key.attacker!, ATTACH, { g: secondAgentId, m: mem.appX!.urn, r: 'read' });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(await db.agentMemoryItem.findFirst({ where: { agentId: secondAgentId, memoryId: mem.appX!.id }, select: { role: true } }))
      .toEqual({ role: 'read' });
    expect(await readsContent(appXKey, 'appX')).toBe('APP X KNOWLEDGE');
  });

  it('the row confers no ambient authority: App Y, where the same agent is installed, still cannot read it', async () => {
    expect(await db.agentMemoryItem.count({ where: { agentId: secondAgentId, memoryId: mem.appX!.id } })).toBe(1);
    expect(await readsContent(appYKey, 'appX')).toBeNull();
  });

  it('no cross-App shortcut: an agent installed only in ANOTHER App is refused, even for an admin of both', async () => {
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'same-app-cross');
    const r = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.appX!.urn, r: 'read' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await db.agentMemoryItem.count({ where: { agentId } })).toBe(0);
    expect(await readsContent(appKey, 'appX')).toBeNull();
  });

  it('read-only only: a same-App READ-WRITE attach still needs the caller\'s own write capability', async () => {
    const third = await db.agent.create({
      data: { id: generateId(), organizationId: attackerOrgId, name: 'third', urn: `attacker-${suffix}:third` } as never,
    });
    await createDbAppAgent(db, appX.id, third.id);
    const r = await gql(key.attacker!, ATTACH, { g: third.id, m: mem.appX!.urn, r: 'read-write' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await db.agentMemoryItem.count({ where: { agentId: third.id } })).toBe(0);
    expect(await writes(appXKey, 'appX')).toBe(false);
  });

  it('a same-App read row cannot be re-roled to read-write through the same branch', async () => {
    const r = await gql(key.attacker!, SET_ROLE, { g: secondAgentId, m: mem.appX!.urn, r: 'read-write' });
    expect(r.errors).toHaveLength(1);
    expect(await db.agentMemoryItem.findFirst({ where: { agentId: secondAgentId, memoryId: mem.appX!.id }, select: { role: true } }))
      .toEqual({ role: 'read' });
  });

  it('an uninstalled App admits nothing', async () => {
    const gone = await createDbAppWithKey(db, 'same-app-gone', attackerOrgId);
    const goneMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: attackerOrgId, appId: gone.app.id, urn: `attacker-${suffix}:goneknow`,
        name: 'goneknow', class: 'knowledge', visibility: 'ORGANIZATION',
      } as never,
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: attackerOrgId, name: 'goneagent', urn: `attacker-${suffix}:goneagent` } as never,
    });
    await createDbAppAgent(db, gone.app.id, agent.id);
    await db.app.update({ where: { id: gone.app.id }, data: { uninstalledAt: new Date() } });
    const r = await gql(key.attacker!, ATTACH, { g: agent.id, m: `hrn:mem:attacker-${suffix}:goneknow`, r: 'read' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await db.agentMemoryItem.count({ where: { memoryId: goneMem.id } })).toBe(0);
  });

  it('only knowledge/group: an App-scoped APP-class memory is not admitted', async () => {
    const appClass = await db.memory.create({
      data: {
        id: generateId(), organizationId: attackerOrgId, appId: appX.id, urn: `attacker-${suffix}:xappclass`,
        name: 'xappclass', class: 'app', visibility: null,
      } as never,
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: attackerOrgId, name: 'appclassagent', urn: `attacker-${suffix}:appclassagent` } as never,
    });
    await createDbAppAgent(db, appX.id, agent.id);
    const r = await gql(key.attacker!, ATTACH, { g: agent.id, m: `hrn:mem:attacker-${suffix}:xappclass`, r: 'read' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await db.agentMemoryItem.count({ where: { memoryId: appClass.id } })).toBe(0);
  });

  it('a DELETED App admits nothing', async () => {
    const del = await createDbAppWithKey(db, 'same-app-deleted', attackerOrgId);
    const delMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: attackerOrgId, appId: del.app.id, urn: `attacker-${suffix}:delknow`,
        name: 'delknow', class: 'knowledge', visibility: 'ORGANIZATION',
      } as never,
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: attackerOrgId, name: 'delagent', urn: `attacker-${suffix}:delagent` } as never,
    });
    await createDbAppAgent(db, del.app.id, agent.id);
    await db.app.update({ where: { id: del.app.id }, data: { deletedAt: new Date() } });
    const r = await gql(key.attacker!, ATTACH, { g: agent.id, m: `hrn:mem:attacker-${suffix}:delknow`, r: 'read' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await db.agentMemoryItem.count({ where: { memoryId: delMem.id } })).toBe(0);
  });

  it('an App in a SOFT-DELETED org admits nothing', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'gone org', urn: `goneorg-${suffix}` } });
    const admin = await db.user.create({ data: { id: generateId(), handle: `goneadmin-${suffix}`, githubUsername: `goneadmin-${suffix}` } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'OWNER' } });
    const adminKey = (await mintUserApiKey(db, { userId: admin.id, label: 'k', createdBy: admin.id, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
    const z = await createDbAppWithKey(db, 'same-app-goneorg', org.id);
    const zMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, appId: z.app.id, urn: `goneorg-${suffix}:zknow`,
        name: 'zknow', class: 'knowledge', visibility: 'ORGANIZATION',
      } as never,
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, name: 'zagent', urn: `goneorg-${suffix}:zagent` } as never,
    });
    await createDbAppAgent(db, z.app.id, agent.id);
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    const r = await gql(adminKey, ATTACH, { g: agent.id, m: `hrn:mem:goneorg-${suffix}:zknow`, r: 'read' });
    expect(r.errors, 'refused').toHaveLength(1);
    expect(await db.agentMemoryItem.count({ where: { memoryId: zMem.id } })).toBe(0);
    // Recorded for the mutation check: WHICH gate answered.
    (globalThis as Record<string, unknown>).__goneOrgCode = code(r);
  });

  it('a caller not authorized for the App is refused by the App gate', async () => {
    // Masking, stated rather than hidden: any caller who passes the AGENT gate
    // but not the App's is also refused later by the tenancy rule — measured,
    // there is no constructible principal for whom the App gate alone decides.
    // So this pins the App gate by its ANSWER: MEMORY_NOT_FOUND comes from the
    // read gate, where tenancy would answer FORBIDDEN / CROSS_TENANT_ATTACH.
    const plain = await db.user.create({
      data: { id: generateId(), handle: `plain-${suffix}`, githubUsername: `plain-${suffix}` },
    });
    await db.orgMember.create({ data: { organizationId: attackerOrgId, userId: plain.id, role: 'CONTRIBUTOR' } });
    const plainKey = (await mintUserApiKey(db, { userId: plain.id, label: 'k', createdBy: plain.id, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
    const owned = await db.agent.create({
      data: { id: generateId(), ownerUserId: plain.id, name: 'plainagent', urn: `plain-${suffix}:agent` } as never,
    });
    await createDbAppAgent(db, appX.id, owned.id);
    const r = await gql(plainKey, ATTACH, { g: owned.id, m: mem.appX!.urn, r: 'read' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await db.agentMemoryItem.count({ where: { agentId: owned.id } })).toBe(0);
  });
});

describe('#1357 round 2 — revocation and the same-App branch (@copilot, PR #1357)', () => {
  const NARROW = `mutation($id: ID!, $v: MemoryVisibility!) { updateMemory(id: $id, visibility: $v) { id visibility } }`;
  const mkVictimMem = async (label: string, data: Record<string, unknown>) => {
    const m = await db.memory.create({
      data: { id: generateId(), organizationId: victimOrgId, urn: `victim-${suffix}:${label}`, name: label, class: 'knowledge', ...data } as never,
    });
    const n = await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'payroll', name: 'p', content: `${label} SECRET` } });
    mem[label] = { id: m.id, urn: `hrn:mem:victim-${suffix}:${label}`, nodeId: n.id };
    return m;
  };

  it('a FOREIGN PUBLIC agent\'s read link cannot veto the owner\'s narrowing; it is revoked instead', async () => {
    const pub = await mkVictimMem('vetopub', { visibility: 'PUBLIC' });
    // Another tenant's PUBLIC agent holding the memory read-only — legitimate
    // while the memory is PUBLIC.
    const foreign = await db.agent.create({
      data: { id: generateId(), organizationId: attackerOrgId, name: 'foreignpub', urn: `attacker-${suffix}:foreignpub`, visibility: 'PUBLIC' } as never,
    });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: foreign.id, memoryId: pub.id, role: 'read' } });

    const narrow = await gql(key.victim!, NARROW, { id: pub.id, v: 'ORGANIZATION' });
    expect(narrow.errors, JSON.stringify(narrow.errors)).toBeUndefined();
    expect((await db.memory.findUniqueOrThrow({ where: { id: pub.id } })).visibility).toBe('ORGANIZATION');
    expect((await db.agentMemoryItem.findFirstOrThrow({ where: { agentId: foreign.id } })).deletedAt).not.toBeNull();
  });

  it('a SAME-tenant PUBLIC agent still blocks the narrowing (the genuine congruence rule)', async () => {
    const pub = await mkVictimMem('ownpub', { visibility: 'PUBLIC' });
    const own = await db.agent.create({
      data: { id: generateId(), organizationId: victimOrgId, name: 'ownpubagent', urn: `victim-${suffix}:ownpubagent`, visibility: 'PUBLIC' } as never,
    });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: own.id, memoryId: pub.id, role: 'read' } });
    const narrow = await gql(key.victim!, NARROW, { id: pub.id, v: 'ORGANIZATION' });
    expect(narrow.errors?.[0]?.message ?? '').toMatch(/knowledge of the PUBLIC agent/);
    expect((await db.memory.findUniqueOrThrow({ where: { id: pub.id } })).visibility).toBe('PUBLIC');
  });

  it('an App-scoped PUBLIC memory has no public audience: the sweep revokes even its foreign READ links', async () => {
    const vapp = await db.app.findFirstOrThrow({ where: { organizationId: victimOrgId, urn: { endsWith: ':vapp' } } });
    const scopedPub = await mkVictimMem('scopedpub', { visibility: 'PUBLIC', appId: vapp.id });
    const { agentId, appKey } = await agentWithApp(attackerOrgId, 'scopedpub-foreign');
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId, memoryId: scopedPub.id, role: 'read' } });
    // Any visibility write runs the sweep; here it keeps the memory PUBLIC.
    const touch = await gql(key.victim!, NARROW, { id: scopedPub.id, v: 'PUBLIC' });
    expect(touch.errors, JSON.stringify(touch.errors)).toBeUndefined();
    expect((await db.agentMemoryItem.findFirstOrThrow({ where: { agentId } })).deletedAt).not.toBeNull();
    expect(await readsContent(appKey, 'scopedpub')).toBeNull();
  });

  it('same-App never admits a USER-owned row, even for the App\'s admin', async () => {
    // Masking, stated: tenancy would also refuse (the row has no organization),
    // so this pins the branch by its ANSWER — MEMORY_NOT_FOUND from the read
    // gate rather than CROSS_TENANT_ATTACH from tenancy.
    const { app: appZ } = await createDbAppWithKey(db, 'same-app-userowned', attackerOrgId);
    const owned = await db.memory.create({
      data: {
        id: generateId(), ownerUserId: reader2UserId, appId: appZ.id, urn: `attacker-${suffix}:userowned`,
        name: 'userowned', class: 'knowledge', visibility: 'ORGANIZATION',
      } as never,
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: attackerOrgId, name: 'uoagent', urn: `attacker-${suffix}:uoagent` } as never,
    });
    await createDbAppAgent(db, appZ.id, agent.id);
    const r = await gql(key.attacker!, ATTACH, { g: agent.id, m: `hrn:mem:attacker-${suffix}:userowned`, r: 'read' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await db.agentMemoryItem.count({ where: { memoryId: owned.id } })).toBe(0);
  });
});

describe('#1357 round 3 (@codex / @copilot, PR #1357)', () => {
  it('an INVALID role on an unreadable memory answers as a missing memory — for attach and re-role', async () => {
    const { agentId } = await agentWithApp(attackerOrgId, 'badrole-hidden');
    const missingUrn = `hrn:mem:victim-${suffix}:no-such-memory`;
    for (const q of [ATTACH, SET_ROLE]) {
      const existing = await gql(key.attacker!, q, { g: agentId, m: mem.orgKnowledge!.urn, r: 'write' });
      const missing = await gql(key.attacker!, q, { g: agentId, m: missingUrn, r: 'write' });
      expect(code(missing)).toBe('MEMORY_NOT_FOUND');
      expect(code(existing)).toBe('MEMORY_NOT_FOUND');
      expect(existing.errors?.[0]?.message.replace(mem.orgKnowledge!.urn, '<REF>'))
        .toBe(missing.errors?.[0]?.message.replace(missingUrn, '<REF>'));
    }
  });

  it('control: an invalid role on a memory the caller CAN read is still BAD_USER_INPUT', async () => {
    const { agentId } = await agentWithApp(attackerOrgId, 'badrole-visible');
    const r = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.ownKnowledge!.urn, r: 'write' });
    expect(code(r)).toBe('BAD_USER_INPUT');
    expect(await db.agentMemoryItem.count({ where: { agentId } })).toBe(0);
  });

  const TRANSFER = `mutation($id: ID!, $o: ID!) { updateMemory(id: $id, organizationId: $o, visibility: ORGANIZATION) { id } }`;
  const mkTransferFixture = async (label: string) => {
    // The victim owns two orgs: the memory starts PUBLIC in victimOrg and moves to orgC.
    const orgC = await db.organization.create({ data: { id: generateId(), name: `c-${label}`, urn: `c-${label}-${suffix}` } });
    const victim = await db.user.findFirstOrThrow({ where: { handle: `victim-${suffix}` } });
    await db.orgMember.create({ data: { organizationId: orgC.id, userId: victim.id, role: 'OWNER' } });
    const m = await db.memory.create({
      data: { id: generateId(), organizationId: victimOrgId, urn: `victim-${suffix}:${label}`, name: label, class: 'knowledge', visibility: 'PUBLIC' } as never,
    });
    return { orgC, m };
  };

  it('transfer + narrow in ONE call: a PUBLIC agent in the DESTINATION org blocks it', async () => {
    const { orgC, m } = await mkTransferFixture('xfer-dest');
    const destAgent = await db.agent.create({
      data: { id: generateId(), organizationId: orgC.id, name: 'destpub', urn: `c-xfer-dest-${suffix}:destpub`, visibility: 'PUBLIC' } as never,
    });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: destAgent.id, memoryId: m.id, role: 'read' } });
    const r = await gql(key.victim!, TRANSFER, { id: m.id, o: orgC.id });
    expect(r.errors?.[0]?.message ?? '').toMatch(/knowledge of the PUBLIC agent/);
    const after = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
    expect({ org: after.organizationId, vis: after.visibility }).toEqual({ org: victimOrgId, vis: 'PUBLIC' });
  });

  it('transfer + narrow in ONE call: a PUBLIC agent in the SOURCE org does not block it, and its link is revoked', async () => {
    const { orgC, m } = await mkTransferFixture('xfer-src');
    const srcAgent = await db.agent.create({
      data: { id: generateId(), organizationId: victimOrgId, name: 'srcpub', urn: `victim-${suffix}:srcpub`, visibility: 'PUBLIC' } as never,
    });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: srcAgent.id, memoryId: m.id, role: 'read' } });
    const r = await gql(key.victim!, TRANSFER, { id: m.id, o: orgC.id });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    const after = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
    expect({ org: after.organizationId, vis: after.visibility }).toEqual({ org: orgC.id, vis: 'ORGANIZATION' });
    expect((await db.agentMemoryItem.findFirstOrThrow({ where: { agentId: srcAgent.id } })).deletedAt).not.toBeNull();
  });
});

describe('#1357 round 4 (@codex / @copilot, PR #1357)', () => {
  it('a TRANSFER alone into a tenant whose PUBLIC agent links the memory is refused (congruence)', async () => {
    const orgC = await db.organization.create({ data: { id: generateId(), name: 'c-xonly', urn: `c-xonly-${suffix}` } });
    const victim = await db.user.findFirstOrThrow({ where: { handle: `victim-${suffix}` } });
    await db.orgMember.create({ data: { organizationId: orgC.id, userId: victim.id, role: 'OWNER' } });
    const m = await db.memory.create({
      data: { id: generateId(), organizationId: victimOrgId, urn: `victim-${suffix}:xonly`, name: 'xonly', class: 'knowledge', visibility: 'ORGANIZATION' } as never,
    });
    const destPub = await db.agent.create({
      data: { id: generateId(), organizationId: orgC.id, name: 'xonlypub', urn: `c-xonly-${suffix}:pub`, visibility: 'PUBLIC' } as never,
    });
    // A pre-existing cross-tenant link — after the transfer it would be same-tenant and survive the sweep.
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: destPub.id, memoryId: m.id, role: 'read' } });
    const r = await gql(key.victim!, `mutation($id: ID!, $o: ID!) { updateMemory(id: $id, organizationId: $o) { id } }`, { id: m.id, o: orgC.id });
    expect(r.errors?.[0]?.message ?? '').toMatch(/knowledge of the PUBLIC agent/);
    expect((await db.memory.findUniqueOrThrow({ where: { id: m.id } })).organizationId).toBe(victimOrgId);
  });

  it('the agent gate is re-checked on the LOCKED agent: a revocation just before the transaction refuses the attach', async () => {
    const { agentId } = await agentWithApp(attackerOrgId, 'toctou');
    // A PUBLIC memory in the agent's own org: a revoked user can STILL read it,
    // so the memory-side gate and tenancy both pass and only the agent gate can
    // refuse. (First version used an org-visible memory, and the memory-side
    // gate refused after the revocation — masked, caught by running this test
    // against the previous head.)
    const pub = await db.memory.create({
      data: { id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:toctou-pub`, name: 'toctou-pub', class: 'knowledge', visibility: 'PUBLIC' } as never,
    });
    const membership = await db.orgMember.findFirstOrThrow({ where: { organizationId: attackerOrgId, userId: attacker2UserId } });
    // Stage the interleaving: the pre-transaction agent gate has passed; the
    // revocation commits; then the transaction runs.
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (...a: unknown[]) => {
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: attackerOrgId, userId: attacker2UserId } } as never, data: { deletedAt: new Date() } });
      return real(...a);
    }) as never);
    try {
      const r = await gql(key.attacker2!, ATTACH, { g: agentId, m: `hrn:mem:attacker-${suffix}:toctou-pub`, r: 'read' });
      expect(spy).toHaveBeenCalled();
      expect(r.errors, 'refused by the in-transaction agent gate').toHaveLength(1);
      expect(await db.agentMemoryItem.count({ where: { agentId, memoryId: pub.id } })).toBe(0);
    } finally {
      spy.mockRestore();
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: attackerOrgId, userId: attacker2UserId } } as never, data: { deletedAt: membership.deletedAt } });
    }
  });

  it('rename race: the OLDER rename\'s sync lands last and still converges on the agent\'s CURRENT URN and name', async () => {
    const { syncSystemMemoryUrn, syncSystemMemoryName } = await import('../../api/graphql/schema/resolvers.mutation.agent.js');
    // State after two renames A→B→C committed, with the SECOND sync already run
    // (it skipped: memory still at A-system) and the FIRST sync about to run.
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: attackerOrgId, name: 'Final Name', urn: `attacker-${suffix}:race-c` } as never,
    });
    const sys = await db.memory.create({
      data: { id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:race-a-system`, name: 'First Name System', class: 'system' } as never,
    });
    await syncSystemMemoryUrn(db as never, { agentId: agent.id, systemMemoryId: sys.id, oldAgentUrn: `attacker-${suffix}:race-a`, actor: null });
    await syncSystemMemoryName(db as never, { agentId: agent.id, systemMemoryId: sys.id, actor: null });
    const after = await db.memory.findUniqueOrThrow({ where: { id: sys.id } });
    expect(after.urn).toBe(`attacker-${suffix}:race-c-system`);
    expect(after.name).toBe('Final Name System');
  });

  it('rename sync never rewrites an author-chosen system-memory URN', async () => {
    const { syncSystemMemoryUrn } = await import('../../api/graphql/schema/resolvers.mutation.agent.js');
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: attackerOrgId, name: 'x', urn: `attacker-${suffix}:chosen-new` } as never,
    });
    const sys = await db.memory.create({
      data: { id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:my-own-brain`, name: 'b', class: 'system' } as never,
    });
    await syncSystemMemoryUrn(db as never, { agentId: agent.id, systemMemoryId: sys.id, oldAgentUrn: `attacker-${suffix}:chosen-old`, actor: null });
    expect((await db.memory.findUniqueOrThrow({ where: { id: sys.id } })).urn).toBe(`attacker-${suffix}:my-own-brain`);
  });
});

describe('#1357 round 4 — re-role TOCTOU', () => {
  it('the agent gate is re-checked on the LOCKED agent for a RE-ROLE too', async () => {
    const { agentId } = await agentWithApp(attackerOrgId, 'toctou-rerole');
    const pub = await db.memory.create({
      data: { id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:toctou-rr`, name: 'toctou-rr', class: 'knowledge', visibility: 'PUBLIC' } as never,
    });
    const row = await db.agentMemoryItem.create({ data: { id: generateId(), agentId, memoryId: pub.id, role: 'read' } });
    const membership = await db.orgMember.findFirstOrThrow({ where: { organizationId: attackerOrgId, userId: attacker2UserId } });
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(db, '$transaction').mockImplementationOnce((async (...a: unknown[]) => {
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: attackerOrgId, userId: attacker2UserId } } as never, data: { deletedAt: new Date() } });
      return real(...a);
    }) as never);
    try {
      // Re-role to the SAME `read` role: the memory-side gate and tenancy pass
      // for a PUBLIC same-org memory, so only the agent gate can refuse.
      const r = await gql(key.attacker2!, SET_ROLE, { g: agentId, m: `hrn:mem:attacker-${suffix}:toctou-rr`, r: 'read' });
      expect(spy).toHaveBeenCalled();
      expect(r.errors, 'refused by the in-transaction agent gate').toHaveLength(1);
      expect((await db.agentMemoryItem.findUniqueOrThrow({ where: { id: row.id } })).updatedBy).toBeNull();
    } finally {
      spy.mockRestore();
      await db.orgMember.update({ where: { organizationId_userId: { organizationId: attackerOrgId, userId: attacker2UserId } } as never, data: { deletedAt: membership.deletedAt } });
    }
  });
});

describe('#1357 round 4 — the in-transaction congruence check on a transfer', () => {
  it('a destination PUBLIC-agent link committing after the fail-fast is caught under the lock', async () => {
    const orgC = await db.organization.create({ data: { id: generateId(), name: 'c-late', urn: `c-late-${suffix}` } });
    const victim = await db.user.findFirstOrThrow({ where: { handle: `victim-${suffix}` } });
    await db.orgMember.create({ data: { organizationId: orgC.id, userId: victim.id, role: 'OWNER' } });
    const m = await db.memory.create({
      data: { id: generateId(), organizationId: victimOrgId, urn: `victim-${suffix}:late`, name: 'late', class: 'knowledge', visibility: 'ORGANIZATION' } as never,
    });
    const destPub = await db.agent.create({
      data: { id: generateId(), organizationId: orgC.id, name: 'latepub', urn: `c-late-${suffix}:pub`, visibility: 'PUBLIC' } as never,
    });
    // The fail-fast runs before any transaction and sees NO link. The link
    // commits between it and the deciding transaction — the window only the
    // in-transaction check covers (it was masked by the fail-fast otherwise).
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    let staged = false;
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (...a: unknown[]) => {
      if (!staged) {
        staged = true;
        await db.agentMemoryItem.create({ data: { id: generateId(), agentId: destPub.id, memoryId: m.id, role: 'read' } });
      }
      return real(...a);
    }) as never);
    try {
      const r = await gql(key.victim!, `mutation($id: ID!, $o: ID!) { updateMemory(id: $id, organizationId: $o) { id } }`, { id: m.id, o: orgC.id });
      expect(staged, 'the link was staged inside the window').toBe(true);
      expect(r.errors?.[0]?.message ?? '').toMatch(/knowledge of the PUBLIC agent/);
      expect((await db.memory.findUniqueOrThrow({ where: { id: m.id } })).organizationId).toBe(victimOrgId);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('#1357 round 5 (@codex, PR #1357)', () => {
  const RENAME = `mutation($r: ID!, $u: String!) { updateAgent(ref: $r, urn: $u) { urn } }`;

  it('rename race, OLDER sync first: a rename committing inside another\'s window still converges on the latest URN', async () => {
    const base = `attacker-${suffix}`;
    const sys = await db.memory.create({
      data: { id: generateId(), organizationId: attackerOrgId, urn: `${base}:ren-a-system`, name: 'ren System', class: 'system' } as never,
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: attackerOrgId, name: 'ren', urn: `${base}:ren-a`, systemMemoryId: sys.id } as never,
    });
    // Request 2 (→ ren-c) has already read the agent at ren-a. Request 1
    // (→ ren-b) then runs to completion — its own sync included — before
    // request 2's transaction starts.
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    let staged = false;
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (...a: unknown[]) => {
      if (!staged) {
        staged = true;
        spy.mockImplementation(((...b: unknown[]) => real(...b)) as never);
        const first = await gql(key.attacker!, RENAME, { r: agent.id, u: 'ren-b' });
        expect(first.errors, JSON.stringify(first.errors)).toBeUndefined();
        expect((await db.memory.findUniqueOrThrow({ where: { id: sys.id } })).urn).toBe(`${base}:ren-b-system`);
      }
      return real(...a);
    }) as never);
    try {
      const second = await gql(key.attacker!, RENAME, { r: agent.id, u: 'ren-c' });
      expect(staged).toBe(true);
      expect(second.errors, JSON.stringify(second.errors)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).urn).toBe(`${base}:ren-c`);
    expect((await db.memory.findUniqueOrThrow({ where: { id: sys.id } })).urn).toBe(`${base}:ren-c-system`);
  });

  it('a PUBLIC agent may hold READ-WRITE on an App-scoped memory — the same answer in either order', async () => {
    // A platform admin can read and write an App-scoped memory, so both orders
    // are reachable. App-scoped links are outside the covered set, which is how
    // publication judges them; the attach guard now agrees.
    const admin = await db.user.create({
      data: { id: generateId(), handle: `padmin2-${suffix}`, githubUsername: `padmin2-${suffix}`, roles: ['ADMIN'] },
    });
    const adminKey = (await mintUserApiKey(db, { userId: admin.id, label: 'k', createdBy: admin.id, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
    const { app } = await createDbAppWithKey(db, 'covered-order', attackerOrgId);
    const scoped = await db.memory.create({
      data: { id: generateId(), organizationId: attackerOrgId, appId: app.id, urn: `attacker-${suffix}:covered-order`, name: 'co', class: 'knowledge', visibility: 'ORGANIZATION' } as never,
    });
    const urn = `hrn:mem:attacker-${suffix}:covered-order`;
    // Order A: attach to a non-public agent, then publish it.
    const a = await db.agent.create({ data: { id: generateId(), organizationId: attackerOrgId, name: 'co-a', urn: `attacker-${suffix}:co-a` } as never });
    const attachA = await gql(adminKey, ATTACH, { g: a.id, m: urn, r: 'read-write' });
    expect(attachA.errors, JSON.stringify(attachA.errors)).toBeUndefined();
    const publish = await gql(adminKey, `mutation($r: ID!) { updateAgent(ref: $r, visibility: PUBLIC) { visibility } }`, { r: a.id });
    expect(publish.errors, JSON.stringify(publish.errors)).toBeUndefined();
    // Order B: attach to an already-PUBLIC agent.
    const b = await db.agent.create({ data: { id: generateId(), organizationId: attackerOrgId, name: 'co-b', urn: `attacker-${suffix}:co-b`, visibility: 'PUBLIC' } as never });
    const attachB = await gql(adminKey, ATTACH, { g: b.id, m: urn, r: 'read-write' });
    expect(attachB.errors, JSON.stringify(attachB.errors)).toBeUndefined();
    expect(await db.agentMemoryItem.count({ where: { memoryId: scoped.id, role: 'read-write', deletedAt: null } })).toBe(2);
  });

  it('control: the PUBLIC-agent read-write guard still applies to a COVERED memory', async () => {
    const pubAgent = await db.agent.create({ data: { id: generateId(), organizationId: attackerOrgId, name: 'cov-pub', urn: `attacker-${suffix}:cov-pub`, visibility: 'PUBLIC' } as never });
    const r = await gql(key.attacker!, ATTACH, { g: pubAgent.id, m: mem.ownKnowledge!.urn, r: 'read-write' });
    expect(r.errors?.[0]?.extensions?.reason).toBe('PUBLIC_AGENT_READ_WRITE');
  });
});

describe('#1357 round 6 (@copilot, PR #1357)', () => {
  const stageBeforeTx = (act: () => Promise<unknown>) => {
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    let staged = false;
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (...a: unknown[]) => {
      if (!staged) { staged = true; await act(); }
      return real(...a);
    }) as never);
    return { spy, wasStaged: () => staged };
  };

  it('an APP-class memory is refused for every caller — a platform admin included', async () => {
    const admin = await db.user.create({
      data: { id: generateId(), handle: `padmin3-${suffix}`, githubUsername: `padmin3-${suffix}`, roles: ['ADMIN'] },
    });
    const adminKey = (await mintUserApiKey(db, { userId: admin.id, label: 'k', createdBy: admin.id, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
    const { app } = await createDbAppWithKey(db, 'appclass-any', attackerOrgId);
    const appMem = await db.memory.create({
      data: { id: generateId(), organizationId: attackerOrgId, appId: app.id, urn: `attacker-${suffix}:appclass-any`, name: 'ac', class: 'app', visibility: null } as never,
    });
    const { agentId } = await agentWithApp(attackerOrgId, 'appclass-any');
    const r = await gql(adminKey, ATTACH, { g: agentId, m: `hrn:mem:attacker-${suffix}:appclass-any`, r: 'read' });
    expect(code(r)).toBe('UNSUPPORTED_MEMORY_CLASS');
    expect(await db.agentMemoryItem.count({ where: { memoryId: appMem.id } })).toBe(0);
  });

  it('an agent soft-deleted after the pre-check answers exactly as a missing agent, and gets no grant', async () => {
    const { agentId } = await agentWithApp(attackerOrgId, 'dead-agent');
    const missing = await gql(key.attacker!, ATTACH, { g: `hrn:agent:attacker-${suffix}:no-such-agent`, m: mem.ownKnowledge!.urn, r: 'read' });
    const { spy, wasStaged } = stageBeforeTx(() => db.agent.update({ where: { id: agentId }, data: { deletedAt: new Date() } }));
    try {
      const r = await gql(key.attacker!, ATTACH, { g: agentId, m: mem.ownKnowledge!.urn, r: 'read' });
      expect(wasStaged()).toBe(true);
      expect(code(r)).toBe(code(missing));
      expect(r.errors).toHaveLength(1);
      expect(await db.agentMemoryItem.count({ where: { agentId } })).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('a memory soft-deleted after the pre-check answers MEMORY_NOT_FOUND, and gets no grant', async () => {
    // Through the SAME-APP branch: the ordinary read gate already excludes a
    // deleted memory (the first version of this test was masked by it), but
    // the same-App admission never looked at the memory's liveness.
    const { app } = await createDbAppWithKey(db, 'liveness-app', attackerOrgId);
    const doomed = await db.memory.create({
      data: { id: generateId(), organizationId: attackerOrgId, appId: app.id, urn: `attacker-${suffix}:liveness-doomed`, name: 'liveness-doomed', class: 'knowledge', visibility: 'ORGANIZATION' } as never,
    });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: attackerOrgId, name: 'liveness-agent', urn: `attacker-${suffix}:liveness-agent` } as never });
    await createDbAppAgent(db, app.id, agent.id);
    const { spy, wasStaged } = stageBeforeTx(() => db.memory.update({ where: { id: doomed.id }, data: { deletedAt: new Date() } }));
    try {
      const r = await gql(key.attacker!, ATTACH, { g: agent.id, m: `hrn:mem:attacker-${suffix}:liveness-doomed`, r: 'read' });
      expect(wasStaged()).toBe(true);
      expect(code(r)).toBe('MEMORY_NOT_FOUND');
      expect(await db.agentMemoryItem.count({ where: { memoryId: doomed.id } })).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('#1357 round 7 — first-attach promotion and renames (@copilot, PR #1357)', () => {
  const ATTACH_SYS = `mutation($r: ID!, $s: String!) { updateAgent(ref: $r, systemMemoryId: $s) { id } }`;
  const RENAME_NAME = `mutation($r: ID!, $n: String!) { updateAgent(ref: $r, name: $n) { name } }`;
  const fixture = async (label: string) => {
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: attackerOrgId, name: 'Old', urn: `attacker-${suffix}:${label}` } as never });
    const brain = await db.memory.create({
      data: { id: generateId(), organizationId: attackerOrgId, urn: `attacker-${suffix}:${label}-brain`, name: 'brain', class: 'knowledge', visibility: 'ORGANIZATION' } as never,
    });
    return { agent, brain };
  };
  const inWindow = (act: () => Promise<void>) => {
    const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    let staged = false;
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (...a: unknown[]) => {
      if (!staged) { staged = true; await act(); }
      return real(...a);
    }) as never);
    return { spy, wasStaged: () => staged };
  };

  it('a rename committing inside a first-attach\'s window: the promoted memory takes the CURRENT name', async () => {
    const { agent, brain } = await fixture('promo-a');
    const { spy, wasStaged } = inWindow(async () => {
      const r = await gql(key.attacker!, RENAME_NAME, { r: agent.id, n: 'New' });
      expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    });
    try {
      const p = await gql(key.attacker!, ATTACH_SYS, { r: agent.id, s: brain.id });
      expect(wasStaged()).toBe(true);
      expect(p.errors, JSON.stringify(p.errors)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect((await db.memory.findUniqueOrThrow({ where: { id: brain.id } })).name).toBe('New System');
  });

  it('a first-attach committing inside a rename\'s window: the rename still syncs the new name', async () => {
    const { agent, brain } = await fixture('promo-b');
    const { spy, wasStaged } = inWindow(async () => {
      const p = await gql(key.attacker!, ATTACH_SYS, { r: agent.id, s: brain.id });
      expect(p.errors, JSON.stringify(p.errors)).toBeUndefined();
    });
    try {
      const r = await gql(key.attacker!, RENAME_NAME, { r: agent.id, n: 'New2' });
      expect(wasStaged()).toBe(true);
      expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect((await db.memory.findUniqueOrThrow({ where: { id: brain.id } })).name).toBe('New2 System');
  });
});

describe('#1357 round 8 — the same-App install check holds a lock (@copilot, PR #1357)', () => {
  it('an uninstall cannot commit between the install check and the grant: it waits on the lock', async () => {
    const { requireAgentMemoryGrant } = await import('../../api/graphql/schema/resolvers.helpers.js');
    const { app } = await createDbAppWithKey(db, 'lock-app', attackerOrgId);
    const memRow = await db.memory.create({
      data: { id: generateId(), organizationId: attackerOrgId, appId: app.id, urn: `attacker-${suffix}:lock-know`, name: 'lk', class: 'knowledge', visibility: 'ORGANIZATION' } as never,
    });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: attackerOrgId, name: 'lock-agent', urn: `attacker-${suffix}:lock-agent` } as never });
    await createDbAppAgent(db, app.id, agent.id);
    let uninstall = '';
    await db.$transaction(async (tx) => {
      // The real gate, on the same-App path: it takes the install-row lock.
      const role = await requireAgentMemoryGrant(
        { db: tx, userId: attackerUserId, roles: [] } as never,
        { id: agent.id, organizationId: attackerOrgId, ownerUserId: null, visibility: 'PERSONAL' },
        { id: memRow.id, class: 'knowledge', visibility: 'ORGANIZATION', userId: null, ownerUserId: null, organizationId: attackerOrgId, appId: app.id, userMemoryOfAgentId: null },
        'read',
        'lock-ref',
      );
      expect(role).toBe('read');
      // An uninstall on ANOTHER connection must block behind that lock.
      uninstall = await db.$transaction(async (t2) => {
        await t2.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
        await t2.appAgent.delete({ where: { appId_agentId: { appId: app.id, agentId: agent.id } } });
        return 'committed';
      }).then(String, (e: Error) => e.message);
    }, { timeout: 15_000 });
    expect(uninstall).toMatch(/lock timeout|canceling statement/i);
    expect(await db.appAgent.count({ where: { appId: app.id, agentId: agent.id } })).toBe(1);
  });
});
