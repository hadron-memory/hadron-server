import type { Prisma } from '../../generated/prisma/index.js';

/**
 * A stable authority domain, rather than a particular grant row. A grant
 * writer holds the anchor shared; every revoker of authority in that domain
 * holds it exclusively until its transaction commits. Collisions in the two
 * hashtext keys can delay an unrelated operation but cannot permit a race.
 */
export interface AuthorityAnchor {
  kind: 'org' | 'memory' | 'app' | 'user' | 'connection' | 'invitation' | 'agent';
  id: string;
}

/** A SERIALIZABLE attempt observed an authority-dependent row set from before an anchor wait. */
export class AuthoritySnapshotStale extends Error {
  constructor() {
    super('Authority snapshot is stale; retry the transaction');
    this.name = 'AuthoritySnapshotStale';
  }
}

type LockTx = Pick<Prisma.TransactionClient, '$executeRaw'>;

function orderedAnchors(anchors: readonly AuthorityAnchor[]): AuthorityAnchor[] {
  const unique = new Map<string, AuthorityAnchor>();
  for (const anchor of anchors) {
    if (!anchor.id) throw new Error('Authority anchor id is required');
    unique.set(`${anchor.kind}:${anchor.id}`, anchor);
  }
  return [...unique.values()].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/** Acquire every anchor in one order so multi-anchor operations cannot cycle. */
export async function lockAuthorityAnchors(
  tx: LockTx,
  anchors: readonly AuthorityAnchor[],
  mode: 'shared' | 'exclusive',
): Promise<void> {
  for (const anchor of orderedAnchors(anchors)) {
    const domain = `authorization:${anchor.kind}`;
    if (mode === 'shared') {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${domain}), hashtext(${anchor.id}))`;
    } else {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${domain}), hashtext(${anchor.id}))`;
    }
  }
}
