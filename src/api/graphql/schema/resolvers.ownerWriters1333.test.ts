/**
 * #1333 — `NodeRoleRule.writers = OWNER` (cor:acl:010:03), built on the #1331 authorization layer.
 *
 * OWNER audience for a memory owned by org X: the owning-party people (contributors and above in X, platform admins,
 * through the ONE shared predicate `requireMemoryManageAccess`) plus an App PUBLISHED by X: an active App
 * (`uninstalledAt IS NULL`) with an `AppAgent` row whose Agent is not deleted and has `organizationId = X` (Vera's
 * ruling A, Holger via Fiona 2026-10-27; no schema change). A user-owned memory: `Agent.ownerUserId` = the owning
 * user. Evaluated at write time on live rows. A headless run is the App service identity (D23): the triggering user's
 * own standing never counts, only the App's. OWNER is never read as ALL. Memory write access stays necessary.
 *
 * The recorded consequence (issue body, Vera's items 3-4): a non-member who can drive an owning-org-published App
 * writes at owner level through it. Interactive human-through-App identity is out of scope: a principal with a
 * userId and no run client keeps the person's own standing (established behavior), never the App's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { roleWritersRefusal, appCarriesOwnersAgent, assertRoleWritersForNodes } from '../../../lib/nodeRoleWriters.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { makeProdRunDeps, runContext } from '../../../jobs/appRunDeps.js';
import { testRunAgentId } from '../../../test/runAgent.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const UNSUPPORTED = 'ROLE_WRITERS_UNSUPPORTED';
const REFUSED = 'ROLE_WRITER_LEVEL_REQUIRED';

let n: number;
let org: { id: string; urn: string };
let vendorOrg: { id: string; urn: string };
let memoryId: string;
const user: Record<string, string> = {};

const as = (who: string, roles: Context['roles'] = []): Context => ({ db, userId: user[who], roles, clientId: `user:${user[who]}` });
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return 'OK'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
}
async function rule(mem: string, role: string, writers: 'ALL' | 'ADMIN' | 'OWNER') {
  const config = (await db.memoryConfig.findUnique({ where: { memoryId: mem } }))
    ?? await db.memoryConfig.create({ data: { id: generateId(), memoryId: mem } });
  return db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role, writers } });
}
const create = (ctx: Context, loc: string, mem = memoryId) =>
  resolvers.Mutation.createNode(null, { input: { memoryId: mem, loc, name: loc, content: 'x', role: 'vault' } }, ctx);
const exists = async (loc: string, mem = memoryId) => (await db.node.count({ where: { memoryId: mem, loc } })) > 0;

async function agent(orgId: string | null, ownerUserId: string | null, extra: Record<string, unknown> = {}) {
  const id = generateId();
  return (await db.agent.create({
    data: { id, name: `a-${id}`, urn: `ag-${id}`.toLowerCase(), organizationId: orgId, ownerUserId, ...extra },
  })).id;
}
async function app(opts: { orgId?: string | null; ownerUserId?: string | null; agents?: string[]; uninstalled?: boolean }) {
  const id = generateId();
  await db.app.create({
    data: {
      id, name: `app-${id}`, urn: `app-${id}`.toLowerCase(),
      organizationId: opts.orgId ?? null, ownerUserId: opts.ownerUserId ?? null,
      uninstalledAt: opts.uninstalled ? new Date() : null,
    },
  });
  for (const agentId of opts.agents ?? []) await db.appAgent.create({ data: { appId: id, agentId } });
  return id;
}
const principalOf = (appId: string, extra: Record<string, unknown> = {}) =>
  ({ ...runAuthContext({ id: generateId(), appId, userId: null, organizationId: org.id }), ...extra }) as never;
const refusal = async (p: never, mem = memoryId) =>
  (await roleWritersRefusal(db, p, mem, { priorRole: null, nextRole: 'vault' }))?.extensions.code ?? null;

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Owner', urn: `own1333-${n}` }, select: { id: true, urn: true } });
  vendorOrg = await db.organization.create({ data: { name: 'Vendor', urn: `vend1333-${n}` }, select: { id: true, urn: true } });
  for (const who of ['owner', 'admin', 'contrib', 'reader', 'outsider', 'platform', 'grantee']) {
    user[who] = (await db.user.create({
      data: { handle: `o1333-${who}-${n}`, roles: who === 'platform' ? ['ADMIN'] : ['READER'] },
    })).id;
  }
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: user.owner!, role: 'OWNER' },
    { organizationId: org.id, userId: user.admin!, role: 'ADMIN' },
    { organizationId: org.id, userId: user.contrib!, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: user.reader!, role: 'READER' },
  ] });
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mem', class: 'knowledge' },
  })).id;
  await rule(memoryId, 'vault', 'OWNER');
});

describe('people: the owning party writes, OWNER is never read as ALL', () => {
  it('org OWNER, ADMIN, CONTRIBUTOR and a platform admin write; a reader, an outsider and a share grantee do not', async () => {
    expect(await code(create(as('owner'), 'v1'))).toBe('OK');
    expect(await code(create(as('admin'), 'v2'))).toBe('OK');
    expect(await code(create(as('contrib'), 'v3'))).toBe('OK');
    expect(await code(create(as('platform', ['ADMIN']), 'v4'))).toBe('OK');
    await db.memoryShare.create({ data: { memoryId, granteeId: user.grantee!, grantorId: user.owner!, role: 'writer' as never } });
    for (const who of ['reader', 'outsider', 'grantee']) {
      const c = await code(create(as(who), `x-${who}`));
      expect(c, who).not.toBe('OK');
      expect(await exists(`x-${who}`)).toBe(false);
    }
  });

  it('a revoked (soft-deleted) membership does not qualify', async () => {
    expect(await code(create(as('contrib'), 'live'))).toBe('OK');
    await db.orgMember.updateMany({ where: { userId: user.contrib! }, data: { deletedAt: new Date() } });
    expect(await code(create(as('contrib'), 'gone'))).not.toBe('OK');
    expect(await exists('gone')).toBe(false);
  });

  it('the level check itself refuses a principal outside the audience with the writer-level code, not UNSUPPORTED', async () => {
    const p = { userId: user.reader!, roles: [] as never, clientId: 'x' } as never;
    expect(await refusal(p)).toBe(REFUSED);
  });
});

describe('the refusal is the OWNER writer level, not the base write gate (blind review F1)', () => {
  it('a share grantee never reaches the level on an org memory: the base gate answers first, and the level itself excludes them', async () => {
    await db.memoryShare.create({ data: { memoryId, granteeId: user.grantee!, grantorId: user.owner!, role: 'writer' as never } });
    // The base gate (memory visibility and write access) refuses the grantee of an org memory before any level is read.
    expect(await code(resolvers.Mutation.createNode(null, { input: { memoryId, loc: 'ctl', name: 'ctl', content: 'x' } }, as('grantee'))))
      .toBe('MEMORY_NOT_FOUND: ' + memoryId);
    // So the level is pinned where it is judged: the grantee is outside the OWNER audience.
    expect(await refusal({ userId: user.grantee!, roles: [], clientId: `user:${user.grantee}` } as never)).toBe(REFUSED);
  });

  it('a contributor passes the base gate and is inside the OWNER audience (positive control)', async () => {
    // Positive control for the base gate, then the level: a contributor writes the ungoverned node AND the OWNER one.
    expect(await code(resolvers.Mutation.createNode(null, { input: { memoryId, loc: 'plain', name: 'plain', content: 'x' } }, as('contrib')))).toBe('OK');
    expect(await code(create(as('contrib'), 'owned'))).toBe('OK');
  });

  it('an outsider, a reader and a grantee are all outside the OWNER audience at the level itself', async () => {
    for (const who of ['reader', 'outsider', 'grantee']) {
      expect(await refusal({ userId: user[who]!, roles: [], clientId: `user:${user[who]}` } as never), who).toBe(REFUSED);
    }
  });
});

describe('Apps: published by the owning org vs merely installed', () => {
  it('publisher: an active App holding an agent of the owning org qualifies; the run writes through the real door', async () => {
    const own = await agent(org.id, null);
    const a = await app({ orgId: vendorOrg.id, agents: [own] });
    expect(await refusal(principalOf(a))).toBeNull();
  });

  it('installer: an App the owner owns but that only carries a vendor agent does not qualify', async () => {
    const vendor = await agent(vendorOrg.id, null);
    const a = await app({ orgId: org.id, agents: [vendor] });
    expect(await refusal(principalOf(a))).toBe(REFUSED);
  });

  it('multi-agent mix: one owning-org agent among vendor agents qualifies (accepted consequence)', async () => {
    const a = await app({ orgId: vendorOrg.id, agents: [await agent(vendorOrg.id, null), await agent(org.id, null)] });
    expect(await refusal(principalOf(a))).toBeNull();
  });

  it('an App with no agents does not qualify', async () => {
    expect(await refusal(principalOf(await app({ orgId: org.id })))).toBe(REFUSED);
  });

  it('an uninstalled App never qualifies, at write time on live rows', async () => {
    const a = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    const p = principalOf(a);
    expect(await refusal(p)).toBeNull();
    await db.app.update({ where: { id: a }, data: { uninstalledAt: new Date() } });
    expect(await refusal(p)).toBe(REFUSED);
  });

  it('a deleted Agent does not count, taking effect on the next write', async () => {
    const own = await agent(org.id, null);
    const a = await app({ orgId: org.id, agents: [own] });
    const p = principalOf(a);
    expect(await refusal(p)).toBeNull();
    await db.agent.update({ where: { id: own }, data: { deletedAt: new Date() } });
    expect(await refusal(p)).toBe(REFUSED);
  });

  it('a soft-deleted App never qualifies', async () => {
    const a = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    await db.app.update({ where: { id: a }, data: { deletedAt: new Date() } });
    expect(await refusal(principalOf(a))).toBe(REFUSED);
  });

  it('an unknown appId never qualifies', async () => {
    expect(await refusal(principalOf(generateId()))).toBe(REFUSED);
  });
});

describe('headless identity (D23): the App service identity, not the triggering user', () => {
  it('an external, non-member driver through an owning-org-published App writes at owner level (recorded consequence)', async () => {
    const a = await app({ orgId: vendorOrg.id, agents: [await agent(org.id, null)] });
    const p = principalOf(a, { userId: user.outsider! });
    expect(await refusal(p)).toBeNull();
  });

  it('an org OWNER triggering a run of an App that only carries a vendor agent does NOT write at owner level', async () => {
    const a = await app({ orgId: org.id, agents: [await agent(vendorOrg.id, null)] });
    const p = principalOf(a, { userId: user.owner! });
    expect(await refusal(p)).toBe(REFUSED);
  });

  it('a pure App key (no user, no run client) is judged as its App', async () => {
    const own = await agent(org.id, null);
    const yes = await app({ orgId: org.id, agents: [own] });
    const no = await app({ orgId: org.id, agents: [await agent(vendorOrg.id, null)] });
    expect(await refusal({ appId: yes, roles: [], clientId: 'app:k' } as never)).toBeNull();
    expect(await refusal({ appId: no, roles: [], clientId: 'app:k' } as never)).toBe(REFUSED);
  });

  it('interactive person-through-App (userId, no run client) keeps the person\'s own standing, never the App\'s', async () => {
    const publisher = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    const vendorApp = await app({ orgId: org.id, agents: [await agent(vendorOrg.id, null)] });
    // A non-member through the owning org's own App: the App does not lift the person.
    expect(await refusal({ userId: user.outsider!, appId: publisher, roles: [], clientId: `user:${user.outsider}` } as never)).toBe(REFUSED);
    // A contributor through a vendor-only App keeps the contributor's own standing.
    expect(await refusal({ userId: user.contrib!, appId: vendorApp, roles: [], clientId: `user:${user.contrib}` } as never)).toBeNull();
  });
});

describe('user-owned memory: Agent.ownerUserId is the owning user', () => {
  let ownedMemory: string;
  beforeEach(async () => {
    ownedMemory = (await db.memory.create({
      data: { id: generateId(), ownerUserId: user.contrib!, urn: `o1333-${n}:mem`, name: 'own', class: 'knowledge' },
    })).id;
    await rule(ownedMemory, 'vault', 'OWNER');
  });

  it('an App with the owning user\'s agent qualifies; an org agent or another user\'s agent does not', async () => {
    const mine = await app({ ownerUserId: user.contrib!, agents: [await agent(null, user.contrib!)] });
    const orgs = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    const others = await app({ ownerUserId: user.outsider!, agents: [await agent(null, user.outsider!)] });
    expect(await refusal(principalOf(mine), ownedMemory)).toBeNull();
    expect(await refusal(principalOf(orgs), ownedMemory)).toBe(REFUSED);
    expect(await refusal(principalOf(others), ownedMemory)).toBe(REFUSED);
  });

  it('the owning user writes; another user does not', async () => {
    expect(await code(create(as('contrib'), 'u1', ownedMemory))).toBe('OK');
    expect(await code(create(as('outsider'), 'u2', ownedMemory))).not.toBe('OK');
    expect(await exists('u2', ownedMemory)).toBe(false);
  });
});

describe('the old fail-closed refusal is gone for OWNER, kept for an unknown level', () => {
  it('an OWNER rule no longer answers ROLE_WRITERS_UNSUPPORTED', async () => {
    expect(await code(create(as('contrib'), 'v9'))).not.toBe(UNSUPPORTED);
  });
});

describe('the write doors: generic GraphQL, MCP and the run tool path share the one check', () => {
  /**
   * The driver is a platform admin, so memory write access (necessary, never widened) is not what decides: the run
   * is judged as its App and the driver's own standing must not lift a vendor-only App (D23).
   */
  const appWithWriteAccess = (agentOrgId: string, appOrgId: string) => app({ orgId: appOrgId, agents: [] }).then(async (a) => {
    await db.appAgent.create({ data: { appId: a, agentId: await agent(agentOrgId, null) } });
    return a;
  });
  const driver = (a: string) => principalOf(a, { userId: user.platform!, roles: ['ADMIN'], db }) as Context;
  const mcpCreate = (p: Record<string, unknown>, loc: string) =>
    createTestableMcpServer(p as never).callToolText('hadron_create_node', {
      urn: `hrn:node:${org.urn}:mem:${loc}`, name: loc, content: 'x', role: 'vault',
    });

  it('GraphQL createNode: a headless run of the publisher App writes, a run of an installed vendor App is refused', async () => {
    const pub = await appWithWriteAccess(org.id, vendorOrg.id);
    const ven = await appWithWriteAccess(vendorOrg.id, org.id);
    expect(await code(create(driver(pub), 'run-ok'))).toBe('OK');
    expect(await code(create(driver(ven), 'run-no'))).toBe(REFUSED);
    expect(await exists('run-ok')).toBe(true);
    expect(await exists('run-no')).toBe(false);
  });

  it('MCP hadron_create_node: the same split, and the refusal is the typed writer-level text', async () => {
    const pub = await appWithWriteAccess(org.id, vendorOrg.id);
    const ven = await appWithWriteAccess(vendorOrg.id, org.id);
    expect(await mcpCreate(driver(ven) as never, 'm-no')).toContain('[role_writer_level_required]');
    expect(await exists('m-no')).toBe(false);
    expect(await mcpCreate(driver(pub) as never, 'm-ok')).not.toContain('role_writer');
    expect(await exists('m-ok')).toBe(true);
  });

  it('MCP, a person: a contributor writes and a reader is refused (OWNER is not ALL)', async () => {
    const mcpAs = (who: string) => createTestableMcpServer({ userId: user[who]!, roles: [] as never, clientId: `user:${user[who]}` });
    expect(await mcpAs('contrib').callToolText('hadron_create_node', { urn: `hrn:node:${org.urn}:mem:mc`, name: 'mc', content: 'x', role: 'vault' }))
      .not.toContain('role_writer');
    expect(await mcpAs('reader').callToolText('hadron_create_node', { urn: `hrn:node:${org.urn}:mem:mr`, name: 'mr', content: 'x', role: 'vault' }))
      .not.toContain('role_writers_unsupported');
    expect(await exists('mr')).toBe(false);
  });
});

