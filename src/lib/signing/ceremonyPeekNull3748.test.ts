/**
 * #3748 item 4 (#3737 §10 P3): the pre-anchor read in `spendSigningCeremony` (`signingCeremony.ts`, the
 * `if (!peek?.user_id) throw new CeremonyRefused()` line) only NAMES the signer anchor; when it finds no SIGN ceremony it
 * must refuse BEFORE any anchor is taken. At the route that refusal is indistinguishable from the later one (the same
 * uniform 403), so it is pinned here, at function level, through the exported callers `completeSigning` and
 * `declineSigning`: the answer is `CeremonyRefused` and `lockAuthorityAnchors` is never called.
 *
 * A SIGN ceremony row with a NULL user cannot exist (`chk_passkey_ceremony_registration` requires `user_id` on SIGN),
 * so the reachable "no user" cases are an id with no SIGN row: an unknown id, and a SIGN_PROOF ceremony's id. A control
 * shows the spy is wired: a real SIGN row (bound to a user, for another challenge) does reach the anchor, then is refused.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../../test/helpers.js';
import { createSigningRequestInTransaction } from './requests.js';

const anchorSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../auth/authorityAnchors.js', async (orig) => {
  const m = await orig<typeof import('../auth/authorityAnchors.js')>();
  return {
    ...m,
    lockAuthorityAnchors: (async (...a: Parameters<typeof m.lockAuthorityAnchors>) => {
      anchorSpy.calls += 1;
      return m.lockAuthorityAnchors(...a);
    }) as typeof m.lockAuthorityAnchors,
  };
});
// Imported after the mock is registered, so the module under test sees the spied anchor lock.
const { CeremonyRefused, completeSigning, declineSigning, openProofCeremony } = await import('./signingCeremony.js');

const sha256Hex = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const browser = sha256Hex('peek-null-3748-browser');
const assertion = { authenticatorData: Buffer.alloc(37), clientDataJson: Buffer.from('{}'), signature: Buffer.alloc(64) } as never;

let requestId: string;
let signerId: string;

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'pn-org', graphName: 'pn' });
  const requester = await db.user.create({ data: { handle: 'pn-requester', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: requester.id, role: 'CONTRIBUTOR' } });
  signerId = (await db.user.create({ data: { handle: 'pn-signer', roles: [] } })).id;
  const node = await createDbNode(db, { loc: 'policies:pn', memoryId: graph.id, name: 'Peek null', content: 'Body.\n' });
  requestId = (await db.$transaction((tx) => createSigningRequestInTransaction(tx, node.id, {
    memoryId: graph.id, requester: { userId: requester.id, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true,
  }))).id;
  anchorSpy.calls = 0;
});

afterEach(() => { vi.unstubAllEnvs(); });

const complete = (ceremonyId: string) => completeSigning(db, { requestId, ceremonyId, browserNonceHash: browser, credentialId: Buffer.alloc(16), assertion });
const decline = (ceremonyId: string) => declineSigning(db, { requestId, ceremonyId, browserNonceHash: browser });

describe('#3748 item 4: no SIGN ceremony behind the id refuses before any signer anchor is taken', () => {
  it('an unknown ceremony id: completeSigning and declineSigning refuse, and no anchor lock is taken', async () => {
    const unknown = randomBytes(32).toString('base64url');
    await expect(complete(unknown)).rejects.toBeInstanceOf(CeremonyRefused);
    await expect(decline(unknown)).rejects.toBeInstanceOf(CeremonyRefused);
    expect(anchorSpy.calls).toBe(0);
  });

  it('a SIGN_PROOF ceremony id (it exists, but is not a SIGN ceremony and is never bound): refused, no anchor lock', async () => {
    const { ceremonyId } = await openProofCeremony(db, { requestId, browserNonceHash: browser });
    await expect(complete(ceremonyId)).rejects.toBeInstanceOf(CeremonyRefused);
    await expect(decline(ceremonyId)).rejects.toBeInstanceOf(CeremonyRefused);
    expect(anchorSpy.calls).toBe(0);
  });

  it('control: a real SIGN ceremony (bound to a user, for another challenge) DOES take the anchor, then is refused', async () => {
    const id = randomBytes(32).toString('base64url');
    await db.$executeRaw`INSERT INTO passkey_ceremonies (id, purpose, browser_nonce_hash, challenge_hash, expires_at, user_id, kind)
      VALUES (${id}, 'SIGN', ${browser}, ${sha256Hex('another challenge')},
              (clock_timestamp() AT TIME ZONE 'UTC') + interval '10 minutes', ${signerId}, 'sign')`;
    await expect(complete(id)).rejects.toBeInstanceOf(CeremonyRefused);
    expect(anchorSpy.calls).toBe(1);
  });
});
