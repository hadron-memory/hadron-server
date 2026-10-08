import { createHmac, timingSafeEqual } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import { canonicalizeTeamJson } from './canonicalize.js';
import { ownRecordIssues } from './recordEntries.js';

export const TEAM_RECORD_CODEC = 'hadron.dev/team-record/v1';
const TOKEN_DOMAIN = 'hadron/team-record-token/v1';
const SEAL_DOMAIN = 'hadron/team-record-seal/v1';
const keyId = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const keyedToken = z.string().regex(/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]{43}$/);
const stateSchema = z.strictObject({
  managed: z.record(z.string(), z.strictObject({ token: keyedToken })),
  annotations: z.record(z.string(), z.record(z.string(), z.string())),
  sources: z.record(z.string(), z.array(z.strictObject({
    node: z.string().min(1), revision: z.number().int().positive(), token: keyedToken,
  }))),
  identities: z.record(z.string(), z.strictObject({ agent: z.string().min(1) })),
});
const receiptSchema = z.strictObject({
  planHash: z.string().regex(/^[0-9a-f]{64}$/), userId: z.string().min(1),
  at: z.iso.datetime(), summary: z.record(z.string(), z.number().int().nonnegative()),
});
const envelopeSchema = z.strictObject({
  codec: z.literal(TEAM_RECORD_CODEC), state: stateSchema, receipt: receiptSchema,
  seal: z.strictObject({ keyId, mac: z.string().regex(/^[a-zA-Z0-9_-]{43}$/) }),
});
export type TeamRecordState = z.infer<typeof stateSchema>;
export type TeamRecordReceipt = z.infer<typeof receiptSchema>;
export type TeamRecordEnvelope = z.infer<typeof envelopeSchema>;
export type TeamRecordKeys = { current: string; keys: ReadonlyMap<string, Buffer> };
export type TeamRecordBinding = { appId: string; recordNodeId: string };

/** Unset disables team-record operations only. Never print the supplied secret. */
export function readTeamRecordKeys(text = process.env.TEAM_RECORD_KEYRING): TeamRecordKeys | null {
  if (!text) return null;
  try {
    const raw: unknown = JSON.parse(text);
    const keys = z.record(keyId, z.string().regex(/^[0-9a-f]{64}$/));
    z.strictObject({ current: keyId, keys }).parse(raw);
    const config = raw as { current: string; keys: Record<string, string> };
    if (ownRecordIssues(keys, config.keys).length) throw new Error('invalid key');
    if (!Object.hasOwn(config.keys, config.current)) throw new Error('missing current');
    return { current: config.current, keys: new Map(Object.entries(config.keys).map(([id, hex]) => [id, Buffer.from(hex, 'hex')])) };
  } catch {
    throw new Error('TEAM_RECORD_KEYRING must name a current key and contain 32-byte lowercase-hex keys');
  }
}

const currentKey = (ring: TeamRecordKeys): Buffer => {
  const key = ring.keys.get(ring.current);
  if (!key || key.length !== 32) throw new Error('Invalid team record keyring');
  return key;
};
const mac = (key: Buffer, domain: string, value: unknown) =>
  createHmac('sha256', key).update(domain + '\0', 'utf8').update(canonicalizeTeamJson(value), 'utf8').digest('base64url');
const hasStateKey = (state: TeamRecordState, id: string): boolean =>
  [...Object.values(state.managed).map((v) => v.token), ...Object.values(state.sources).flat().map((v) => v.token)]
    .every((token) => token.startsWith(id + ':'));
const assertState = (state: TeamRecordState): void => {
  stateSchema.parse(state);
  const issues = [
    ...ownRecordIssues(stateSchema.shape.managed, state.managed),
    ...ownRecordIssues(stateSchema.shape.annotations, state.annotations),
    ...ownRecordIssues(stateSchema.shape.sources, state.sources),
    ...ownRecordIssues(stateSchema.shape.identities, state.identities),
  ];
  if (issues.length) throw new z.ZodError(issues);
};
const assertReceipt = (receipt: TeamRecordReceipt): void => {
  receiptSchema.parse(receipt);
  const issues = ownRecordIssues(receiptSchema.shape.summary, receipt.summary);
  if (issues.length) throw new z.ZodError(issues);
};

