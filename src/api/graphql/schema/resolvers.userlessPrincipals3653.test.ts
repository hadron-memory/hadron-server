/**
 * #3653 / cor:agt:040:10 (ruling 0235): serving a personal App's install of an organization's Agent checks the App
 * owner's licence, not the caller, so an App key with no user is served a worker's briefing while that licence holds.
 * Reads stay the reader's: this file pins that they did not move. A run has no case here, because it can't exist on a
 * personal App: see the last pin, and the trace on #3653 (6702873777).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { composeWorkerPrompt } from './resolvers.worker.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { sessionScopedMemoryIds } from '../../../lib/auth/sessionScopedMemoryIds.js';
import { mintAppRun, RunLaunchDeniedError } from '../../../jobs/appRuns.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const SENTINEL = 'SYNTHETIC ORG BRIEFING 3653';
const mutation = resolvers.Mutation as any;
let ownerId: string, outsiderId: string, orgId: string, agentId: string, appId: string, otherAppId: string, systemMemoryId: string;
const person = (userId = ownerId): Context => ({ db, userId, roles: ['READER'] });
const appKey = (id = appId, sessionId?: string): Context =>
  ({ db, appId: id, roles: [], ...(sessionId ? { sessionId } : {}) }) as Context;
const revokeOwnerLicence = () =>
  db.agentSubscription.update({ where: { userId_agentId: { userId: ownerId, agentId } }, data: { revokedAt: new Date() } });
const endOwnerMembership = () =>
  db.orgMember.update({ where: { organizationId_userId: { organizationId: orgId, userId: ownerId } }, data: { deletedAt: new Date() } });
const castWorker = async () => {
  const made = await mutation.castWorker({}, { appRef: appId, agentRef: agentId, name: 'Briefed' }, person());
  return db.worker.findUniqueOrThrow({ where: { id: made.id } });
};

beforeEach(async () => {
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { id: generateId(), handle: 'owner3653', roles: ['READER'] } })).id;
  outsiderId = (await db.user.create({ data: { id: generateId(), handle: 'outsider3653', roles: ['READER'] } })).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'Publisher', urn: 'publisher3653.test' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: ownerId, role: 'READER' } });
  systemMemoryId = (await db.memory.create({ data: { class: 'system', organizationId: orgId, name: 'Agent system', urn: 'publisher3653.test:system' } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'Assistant', urn: 'publisher3653.test:assistant', visibility: 'ORGANIZATION', personaRole: 'engineer', systemMemoryId } })).id;
  await db.agentSubscription.create({ data: { userId: ownerId, agentId, activatedAt: new Date('2020-01-01') } });
  appId = (await db.app.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Personal', urn: '@owner3653:personal' } })).id;
  otherAppId = (await db.app.create({ data: { id: generateId(), ownerUserId: outsiderId, name: 'Other', urn: '@outsider3653:other' } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.createMany({ data: [{ appId, userId: ownerId, role: 'owner' }, { appId, userId: outsiderId, role: 'member' }] });
  await serveAgentBootPrompt(db, agentId, SENTINEL);
});

describe('worker briefing read', () => {
  it('serves an App key with no session while the owner licence holds', async () => {
    const worker = await castWorker();
    const read = await composeWorkerPrompt(appKey(), worker);
    expect(read.refusal ?? null).toBeNull();
    expect(read.text).toContain(SENTINEL);
  });

  it('serves a session-bound App key while the owner licence holds', async () => {
    const worker = await castWorker();
    const session = await db.session.create({ data: { id: generateId(), appId, agentId, userId: ownerId } });
    const read = await composeWorkerPrompt(appKey(appId, session.id), worker);
    expect(read.refusal ?? null).toBeNull();
    expect(read.text).toContain(SENTINEL);
  });

  it('serves a session-bound App key whose session has no user', async () => {
    const worker = await castWorker();
    const session = await db.session.create({ data: { id: generateId(), appId, agentId, userId: null } });
    const read = await composeWorkerPrompt(appKey(appId, session.id), worker);
    expect(read.refusal ?? null).toBeNull();
    expect(read.text).toContain(SENTINEL);
  });

  it.each([['revoked licence', revokeOwnerLicence], ['owner left the organization', endOwnerMembership]])(
    'refuses an App key after %s, with no text', async (_label, lapse) => {
      const worker = await castWorker();
      await lapse();
      const read = await composeWorkerPrompt(appKey(), worker);
      expect(read.text).toBeNull();
      expect(read.refusal).toBe('FORBIDDEN');
    },
  );

  it('gives another App key nothing', async () => {
    const worker = await castWorker();
    expect((await composeWorkerPrompt(appKey(otherAppId), worker)).text).toBeNull();
  });

  it('keeps a person outside the organization refused, as built', async () => {
    const worker = await castWorker();
    const read = await composeWorkerPrompt(person(outsiderId), worker);
    expect(read.text).toBeNull();
    expect(read.refusal).toBe('FORBIDDEN');
  });
});

describe('reads did not move', () => {
  it('an App key with no session reads none of the system memory', async () => {
    expect(await canReadMemory(db, appKey(), systemMemoryId)).toBe(false);
  });

  it('a session-bound App key reads as its session user', async () => {
    const own = await db.session.create({ data: { id: generateId(), appId, agentId, userId: ownerId } });
    const outsider = await db.session.create({ data: { id: generateId(), appId, agentId, userId: outsiderId } });
    const nobody = await db.session.create({ data: { id: generateId(), appId, agentId, userId: null } });
    expect(await sessionScopedMemoryIds(db, appId, own.id)).toContain(systemMemoryId);
    expect(await sessionScopedMemoryIds(db, appId, outsider.id)).not.toContain(systemMemoryId);
    expect(await sessionScopedMemoryIds(db, appId, nobody.id)).not.toContain(systemMemoryId);
  });
});

describe('a run cannot exist on a personal App', () => {
  // If runs are ever modelled for a personal App this goes red, and that work must carry the run's principal into the
  // membership check (`installedSystemMemoryFolds`, called with no user for a run) and require a participant.
  it('is refused at the one mint door, so the membership check never sees a run', async () => {
    await expect(mintAppRun(db, { appId, organizationId: orgId, triggerKind: 'MANUAL', entryNodeUrn: 'x' } as never))
      .rejects.toSatisfy(error => error instanceof RunLaunchDeniedError && error.code === 'APP_NOT_FOUND');
    expect(await db.appRun.count({ where: { appId } })).toBe(0);
  });
});
