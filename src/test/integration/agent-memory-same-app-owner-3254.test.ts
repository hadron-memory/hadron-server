/**
 * #3254 (ruling 0063 A, point 4; hrn:node:hadronmemory.com:specs:cor:dmo:050:09, the same-App exception) —
 * a caller who manages the App (hrn:node:hadronmemory.com:specs:cor:dmo:050:12) may link an App-scoped
 * knowledge or group memory of that App `read` to an Agent installed in the App, even without reading the
 * memory. Before the fix, `sameAppAttachAdmitted` admitted only through `requireOwnerOrOrgRole(app, 'ADMIN')`,
 * which has no owner-role App member arm. It now asks the shared `managesApp`.
 *
 * Real HTTP, real keys. Each case states the mutation's answer and what was stored.
 *
 * The principal that reaches the new arm: an owner-role AppMember of an org-owned App who is NOT an org
 * ADMIN, managing an Agent of their own (user-owned) that is installed in the App and licensed to its org
 * (an active AgentOrgGrant). They cannot read the App's group memory (membership is MemoryMember only).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { mintUserApiKey } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

type GqlError = { message: string; extensions?: Record<string, unknown> };
type Gql = { status: number; data: Record<string, any> | null | undefined; errors: GqlError[] | undefined };

const ATTACH = `mutation($g: ID!, $m: ID!, $r: String) { addMemoryToAgent(agentRef: $g, memoryRef: $m, role: $r) { id } }`;

let server: Server;
let baseUrl: string;
let suffix: string;
let orgId: string;
let orgUrn: string;
let appX: { id: string };
let appY: { id: string };
const groupMem: { id: string; urn: string } = { id: '', urn: '' };
const knowMem: { id: string; urn: string } = { id: '', urn: '' };

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

async function mkUser(label: string, roles?: string[]) {
  const user = await db.user.create({
    data: { id: generateId(), handle: `${label}-${suffix}`, githubUsername: `${label}-${suffix}`, ...(roles ? { roles } : {}) },
  });
  const rawKey = (await mintUserApiKey(db, { userId: user.id, label: 'k', createdBy: user.id, issuedVia: 'test', oauthScopes: ['account'] })).rawKey;
  return { id: user.id, key: rawKey };
}

/** The caller's OWN Agent (user-owned), installed in `appId` and licensed to the App's org. */
async function ownAgentIn(appId: string, ownerUserId: string, label: string) {
  const agent = await db.agent.create({
    data: { id: generateId(), ownerUserId, name: label, urn: `${label}-${suffix}:agent` } as never,
  });
  await createDbAppAgent(db, appId, agent.id);
  await db.agentOrgGrant.create({ data: { orgId, agentId: agent.id, activatedAt: new Date() } });
  return agent.id;
}

/** An org-owned Agent of the App's org, installed in `appId` (same tenant: no license needed). */
async function orgAgentIn(appId: string, label: string) {
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: orgId, name: label, urn: `${orgUrn}:${label}` } as never,
  });
  await createDbAppAgent(db, appId, agent.id);
  return agent.id;
}

const linked = (agentId: string, memoryId: string) =>
  db.agentMemoryItem.findFirst({ where: { agentId, memoryId }, select: { role: true } });

