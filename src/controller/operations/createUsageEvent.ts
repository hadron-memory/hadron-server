import { UsageEvent } from '../../index.d.js'
import { db } from '../../db/client.js';
import { serializeJson } from '../../db/provider.js';

export const createUsageEvent = async (
  event: UsageEvent,
): Promise<{ event?: UsageEvent, error?: string }> => {
  // todo: save event to db
  if (!event.type) {
    return { error: 'Missing event.type' };
  }

  try {
    const node = event.nodeLoc
      ? await db.node.findUnique({ where: { loc: event.nodeLoc } })
      : null;

    const savedEvent = await db.usageEvent.create({
      data: {
        type: event.type,
        nodeLoc: event.nodeLoc,
        nodeId: node?.id,
        actionArgs: serializeJson(event.actionArgs) as typeof event.actionArgs,
        clientId: event.clientId,
        sessionId: event.sessionId,
      },
    });

    return { event: savedEvent };
  } catch (error) {
    console.error('Usage ingest error:', error);
    return { error: error.message };
  }
}
