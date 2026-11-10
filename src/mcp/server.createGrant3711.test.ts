/**
 * #3711 (ruling 0255 item 21, acceptance 11): `hadron_create_grant`, a PERSON who manages an App asking for a grant over MCP. The
 * tool delegates to the manager arm of GraphQL `createGrant`, so it creates the same pending row; it always records the PERSON,
 * never a worker, even on a connection bound to one; and an App key, a non-manager and an impersonated session are refused with
 * the one answer. The tool exists only where signing is switched on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { upsertPlatformActions } from '../lib/grants/actions.js';
import { dropTestActions, seedWorld, type World } from '../lib/grants/grantFixtures3668.js';
import { createTestableMcpServer } from './server.js';
import { runAsActor } from '../lib/requestActor.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

beforeAll(() => { vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true'); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); vi.unstubAllEnvs(); });

let w: World;
let managerId: string; let memberId: string;
let holderWorkerId: string;

const input = (over: Record<string, unknown> = {}) => ({
  app: w.appId, action: 'schedule.create', values: { entryNode: generateId() }, holderKind: 'WORKER', holderRef: holderWorkerId, reason: 'nightly digest', ...over,
});
function server(over: Partial<AuthContext> & { userId?: string } = {}) {
  const auth = { userId: managerId, roles: ['READER'], clientId: `user:${managerId}`, appId: w.appId, organizationId: w.orgId, ...over } as AuthContext;
  return createTestableMcpServer(auth, { sessionId: `g-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
}
const rows = () => db.$queryRawUnsafe<any[]>('SELECT * FROM grants');

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  await upsertPlatformActions(db);
  memberId = w.userId; managerId = w.user2Id;
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: memberId, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: managerId, role: 'ADMIN' } });
  holderWorkerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: w.agentId, name: 'p', slug: `p-${generateId().slice(0, 6)}` } })).id;
});

describe('hadron_create_grant', () => {
  it('a manager\'s person key creates the same PENDING row GraphQL createGrant makes, recorded as the person', async () => {
    const text = await server().callToolText('hadron_create_grant', input());
    const g = JSON.parse(text);
    expect(g).toMatchObject({
      appId: w.appId, holderKind: 'WORKER', holderId: holderWorkerId, requestedByUserId: managerId, requestedByWorkerId: null,
      issuerUserId: null, activatedAt: null, revokedAt: null, allows: false,
    });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ requested_by_user_id: managerId, requested_by_worker_id: null, requested_by_session_id: null, activated_at: null, verification_kind: null });
  });

  it('on a connection BOUND to a worker the row still records the person, never the worker or its session', async () => {
    await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: managerId } });
    const sessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: managerId, workerId: w.workerId, agentId: w.agentId } })).id;
    const text = await server({ sessionId }).callToolText('hadron_create_grant', input());
    expect(JSON.parse(text)).toMatchObject({ requestedByUserId: managerId, requestedByWorkerId: null, requestedBySessionId: null });
    const [row] = await rows();
    expect(row).toMatchObject({ requested_by_worker_id: null, requested_by_session_id: null });
  });

  it('Riana P2-3: with the worker ACTUALLY PUBLISHED as the connection\'s actor (as the transport does for a bound connection) the row still records the person', async () => {
    await db.worker.update({ where: { id: w.workerId }, data: { heldByUserId: managerId } });
    const sessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: managerId, workerId: w.workerId, agentId: w.agentId } })).id;
    const srv = server({ sessionId });
    const text = await runAsActor({ workerId: w.workerId, agentId: w.agentId, userId: managerId }, () => srv.callToolText('hadron_create_grant', input()));
    expect(JSON.parse(text)).toMatchObject({ requestedByUserId: managerId, requestedByWorkerId: null, requestedBySessionId: null });
    const [row] = await rows();
    expect(row).toMatchObject({ requested_by_worker_id: null, requested_by_session_id: null });
  });

  it('a worker connection whose person does NOT manage the App gains nothing from being a worker: refused, no row', async () => {
    const sessionId = (await db.session.create({ data: { id: generateId(), appId: w.appId, userId: memberId, workerId: w.workerId, agentId: w.agentId } })).id;
    const text = await server({ userId: memberId, clientId: `user:${memberId}`, sessionId }).callToolText('hadron_create_grant', input({ holderRef: w.workerId }));
    expect(text).toMatch(/^\[grant_not_manager\]/);
    expect(await rows()).toHaveLength(0);
  });

  it('a member who does not manage, an unknown App and an App key each get the same refusal; no row', async () => {
    const member = await server({ userId: memberId, clientId: `user:${memberId}` }).callToolText('hadron_create_grant', input());
    const unknown = await server().callToolText('hadron_create_grant', input({ app: generateId() }));
    const key = await server({ userId: undefined, appKeyId: generateId(), clientId: 'appkey:x' } as never).callToolText('hadron_create_grant', input());
    for (const t of [member, unknown, key]) expect(t).toMatch(/^\[grant_not_manager\]/);
    expect(member).toBe(unknown);
    expect(await rows()).toHaveLength(0);
  });

  it('a refused session binding is refused, as on GraphQL', async () => {
    const text = await server({ sessionBindingRefused: true } as never).callToolText('hadron_create_grant', input());
    expect(text).toMatch(/^\[grant_not_manager\]/);
    expect(await rows()).toHaveLength(0);
  });

  it('an impersonated session is refused', async () => {
    const text = await server({ impersonation: { sessionId: generateId(), adminUserId: memberId } } as never).callToolText('hadron_create_grant', input());
    expect(text).toMatch(/^\[grant_not_manager\]/);
    expect(await rows()).toHaveLength(0);
  });

  it('typed holder refusals carry through, and leave no row', async () => {
    const other = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.app2Id, agentId: w.agentId, name: 'o', slug: `o-${generateId().slice(0, 6)}` } });
    const text = await server().callToolText('hadron_create_grant', input({ holderRef: other.id }));
    expect(text).toMatch(/^\[grant_holder_not_allowed\]/);
    expect(await rows()).toHaveLength(0);
  });

  it('the tool is absent where signing is off, as createGrant is', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
    try {
      const text = await server().callToolText('hadron_create_grant', input()).catch((e: Error) => String(e.message));
      expect(text).toMatch(/not registered/i);
    } finally {
      vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    }
  });
});