describe('the real run principal: runContext, not a synthesized one (blind review F2)', () => {
  /** A userless run of `appId` with the principal `runContext` builds, optionally holding the write grant on `vault`. */
  async function runOf(appId: string, grant: boolean) {
    if (grant) await db.appMemoryWriteGrant.create({ data: { appId, memoryId, prefix: 'vault', grantedBy: user.owner! } });
    const run = await db.appRun.create({
      data: {
        id: generateId(), organizationId: org.id, appId, agentId: await testRunAgentId(db, org.id, appId), triggerKind: 'MANUAL',
        entryNodeUrn: `${org.urn}:mem:flow:entry`, status: 'RUNNING',
      },
    });
    return { run, principal: runContext(db, run) };
  }
  it('GraphQL createNode under runContext: a qualifying App holding the grant writes the OWNER role; an installed vendor-only App is refused the level', async () => {
    const publisher = await runOf(await app({ orgId: org.id, agents: [await agent(org.id, null)] }), true);
    const installer = await runOf(await app({ orgId: org.id, agents: [await agent(vendorOrg.id, null)] }), true);
    expect(await code(create(publisher.principal, 'vault:pub'))).toBe('OK');
    expect(await code(create(installer.principal, 'vault:ins'))).toBe(REFUSED);
    expect(await exists('vault:pub')).toBe(true);
    expect(await exists('vault:ins')).toBe(false);
  });

  it('a qualifying App with no write access on the memory fails the base gate and never reaches the level', async () => {
    const publisher = await runOf(await app({ orgId: org.id, agents: [await agent(org.id, null)] }), false);
    const refused = await code(create(publisher.principal, 'vault:nogrant'));
    expect(refused).not.toBe('OK');
    expect(refused).not.toBe(REFUSED);
    expect(await exists('vault:nogrant')).toBe(false);
  });
});

