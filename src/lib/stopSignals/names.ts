/**
 * #2022 (Uma #2166 P2-1, P2-2) — the public names a stop-signal refusal or listing shows beside the ids: a worker's
 * name and URN, a person's handle, a host's id and label. Read in one query per kind, inside the caller's App only, so
 * a refusal never names anything outside it. Missing rows fall back to the id.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { composeWorkerUrn } from '../entityRef/workerRef.js';
import { normalizeUrnForLookup } from '../urn.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type StopNames = {
  worker: (id: string | null) => { name: string; urn: string | null } | null;
  user: (id: string | null) => string | null;
  host: (registrationId: string | null) => { hostId: string; label: string } | null;
};

export async function stopNames(
  db: Db,
  appId: string,
  ids: { workerIds?: (string | null)[]; userIds?: (string | null)[]; registrationIds?: (string | null)[] },
): Promise<StopNames> {
  const clean = (xs?: (string | null)[]) => [...new Set((xs ?? []).filter((x): x is string => !!x))];
  const [app, workers, users, hosts] = await Promise.all([
    db.app.findUnique({ where: { id: appId }, select: { urn: true } }),
    clean(ids.workerIds).length ? db.worker.findMany({ where: { appId, id: { in: clean(ids.workerIds) } }, select: { id: true, name: true, slug: true } }) : [],
    clean(ids.userIds).length ? db.user.findMany({ where: { id: { in: clean(ids.userIds) } }, select: { id: true, handle: true } }) : [],
    clean(ids.registrationIds).length ? db.hostRegistration.findMany({ where: { appId, id: { in: clean(ids.registrationIds) } }, select: { id: true, hostId: true, label: true } }) : [],
  ]);
  const urnOf = (slug: string): string | null => {
    try {
      return app?.urn ? composeWorkerUrn(normalizeUrnForLookup(app.urn), slug) : null;
    } catch {
      return null;
    }
  };
  const w = new Map(workers.map((x) => [x.id, { name: x.name, urn: urnOf(x.slug) }]));
  const u = new Map(users.map((x) => [x.id, x.handle]));
  const h = new Map(hosts.map((x) => [x.id, { hostId: x.hostId, label: x.label }]));
  return {
    worker: (id) => (id ? w.get(id) ?? null : null),
    user: (id) => (id ? u.get(id) ?? null : null),
    host: (id) => (id ? h.get(id) ?? null : null),
  };
}
