/**
 * #3125 S1 — `App.properties` and `setAppProperties` (cor:dmo:050:02, cor:dmo:050:20; the task-integration namespace
 * is cor:agt:120:01).
 *
 * Write gate (V33): whoever manages the App (`actorManagesApp`, the gate of the App's ticker and delivery settings,
 * cor:agt:080:19), a person acting as themselves; a worker session, an App key and an impersonation are refused. The
 * gate is judged first, inside the App's EXCLUSIVE write transaction, so a caller who doesn't manage the App gets the
 * same refusal whatever the object holds. Read gate: whoever may read the App (the App type's own gate).
 *
 * A write replaces the whole object (V34); `expectedRevision`, when sent, must equal the stored `propertiesRevision`.
 * An empty object is stored as null. A write that changes nothing leaves the row (and its revision) as it was and records no event; a changing write
 * moves the revision by one and appends `app.properties-changed` naming the changed top-level keys (V43).
 */
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { actorManagesApp, resolveParticipatedApp, resolveTaskWorkerId, taskError } from './resolvers.agentTask.js';
import { writeInApp } from './resolvers.ticker.js';
import { appendAppPropertiesChangedEvent, eventActor } from '../../../lib/agentTasks/events.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';
import {
  TASK_INTEGRATIONS_KEY,
  changedTopLevelKeys,
  checkAppPropertiesShape,
  normalizeTaskIntegrations,
  projectAppProperties,
} from '../../../lib/appProperties.js';

type AppPropertiesRow = { id: string; properties?: unknown; propertiesRevision?: number };

async function storedProperties(ctx: Context, a: AppPropertiesRow): Promise<{ properties: unknown; propertiesRevision: number }> {
  if (a.properties !== undefined && a.propertiesRevision !== undefined) {
    return { properties: a.properties, propertiesRevision: a.propertiesRevision };
  }
  const row = await ctx.db.app.findUnique({ where: { id: a.id }, select: { properties: true, propertiesRevision: true } });
  return { properties: row?.properties ?? null, propertiesRevision: row?.propertiesRevision ?? 0 };
}

async function leadUrns(ctx: Context, workerIds: string[]): Promise<Map<string, string>> {
  const rows = await ctx.db.worker.findMany({
    where: { id: { in: workerIds } },
    select: { id: true, slug: true, app: { select: { urn: true } } },
  });
  return new Map(rows.map((w) => [w.id, composeWorkerUrn(w.app.urn, w.slug)]));
}

export const appPropertiesTypeResolvers = {
  properties: async (a: AppPropertiesRow, _: unknown, ctx: Context) =>
    projectAppProperties((await storedProperties(ctx, a)).properties, (ids) => leadUrns(ctx, ids)),
  propertiesRevision: async (a: AppPropertiesRow, _: unknown, ctx: Context) =>
    (await storedProperties(ctx, a)).propertiesRevision,
};

export async function writeAppProperties(
  ctx: Context, appRef: string, rawProperties: unknown, expectedRevision: number | null | undefined,
) {
  const { app, actor } = await resolveParticipatedApp(ctx, appRef);
  return writeInApp(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.'), async (tx, txCtx, fresh) => {
    if (!(await actorManagesApp(txCtx, fresh, actor))) {
      throw taskError('FORBIDDEN', 'Only whoever manages this App can change its properties.');
    }
    let next: Prisma.InputJsonObject | null = null;
    if (rawProperties !== null && rawProperties !== undefined) {
      const shaped = checkAppPropertiesShape(rawProperties);
      if (TASK_INTEGRATIONS_KEY in shaped) {
        // #3125 Ask 5: task integrations reach GitHub through the organization's installation; an App with no
        // organization has none, so it may not hold them (Holger may veto).
        if (!fresh.organizationId) {
          throw taskError(
            'TASK_INTEGRATION_ORG_REQUIRED',
            'Task integrations need an App that belongs to an organization. Nothing was changed.',
          );
        }
        const integrations = await normalizeTaskIntegrations(shaped[TASK_INTEGRATIONS_KEY], async (ref) => {
          const id = await resolveTaskWorkerId(txCtx, fresh.id, ref);
          if (!id) return null;
          const w = await tx.worker.findUnique({ where: { id }, select: { appId: true, retiredAt: true } });
          return w && w.appId === fresh.id && !w.retiredAt ? id : null;
        });
        next = { ...shaped, [TASK_INTEGRATIONS_KEY]: integrations as unknown as Prisma.InputJsonArray };
      } else {
        next = shaped;
      }
    }
    const cur = await tx.app.findUniqueOrThrow({ where: { id: fresh.id }, select: { properties: true, propertiesRevision: true } });
    if (expectedRevision != null && expectedRevision !== cur.propertiesRevision) {
      throw taskError(
        'APP_PROPERTIES_CONFLICT',
        `The App's properties changed since revision ${expectedRevision} (now ${cur.propertiesRevision}). Read them again and resend. Nothing was changed.`,
        { currentRevision: cur.propertiesRevision },
      );
    }
    // An empty object holds nothing, so it is stored as no properties: a write changes the row only when a key changed.
    if (next !== null && Object.keys(next).length === 0) next = null;
    const keys = changedTopLevelKeys(cur.properties as Record<string, unknown> | null, next as Record<string, unknown> | null);
    if (keys.length > 0) {
      const moved = await tx.app.updateMany({
        where: { id: fresh.id, propertiesRevision: cur.propertiesRevision },
        data: { properties: next ?? Prisma.DbNull, propertiesRevision: { increment: 1 } },
      });
      if (moved.count !== 1) {
        throw taskError('APP_PROPERTIES_CONFLICT', 'The App\'s properties changed during this write. Read them again and resend. Nothing was changed.');
      }
      await appendAppPropertiesChangedEvent(tx, { appId: fresh.id, actor: eventActor(txCtx.userId), keys });
    }
    return tx.app.findUniqueOrThrow({ where: { id: fresh.id } });
  }, { lockMode: 'exclusive' });
}

export const appPropertiesMutations = {
  setAppProperties: async (
    _: unknown,
    { appRef, properties, expectedRevision }: { appRef: string; properties?: unknown; expectedRevision?: number | null },
    ctx: Context,
  ) => writeAppProperties(ctx, appRef, properties ?? null, expectedRevision),
};
