import type { UsageEvent } from '../../index.d.js';
import type { InputJsonValue } from '../../generated/prisma/runtime/library.js';
import { db } from '../../integrations/db/client.js';
import { serializeJson } from '../../integrations/db/provider.js';

export const createUsageEvent = async (
  event: Partial<UsageEvent>,
): Promise<{ event?: UsageEvent; error?: string }> => {
  if (!event.type) {
    return { error: 'Missing event.type' };
  }

  try {
    const node = event.nodeLoc
      ? await db.node.findFirst({ where: { loc: event.nodeLoc, isLink: false } })
        ?? await db.node.findFirst({ where: { loc: event.nodeLoc } })
      : null;

    const savedEvent = await db.usageEvent.create({
      data: {
        type: event.type,
        nodeLoc: event.nodeLoc ?? null,
        nodeId: node?.id,
        actionArgs: serializeJson(event.actionArgs) as InputJsonValue | undefined,
        clientId: event.clientId ?? null,
        sessionId: event.sessionId ?? null,
      },
    });

    return { event: savedEvent as unknown as UsageEvent };
  } catch (error) {
    console.error('Usage ingest error:', error);
    return { error: (error as Error).message };
  }
};
