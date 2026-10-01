import type { PrismaClient } from '../../generated/prisma/index.js';
import { AuthoritySnapshotStale } from './authorityAnchors.js';

type InvitationDb = Pick<PrismaClient, 'userInvitation' | 'orgMemberInvitation'>;

/**
 * A SERIALIZABLE revoker can acquire the org anchor after a writer commits
 * yet retain its pre-wait snapshot. Compare the invitation IDs against a
 * second READ COMMITTED connection while the exclusive anchor is held. A
 * mismatch aborts the entire removal and retries it with a new snapshot.
 */
export async function assertIssuerInvitationSnapshotFresh(
  tx: InvitationDb,
  freshDb: InvitationDb,
  orgId: string,
  issuerUserId: string,
): Promise<void> {
  const userWhere = { organizationId: orgId, senderUserId: issuerUserId, deletedAt: null };
  const memberWhere = {
    sender: { organizationId: orgId, userId: issuerUserId }, acceptedAt: null, deletedAt: null,
  };
  const snapshot = [
    ...(await tx.userInvitation.findMany({ where: userWhere, select: { id: true } })).map((r) => `user:${r.id}`),
    ...(await tx.orgMemberInvitation.findMany({ where: memberWhere, select: { id: true } })).map((r) => `member:${r.id}`),
  ].sort();
  const fresh = [
    ...(await freshDb.userInvitation.findMany({ where: userWhere, select: { id: true } })).map((r) => `user:${r.id}`),
    ...(await freshDb.orgMemberInvitation.findMany({ where: memberWhere, select: { id: true } })).map((r) => `member:${r.id}`),
  ].sort();
  if (snapshot.length !== fresh.length || snapshot.some((id, i) => id !== fresh[i])) {
    throw new AuthoritySnapshotStale();
  }
}

/** Revoke invitations whose issuer no longer has authority in this org. */
export async function revokeOrgInvitationsByIssuer(
  tx: InvitationDb,
  orgId: string,
  issuerUserId: string,
  deletedBy: string | null,
): Promise<void> {
  const data = { deletedAt: new Date(), deletedBy };
  await tx.userInvitation.updateMany({
    where: { organizationId: orgId, senderUserId: issuerUserId, deletedAt: null },
    data,
  });
  await tx.orgMemberInvitation.updateMany({
    where: {
      sender: { organizationId: orgId, userId: issuerUserId },
      acceptedAt: null,
      deletedAt: null,
    },
    data,
  });
}

/** Org deletion invalidates every outstanding invitation for the org. */
export async function revokeAllOrgInvitations(
  tx: InvitationDb,
  orgId: string,
  deletedBy: string | null,
): Promise<void> {
  const data = { deletedAt: new Date(), deletedBy };
  await tx.userInvitation.updateMany({
    where: { organizationId: orgId, deletedAt: null },
    data,
  });
  await tx.orgMemberInvitation.updateMany({
    where: { sender: { organizationId: orgId }, acceptedAt: null, deletedAt: null },
    data,
  });
}