/** Bind value baselines to the App and field address; never store bare digests. */
export function teamValueToken(ring: TeamRecordKeys, appId: string, address: string, value: unknown, useKey = ring.current): string {
  const key = ring.keys.get(useKey);
  if (!key || key.length !== 32) throw new Error('Unknown team record key');
  return useKey + ':' + mac(key, TOKEN_DOMAIN, { appId, address, value });
}

/** The caller compares/hashes only state; receipt and seal never cause churn. */
export function teamRecordStateText(state: TeamRecordState): string {
  assertState(state);
  return canonicalizeTeamJson(state);
}

/** Seal exactly the accepted data; no schema transforms or secret copying. */
export function sealTeamRecord(
  ring: TeamRecordKeys, binding: TeamRecordBinding,
  state: TeamRecordState, receipt: TeamRecordReceipt,
): TeamRecordEnvelope {
  assertState(state); assertReceipt(receipt);
  if (!hasStateKey(state, ring.current)) throw new Error('Team record baselines must use the current key');
  const codec = TEAM_RECORD_CODEC;
  const keyId = ring.current;
  return { codec, state, receipt, seal: {
    keyId, mac: mac(currentKey(ring), SEAL_DOMAIN, { codec, keyId, appId: binding.appId, recordNodeId: binding.recordNodeId, state, receipt }),
  } };
}

export type TeamRecordCheck =
  | { status: 'absent' }
  | { status: 'valid'; record: TeamRecordEnvelope }
  | { status: 'refused'; code: 'TEAM_RECORD_FOREIGN' | 'TEAM_RECORD_UNVERIFIABLE' };

/** A bad/unknown record blocks apply but never supplies diff baselines. */
export function verifyTeamRecord(ring: TeamRecordKeys, binding: TeamRecordBinding, body: string | null): TeamRecordCheck {
  if (body === null) return { status: 'absent' };
  let input: unknown;
  try { input = JSON.parse(body); } catch { return { status: 'refused', code: 'TEAM_RECORD_FOREIGN' }; }
  if (input && typeof input === 'object' && 'codec' in input && input.codec !== TEAM_RECORD_CODEC) {
    return { status: 'refused', code: 'TEAM_RECORD_UNVERIFIABLE' };
  }
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) return { status: 'refused', code: 'TEAM_RECORD_FOREIGN' };
  // Retain all accepted annotation keys, as S1 does. Zod is validation only.
  const record = input as TeamRecordEnvelope;
  try { assertState(record.state); assertReceipt(record.receipt); }
  catch { return { status: 'refused', code: 'TEAM_RECORD_FOREIGN' }; }
  if (!hasStateKey(record.state, record.seal.keyId)) return { status: 'refused', code: 'TEAM_RECORD_FOREIGN' };
  const key = ring.keys.get(record.seal.keyId);
  if (!key || key.length !== 32) return { status: 'refused', code: 'TEAM_RECORD_UNVERIFIABLE' };
  let expected: string;
  try {
    expected = mac(key, SEAL_DOMAIN, {
      codec: record.codec, keyId: record.seal.keyId, appId: binding.appId, recordNodeId: binding.recordNodeId,
      state: record.state, receipt: record.receipt,
    });
  } catch { return { status: 'refused', code: 'TEAM_RECORD_FOREIGN' }; }
  const actualBytes = Buffer.from(record.seal.mac, 'base64url');
  const expectedBytes = Buffer.from(expected, 'base64url');
  if (actualBytes.toString('base64url') !== record.seal.mac || actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return { status: 'refused', code: 'TEAM_RECORD_FOREIGN' };
  }
  return { status: 'valid', record };
}

export function requireTeamRecordKeys(): TeamRecordKeys {
  const ring = readTeamRecordKeys();
  if (!ring) throw new GraphQLError('Team record keys are not configured', { extensions: { code: 'TEAM_RECORD_UNAVAILABLE' } });
  return ring;
}
