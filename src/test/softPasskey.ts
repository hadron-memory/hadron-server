/**
 * #1632 — a software WebAuthn authenticator for tests: a real P-256 key, a
 * COSE public key for passkey_credentials, and assertions built byte by byte
 * (authenticatorData, clientDataJSON, a DER ECDSA signature over
 * authenticatorData || SHA-256(clientDataJSON)). Every knob a refusal test
 * needs (origin, RP ID, UV, type, challenge payload) is explicit.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/index.js';
import { generateId } from '../lib/id.js';
import { passkeyRpId } from '../lib/signing/config.js';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

function coseEs256(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  // CBOR map(5): {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x,
    Buffer.from([0x22, 0x58, 0x20]), y,
  ]);
}

export interface SoftPasskey {
  credentialId: Buffer;
  cosePublicKey: Buffer;
  assert(opts: { payload: Buffer; rawChallenge?: Buffer; origin: string; rpId: string; uv?: boolean; type?: string; counter?: number }): {
    authenticatorData: Buffer; clientDataJson: Buffer; signature: Buffer;
  };
}

export function softPasskey(): SoftPasskey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    credentialId: randomBytes(16),
    cosePublicKey: coseEs256(publicKey),
    assert({ payload, rawChallenge, origin, rpId, uv = true, type = 'webauthn.get', counter = 0 }) {
      const counterBytes = Buffer.alloc(4);
      counterBytes.writeUInt32BE(counter);
      const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([0x01 | (uv ? 0x04 : 0)]), counterBytes]);
      const clientDataJson = Buffer.from(JSON.stringify({
        type, challenge: (rawChallenge ?? sha256(payload)).toString('base64url'), origin, crossOrigin: false,
      }));
      const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJson)]), privateKey);
      return { authenticatorData, clientDataJson, signature };
    },
  };
}

/**
 * Register a soft passkey for `ownerId`; `firstWindow` makes it a first passkey with an open 72h window.
 * `rpId` is its enrollment RP ID, by default the deployment's current one, as a real enrollment records it.
 */
export async function insertSoftPasskey(db: PrismaClient, ownerId: string, key: SoftPasskey, opts: { firstWindow?: boolean; label?: string; rpId?: string } = {}): Promise<string> {
  const id = generateId();
  const first = opts.firstWindow ?? false;
  await db.$executeRaw`INSERT INTO passkey_credentials
    (id, owner_id, credential_id, public_key, algorithm, user_handle, enrollment_rp_id, label, registered_at, counter, transports, backup_eligible, backed_up, registration_method, window_ends_at)
    VALUES (${id}, ${ownerId}, ${key.credentialId}, ${key.cosePublicKey}, -7, ${randomBytes(32)}, ${opts.rpId ?? passkeyRpId()}, ${opts.label ?? 'Soft key'},
      (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3), 0, ARRAY['internal'], false, false,
      ${first ? 'github' : null}, CASE WHEN ${first} THEN (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) + interval '72 hours' ELSE NULL END)`;
  return id;
}