describe('the App, its AppAgent link and its Agent are held while the write decides (blind review F5, section-10 delta)', () => {
  const owner = () => ({ organizationId: org.id, ownerUserId: null });
  // The timer is cleared when the work settles (#4664), so none outlives the helper.
  const within = async <T>(p: Promise<T>, ms: number): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`not reached within ${ms}ms`)), ms); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * A write transaction that judges `appId` qualified and then sits on its locks. `start` begins the competing change;
   * it must be observed WAITING on a lock (not merely slow) before the write is released. Every path releases the gate
   * and drains both operations in `finally`, so a failed assertion cannot leave a transaction holding its locks.
   */
  async function raceHeldJudgement(appId: string, start: () => Promise<unknown>): Promise<void> {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let judged!: () => void;
    const judgedFirst = new Promise<void>((res) => { judged = res; });
    const writing = db.$transaction(async (tx) => {
      expect(await appCarriesOwnersAgent(tx as never, appId, owner())).toBe(true);
      judged();
      await gate;
    }, { timeout: 8_000 });
    let settled = false;
    let op: Promise<unknown> | undefined;
    let lockWait: Promise<unknown> | undefined;
    let failure: unknown;
    try {
      // Readiness races the transaction itself, so a transaction that fails before judging surfaces at once, not by timeout.
      await within(Promise.race([judgedFirst, writing.then(() => { throw new Error('write ended before judging'); })]), 5_000);
      op = start().then(() => { settled = true; });
      // The change itself is raced against the lock-wait: a database error from it surfaces as ITSELF at once, and a
      // change that finishes without ever waiting is a failure. The observer is attached now so a fast rejection is never unhandled.
      const early = op.then(() => { throw new Error('the competing change finished without waiting on the held lock'); });
      early.catch(() => undefined);
      lockWait = waitForLockWaiters(db, 1, 3_000);
      lockWait.catch(() => undefined);
      await Promise.race([lockWait, early]);
      expect(settled).toBe(false);
    } catch (e) {
      failure = e;
    } finally {
      release();
      // Drain both operations whatever happened, then rethrow the FIRST failure, never a later cleanup one.
      // The lock-wait poll is drained too (bounded at 3 s), so no check outlives the helper into the next invocation.
      const done = await Promise.allSettled([writing, ...(op ? [op] : []), ...(lockWait ? [lockWait] : [])]);
      if (failure === undefined) {
        const bad = done.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        if (bad) failure = bad.reason;
      }
    }
    if (failure !== undefined) throw failure;
  }

  /**
   * The reverse order (#4664): a change that already holds its locks BEFORE the judgement starts. `change` runs in its own
   * transaction and stays open until released; the judgement is started then, must be observed WAITING on a lock (not merely
   * slow), and once the change commits it must see the committed state and answer `expected`. Every path releases the
   * change and drains both operations in `finally`.
   */
  async function judgeBehindHeldChange(
    appId: string, change: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>, expected: boolean,
  ): Promise<void> {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let changed!: () => void;
    const changedFirst = new Promise<void>((res) => { changed = res; });
    const changing = db.$transaction(async (tx) => {
      await change(tx);
      changed();
      await gate;
    }, { timeout: 8_000 });
    let judging: Promise<boolean> | undefined;
    let lockWait: Promise<unknown> | undefined;
    let settled = false;
    let failure: unknown;
    try {
      await within(Promise.race([changedFirst, changing.then(() => { throw new Error('change ended before holding'); })]), 5_000);
      judging = db.$transaction((tx) => appCarriesOwnersAgent(tx as never, appId, owner()), { timeout: 8_000 })
        .then((v) => { settled = true; return v; });
      const early = judging.then(() => { throw new Error('the judgement finished without waiting behind the held change'); });
      early.catch(() => undefined);
      lockWait = waitForLockWaiters(db, 1, 3_000);
      lockWait.catch(() => undefined);
      await Promise.race([lockWait, early]);
      expect(settled).toBe(false);
    } catch (e) {
      failure = e;
    } finally {
      release();
      const done = await Promise.allSettled([changing, ...(judging ? [judging] : []), ...(lockWait ? [lockWait] : [])]);
      if (failure === undefined) {
        const bad = done.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        if (bad) failure = bad.reason;
      }
    }
    if (failure !== undefined) throw failure;
    expect(await judging).toBe(expected);
  }

  it('an AppAgent unlink that holds first makes the judgement wait, then see no link and refuse (unlink-first, #4664)', async () => {
    const own = await agent(org.id, null);
    const a = await app({ orgId: org.id, agents: [own] });
    await judgeBehindHeldChange(a, (tx) => tx.appAgent.delete({ where: { appId_agentId: { appId: a, agentId: own } } }), false);
    expect(await refusal(principalOf(a))).toBe(REFUSED);
  }, 30_000);

  it('an App uninstall that holds first makes the judgement wait, then see the uninstall and refuse (unlink-first, #4664)', async () => {
    const a = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    await judgeBehindHeldChange(a, (tx) => tx.app.update({ where: { id: a }, data: { uninstalledAt: new Date() } }), false);
    expect(await refusal(principalOf(a))).toBe(REFUSED);
  }, 30_000);

  it('an Agent deletion that holds first makes the judgement wait, then see the deleted Agent and refuse (unlink-first, #4664)', async () => {
    const own = await agent(org.id, null);
    const a = await app({ orgId: org.id, agents: [own] });
    await judgeBehindHeldChange(a, (tx) => tx.agent.update({ where: { id: own }, data: { deletedAt: new Date() } }), false);
    expect(await refusal(principalOf(a))).toBe(REFUSED);
  }, 30_000);

  it('positive control: an unrelated App edit that holds first also makes the judgement wait, and the judgement then still qualifies (control, #4664)', async () => {
    const a = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    await judgeBehindHeldChange(a, (tx) => tx.app.update({ where: { id: a }, data: { name: 'held-edit' } }), true);
    expect(await refusal(principalOf(a))).toBeNull();
  }, 30_000);

  it('the race helper surfaces a fast failure of the competing change as itself, and rejects a change that never waited', async () => {
    const a = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    await expect(raceHeldJudgement(a, () => Promise.reject(new Error('boom from the competing change')))).rejects.toThrow('boom from the competing change');
    await expect(raceHeldJudgement(a, () => Promise.resolve())).rejects.toThrow('finished without waiting');
    // Nothing is left holding a lock: an ordinary change goes straight through afterwards.
    await db.app.update({ where: { id: a }, data: { name: 'after-the-helper' } });
  }, 30_000);

  it('an uninstall waits for a write that already judged the App qualified, then the next write is refused', async () => {
    const a = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    await raceHeldJudgement(a, () => db.app.update({ where: { id: a }, data: { uninstalledAt: new Date() } }));
    expect(await refusal(principalOf(a))).toBe(REFUSED);
  }, 30_000);

  it('an AppAgent unlink waits for a write that already judged the App qualified', async () => {
    const own = await agent(org.id, null);
    const a = await app({ orgId: org.id, agents: [own] });
    await raceHeldJudgement(a, () => db.appAgent.delete({ where: { appId_agentId: { appId: a, agentId: own } } }));
    expect(await refusal(principalOf(a))).toBe(REFUSED);
  }, 30_000);

  it('an Agent deletion waits for a write that already judged the App qualified', async () => {
    const own = await agent(org.id, null);
    const a = await app({ orgId: org.id, agents: [own] });
    await raceHeldJudgement(a, () => db.agent.update({ where: { id: own }, data: { deletedAt: new Date() } }));
    expect(await refusal(principalOf(a))).toBe(REFUSED);
  }, 30_000);
});

