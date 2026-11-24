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
 * **Contract: a selector names an existing user.** With `--email` /
 * `--user-id` / `--handle` this mints a token for a user that ALREADY exists
 * and never creates one (issue #300 decision): the operator points the selector
 * at a row that is already there (seeded, or created by a prior browser login)
 * and this hands back a `hdr_user_*` key for it.
 *
 * **The one exception: `--create-service-user <handle>` (#5012, Billing A5).**
 * It creates a SERVICE user (no email, no identity provider, no name) whose only
 * platform role is BILLING, and mints its key — the credential a payment service
 * holds so it no longer needs a platform admin's key. It refuses a handle that
 * is taken in the shared principal pool (a user's or an organization's name).
 *
 * The CLI wrapper lives in `scripts/admin-mint-token.ts`; the testable core is
 * here so it runs under the normal vitest `src/**` set.
 */
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import { mintUserApiKey } from '../middleware/auth.js';
import { isHandleTaken, normalizeHandle } from '../lib/userHandle.js';
import { ensureUserPrincipal, RootNameTakenError } from '../lib/principal/mintPrincipal.js';
import { logUserRolesChanged } from '../lib/auth/userRolesChanged.js';

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

/** Default label of a service user's key (#5012 gate ruling 10.3), unless `--label` is given. */
export const SERVICE_USER_TOKEN_LABEL = 'billing-service';

/** The audit actor of a host-script role change: the script has no authenticated user (#5012 gate ruling 10.4). */
export const HOST_SCRIPT_ACTOR = 'host-script';

/**
 * Create a service user whose only platform role is BILLING, and mint its key (#5012, Billing A5).
 *
 * The user has `email`, `name` and `identityProvider` null (gate ruling 10.3) and `createdBy` null (a host script
 * has no authenticated actor). The handle is validated strictly (`normalizeHandle`: an illegal handle is refused, not
 * replaced by a random one) and must be free in the shared principal pool (`isHandleTaken`, so an organization's name
 * also counts as taken). The user and its principal are created in one transaction; a concurrent claim of the same
 * name (`RootNameTakenError`) gets the same refusal. The key goes through the shared `mintUserApiKey` path with
 * `issuedVia: 'admin'`, labelled `billing-service` unless a label is given. One `user.roles.changed` line is written
 * after the user commits, with the actor `host-script` (gate ruling 10.4).
 */
export async function mintServiceUser(
  db: PrismaClient,
  input: { handle: string },
  opts: { label?: string | null } = {},
): Promise<MintedBootstrapToken> {
  let handle: string;
  try {
    handle = normalizeHandle(input.handle ?? '');
  } catch (err) {
    throw new BootstrapTokenError(
      `"${input.handle}" is not a legal handle: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const taken = () => new BootstrapTokenError(`The handle "${handle}" is already taken; refusing to create a service user.`);

  const user = await db
    .$transaction(async (tx) => {
      if (await isHandleTaken(tx, handle)) throw taken();
      const created = await tx.user.create({
        data: { handle, email: null, name: null, identityProvider: null, roles: ['BILLING'], createdBy: null },
      });
      await ensureUserPrincipal(tx, created);
      return created;
    })
    .catch((err: unknown) => {
      // The pool probe and the inserts are two steps: a concurrent claim of the name loses in the principal pool
      // (RootNameTakenError) or on the users handle index (P2002, the only unique value this insert supplies).
      if (err instanceof RootNameTakenError) throw taken();
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw taken();
      throw err;
    });
  logUserRolesChanged({ actor: HOST_SCRIPT_ACTOR, target: user.id, before: [], after: user.roles });

  const label = opts.label !== undefined && opts.label !== null && opts.label.length > 0
    ? opts.label
    : SERVICE_USER_TOKEN_LABEL;
  const { rawKey } = await mintUserApiKey(db, {
    userId: user.id,
    label,
    createdBy: user.id,
    issuedVia: BOOTSTRAP_ISSUED_VIA,
  });
  return { rawKey, user: { id: user.id, email: user.email, handle: user.handle, name: user.name } };
}

/** What `admin:mint-token` was asked to do. */
export interface MintTokenArgs {
  selector: UserSelector;
  /** `--create-service-user <handle>` (#5012): create a BILLING service user instead of selecting one. */
  serviceUserHandle?: string;
  label?: string;
  help: boolean;
}

/**
 * Parse `admin:mint-token`'s arguments (minimal `--key value` / `--key=value`; no arg-parsing dependency in the
 * repo). `--create-service-user` excludes every selector. Lives here, not in the script, so it runs under vitest.
 */
export function parseMintTokenArgs(argv: string[]): MintTokenArgs {
  const selector: UserSelector = {};
  let serviceUserHandle: string | undefined;
  let label: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineVal = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const valueFor = (): string => {
      if (inlineVal !== undefined) return inlineVal;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new BootstrapTokenError(`Missing value for ${key}.`);
      }
      i++;
      return next;
    };

    switch (key) {
      case '--email':
        selector.email = valueFor();
        break;
      case '--user-id':
        selector.userId = valueFor();
        break;
      case '--handle':
        selector.handle = valueFor();
        break;
      case '--create-service-user':
        serviceUserHandle = valueFor();
        break;
      case '--label':
        label = valueFor();
        break;
      default:
        throw new BootstrapTokenError(`Unknown argument: ${arg}`);
    }
  }

  if (serviceUserHandle !== undefined) {
    const selectors = (['email', 'userId', 'handle'] as const).filter((k) => selector[k] !== undefined);
    if (selectors.length > 0) {
      throw new BootstrapTokenError(
        `--create-service-user creates a new user; it cannot be combined with ${selectors.map((k) => SELECTOR_FLAGS[k]).join(', ')}.`,
      );
    }
  }
  return { selector, serviceUserHandle, label, help };
}