beforeAll(async () => {
  await cleanDb(db);
  suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgUrn = `own3254-${suffix}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'own3254', urn: orgUrn } });
  orgId = org.id;
  ({ app: appX } = await createDbAppWithKey(db, 'x3254', orgId));
  ({ app: appY } = await createDbAppWithKey(db, 'y3254', orgId));
  const g = await db.memory.create({
    data: { id: generateId(), organizationId: orgId, appId: appX.id, urn: `${orgUrn}:xgroup`, name: 'xgroup', class: 'group', visibility: 'GROUP' } as never,
  });
  groupMem.id = g.id; groupMem.urn = `hrn:mem:${orgUrn}:xgroup`;
  const k = await db.memory.create({
    data: { id: generateId(), organizationId: orgId, appId: appX.id, urn: `${orgUrn}:xknow`, name: 'xknow', class: 'knowledge', visibility: 'ORGANIZATION' } as never,
  });
  knowMem.id = k.id; knowMem.urn = `hrn:mem:${orgUrn}:xknow`;
  const app = await createServer();
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('#3254 — an owner-role App member manages the App for the same-App link', () => {
  it('links the App group memory read to their Agent installed in the App', async () => {
    const owner = await mkUser('ownr-group');
    await createDbAppMember(db, appX.id, owner.id, 'owner');
    const agentId = await ownAgentIn(appX.id, owner.id, 'ownr-group');
    const r = await gql(owner.key, ATTACH, { g: agentId, m: groupMem.urn, r: 'read' });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(await linked(agentId, groupMem.id)).toEqual({ role: 'read' });
  });

  it('links App-scoped knowledge read the same way', async () => {
    const owner = await mkUser('ownr-know');
    await createDbAppMember(db, appX.id, owner.id, 'owner');
    const agentId = await ownAgentIn(appX.id, owner.id, 'ownr-know');
    const r = await gql(owner.key, ATTACH, { g: agentId, m: knowMem.urn, r: 'read' });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(await linked(agentId, knowMem.id)).toEqual({ role: 'read' });
  });

  it('read-write is refused for the same caller, and nothing is stored', async () => {
    const owner = await mkUser('ownr-rw');
    await createDbAppMember(db, appX.id, owner.id, 'owner');
    const agentId = await ownAgentIn(appX.id, owner.id, 'ownr-rw');
    const r = await gql(owner.key, ATTACH, { g: agentId, m: groupMem.urn, r: 'read-write' });
    expect(r.errors).toBeDefined();
    expect(['MEMORY_NOT_FOUND', 'FORBIDDEN']).toContain(code(r));
    expect(await linked(agentId, groupMem.id)).toBeNull();
  });
});

describe('#3254 — who does not manage the App is still refused, as a missing memory', () => {
  it('a plain (non-owner-role) App member', async () => {
    const plain = await mkUser('plain');
    await createDbAppMember(db, appX.id, plain.id, 'member');
    const agentId = await ownAgentIn(appX.id, plain.id, 'plain');
    const r = await gql(plain.key, ATTACH, { g: agentId, m: groupMem.urn, r: 'read' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await linked(agentId, groupMem.id)).toBeNull();
  });

  it('a removed owner-role member (AppMember has no deletedAt: revocation deletes the row)', async () => {
    const gone = await mkUser('removed');
    await createDbAppMember(db, appX.id, gone.id, 'owner');
    const agentId = await ownAgentIn(appX.id, gone.id, 'removed');
    await db.appMember.delete({ where: { appId_userId: { appId: appX.id, userId: gone.id } } });
    const r = await gql(gone.key, ATTACH, { g: agentId, m: groupMem.urn, r: 'read' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await linked(agentId, groupMem.id)).toBeNull();
  });

  it('a demoted owner-role member', async () => {
    const demoted = await mkUser('demoted');
    await createDbAppMember(db, appX.id, demoted.id, 'owner');
    const agentId = await ownAgentIn(appX.id, demoted.id, 'demoted');
    await db.appMember.update({ where: { appId_userId: { appId: appX.id, userId: demoted.id } }, data: { role: 'member' } });
    const r = await gql(demoted.key, ATTACH, { g: agentId, m: groupMem.urn, r: 'read' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await linked(agentId, groupMem.id)).toBeNull();
  });

  it("an owner-role member of ANOTHER App of the same org, with the Agent installed in the memory's App", async () => {
    const other = await mkUser('other-app');
    await createDbAppMember(db, appY.id, other.id, 'owner');
    const agentId = await ownAgentIn(appX.id, other.id, 'other-app');
    const r = await gql(other.key, ATTACH, { g: agentId, m: groupMem.urn, r: 'read' });
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await linked(agentId, groupMem.id)).toBeNull();
  });
});

describe('#3254 — parity: everyone the old App gate admitted is still admitted (gate note 1)', () => {
  for (const role of ['ADMIN', 'OWNER'] as const) {
    it(`an org ${role} who is not an App member`, async () => {
      const admin = await mkUser(`org-${role.toLowerCase()}`);
      await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role } });
      const agentId = await orgAgentIn(appX.id, `org-${role.toLowerCase()}-agent`);
      const r = await gql(admin.key, ATTACH, { g: agentId, m: groupMem.urn, r: 'read' });
      expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
      expect(await linked(agentId, groupMem.id)).toEqual({ role: 'read' });
    });
  }

  it('a platform ADMIN, read only', async () => {
    const admin = await mkUser('platform', ['ADMIN']);
    const agentId = await orgAgentIn(appX.id, 'platform-agent');
    const r = await gql(admin.key, ATTACH, { g: agentId, m: groupMem.urn, r: 'read' });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(await linked(agentId, groupMem.id)).toEqual({ role: 'read' });
  });
});

describe('#3254 — the deciding membership is held through the link', () => {
  it('a removal holding the member row makes the link wait, and the link then sees the removal', async () => {
    const owner = await mkUser('race');
    await createDbAppMember(db, appX.id, owner.id, 'owner');
    const agentId = await ownAgentIn(appX.id, owner.id, 'race');
    let release!: () => void; let ready!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { ready = r; });
    // The removal's shape (removeAppMember holds the row FOR UPDATE, then deletes it).
    const removing = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${appX.id} AND user_id = ${owner.id} FOR UPDATE`;
      ready();
      await held;
      await tx.appMember.delete({ where: { appId_userId: { appId: appX.id, userId: owner.id } } });
    }, { timeout: 30000 });
    await started;
    let finished = false;
    const linking = gql(owner.key, ATTACH, { g: agentId, m: groupMem.urn, r: 'read' }).finally(() => { finished = true; });
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        const rows = await db.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ~ 'app_members.*FOR SHARE'`;
        if (Number(rows[0]?.n ?? 0) > 0) break;
        if (finished) throw new Error('the link decided without waiting on the held membership row');
        if (Date.now() > deadline) throw new Error('the link never waited on the membership row');
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      release();
      await removing;
    }
    const r = await linking;
    expect(code(r)).toBe('MEMORY_NOT_FOUND');
    expect(await linked(agentId, groupMem.id)).toBeNull();
  });
});
