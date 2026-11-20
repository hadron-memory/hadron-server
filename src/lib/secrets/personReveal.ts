/**
 * #3998 (S3 of #3991, cor:sec:060, ruling R5/Q23): a PERSON who holds a read client reveals only on the server-hosted passkey
 * page, never through an API token. One passkey assertion over a challenge bound to the client id AND this ceremony id spends one
 * unbound `SECRET_REVEAL` ceremony and proves who is reading; the reveal then runs as that person, once. Any ceremony problem is
 * the one `CeremonyRefused`; past it, the reveal's own typed refusals stand (the caller has proven they hold a passkey).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { decideCeremonyAssertion, verifyCeremonyAssertion } from '../passkeys/ceremony.js';
import { CeremonyRefused } from '../signing/signingCeremony.js';
import type { AssertionParts } from '../signing/verify.js';
import { revealForPersonHolder, type RevealResult } from './readClientReveal.js';

export const SECRET_REVEAL_TTL_SECONDS = 300;

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();
const sha256Hex = (b: Uint8Array | string) => sha256(b).toString('hex');

/** The challenge: its own prefix, bound to the client AND the ceremony id, so no other ceremony's assertion replays here. */
export function secretRevealChallenge(clientId: string, ceremonyId: string): Buffer {
  return sha256(`hadron-secret-reveal\nclient ${clientId}\nceremony ${ceremonyId}\n`);
}

/** Open the ceremony for this browser. Reads nothing about the client: the same answer for every id. */
export async function openSecretRevealCeremony(
  db: PrismaClient, input: { clientId: string; browserNonceHash: string },
): Promise<{ ceremonyId: string; challenge: string }> {
  const ceremonyId = randomBytes(32).toString('base64url');
  const challenge = secretRevealChallenge(input.clientId, ceremonyId);
  await db.$executeRaw`INSERT INTO passkey_ceremonies (id, purpose, browser_nonce_hash, challenge_hash, expires_at)
    VALUES (${ceremonyId}, 'SECRET_REVEAL', ${input.browserNonceHash}, ${sha256Hex(challenge)},
            (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${SECRET_REVEAL_TTL_SECONDS}))`;
  return { ceremonyId, challenge: challenge.toString('base64url') };
}

/** Verify the assertion, spend the ceremony, then reveal as the proven person. The value leaves only after the use commits. */
export async function revealForPasskeyPerson(db: PrismaClient, a: {
  clientId: string; ceremonyId: string; browserNonceHash: string; credentialId: Buffer; assertion: AssertionParts; rpId: string; origins: string[];
}): Promise<RevealResult> {
  const [cred] = await db.$queryRaw<Array<{ id: string; owner_id: string; credential_id: Buffer; public_key: Buffer; counter: bigint; revoked_at: Date | null; enrollment_rp_id: string }>>`
    SELECT id, owner_id, credential_id, public_key, counter, revoked_at, enrollment_rp_id FROM passkey_credentials WHERE credential_id = ${a.credentialId}`;
  if (!cred || cred.revoked_at !== null || cred.enrollment_rp_id !== a.rpId) throw new CeremonyRefused();
  let verified;
  try {
    verified = await verifyCeremonyAssertion({
      assertion: a.assertion,
      credential: { passkeyId: cred.id, ownerId: cred.owner_id, credentialId: cred.credential_id, publicKey: cred.public_key, counter: cred.counter },
      expectedChallenge: secretRevealChallenge(a.clientId, a.ceremonyId), rpId: a.rpId, origins: a.origins,
    });
  } catch { throw new CeremonyRefused(); }
  const userId = await db.$transaction(async (tx) => {
    const decided = await decideCeremonyAssertion(tx, { ceremonyId: a.ceremonyId, browserNonceHash: a.browserNonceHash, purpose: 'SECRET_REVEAL', verified: verified.snapshot });
    if (!decided || decided.ownerId !== cred.owner_id) throw new CeremonyRefused();
    return decided.ownerId;
  });
  const user = await db.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true, roles: true } });
  if (!user) throw new CeremonyRefused();
  return revealForPersonHolder({ db, userId: user.id, roles: user.roles } as unknown as Context, a.clientId);
}
