/**
 * #5412 (cor:acl:140:02, `memory.read`'s optional `branch` and `automation`; cor:acl:140:09, the absent-key form): what a grant with an
 * optional parameter lets an App with no person behind it read. Every per-memory case runs through the MCP gate (`canReadMemory`) AND
 * the GraphQL node set (`getAccessibleMemoryIds`), as the #5321 pins do.
 *
 * - `automation` admits only a userless run whose live root trigger is that schedule or webhook: never a key, a manual run, another
 *   automation's run, or a run of a trigger deleted since.
 * - `branch` opens PART of a memory, so a memory reached only through branch grants stays out of the per-memory reach (those gates fail
 *   closed) and is carried, with its prefixes, in the reach detail the node surfaces read.
 * - A stored optional key holding anything but one non-empty string makes the row reach nothing (a malformed restriction is never
 *   read as none); with no optional key a grant reaches exactly what an S1 grant reaches.
 *
 * Grants are ACTIVE rows written around the ceremony (`insertGrantUnguarded`), so these pins judge the READ.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { Context } from './resolvers.js';
import { getAccessibleMemoryIds } from './resolvers.helpers.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { DB_NOW, raw, insertGrantUnguarded, type World } from '../../../lib/grants/grantFixtures3668.js';
import { branchAdmitsLoc, grantReadReachDetailFor } from '../../../lib/grants/readGrant.js';
import { testRunAgentId } from '../../../test/runAgent.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const ENTRY = 'hrn:node:example.com:m:flows:entry';
let org: { id: string; urn: string };
let alice: string; // OWNER of her own organization's knowledge memory: its manager, the giver
let app: { id: string; urn: string };
let keyId: string;

const keyAuth = (appKeyId = keyId): AuthContext => ({ appId: app.id, appKeyId, roles: [], clientId: `app:${app.id}` } as AuthContext);
const runAuth = (runId: string): AuthContext => ({ appId: app.id, roles: [], clientId: `run:${runId}` } as AuthContext);

async function reachFor(auth: AuthContext, memoryId: string) {
  const mcp = await canReadMemory(db as never, auth, memoryId);
  const graphql = (await getAccessibleMemoryIds({ db, ...auth } as unknown as Context, memoryId)).includes(memoryId);
  return { mcp, graphql };
}
const NONE = { mcp: false, graphql: false };
const BOTH = { mcp: true, graphql: true };

async function alicesMemory() {
  const own = await db.organization.create({ data: { id: generateId(), name: `alice-${generateId().slice(-8)}`, urn: `alice-${generateId().slice(-8)}` } });
  await db.orgMember.create({ data: { organizationId: own.id, userId: alice, role: 'OWNER' } });
  return db.memory.create({
    data: { id: generateId(), name: 'a', urn: `${own.urn}:kb`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: own.id } as never,
  });
}
const world = (appId: string): World => ({ appId, userId: alice } as World);
async function activeGrant(values: Record<string, unknown>, issuer: string = alice) {
  return insertGrantUnguarded(world(app.id), {
    user_id: null, grantee_app_id: app.id, issuer_user_id: issuer, action: 'memory.read', action_values: values,
    activated_at: raw(DB_NOW), verification_kind: 'PASSKEY', verified_by: issuer,
  } as never);
}
async function grantScope(appKeyId: string) {
  await db.$executeRawUnsafe(`INSERT INTO app_key_scopes (id, app_key_id, scope, granted_by_user_id) VALUES ($1, $2, 'grant:read', $3)`, generateId(), appKeyId, alice);
}
const schedule = () => db.agentSchedule.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, name: 'S', cron: '* * * * *', entryNodeUrn: ENTRY } });
const webhook = () => db.agentWebhook.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, name: 'W', secret: generateId(), entryNodeUrn: ENTRY } });
const run = async (triggerKind: 'SCHEDULE' | 'WEBHOOK' | 'MANUAL' | 'SPAWN', triggerId: string | null, parentRunId: string | null = null) =>
  db.appRun.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, agentId: await testRunAgentId(db, org.id, app.id), triggerKind, triggerId, parentRunId, entryNodeUrn: ENTRY } });

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  org = (await createDbOrgAndGraph(db, { orgName: 'rg5412', graphName: 'base' })).org;
  alice = (await db.user.create({ data: { id: generateId(), handle: `alice-${generateId().slice(-6)}` } as never })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: alice, role: 'READER' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } as never });
  keyId = (await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'k1' } })).id;
  await grantScope(keyId);
});

describe('automation: only the runs of that one live trigger', () => {
  it('a run of the schedule, and a spawn under it, read; a key, a manual run and another schedule\'s run do not', async () => {
    const m = await alicesMemory();
    const s = await schedule();
    const other = await schedule();
    await activeGrant({ memory: m.id, automation: s.id });
    const root = await run('SCHEDULE', s.id);
    expect(await reachFor(runAuth(root.id), m.id)).toEqual(BOTH);
    expect(await reachFor(runAuth((await run('SPAWN', root.id, root.id)).id), m.id)).toEqual(BOTH);
    expect(await reachFor(keyAuth(), m.id)).toEqual(NONE);
    expect(await reachFor(runAuth((await run('MANUAL', null)).id), m.id)).toEqual(NONE);
    expect(await reachFor(runAuth((await run('SCHEDULE', other.id)).id), m.id)).toEqual(NONE);
    expect(await reachFor(runAuth(generateId()), m.id)).toEqual(NONE); // a run that does not exist
  });

  it('a webhook\'s runs read; once the webhook is deleted its runs read nothing (judged at every read)', async () => {
    const m = await alicesMemory();
    const h = await webhook();
    await activeGrant({ memory: m.id, automation: h.id });
    const r = await run('WEBHOOK', h.id);
    expect(await reachFor(runAuth(r.id), m.id)).toEqual(BOTH);
    await db.agentWebhook.update({ where: { id: h.id }, data: { deletedAt: new Date() } });
    expect(await reachFor(runAuth(r.id), m.id)).toEqual(NONE);
  });

  it('form (a) with an automation: the organization\'s knowledge, for that trigger\'s runs only', async () => {
    const k = await db.memory.create({ data: { id: generateId(), name: 'k', urn: `${org.urn}:k-${generateId().slice(-8)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never });
    const admin = (await db.user.create({ data: { id: generateId(), handle: `adm-${generateId().slice(-6)}` } as never })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
    const s = await schedule();
    await activeGrant({ memory: org.id, automation: s.id }, admin);
    expect(await reachFor(runAuth((await run('SCHEDULE', s.id)).id), k.id)).toEqual(BOTH);
    expect(await reachFor(keyAuth(), k.id)).toEqual(NONE);
  });
});

describe('branch: part of one memory, kept out of the per-memory gates', () => {
  it('a branch-only memory is unreadable to the per-memory gates and carried with its prefixes in the detail', async () => {
    const m = await alicesMemory();
    await activeGrant({ memory: m.id, branch: 'docs:api' });
    await activeGrant({ memory: m.id, branch: 'notes' });
    expect(await reachFor(keyAuth(), m.id)).toEqual(NONE);
    const d = await grantReadReachDetailFor(db, keyAuth());
    expect(d.whole.has(m.id)).toBe(false);
    expect(d.branches.get(m.id)).toEqual(['docs:api', 'notes']);
  });

  it('a whole-memory grant beside a branch grant reads the whole memory, and the memory leaves the branch map', async () => {
    const m = await alicesMemory();
    await activeGrant({ memory: m.id, branch: 'docs' });
    await activeGrant({ memory: m.id });
    expect(await reachFor(keyAuth(), m.id)).toEqual(BOTH);
    const d = await grantReadReachDetailFor(db, keyAuth());
    expect(d.whole.has(m.id)).toBe(true);
    expect(d.branches.has(m.id)).toBe(false);
  });

  it('branchAdmitsLoc: the prefix itself and below it on a `:` boundary, nothing else', () => {
    expect(branchAdmitsLoc(['docs:api'], 'docs:api')).toBe(true);
    expect(branchAdmitsLoc(['docs:api'], 'docs:api:v1')).toBe(true);
    expect(branchAdmitsLoc(['docs:api'], 'docs:apis')).toBe(false);
    expect(branchAdmitsLoc(['docs:api'], 'docs')).toBe(false);
    expect(branchAdmitsLoc(['docs:api'], 'other')).toBe(false);
    expect(branchAdmitsLoc(undefined, 'docs')).toBe(false);
    expect(branchAdmitsLoc([], 'docs')).toBe(false);
  });

  it('a branch with an automation: the branch only, for that trigger\'s runs only', async () => {
    const m = await alicesMemory();
    const s = await schedule();
    await activeGrant({ memory: m.id, branch: 'docs', automation: s.id });
    expect((await grantReadReachDetailFor(db, runAuth((await run('SCHEDULE', s.id)).id))).branches.get(m.id)).toEqual(['docs']);
    expect((await grantReadReachDetailFor(db, keyAuth())).branches.has(m.id)).toBe(false);
  });
});

describe('a stored row the creation door would refuse reaches nothing', () => {
  it('a present optional key holding null, "", the wildcard, a list or an object', async () => {
    const s = await schedule();
    const r = await run('SCHEDULE', s.id);
    // Grants are append-only, so each malformed row gets a memory of its own.
    for (const bad of [{ branch: null }, { branch: '' }, { branch: '*' }, { branch: ['docs'] }, { automation: null }, { automation: '' }, { automation: '*' }, { automation: [s.id] }, { automation: {} }]) {
      const m = await alicesMemory();
      await activeGrant({ memory: m.id, ...bad });
      expect({ bad, key: await reachFor(keyAuth(), m.id), run: await reachFor(runAuth(r.id), m.id) }).toEqual({ bad, key: NONE, run: NONE });
      const d = await grantReadReachDetailFor(db, keyAuth());
      expect({ bad, branches: [...d.branches.keys()] }).toEqual({ bad, branches: [] });
    }
  });

  it('a branch that is not a well-formed loc, and a key the judge does not know, make the row inert', async () => {
    const s = await schedule();
    const r = await run('SCHEDULE', s.id);
    for (const bad of [{ branch: 'bad loc' }, { branch: ':docs' }, { branch: 'docs:' }, { branch: 'a'.repeat(5000) }, { prefix: 'docs' }, { future: 'x' }, { automation: s.id, future: 'x' }]) {
      const m = await alicesMemory();
      await activeGrant({ memory: m.id, ...bad });
      expect({ bad, key: await reachFor(keyAuth(), m.id), run: await reachFor(runAuth(r.id), m.id) }).toEqual({ bad, key: NONE, run: NONE });
      expect({ bad, branches: [...(await grantReadReachDetailFor(db, keyAuth())).branches.keys()] }).toEqual({ bad, branches: [] });
    }
  });

  it('a branch beside form (a) or a list reaches nothing', async () => {
    const m = await alicesMemory();
    const admin = (await db.user.create({ data: { id: generateId(), handle: `adm-${generateId().slice(-6)}` } as never })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
    const k = await db.memory.create({ data: { id: generateId(), name: 'k', urn: `${org.urn}:k-${generateId().slice(-8)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never });
    await activeGrant({ memory: org.id, branch: 'docs' }, admin);
    await activeGrant({ memory: [m.id], branch: 'docs' });
    // Form (a) reaches runs only, so judge with a userless run (and with a key, for the list row).
    const r = runAuth((await run('MANUAL', null)).id);
    for (const auth of [r, keyAuth()]) {
      const d = await grantReadReachDetailFor(db, auth);
      expect({ whole: [...d.whole], branches: [...d.branches.keys()] }).toEqual({ whole: [], branches: [] });
      expect(await reachFor(auth, k.id)).toEqual(NONE);
      expect(await reachFor(auth, m.id)).toEqual(NONE);
    }
  });
});

describe('no optional key: exactly S1', () => {
  it('a key with grant:read and a userless run read; a key without the scope does not', async () => {
    const m = await alicesMemory();
    await activeGrant({ memory: m.id });
    expect(await reachFor(keyAuth(), m.id)).toEqual(BOTH);
    expect(await reachFor(runAuth((await run('MANUAL', null)).id), m.id)).toEqual(BOTH);
    const bare = (await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'k2' } })).id;
    expect(await reachFor(keyAuth(bare), m.id)).toEqual(NONE);
  });
});

/**
 * The security seat's requirement (c): a key only ever narrows. For every #5321 shape (one memory, a list, the organization) and
 * every key (valid, unknown or malformed), the grant WITH the key reaches no more than the same grant without it, for a key holding
 * grant:read, a run of the named schedule and a manual run: whole > part (branch) > nothing.
 */
