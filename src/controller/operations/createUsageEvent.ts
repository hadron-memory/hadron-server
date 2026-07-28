import type { UsageEvent } from '../../index.d.js';
import type { InputJsonValue } from '../../generated/prisma/runtime/library.js';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../../lib/id.js';
import { serializeJson } from '../../integrations/db/provider.js';

export const createUsageEvent = async (
  event: Partial<UsageEvent>,
): Promise<{ event?: UsageEvent; error?: string }> => {
  if (!event.type) {
    return { error: 'Missing event.type' };
  }

  try {
    const node = event.nodeLoc
      // loc-scope-ok: #825 — unscoped + unauthorized attribution, tracked; fix takes a node ref
      ? await db.node.findFirst({ where: { loc: event.nodeLoc, isLink: false } })
        // loc-scope-ok: #825 — same tracked call site (fallback branch)
        ?? await db.node.findFirst({ where: { loc: event.nodeLoc } })
      : null;

    const savedEvent = await db.usageEvent.create({
      data: {
        id: generateId(),
        type: event.type,
        nodeLoc: event.nodeLoc ?? null,
        nodeId: node?.id,
        // #796: derived from the same row `nodeId` comes from — inherits this
        // path's cross-memory loc ambiguity and nothing more (as in recordUsage).
        memoryId: node?.memoryId,
        actionArgs: serializeJson(event.actionArgs) as InputJsonValue | undefined,
        appId: event.appId ?? null,
        createdBy: event.appId ?? null,
        sessionId: event.sessionId ?? null,
      },
    });

    return { event: savedEvent as unknown as UsageEvent };
  } catch (error) {
    console.error('Usage ingest error:', error);
    return { error: (error as Error).message };
  }
};