describe('the live headless path: hadron_update_node under the real run principal (Peter, #125592)', () => {
  const ENTRY = () => `${org.urn}:mem:flow:entry`;

  /** The App's own team space (class app) with an OWNER-role rule: the one org memory a userless run reads by itself. */
  async function teamSpace(appId: string, loc: string) {
    const mem = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, appId, urn: `${org.urn}:team-${appId}`.toLowerCase(), name: 'team', class: 'app' },
    });
    await rule(mem.id, 'vault', 'OWNER');
    await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc, name: loc, content: 'before', role: 'vault' } });
    return mem;
  }

  /** A userless SCHEDULE run of `runApp`, with the write grant on `vault`, editing `loc` in `target`'s team space. */
  async function liveRun(runApp: string, target: { id: string; urn: string }, loc: string, grant = true): Promise<{ code: string; message: string }> {
    if (grant) await db.appMemoryWriteGrant.create({ data: { appId: runApp, memoryId: target.id, prefix: 'vault', grantedBy: user.owner! } });
    const schedule = await db.agentSchedule.create({
      data: { id: generateId(), organizationId: org.id, appId: runApp, name: 'S', cron: '* * * * *', entryNodeUrn: ENTRY() },
    });
    const run = await db.appRun.create({
      data: {
        id: generateId(), organizationId: org.id, appId: runApp, agentId: await testRunAgentId(db, org.id, runApp),
        triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: ENTRY(), status: 'RUNNING',
      },
    });
    // The production dispatch of a script node's declared tool call (no model needed): callScript -> admitAndExecuteTool.
    try {
      await makeProdRunDeps(db).callScript!(run as never, {
        tool: 'hadron_update_node', args: { urn: `hrn:node:${target.urn}:${loc}`, content: 'after' },
      } as never, { onToolCall: async () => true, log: vi.fn(), nodeUrn: ENTRY() } as never);
      return { code: 'OK', message: '' };
    } catch (e) {
      // admitAndExecuteTool wraps a handler's refusal as ToolExecutionError; the typed code rides its cause.
      const inner = ((e as { cause?: unknown }).cause ?? e) as { extensions?: { code?: unknown }; message?: string };
      return { code: inner.extensions?.code ? String(inner.extensions.code) : String(inner.message), message: String(inner.message) };
    }
  }
  /** The same dispatch for a READ of the node, as the control that the principal can read the target. */
  async function readRun(runApp: string, target: { id: string; urn: string }, loc: string) {
    const schedule = await db.agentSchedule.create({
      data: { id: generateId(), organizationId: org.id, appId: runApp, name: 'R', cron: '* * * * *', entryNodeUrn: ENTRY() },
    });
    const run = await db.appRun.create({
      data: {
        id: generateId(), organizationId: org.id, appId: runApp, agentId: await testRunAgentId(db, org.id, runApp),
        triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: ENTRY(), status: 'RUNNING',
      },
    });
    try {
      await makeProdRunDeps(db).callScript!(run as never, { tool: 'hadron_read_node', args: { urn: `hrn:node:${target.urn}:${loc}` } } as never,
        { onToolCall: async () => true, log: vi.fn(), nodeUrn: ENTRY() } as never);
      return 'OK';
    } catch (e) {
      const inner = ((e as { cause?: unknown }).cause ?? e) as { message?: string };
      return String(inner.message);
    }
  }
  const content = async (memId: string, loc: string) => (await db.node.findFirst({ where: { memoryId: memId, loc } }))!.content;

  it('publisher: a userless run edits an OWNER-role node in its own team space through the real tool', async () => {
    const publisher = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    const space = await teamSpace(publisher, 'vault:pub');
    expect((await liveRun(publisher, space, 'vault:pub')).code).toBe('OK');
    expect(await content(space.id, 'vault:pub')).toBe('after');
  });

  it('installer: a run whose App only carries a vendor agent is refused the level and the node is unchanged', async () => {
    const installer = await app({ orgId: org.id, agents: [await agent(vendorOrg.id, null)] });
    const space = await teamSpace(installer, 'vault:ins');
    expect((await liveRun(installer, space, 'vault:ins')).code).toBe(REFUSED);
    expect(await content(space.id, 'vault:ins')).toBe('before');
  });

  it('the same installer run passes the base gate for an ordinary node and is refused only the OWNER-role one (state unchanged)', async () => {
    const installer = await app({ orgId: org.id, agents: [await agent(vendorOrg.id, null)] });
    const space = await teamSpace(installer, 'vault:keep');
    await db.node.create({ data: { id: generateId(), memoryId: space.id, loc: 'vault:plain', name: 'note', content: 'before' } });
    // Control: the base write gate admits this run on an ungoverned node.
    expect((await liveRun(installer, space, 'vault:plain')).code).toBe('OK');
    expect(await content(space.id, 'vault:plain')).toBe('after');
    // The same run, same grant, same memory: the OWNER-role node is refused by the level alone.
    expect((await liveRun(installer, space, 'vault:keep', false)).code).toBe(REFUSED);
    expect(await content(space.id, 'vault:keep')).toBe('before');
  });

  it('a qualifying App with no write grant on its OWN readable space is refused by the base write gate, never the level', async () => {
    const publisher = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    const space = await teamSpace(publisher, 'vault:own');
    // Control: the same principal reads the same node (the space is readable), so the refusal below is the write gate.
    expect(await readRun(publisher, space, 'vault:own')).toBe('OK');
    const refused = await liveRun(publisher, space, 'vault:own', false);
    expect(refused.code).not.toBe('OK');
    expect(refused.code).not.toBe(REFUSED);
    expect(refused.code).toBe('FORBIDDEN');
    // The write gate's own refusal, not an unrelated FORBIDDEN: the same principal read this node above, and both
    // assertions come from the same invocation.
    expect(refused.message).toContain('no write access to this memory');
    expect(await content(space.id, 'vault:own')).toBe('before');
  });

  it('a run of a publisher App on ANOTHER App\'s team space has no read: refused, identically whether or not the node exists', async () => {
    const publisher = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    const otherApp = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    const space = await teamSpace(otherApp, 'vault:secret');
    const existing = (await liveRun(publisher, space, 'vault:secret', false)).code;
    const missing = (await liveRun(publisher, space, 'vault:nothing-here', false)).code;
    expect(existing).not.toBe('OK');
    expect(existing).not.toBe(REFUSED);
    expect(missing).toBe(existing);
    expect(await content(space.id, 'vault:secret')).toBe('before');
  });
});

