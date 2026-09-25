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
