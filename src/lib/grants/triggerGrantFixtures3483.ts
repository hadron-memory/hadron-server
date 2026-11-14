/**
 * #3483 test fixtures: an App a person manages, an entry node, an installed role agent with a worker and its session, and
 * grants that are REALLY activated (a completed signing request, the signer's own passkey record, then the guard's activation
 * move), so a pin never depends on a row the guards would refuse.
 */
import { db } from '../../integrations/db/client.js';
import { generateId } from '../id.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { newSigningRequestId } from '../signing/requests.js';
import { upsertPlatformActions } from './actions.js';
import { DB_NOW, insertGrant, seedWorld, type World } from './grantFixtures3668.js';

export interface TriggerWorld extends World {
  entryNodeId: string; entryNodeUrn: string; otherEntryNodeId: string; otherEntryNodeUrn: string;
  /** A person who manages the App (org ADMIN), acting as themselves. */
  person: { db: typeof db; userId: string; roles: never[] };
  /** The worker's own context: its session names the worker. */
  workerCtx: { db: typeof db; userId: string; roles: never[]; sessionId: string };
}

let n = 0;

export async function seedTriggerWorld(): Promise<TriggerWorld> {
  const w = await seedWorld();
  await upsertPlatformActions(db);
  await db.orgMember.create({ data: { userId: w.userId, organizationId: w.orgId, role: 'ADMIN' } });
  await db.appMember.create({ data: { appId: w.appId, userId: w.userId, role: 'owner' } });
  await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
  const org = await db.organization.findUniqueOrThrow({ where: { id: w.orgId } });
  const memory = await db.memory.create({ data: { name: 'Flow', urn: `${org.urn}:flow`, class: 'knowledge', organizationId: w.orgId } });
  const entry = await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'go' } });
  const other = await db.node.create({ data: { memoryId: memory.id, loc: 'other', name: 'Other', isRunnable: true, content: 'go' } });
  // The worker's session is driven by the person who holds it (a held worker's session carries its holder).
  await db.session.update({ where: { id: w.sessionId }, data: { userId: w.userId } as never });
  return {
    ...w,
    entryNodeId: entry.id, entryNodeUrn: `hrn:node:${org.urn}:flow:entry`,
    otherEntryNodeId: other.id, otherEntryNodeUrn: `hrn:node:${org.urn}:flow:other`,
    person: { db, userId: w.userId, roles: [] },
    workerCtx: { db, userId: w.userId, roles: [], sessionId: w.sessionId },
  };
}

export async function workerOf(w: World, agentId = w.agentId, appId = w.appId): Promise<string> {
  const k = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: `t${++n}`, slug: `t-${n}-${generateId().slice(0, 6)}` } });
  return k.id;
}

/** A session for `workerId`, held by the world's person; `launched` marks it host-launched. */
export async function sessionOf(w: World, workerId: string, agentId = w.agentId, launched = false): Promise<string> {
  const s = await db.session.create({ data: {
    id: generateId(), appId: w.appId, workerId, agentId, userId: w.userId,
    ...(launched ? { launchOperationId: generateId(), launchHostId: generateId(), launchIssuedBy: 'platform' } : {}),
  } as never });
  return s.id;
}

type Holder = { kind: 'worker' | 'agent'; id: string };

/**
 * A grant row, pending, then signed and activated by `w.user2Id` unless `activate` is false. `over` sets any column
 * (`max_uses`, `expires_at`, `app_id`, `action`, `action_values` …).
 */
export async function triggerGrant(
  w: TriggerWorld,
  opts: { holder?: Holder; action?: string; entryNode?: string | string[]; over?: Record<string, unknown>; activate?: boolean } = {},
): Promise<string> {
  const holder = opts.holder ?? { kind: 'worker', id: w.workerId };
  const g = await insertGrant(w, {
    user_id: null, worker_id: holder.kind === 'worker' ? holder.id : null, agent_id: holder.kind === 'agent' ? holder.id : null,
    action: opts.action ?? 'schedule.create', action_values: { entryNode: opts.entryNode ?? w.entryNodeId }, max_uses: 1,
    ...(opts.over ?? {}),
  } as never);
  if (opts.activate === false) return g;
  const r = newSigningRequestId();
  await db.$executeRawUnsafe(
    `INSERT INTO grant_signing_requests (id, grant_id, version, terms_hash, payload_version, requester_user_id, expires_at)
     VALUES ($1, $2, 1, $3, 'hadron-grant-signature-v1', $4, ${DB_NOW} + interval '1 hour')`, r, g, 'a'.repeat(64), w.userId);
  const key = softPasskey();
  const passkeyId = await insertSoftPasskey(db, w.user2Id, key, { rpId: 'localhost' });
  const a = key.assert({ payload: Buffer.from('x'), origin: 'http://localhost', rpId: 'localhost' });
  const s = generateId();
  await db.$executeRawUnsafe(
    `INSERT INTO grant_signatures (id, grant_id, signing_request_id, signer_id, passkey_credential_id, version, terms_hash, holder_kind,
       holder_id, payload_version, rp_id, authenticator_data, client_data_json, signature)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, 'hadron-grant-signature-v1', 'localhost', $9, $10, $11)`,
    s, g, r, w.user2Id, passkeyId, 'a'.repeat(64), holder.kind, holder.id, a.authenticatorData, a.clientDataJson, a.signature);
  await db.$executeRawUnsafe(`UPDATE grant_signing_requests SET state = 'completed' WHERE id = $1`, r);
  await db.$executeRawUnsafe(
    `UPDATE grants SET activated_at = ${DB_NOW}, verification_kind = 'passkey', verified_by = $2, signature_id = $3 WHERE id = $1`, g, w.user2Id, s);
  return g;
}

export const useCount = async (grantId: string) =>
  (await db.$queryRawUnsafe<Array<{ use_count: number }>>('SELECT use_count FROM grants WHERE id = $1', grantId))[0]!.use_count;
export const useEvents = (grantId: string) => db.grantEvent.findMany({ where: { grantId, action: 'USE' } });
