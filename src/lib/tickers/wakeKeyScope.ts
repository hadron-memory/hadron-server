/** #2136 / cor:agt:080:22: one current registration scope for legacy App-key reads and acknowledgements. */
import { Prisma } from '../../generated/prisma/index.js';
import { GraphQLError } from 'graphql';
import { keyEverHeldHostOperate, keyHostId } from '../hostOperations/hostKey.js';
import { requireKeyScope } from '../appKeyScopes/scopes.js';

type Db = Parameters<typeof keyHostId>[0];
type Key = { appKeyId: string; appId: string };
const scopeRequired = () => new GraphQLError('This key no longer holds its host delivery scope.', { extensions: { code: 'APP_KEY_SCOPE_REQUIRED' } });

export async function legacyWakeKeyScope(db: Db, key: Key) {
  await requireKeyScope(db, key, 'attention:deliver');
  const hostId = await keyHostId(db, key);
  if (!hostId && await keyEverHeldHostOperate(db, key.appKeyId)) throw scopeRequired();
  const where: Prisma.WorkerWhereInput = hostId
    ? { launchableVia: { some: { registration: { appId: key.appId, hostId, lostAt: null } } } }
    // A retained lost-host registration still lists the worker: losing a host
    // must not transfer its workers to an App-wide non-host reader.
    : { launchableVia: { none: {} } };
  return { hostId, where };
}

/**
 * Called under the App's shared authority anchors. Budget -> workers ->
 * registration rows: acknowledgement already holds budget/wake locks; issue
 * takes the same budget lock here before these rows. registerHost takes listed
 * workers FOR SHARE before updating its registration. UPDATE on the selected
 * workers fences a first registration too, where there is no child row to lock.
 */
export async function authorizeLegacyWakeWorkers(
  tx: Prisma.TransactionClient, key: Key, expectedHostId: string | null, workerIds: readonly string[],
): Promise<boolean> {
  const scope = await legacyWakeKeyScope(tx, key);
  if (scope.hostId !== expectedHostId) throw scopeRequired();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wakebudget:' + key.appId}, 0))`;
  const ids = [...new Set(workerIds)].sort();
  if (ids.length) await tx.$queryRaw`SELECT id FROM workers WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
  // Host removal/loss holds still through the answer. For a non-host, the
  // worker lock already fences every insertion; a removal cannot widen an
  // answer that was validated as having no registration.
  if (scope.hostId) await tx.$queryRaw`SELECT id FROM host_registrations WHERE app_id = ${key.appId} AND host_id = ${scope.hostId} FOR SHARE`;
  if (scope.hostId && !(await tx.hostRegistration.findFirst({ where: { appId: key.appId, hostId: scope.hostId, lostAt: null }, select: { id: true } }))) throw scopeRequired();
  const allowed = await tx.worker.count({ where: { AND: [{ id: { in: ids }, appId: key.appId, retiredAt: null }, scope.where] } });
  return allowed === ids.length;
}
