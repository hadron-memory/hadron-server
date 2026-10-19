import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1767 — availability reads: every App participant and the App's own key, read-only
 * (cor:agt:060:02, :03; the tasks audience, cor:agt:050:23).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let manager: { id: string };
let outsider: { id: string };
let ownerUser: { id: string };
let memberUser: { id: string };
let appX: { id: string; urn: string };
let appY: { id: string };
let userApp: { id: string };
let keyX: { id: string };
let workerX: { id: string };
let workerY: { id: string };
let workerU: { id: string };

const uctx = (id: string): Context => ({ db, userId: id, roles: ['READER'] });
const keyCtx = (extra: Partial<Context> = {}): Context => ({ db, appId: appX.id, appKeyId: keyX.id, roles: [], ...extra });
const mkUser = (n: number) => db.user.create({ data: { id: generateId(), githubId: 98_300 + n, githubUsername: `av-${n}-${generateId()}`, roles: ['READER'] }, select: { id: true } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  const org = await db.organization.create({ data: { id: generateId(), name: 'av-org', urn: `av-org-${suffix}.com` } });
  [manager, outsider, ownerUser, memberUser] = [await mkUser(1), await mkUser(2), await mkUser(3), await mkUser(4)];
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, uctx(manager.id));
  appX = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` } });
  appY = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Y', urn: `${org.urn}:y` } });
  userApp = await db.app.create({ data: { id: generateId(), ownerUserId: ownerUser.id, name: 'U', urn: `av-u-${suffix}` } });
  await db.appMember.create({ data: { appId: userApp.id, userId: memberUser.id, role: 'reader' } });
  const w = (appId: string, name: string) => db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name, slug: name.toLowerCase() }, select: { id: true } });
  workerX = await w(appX.id, 'Anne');
  workerY = await w(appY.id, 'Zed');
  workerU = await w(userApp.id, 'Uma');
  keyX = await db.appKey.create({ data: { id: generateId(), appId: appX.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' }, select: { id: true } });
  await M.setWorkerAvailability({}, { input: { worker: workerX.id, state: 'UNAVAILABLE', reason: 'OTHER' } }, uctx(manager.id));
  await M.setModelFamilyAvailability({}, { input: { appRef: appX.id, family: 'claude', state: 'UNAVAILABLE', reason: 'OTHER' } }, uctx(manager.id));
  await M.setWorkerAvailability({}, { input: { worker: workerY.id, state: 'UNAVAILABLE', reason: 'OTHER' } }, uctx(manager.id));
});

describe('teamAvailability — the App\'s own key reads worker and family availability (#1767)', () => {
  it('serves its own App\'s records, and only those', async () => {
    const r = await Q.teamAvailability({}, { appRef: appX.id }, keyCtx());
    expect(r.workers.map((x: { workerId: string }) => x.workerId)).toEqual([workerX.id]);
    expect(r.families.map((x: { family: string }) => x.family)).toEqual(['claude']);
  });

  it('another App answers like a missing one; so do a revoked key and a session-bound key', async () => {
    await expectCode(Q.teamAvailability({}, { appRef: appY.id }, keyCtx()), 'APP_NOT_FOUND');
    await expectCode(Q.teamAvailability({}, { appRef: generateId() }, keyCtx()), 'APP_NOT_FOUND');
    await expectCode(Q.teamAvailability({}, { appRef: appX.id }, keyCtx({ sessionId: generateId() })), 'APP_KEY_SESSION_BOUND');
    await db.appKey.update({ where: { id: keyX.id }, data: { revokedAt: new Date() } });
    await expectCode(Q.teamAvailability({}, { appRef: appX.id }, keyCtx()), 'APP_NOT_FOUND');
  });

  it('the key cannot set availability: both setters still refuse, and nothing changes', async () => {
    const before = JSON.stringify([await db.workerAvailability.findMany({ orderBy: { workerId: 'asc' } }), await db.modelFamilyAvailability.findMany()]);
    await expect(M.setWorkerAvailability({}, { input: { worker: workerX.id, state: 'AVAILABLE' } }, keyCtx())).rejects.toBeInstanceOf(GraphQLError);
    await expect(M.setModelFamilyAvailability({}, { input: { appRef: appX.id, family: 'claude', state: 'AVAILABLE' } }, keyCtx())).rejects.toBeInstanceOf(GraphQLError);
    expect(JSON.stringify([await db.workerAvailability.findMany({ orderBy: { workerId: 'asc' } }), await db.modelFamilyAvailability.findMany()])).toBe(before);
  });
});

describe('teamAvailability — participants as before, plus user-owned App members (#1764)', () => {
  it('a participant reads; a non-participant is refused as today', async () => {
    expect((await Q.teamAvailability({}, { appRef: appX.id }, uctx(manager.id))).workers).toHaveLength(1);
    await expectCode(Q.teamAvailability({}, { appRef: appX.id }, uctx(outsider.id)), 'APP_NOT_FOUND');
  });

  it('a member of a user-owned App reads its availability; a stranger does not', async () => {
    await M.setWorkerAvailability({}, { input: { worker: workerU.id, state: 'UNAVAILABLE', reason: 'OTHER' } }, uctx(ownerUser.id));
    expect((await Q.teamAvailability({}, { appRef: userApp.id }, uctx(memberUser.id))).workers).toHaveLength(1);
    await expectCode(Q.teamAvailability({}, { appRef: userApp.id }, uctx(outsider.id)), 'APP_NOT_FOUND');
  });
});
