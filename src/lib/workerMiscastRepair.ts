/** #1162 / cor:dmo:050:11: private, immutable-id census, including tombstones. */
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
  const commentRows = await db.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM comment_meta WHERE author_key = ${`w:${worker.id}`} OR retracted_by = ${`w:${worker.id}`}
      OR resolved_by = ${`w:${worker.id}`} OR thread_deleted_by = ${`w:${worker.id}`}) AS present`);
  if (commentRows[0].present) return true;
  return !!(worker.memoryId && (await db.node.count({ where: { memoryId: worker.memoryId } })
    || await db.asset.count({ where: { memoryId: worker.memoryId } })));
}
