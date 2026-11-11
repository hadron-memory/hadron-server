/**
 * #3932 — one place that knows an AI service config's owner shape: which owner, its stored urn, and its
 * organization. Used by the `AiServiceConfig.urn` field (batched, one query per owner kind per tick) and by the
 * `aiconf` arm of `resolveUrn`. Reads only the owner's own identity columns.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { currentHadronServerId } from './hadronServer.js';

export type AiConfigOwnerType = 'HADRON_SERVER' | 'ORGANIZATION' | 'APP' | 'AGENT';
export type AiConfigOwnerRef = { ownerType: AiConfigOwnerType; ownerId: string };
/** `urn` is null for a HadronServer owner (the reserved root has none); `current` only means something for it. */
export type AiConfigOwnerInfo = { ownerType: AiConfigOwnerType; urn: string | null; organizationId: string | null; current: boolean };

export const aiConfigOwnerKey = (r: AiConfigOwnerRef) => `${r.ownerType}:${r.ownerId}`;

type Db = Pick<PrismaClient, 'hadronServer' | 'organization' | 'app' | 'agent'>;

/** Owner info for a set of refs: at most one query per owner kind. A missing owner is absent from the map. */
export async function loadAiConfigOwners(db: Db, refs: AiConfigOwnerRef[]): Promise<Map<string, AiConfigOwnerInfo>> {
  const ids = (t: AiConfigOwnerType) => [...new Set(refs.filter((r) => r.ownerType === t).map((r) => r.ownerId))];
  const out = new Map<string, AiConfigOwnerInfo>();
  // #3958 (decided, F5): the four kind queries run together and fail together. One failing kind rejects the whole
  // load, so every row's `urn` in the tick errors rather than reading as a quiet null that a consumer cannot tell
  // apart from "this config has no URN" (cor:urn:010:01 point 6).
  const [servers, orgs, apps, agents] = await Promise.all([
    ids('HADRON_SERVER').length ? currentHadronServerId(db) : Promise.resolve(null),
    ids('ORGANIZATION').length ? db.organization.findMany({ where: { id: { in: ids('ORGANIZATION') } }, select: { id: true, urn: true } }) : [],
    ids('APP').length ? db.app.findMany({ where: { id: { in: ids('APP') } }, select: { id: true, urn: true, organizationId: true } }) : [],
    ids('AGENT').length ? db.agent.findMany({ where: { id: { in: ids('AGENT') } }, select: { id: true, urn: true, organizationId: true } }) : [],
  ]);
  for (const id of ids('HADRON_SERVER')) {
    out.set(aiConfigOwnerKey({ ownerType: 'HADRON_SERVER', ownerId: id }), { ownerType: 'HADRON_SERVER', urn: null, organizationId: null, current: servers === id });
  }
  for (const o of orgs) out.set(aiConfigOwnerKey({ ownerType: 'ORGANIZATION', ownerId: o.id }), { ownerType: 'ORGANIZATION', urn: o.urn, organizationId: o.id, current: true });
  for (const a of apps) out.set(aiConfigOwnerKey({ ownerType: 'APP', ownerId: a.id }), { ownerType: 'APP', urn: a.urn, organizationId: a.organizationId ?? null, current: true });
  for (const a of agents) out.set(aiConfigOwnerKey({ ownerType: 'AGENT', ownerId: a.id }), { ownerType: 'AGENT', urn: a.urn, organizationId: a.organizationId ?? null, current: true });
  return out;
}
