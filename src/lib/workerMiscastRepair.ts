/** #1162 / cor:dmo:050:11: private, immutable-id census, including tombstones. */
import { decryptJson } from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import { Prisma } from '../generated/prisma/index.js';

type Reader = Pick<Prisma.TransactionClient, '$queryRaw' | 'session' | 'node' | 'asset'>;
const quoted = (name: string) => Prisma.raw(`"${name.replaceAll('"', '""')}"`);

/** Include no-FK audit fields: ORM relations alone lose attribution. */
export const workerReferenceInventory = Prisma.dmmf.datamodel.models.flatMap((model) =>
  model.fields.filter((field) => field.kind === 'scalar' && /workerId$/i.test(field.name))
    .map((field) => ({ model: model.name, table: model.dbName ?? model.name, column: field.dbName ?? field.name })));

const JSON_REFERENCES = [
  ['nodes', 'data'], ['nodes', 'properties'],
  ['node_revisions', 'data'], ['node_revisions', 'properties'],
  ['agent_team_events', 'chain'], ['agent_team_events', 'payload'], ['host_operations', 'args'], ['agent_tasks', 'requirements'],
] as const;

async function jsonReferences(db: Reader, table: string, column: string, ids: string[]): Promise<boolean> {
  const predicates = ids.map((id) => Prisma.sql`jsonb_path_exists(${quoted(column)}, '$.** ? (@ == $identity)', jsonb_build_object('identity', ${id}::text))`);
  const rows = await db.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM ${quoted(table)} WHERE ${Prisma.join(predicates, ' OR ')}) AS present`);
  return rows[0].present;
}

/** Ciphertext is not an empty JSON envelope. Legacy data may lack the
 * explicit author stamp, so verify with an already resident key or fail closed.
 * Nothing decrypts for the caller and no new key is acquired. */
async function encryptedHistoryMayReference(db: Reader, worker: { id: string }, sessionIds: string[]): Promise<boolean> {
  const [identity] = await db.$queryRaw<Array<{ createdAt: Date }>>`SELECT created_at AS "createdAt" FROM workers WHERE id = ${worker.id}`;
  if (!identity) return true;
  const since = identity.createdAt.toISOString();
  const rows = await db.$queryRaw<Array<{ memoryId: string; data: unknown }>>(Prisma.sql`
    SELECT memory_id AS "memoryId", data FROM nodes
    WHERE data ? '__enc' AND (created_at >= ${since}::timestamp OR updated_at >= ${since}::timestamp)
    UNION ALL
    SELECT COALESCE(r.memory_id, n.memory_id) AS "memoryId", r.data FROM node_revisions r
      JOIN nodes n ON n.id = r.node_id
    WHERE r.data ? '__enc' AND r.created_at >= ${since}::timestamp`);
  const identities = new Set([worker.id, ...sessionIds]);
  const contains = (value: unknown): boolean => {
    if (typeof value === 'string') return identities.has(value);
    if (Array.isArray(value)) return value.some(contains);
    return !!value && typeof value === 'object' && Object.values(value).some(contains);
  };
  for (const row of rows) {
    const ciphertext = (row.data as { __enc?: unknown } | null)?.__enc;
    const key = sessionKeyCache.getByMemoryId(row.memoryId);
    if (!key || typeof ciphertext !== 'string' || ciphertext.length === 0) return true;
    try { const decoded = decryptJson(ciphertext, key); if (decoded === null || contains(decoded)) return true; }
    catch { return true; } // cannot establish never-used from unreadable history
  }
  return false;
}

/** Call only after staffing authorization; never return this census to callers. */
export async function miscastHasReferences(db: Reader, worker: { id: string; memoryId: string | null; heldByUserId: string | null }): Promise<boolean> {
  const sessions = await db.session.findMany({ where: { workerId: worker.id } });
  const sessionIds = sessions.map((s) => s.id);
  if (sessions.some((s) => s.endedAt === null) || (sessions.length > 0 && worker.heldByUserId !== null)) return true;
  // Tool/transcript location alone is binding metadata; recorded work is use.
  if (sessions.some((s) => s.prNumber !== null || s.summary !== null || s.plan !== null || s.outcome !== null || s.outcomeRef !== null || s.outcomeMeta !== null
    || [s.inputTokens, s.outputTokens, s.turnCount, s.errorCount].some((n) => n !== null && n !== 0) || s.launchOperationId !== null)) return true;
  for (const ref of workerReferenceInventory) {
    if (ref.model === 'Session') continue; // empty ended bindings are disposable
    const rows = await db.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
      SELECT EXISTS (SELECT 1 FROM ${quoted(ref.table)} WHERE ${quoted(ref.column)} = ${worker.id}) AS present`);
    if (rows[0].present) return true;
  }
  if (sessionIds.length) {
    for (const model of Prisma.dmmf.datamodel.models) {
      for (const field of model.fields.filter((f) => f.kind === 'scalar' && /sessionId$/i.test(f.name))) {
        const rows = await db.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
          SELECT EXISTS (SELECT 1 FROM ${quoted(model.dbName ?? model.name)}
          WHERE ${quoted(field.dbName ?? field.name)} IN (${Prisma.join(sessionIds)})) AS present`);
        if (rows[0].present) return true;
      }
    }
  }
  for (const [table, column] of JSON_REFERENCES) {
    if (await jsonReferences(db, table, column, [worker.id, ...sessionIds])) return true;
  }
  if (await encryptedHistoryMayReference(db, worker, sessionIds)) return true;
  const commentRows = await db.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM comment_meta WHERE author_key = ${`w:${worker.id}`} OR retracted_by = ${`w:${worker.id}`}
      OR resolved_by = ${`w:${worker.id}`} OR thread_deleted_by = ${`w:${worker.id}`}) AS present`);
  if (commentRows[0].present) return true;
  return !!(worker.memoryId && (await db.node.count({ where: { memoryId: worker.memoryId } })
    || await db.asset.count({ where: { memoryId: worker.memoryId } })));
}
