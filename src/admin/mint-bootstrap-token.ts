/**
 * Host-side bootstrap-token minting (issue #300, Option 3).
 *
 * The remaining server-side piece needed to make the `hadron` CLI fully
 * portal-free. The OAuth Authorization Server (spec 025) already hosts its
 * own consent screen + GitHub/email/Microsoft login, so a self-hoster with a
 * browser and a configured IdP can already obtain a `hdr_user_*` token without
 * the portal. This path covers the case that none of those help: a fresh,
 * portal-less, possibly air-gapped `hadron-server` where an operator with host
 * + DB access needs to mint the very first user credential directly — no
 * browser, no external IdP. After that first token, `hadron auth token create`
 * (hadron-cli#68) covers everything else.
 *
 * **Contract: require an existing user.** This command mints a token for a
 * user that ALREADY exists; it never creates one (issue #300 decision). User
 * provisioning stays a separate concern — the operator points `--email` /
 * `--user-id` / `--handle` at a row that is already there (seeded, or created
 * by a prior browser login) and this hands back a `hdr_user_*` key for it.
 *
 * The CLI wrapper lives in `scripts/admin-mint-token.ts`; the testable core is
 * here so it runs under the normal vitest `src/**` set.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { mintUserApiKey } from '../middleware/auth.js';

/**
 * Exactly one of these identifies the target user. Email is matched
 * case-insensitively (emails are stored lowercased by the email-auth path).
 */
export interface UserSelector {
  email?: string;
  userId?: string;
  handle?: string;
}

export interface MintedBootstrapToken {
  /** The raw `hdr_user_<…>` key — shown once, never recoverable. */
  rawKey: string;
  user: {
    id: string;
    email: string | null;
    handle: string | null;
    name: string | null;
  };
}

/** Default label so the key is recognizable in `hadron auth token ls`. */
export const BOOTSTRAP_TOKEN_LABEL = 'admin-bootstrap';

/**
 * `issuedVia` discriminator for host-minted tokens, parallel to the OAuth
 * path's `oauth:<clientId>` and the portal's `portal`. Lets the audit trail
 * tell a bootstrap key apart from a self-service one.
 */
export const BOOTSTRAP_ISSUED_VIA = 'admin';

/** Thrown for any caller error (bad selector, unknown/deleted user). */
export class BootstrapTokenError extends Error {}

/** Display names for the selector flags, for error messages. */
const SELECTOR_FLAGS = {
  email: '--email',
  userId: '--user-id',
  handle: '--handle',
} as const;

/**
 * Mint a `hdr_user_*` token for an existing user. Resolves the user from
 * exactly one selector, refuses to create or to mint for a soft-deleted row,
 * then delegates to the shared `mintUserApiKey` insert path (FR-015) so the
 * token validates identically to a portal- or OAuth-issued one.
 *
 * `createdBy` is set to the target user's own id: a host script has no
 * authenticated admin identity to attribute, and self-attribution matches the
 * other `mintUserApiKey` callers. The `issuedVia: 'admin'` discriminator is
 * what marks the bootstrap path in the audit trail.
 */
export async function mintBootstrapToken(
  db: PrismaClient,
  selector: UserSelector,
  opts: { label?: string | null } = {},
): Promise<MintedBootstrapToken> {
  // Trim before measuring length so a whitespace-only selector
  // (e.g. `--handle "  "`) counts as absent, not as present-but-empty.
  const provided = (['email', 'userId', 'handle'] as const).filter(
    (k) => typeof selector[k] === 'string' && selector[k]!.trim().length > 0,
  );
  if (provided.length === 0) {
    throw new BootstrapTokenError(
      'Specify exactly one of --email, --user-id, or --handle.',
    );
  }
  if (provided.length > 1) {
    throw new BootstrapTokenError(
      `Specify only one selector; got ${provided.map((k) => SELECTOR_FLAGS[k]).join(', ')}.`,
    );
  }

  // Build the lookup from the single resolved key — NOT a second
  // `!== undefined` chain. The two would disagree when a caller passes an
  // empty string for one selector and a real value for another
  // (`{ email: '', userId: 'x' }`): `provided` resolves to `userId`, but a
  // `selector.email !== undefined` chain would wrongly query by `{ email: '' }`.
  const key = provided[0];
  const value = selector[key]!.trim();
  const where =
    key === 'email'
      ? { email: value.toLowerCase() }
      : key === 'userId'
        ? { id: value }
        : { handle: value };

  const user = await db.user.findUnique({ where });
  if (!user) {
    throw new BootstrapTokenError(
      `No user matches ${SELECTOR_FLAGS[key]}=${value}. This command requires ` +
        'an existing user; it does not create one.',
    );
  }
  if (user.deletedAt) {
    throw new BootstrapTokenError(`User ${user.id} is deleted; refusing to mint.`);
  }

  const label =
    opts.label !== undefined && opts.label !== null && opts.label.length > 0
      ? opts.label
      : BOOTSTRAP_TOKEN_LABEL;

  const { rawKey } = await mintUserApiKey(db, {
    userId: user.id,
    label,
    createdBy: user.id,
    issuedVia: BOOTSTRAP_ISSUED_VIA,
  });

  return {
    rawKey,
    user: {
      id: user.id,
      email: user.email,
      handle: user.handle,
      name: user.name,
    },
  };
}
