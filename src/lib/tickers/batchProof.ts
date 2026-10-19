// Batch proofs — #2017 (S1), cor:agt:080:17.
//
// A delivery batch's `id` is a signed proof of exactly what the batch rendered (`BatchProofPayload`, built by
// deliveryBatch.ts): per channel its incarnation, the range it covers and the rendered seqs themselves. The key is
// domain-separated from the wake proof's and the attention token's (K_batch = HMAC-SHA256(secret,
// "hadron-batch-proof-v1")), so none of the three verifies as another. The payload's `batchKey` is the batch's STABLE
// identity, computed by the loader; it authorizes nothing, and a batchKey handed back as an id is invalid. Freshness
// (15 minutes), the requester and the channel incarnations are checked by the acknowledger, which has the database.

import { createHmac } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { attentionTokenSecret } from '../teamAttention.js';
import { safeEqual } from '../constantTime.js';
import { MAX_PROOF_CHARS } from './wakeProof.js';
import type { BatchProofPayload } from './deliveryBatch.js';

/** The most rendered seqs one batch carries, across all its channels (renderBatch's message cap). */
export const BATCH_PROOF_MAX_SEQS = 10;

function batchProofKey(): Buffer {
  return createHmac('sha256', attentionTokenSecret()).update('hadron-batch-proof-v1').digest();
}

export function signBatchProof(payload: BatchProofPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', batchProofKey()).update(body).digest('base64url')}`;
}

const isSeq = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

/** Is this a range the loader could have issued? Seqs strictly ascending, from at or below the first, ending at through. */
function wellFormedChannel(c: Partial<BatchProofPayload['channels'][number]> | null | undefined): boolean {
  if (!c || typeof c.channelId !== 'string' || !Number.isInteger(c.incarnation) || !isSeq(c.from) || !isSeq(c.through)) return false;
  const seqs = c.seqs;
  if (!Array.isArray(seqs) || seqs.length === 0 || !seqs.every(isSeq)) return false;
  for (let i = 1; i < seqs.length; i++) if (seqs[i]! <= seqs[i - 1]!) return false;
  return c.from <= seqs[0]! && seqs[seqs.length - 1] === c.through;
}

/** The id's payload, or WAKE_PROOF_INVALID. Signature first, then kind and version, then shape. */
export function verifyBatchProof(token: unknown): BatchProofPayload {
  const invalid = (): never => {
    throw new GraphQLError('Not a valid delivery batch id.', { extensions: { code: 'WAKE_PROOF_INVALID' } });
  };
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_PROOF_CHARS) return invalid();
  const parts = token.split('.');
  if (parts.length !== 2) return invalid();
  const [body, supplied] = parts as [string, string];
  const expected = createHmac('sha256', batchProofKey()).update(body).digest('base64url');
  if (!safeEqual(supplied, expected)) return invalid();
  let value: Partial<BatchProofPayload>;
  try {
    value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<BatchProofPayload>;
  } catch {
    return invalid();
  }
  if (value.kind !== 'batch-proof' || value.v !== 1) return invalid();
  const channels = value.channels;
  if (
    typeof value.appId !== 'string' || typeof value.workerId !== 'string' || typeof value.hostId !== 'string' ||
    typeof value.issuedAt !== 'number' || typeof value.requester?.appKeyId !== 'string' ||
    typeof value.renderHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.renderHash) ||
    typeof value.batchKey !== 'string' || value.batchKey.length === 0 ||
    !Array.isArray(channels) || channels.length === 0 || !channels.every(wellFormedChannel) ||
    new Set(channels.map((c) => c.channelId)).size !== channels.length ||
    channels.reduce((n, c) => n + c.seqs.length, 0) > BATCH_PROOF_MAX_SEQS
  ) return invalid();
  return value as BatchProofPayload;
}