describe('the differential, both ways: a key never widens', () => {
  it('reach(with key) <= reach(without key) for every shape, key and principal', async () => {
    const admin = (await db.user.create({ data: { id: generateId(), handle: `adm-${generateId().slice(-6)}` } as never })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
    const variant = async (shape: 'one' | 'list' | 'org', extra: (sid: string) => Record<string, unknown>) => {
      const a = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'V', urn: `${org.urn}:v-${generateId().slice(-8)}` } as never });
      const k = (await db.appKey.create({ data: { appId: a.id, keyHash: generateId(), keyPreview: 'kv' } })).id;
      await db.$executeRawUnsafe(`INSERT INTO app_key_scopes (id, app_key_id, scope, granted_by_user_id) VALUES ($1, $2, 'grant:read', $3)`, generateId(), k, alice);
      const sch = await db.agentSchedule.create({ data: { id: generateId(), organizationId: org.id, appId: a.id, name: 'S', cron: '* * * * *', entryNodeUrn: ENTRY } });
      const mkRun = async (triggerKind: 'SCHEDULE' | 'MANUAL', triggerId: string | null) =>
        (await db.appRun.create({ data: { id: generateId(), organizationId: org.id, appId: a.id, agentId: await testRunAgentId(db, org.id, a.id), triggerKind, triggerId, entryNodeUrn: ENTRY } })).id;
      const target = shape === 'org'
        ? await db.memory.create({ data: { id: generateId(), name: 'k', urn: `${org.urn}:k-${generateId().slice(-8)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never })
        : await alicesMemory();
      const memory = shape === 'one' ? target.id : shape === 'list' ? [target.id] : org.id;
      await insertGrantUnguarded(world(a.id), {
        user_id: null, grantee_app_id: a.id, issuer_user_id: shape === 'org' ? admin : alice, action: 'memory.read', action_values: { memory, ...extra(sch.id) },
        activated_at: raw(DB_NOW), verification_kind: 'PASSKEY', verified_by: shape === 'org' ? admin : alice,
      } as never);
      const auths: AuthContext[] = [
        { appId: a.id, appKeyId: k, roles: [], clientId: `app:${a.id}` } as AuthContext,
        { appId: a.id, roles: [], clientId: `run:${await mkRun('SCHEDULE', sch.id)}` } as AuthContext,
        { appId: a.id, roles: [], clientId: `run:${await mkRun('MANUAL', null)}` } as AuthContext,
      ];
      const out: number[] = [];
      for (const auth of auths) {
        const r = await reachFor(auth, target.id);
        expect(r.mcp).toBe(r.graphql);
        const d = await grantReadReachDetailFor(db, auth);
        out.push(r.mcp ? 2 : d.branches.has(target.id) ? 1 : 0);
      }
      return out;
    };
    const extras: Array<[string, (sid: string) => Record<string, unknown>]> = [
      ['branch', () => ({ branch: 'docs' })], ['automation', (sid) => ({ automation: sid })], ['both', (sid) => ({ branch: 'docs', automation: sid })],
      ['unknown', () => ({ future: 'x' })], ['bad-branch', () => ({ branch: 'bad loc' })], ['bad-automation', () => ({ automation: '' })],
      ['other-automation', () => ({ automation: generateId() })],
    ];
    let baselinePositive = 0;
    for (const shape of ['one', 'list', 'org'] as const) {
      const without = await variant(shape, () => ({}));
      baselinePositive += without.filter((x) => x > 0).length;
      for (const [label, extra] of extras) {
        const withKey = await variant(shape, extra);
        withKey.forEach((x, i) => expect({ shape, label, principal: i, narrower: x <= without[i] }).toEqual({ shape, label, principal: i, narrower: true }));
      }
    }
    expect(baselinePositive).toBeGreaterThan(0); // the control: the grants without a key do reach something
  }, 120_000);
});

