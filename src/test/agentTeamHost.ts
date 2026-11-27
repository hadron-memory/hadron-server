/**
 * #5259 — test fixtures for the hosts of a team App. Since #5259 a key is granted `host:operate`, and a worker is
 * assigned, only for a host joined to the App (a live `agent_team_hosts` row; HOST_NOT_FOUND otherwise). A fixture that
 * makes a host key through grantAppKeyScope, or assigns a worker, records the host first with one of these: the row
 * only, as the #5259 backfill writes it for a host that existed before; it issues no key. Tests of joining itself call
 * joinAgentTeamHost (src/api/graphql/schema/resolvers.agentTeamHost5259.test.ts).
 */
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { generateId } from '../lib/id.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** Record `hostId` as a live host of the App (reviving a removed row). Idempotent. */
export async function ensureAgentTeamHost(db: Db, appId: string, hostId: string): Promise<void> {
  await db.agentTeamHost.upsert({
    where: { appId_hostId: { appId, hostId } },
    create: { id: generateId(), appId, hostId, label: hostId },
    update: { removedAt: null, removedByUserId: null },
  });
}

/** {@link ensureAgentTeamHost} for the App of `keyId`, before granting that key `host:operate` for `hostId`. */
export async function joinHostForKey(db: Db, keyId: string, hostId: string): Promise<void> {
  const key = await db.appKey.findUniqueOrThrow({ where: { id: keyId }, select: { appId: true } });
  await ensureAgentTeamHost(db, key.appId, hostId);
}
