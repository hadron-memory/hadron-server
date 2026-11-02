/**
 * startImpersonation is a person-only act (cor:acl:100; #2483 lists admin impersonation among the acts that stay
 * person-only until ruled): a worker-bound session and a refused session binding are refused like any other non-person
 * caller, before anything is looked up and again on the authorized transaction. Ending a session is never blocked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

let org: { id: string };
let holder: { id: string };
let target: { id: string };
let platform: { id: string };
let workerSessionId: string;
let personSessionId: string;
let workerId: string;

const ctxOf = (userId: string | undefined, extra: Record<string, unknown> = {}, roles: string[] = []) =>
  ({ db, userId, roles, ...extra }) as unknown as Context;
const start = (c: Context, userRef = target.id) => M.startImpersonation({}, { orgRef: org.id, userRef }, c);

beforeEach(async () => {
  await cleanDb(db);
  const mk = (handle: string, roles: string[] = ['READER']) =>
    db.user.create({ data: { id: generateId(), handle, name: handle, email: `${handle}@x.io`, roles: roles as never } });
  holder = await mk('pg-holder');
  target = await mk('pg-target');
  platform = await mk('pg-platform', ['ADMIN']);
  org = await db.organization.create({ data: { id: generateId(), name: 'PG Org', urn: 'pg-org' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: holder.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: target.id, role: 'CONTRIBUTOR' } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'PG Agent', urn: 'pg-org:agent' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'PG App', urn: 'pg-org:app' } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id,
    name: 'PG Worker', slug: 'pg-worker', heldByUserId: holder.id } });
  workerId = worker.id;
  workerSessionId = (await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id,
    workerId: worker.id, userId: holder.id, tool: 'vitest' } })).id;
  personSessionId = (await db.session.create({ data: { id: generateId(), appId: app.id, agentId: agent.id,
    userId: holder.id, tool: 'vitest' } })).id;
});

describe('startImpersonation is person-only', () => {
  it('refuses a worker-bound session and mints nothing', async () => {
    await expect(start(ctxOf(holder.id, { sessionId: workerSessionId }))).rejects.toThrow(/Forbidden/);
    expect(await db.impersonationSession.count()).toBe(0);
  });

  it('refuses a refused session binding and mints nothing', async () => {
    await expect(start(ctxOf(holder.id, { sessionBindingRefused: true }))).rejects.toThrow(/Forbidden/);
    expect(await db.impersonationSession.count()).toBe(0);
  });

  it('refuses a worker session before any lookup: the refusal is the same whatever the org or target', async () => {
    const c = ctxOf(holder.id, { sessionId: workerSessionId });
    const real = await start(c).then(() => 'minted', (e: any) => e.message);
    const unknownTarget = await start(c, generateId()).then(() => 'minted', (e: any) => e.message);
    const unknownOrg = await M.startImpersonation({}, { orgRef: generateId(), userRef: target.id }, c).then(() => 'minted', (e: any) => e.message);
    expect(unknownTarget).toBe(real);
    expect(unknownOrg).toBe(real);
    expect(real).toMatch(/Forbidden/);
  });

  it('still refuses a run principal carrying a user id', async () => {
    await expect(start(ctxOf(holder.id, { clientId: 'run:test' }))).rejects.toThrow(/Forbidden/);
    expect(await db.impersonationSession.count()).toBe(0);
  });

  it('still refuses an impersonated context and a context with no user', async () => {
    await expect(start(ctxOf(holder.id, { impersonation: { sessionId: generateId(), actorUserId: holder.id, orgId: org.id } }))).rejects.toThrow(/Forbidden/);
    await expect(start(ctxOf(undefined))).rejects.toThrow(/Forbidden/);
  });

  it('control: a person mints, with or without a non-worker session', async () => {
    expect((await start(ctxOf(holder.id))).token).toMatch(/^eyJ/);
    expect((await start(ctxOf(holder.id, { sessionId: personSessionId }))).token).toMatch(/^eyJ/);
  });

  it('control: a platform-admin person mints', async () => {
    expect((await start(ctxOf(platform.id, {}, ['ADMIN']))).token).toMatch(/^eyJ/);
  });
});

describe('the person gate is decided again on the authorized transaction', () => {
  it('a session bound to a worker while the start waits on the anchors is refused; nothing minted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const holding = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'user', id: target.id }], 'exclusive');
      held();
      await gate;
    }, { timeout: 20_000 });
    await isHeld;
    // The session is a person's when the request is first judged.
    const starting = start(ctxOf(holder.id, { sessionId: personSessionId })).then(() => 'minted', (e: any) => e.message);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 5_000);
      await db.session.update({ where: { id: personSessionId }, data: { workerId } });
    } finally {
      release();
      await holding;
    }
    expect(await starting).toMatch(/Forbidden/);
    expect(await db.impersonationSession.count()).toBe(0);
  });
});

describe('stopImpersonation stays open to every bound session', () => {
  it('a worker-bound session can end a session it can administer', async () => {
    const { session } = await start(ctxOf(holder.id));
    const ended = await M.stopImpersonation({}, { id: session.id }, ctxOf(holder.id, { sessionId: workerSessionId }));
    expect(ended.endedAt).not.toBeNull();
  });
});
