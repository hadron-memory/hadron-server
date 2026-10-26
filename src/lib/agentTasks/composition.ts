/** #2061 — pure grouping of already-authorized roster rows, with closed party projections. */
import type { RosterEntry } from './roster.js';
import { composeWorkerUrn } from '../entityRef/workerRef.js';

type Row = Pick<RosterEntry, 'workerId' | 'name' | 'slug' | 'reportsTo' | 'role' | 'family' | 'bound' | 'liveSession' | 'state'> & { appUrn: string };
type Party = { kind: 'WORKER'; id: string; name: string; urn: string };
type Lane = {
  coordinator: Party | null;
  coordinatorRetired: boolean;
  workers: { worker: Party; role: string | null; family: string | null; bound: boolean; liveSession: boolean; state: RosterEntry['state'] }[];
  countsByRole: { role: string | null; count: number }[];
  countsByRoleFamily: { role: string | null; family: string | null; count: number }[];
};
const compare = (a: string | null, b: string | null): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

export function groupComposition(rows: readonly Row[]): Lane[] {
  const lanes = new Map<string | null, Lane>();
  for (const r of rows) {
    const coordinator: Party | null = r.reportsTo ? {
      kind: 'WORKER', id: r.reportsTo.workerId, name: r.reportsTo.name,
      urn: composeWorkerUrn(r.appUrn, r.reportsTo.slug),
    } : null;
    const key = coordinator?.urn ?? null;
    let lane = lanes.get(key);
    if (!lane) {
      lane = { coordinator, coordinatorRetired: r.reportsTo?.retired ?? false, workers: [], countsByRole: [], countsByRoleFamily: [] };
      lanes.set(key, lane);
    }
    lane.workers.push({
      worker: { kind: 'WORKER', id: r.workerId, name: r.name, urn: composeWorkerUrn(r.appUrn, r.slug) },
      role: r.role, family: r.family, bound: r.bound, liveSession: r.liveSession, state: r.state,
    });
  }
  for (const lane of lanes.values()) {
    const roles = new Map<string | null, number>();
    const families = new Map<string | null, Map<string | null, number>>();
    for (const w of lane.workers) {
      roles.set(w.role, (roles.get(w.role) ?? 0) + 1);
      const bucket = families.get(w.role) ?? new Map<string | null, number>();
      bucket.set(w.family, (bucket.get(w.family) ?? 0) + 1);
      families.set(w.role, bucket);
    }
    lane.countsByRole = [...roles].map(([role, count]) => ({ role, count })).sort((a, b) => compare(a.role, b.role));
    lane.countsByRoleFamily = [...families].flatMap(([role, bucket]) =>
      [...bucket].map(([family, count]) => ({ role, family, count })),
    ).sort((a, b) => compare(a.role, b.role) || compare(a.family, b.family));
  }
  return [...lanes.values()].sort((a, b) =>
    compare(a.coordinator?.name.toLowerCase() ?? null, b.coordinator?.name.toLowerCase() ?? null)
    || compare(a.coordinator?.urn ?? null, b.coordinator?.urn ?? null));
}
