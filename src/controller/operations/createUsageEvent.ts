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
      ? await db.node.findFirst({ where: { loc: event.nodeLoc, isLink: false } })
        ?? await db.node.findFirst({ where: { loc: event.nodeLoc } })
      : null;

    // Caller identity: appId for App-keyed callers; stationId for the
    // legacy Station-keyed fallback. Phase 3a of 003-station-to-app
    // populates appId for every new App-provisioned workspace.
    // createdBy carries whichever identity is set (App wins when both).
    const callerId = event.appId ?? event.stationId ?? null;
    const savedEvent = await db.usageEvent.create({
      data: {
        id: generateId(),
        type: event.type,
        nodeLoc: event.nodeLoc ?? null,
        nodeId: node?.id,
        actionArgs: serializeJson(event.actionArgs) as InputJsonValue | undefined,
        appId: event.appId ?? null,
        stationId: event.stationId ?? null,
        createdBy: callerId,
        sessionId: event.sessionId ?? null,
      },
    });

    return { event: savedEvent as unknown as UsageEvent };
  } catch (error) {
    console.error('Usage ingest error:', error);
    return { error: (error as Error).message };
  }
};
