/** #3496 — plaintext operational state, outside the revisioned node row.
 * The caller must already hold the root's advisory path lock for every seed/write.
 * cor:dmo:060:04 excludes operational state; cor:sec:040:03 classification is recorded on #3496.
 */
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import { decryptNodeFields, encryptNodeFields, type MemoryEncryptionInfo } from './nodeCrypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
export interface ChatCounter {
    messageCount: number;
    lastMessageAt: string | null;
}
export function chatDataObject(data: unknown): Record<string, unknown> {
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
}
export function legacyMessageCount(data: unknown): number {
    const n = chatDataObject(data).messageCount;
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 2147483647 ? n : 0;
}
/** PostgreSQL's parser, like the migration (including its finite-value rule).
 * A savepoint confines a malformed tenant timestamp without poisoning the enclosing transaction.
 * Only input errors are converted to null; database outages still surface.
 */
async function legacyTime(tx: Prisma.TransactionClient, data: unknown): Promise<string | null> {
    const value = chatDataObject(data).lastMessageAt;
    if (typeof value !== 'string')
        return null;
    await tx.$executeRawUnsafe('SAVEPOINT chat_counter_time');
    try {
        const [row] = await tx.$queryRaw<Array<{value: string|null}>>`
          SELECT CASE WHEN isfinite(${value}::timestamptz) THEN
            to_char((${value}::timestamptz AT TIME ZONE 'UTC')::timestamp(3),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ||
            CASE WHEN extract(year FROM (${value}::timestamptz AT TIME ZONE 'UTC')::timestamp(3))<0 THEN ' BC' ELSE '' END ELSE NULL END AS value`;
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT chat_counter_time');
        return row?.value ?? null;
    }
    catch (e) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT chat_counter_time');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT chat_counter_time');
        const code = e instanceof Prisma.PrismaClientKnownRequestError ? e.meta?.code : undefined;
        if (typeof code === 'string' && code.startsWith('22'))
            return null;
        throw e;
    }
}
/** Seed iff absent, for plaintext AND encrypted roots, then scrub inert legacy keys.
 * The conditional marker is calculated in the strip statement, from the pre-write row.
 * Never combine this refresh with an ordinary root-data edit: that would launder #3501 drift.
 */
export async function lockedChatCounter(tx: Prisma.TransactionClient, rootId: string, info: MemoryEncryptionInfo, data: unknown): Promise<ChatCounter> {
    let row = (await counterRows(tx,[rootId]))[0];
    if (!row) {
        const count=legacyMessageCount(data);
        const time=await legacyTime(tx,data);
        await tx.$executeRaw`INSERT INTO chat_root_counters(chat_root_node_id,message_count,last_message_at,updated_at)
          VALUES (${rootId},${count},${time}::timestamptz AT TIME ZONE 'UTC',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          ON CONFLICT DO NOTHING`;
        row = (await counterRows(tx,[rootId]))[0]!;
    }
    const object = chatDataObject(data);
    if (Object.hasOwn(object, 'messageCount') || Object.hasOwn(object, 'lastMessageAt')) {
        const clean = { ...object };
        delete clean.messageCount;
        delete clean.lastMessageAt;
        const stored = encryptNodeFields({ data: clean }, info).data;
        await tx.$executeRaw `UPDATE nodes n SET data=${JSON.stringify(stored)}::jsonb,
      revision_content_hash=CASE WHEN n.revision_content_hash=hadron_node_revision_state_hash(n)
        THEN 'refresh' ELSE n.revision_content_hash END WHERE n.id=${rootId}`;
    }
    return { messageCount: row.messageCount, lastMessageAt: row.lastMessageAt };
}
export async function setChatCounterTime(tx: Prisma.TransactionClient, id: string, value: unknown): Promise<void> {
    const time=await legacyTime(tx,{lastMessageAt:value});
    await tx.$executeRaw`UPDATE chat_root_counters SET last_message_at=${time}::timestamptz AT TIME ZONE 'UTC',
      updated_at=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE chat_root_node_id=${id}`;
}
/** Keep PostgreSQL's entire finite timestamp domain out of JS Date/Prisma DateTime decoding.
 * The public field is a String. Normal dates retain the existing ISO-millisecond spelling;
 * PostgreSQL's BC suffix is retained for an era that cannot be represented by the normal spelling.
 */
async function counterRows(db: Pick<PrismaClient,'$queryRaw'>, ids:readonly string[]):Promise<(ChatCounter & {chatRootNodeId:string})[]> {
    if(!ids.length)return [];
    return db.$queryRaw(Prisma.sql`SELECT chat_root_node_id AS "chatRootNodeId",message_count AS "messageCount",
      CASE WHEN last_message_at IS NULL THEN NULL ELSE
        to_char(last_message_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ||
        CASE WHEN extract(year FROM last_message_at)<0 THEN ' BC' ELSE '' END END AS "lastMessageAt"
      FROM chat_root_counters WHERE chat_root_node_id IN (${Prisma.join([...ids])})`);
}
/** Read only after the root's existing access gate. Row lookups and encryption metadata are batched.
 * A locked memory always answers 0/null, even when its plaintext counter exists.
 * Row-less legacy timestamps use the same PostgreSQL parser in one read-only transaction.
 */
export async function readChatCounters(db: PrismaClient, roots: readonly {
    id: string;
    memoryId: string;
    data: unknown;
}[], sessionId?: string): Promise<Map<string, ChatCounter>> {
    if (!roots.length)
        return new Map();
    const [rows, memories] = await Promise.all([
        counterRows(db,roots.map(r=>r.id)),
        db.memory.findMany({ where: { id: { in: [...new Set(roots.map(r => r.memoryId))] } }, select: { id: true, isEncrypted: true } }),
    ]);
    const byId = new Map(rows.map(r => [r.chatRootNodeId, r]));
    const mem = new Map(memories.map(m => [m.id, m]));
    const result = new Map<string, ChatCounter>();
    const legacy: {
        rootId: string;
        data: unknown;
    }[] = [];
    for (const root of roots) {
        const info = mem.get(root.memoryId);
        if (!info || (info.isEncrypted && !sessionKeyCache.hasForSession(info.id, sessionId))) {
            result.set(root.id, { messageCount: 0, lastMessageAt: null });
            continue;
        }
        const row = byId.get(root.id);
        if (row) {
            result.set(root.id, { messageCount: row.messageCount, lastMessageAt: row.lastMessageAt });
            continue;
        }
        const data = decryptNodeFields({ data: root.data }, info).data;
        result.set(root.id, { messageCount: legacyMessageCount(data), lastMessageAt: null });
        if (typeof chatDataObject(data).lastMessageAt === 'string')
            legacy.push({ rootId: root.id, data });
    }
    if (legacy.length)
        await db.$transaction(async (tx) => {
            for (const item of legacy)
                result.get(item.rootId)!.lastMessageAt = await legacyTime(tx, item.data);
        });
    return result;
}