describe('a preview reads plainly and never queues behind the App rows (blind review F1, #4613 fresh seat)', () => {
  /** Another transaction holds the App, its link and the Agent exclusively, as an uninstall or an Agent update would. */
  async function withRowsHeldExclusively<T>(appId: string, body: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const heldFirst = new Promise<void>((r) => { held = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT a.id FROM apps a JOIN app_agents aa ON aa.app_id = a.id JOIN agents ag ON ag.id = aa.agent_id WHERE a.id = ${appId} FOR UPDATE OF a, aa, ag`;
      held();
      await gate;
    }, { timeout: 15_000 });
    holder.catch(() => undefined);
    let result!: T;
    try {
      await Promise.race([heldFirst, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('rows not held')), 5_000))]);
      result = await body();
    } finally {
      release();
      await holder;
    }
    return result;
  }
  const settlesWithin = async (p: Promise<unknown>, ms: number) =>
    Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

  it('a preview (lock: false) completes while another transaction holds the rows; a judgement for a write waits for them', async () => {
    const a = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    const pendingWrite = await withRowsHeldExclusively(a, async () => {
      const preview = roleWritersRefusal(db, principalOf(a) as never, memoryId, { priorRole: null, nextRole: 'vault' }, { lock: false });
      expect(await settlesWithin(preview, 3_000)).toBe(true);
      expect(await preview).toBeNull();
      // The control: the same judgement without the preview flag is observed WAITING on the held lock (not merely slow),
      // and once the holder releases it answers that the App qualifies.
      const forWrite = roleWritersRefusal(db, principalOf(a) as never, memoryId, { priorRole: null, nextRole: 'vault' });
      forWrite.catch(() => undefined);
      await waitForLockWaiters(db, 1, 5_000);
      // Wrapped: returning the bare promise would make the body wait for it, and it waits for the holder this body releases.
      return { forWrite };
    });
    expect(await pendingWrite.forWrite).toBeNull();
  }, 30_000);

  it('assertRoleWritersForNodes in preview mode does not queue either', async () => {
    const a = await app({ orgId: org.id, agents: [await agent(org.id, null)] });
    await withRowsHeldExclusively(a, async () => {
      const preview = db.$transaction((tx) => assertRoleWritersForNodes(
        tx, principalOf(a) as never, [{ role: 'vault' }], { from: memoryId }, { preview: true }), { timeout: 10_000 });
      expect(await settlesWithin(preview, 3_000)).toBe(true);
      await preview;
    });
  }, 30_000);
});

describe('a writer level this server does not know is refused, never read as ALL (blind review F3, #4613 fresh seat)', () => {
  it('an unrecognized rule value at the rule-resolution boundary answers ROLE_WRITERS_UNSUPPORTED with the level', async () => {
    // The database enum cannot hold such a value, so the rulebook is stubbed at the boundary the check reads.
    const stub = {
      memoryConfig: { findUnique: async () => ({ rules: [{ role: 'vault', enabled: true, writers: 'FUTURE_LEVEL' }] }) },
      memory: { findUnique: async () => ({ class: 'knowledge', userId: null, organizationId: org.id, ownerUserId: null }) },
      $queryRaw: async () => [],
    };
    const refused = await roleWritersRefusal(stub as never, { userId: user.owner!, roles: [], clientId: 'x' } as never, memoryId, { priorRole: null, nextRole: 'vault' });
    expect(refused?.extensions.code).toBe(UNSUPPORTED);
    expect(refused?.extensions.level).toBe('FUTURE_LEVEL');
  });
});
