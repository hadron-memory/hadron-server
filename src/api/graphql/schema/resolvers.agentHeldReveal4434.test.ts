/**
 * #4434 (follow-up of #4198, cor:sec:060:02 R5, cor:acl:140:06): an AGENT-held `secret.reveal` grant is read through the role agent's
 * live workers in the client's App. Everything else about the read stays as S3 built it (one use per read, USE + REVEAL events, the
 * uniform not-found, a refused read on a known client recorded).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { PLATFORM_ACTIONS, upsertPlatformActions } from '../../../lib/grants/actions.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';

let ownerId: string; let appId: string; let app2Id: string; let secretId: string;
let roleAgentId: string; let otherAgentId: string; let childAgentId: string;
let w1: string; let w2: string; let otherApp: string; let otherAgentWorker: string; let childWorker: string;
const ctxOf = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);
const asWorker = (id: string | null, p: () => Promise<unknown>) => runAsActor({ workerId: id, agentId: null }, p);
const reveal = (workerId: string | null, clientId: string): Promise<any> => asWorker(workerId, () => resolvers.Mutation.revealSecret({}, { clientId }, ctxOf(ownerId)));
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e));

async function activate(id: string) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
    await tx.$executeRawUnsafe(`UPDATE grants SET activated_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute', verification_kind = 'passkey', verified_by = $2, issuer_user_id = $2 WHERE id = $1`, id, ownerId);
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
  });
}
const issue = (holderKind: 'AGENT' | 'APP' | 'USER' | 'WORKER', holderRef: string | null, maxReads = 3): Promise<any> =>
  resolvers.Mutation.issueSecretReadClient({}, { input: { secretRef: secretId, holderKind, holderRef, autoDelete: false, maxReads, reason: 'need it' } }, ctxOf(ownerId));

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db); await upsertPlatformActions(db);
  ownerId = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
  const mkApp = async (name: string) => (await db.app.create({ data: { name, ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:${name}` } })).id;
  appId = await mkApp('ahr'); app2Id = await mkApp('ahr2');
  const mkAgent = async (slug: string, extra: Record<string, unknown> = {}) =>
    (await db.agent.create({ data: { ownerUserId: ownerId, name: slug, urn: `${generateId().toLowerCase()}:${slug}`, ...extra } as never })).id;
  roleAgentId = await mkAgent('role'); otherAgentId = await mkAgent('other'); childAgentId = await mkAgent('child', { extendsAgentId: roleAgentId });
  for (const a of [roleAgentId, otherAgentId, childAgentId]) await db.appAgent.create({ data: { appId, agentId: a } });
  await db.appAgent.create({ data: { appId: app2Id, agentId: roleAgentId } });
  const mkWorker = async (app: string, agent: string, slug: string) => (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app, agentId: agent, name: slug, slug } })).id;
  w1 = await mkWorker(appId, roleAgentId, 'w1'); w2 = await mkWorker(appId, roleAgentId, 'w2');
  otherApp = await mkWorker(app2Id, roleAgentId, 'w-app2');
  otherAgentWorker = await mkWorker(appId, otherAgentId, 'w-other');
  childWorker = await mkWorker(appId, childAgentId, 'w-child');
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'tok', kind: 'generic', value: 'hunter2' }, ctxOf(ownerId))).id;
});

describe('#4434 agent-held secret.reveal', () => {
  it('declares secret.reveal with the reach WORKER_OR_ROLE_AGENT', () => {
    expect(PLATFORM_ACTIONS.find((a) => a.name === 'secret.reveal')?.reach).toBe('WORKER_OR_ROLE_AGENT');
  });

  it('a live worker of the role agent reads once: one use, one USE grant event, one REVEAL secret event; a sibling worker reads under the same grant', async () => {
    const r = await issue('AGENT', roleAgentId);
    await activate(r.grantId);
    expect(await reveal(w1, r.clientId)).toMatchObject({ secretName: 'tok', value: JSON.stringify('hunter2'), readsLeft: 2 });
    expect((await db.grant.findUniqueOrThrow({ where: { id: r.grantId } })).useCount).toBe(1);
    expect(await db.grantEvent.count({ where: { grantId: r.grantId, action: 'USE' } })).toBe(1);
    expect(await db.secretEvent.count({ where: { secretId, kind: 'REVEAL', outcome: 'OK' } })).toBe(1);
    expect(await code(reveal(w2, r.clientId))).toBe('OK');
    expect((await db.grant.findUniqueOrThrow({ where: { id: r.grantId } })).useCount).toBe(2);
  });

  it.each([
    ['a worker of the same role agent bound in a DIFFERENT App', () => otherApp],
    ['a worker of a different agent', () => otherAgentWorker],
    ['a worker of an agent that EXTENDS the holder agent, in the same App (cor:acl:140:06 S6)', () => childWorker],
  ])('refuses %s with the uniform not-found, spends nothing, and records the refusal on the known client', async (_n, who) => {
    const r = await issue('AGENT', roleAgentId);
    await activate(r.grantId);
    expect(await code(reveal(who(), r.clientId))).toBe('SECRET_READ_CLIENT_NOT_FOUND');
    expect((await db.grant.findUniqueOrThrow({ where: { id: r.grantId } })).useCount).toBe(0);
    expect(await db.grantEvent.count({ where: { grantId: r.grantId, action: 'USE' } })).toBe(0);
    expect(await db.secretEvent.count({ where: { secretId, kind: 'REVEAL', outcome: 'SECRET_READ_CLIENT_NOT_FOUND' } })).toBe(1);
  });

  it('refuses a RETIRED worker of the holder agent the same way', async () => {
    const r = await issue('AGENT', roleAgentId);
    await activate(r.grantId);
    await db.worker.update({ where: { id: w2 }, data: { retiredAt: new Date() } });
    expect(await code(reveal(w2, r.clientId))).toBe('SECRET_READ_CLIENT_NOT_FOUND');
    expect((await db.grant.findUniqueOrThrow({ where: { id: r.grantId } })).useCount).toBe(0);
    expect(await code(reveal(w1, r.clientId))).toBe('OK');
  });

  it('stops reaching the workers once the agent is uninstalled from the App (judged at the read, not at issue)', async () => {
    const r = await issue('AGENT', roleAgentId);
    await activate(r.grantId);
    await db.appAgent.delete({ where: { appId_agentId: { appId, agentId: roleAgentId } } });
    expect(await code(reveal(w1, r.clientId))).toBe('SECRET_READ_CLIENT_NOT_FOUND');
    expect((await db.grant.findUniqueOrThrow({ where: { id: r.grantId } })).useCount).toBe(0);
  });

  it('an agent-held client is refused to a person (no worker bound) with the same uniform answer', async () => {
    const r = await issue('AGENT', roleAgentId);
    await activate(r.grantId);
    expect(await code(reveal(null, r.clientId))).toBe('SECRET_READ_CLIENT_NOT_FOUND');
  });

  it('an agent that is not installed in the App is refused at request, as is an unknown agent id', async () => {
    const stranger = (await db.agent.create({ data: { ownerUserId: ownerId, name: 's', urn: `${generateId().toLowerCase()}:s` } as never })).id;
    expect(await code(issue('AGENT', stranger))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await code(issue('AGENT', 'nosuchagent'))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await db.secretReadClient.count({ where: { secretId } })).toBe(0);
  });

  it('an App-held reveal client is still refused at request, and leaves nothing', async () => {
    expect(await code(issue('APP', appId))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    // Nor may an APP kind carry a live worker's or agent's id through to a worker- or agent-held grant.
    expect(await code(issue('APP', w1))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await code(issue('APP', roleAgentId))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await db.secretReadClient.count({ where: { secretId } })).toBe(0);
    expect(await db.grant.count({ where: { appId } })).toBe(0);
  });

  it('a person-held grant still reaches no worker', async () => {
    const r = await issue('USER', null);
    await activate(r.grantId);
    expect(await code(reveal(w1, r.clientId))).toBe('SECRET_READ_CLIENT_NOT_FOUND');
    expect((await db.grant.findUniqueOrThrow({ where: { id: r.grantId } })).useCount).toBe(0);
  });
});
