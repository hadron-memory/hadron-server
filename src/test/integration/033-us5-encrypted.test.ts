import { randomUUID } from 'node:crypto';
/**
 * 033-rag-vector-retrieval US5 — encrypted-memory opt-in, disclosed (FR-026).
 *
 * What US5 pins (SC-010):
 *   - Enabling vectorIndex on an encrypted memory without
 *     `acknowledgeVectorInversionRisk: true` → throws
 *     EncryptedVectorIndexNotAcknowledgedError. The chk_memory_vector_encrypted_ack
 *     CHECK is the structural backstop; the resolver gate is the friendly error.
 *   - With the ack, the update succeeds AND `vectorIndexEncryptedAckAt` is
 *     stamped.
 *   - R132 ciphertext-only pending work is excluded from keyless recovery;
 *     it retains its token and explicit fresh-plaintext diagnostic.
 *   - Revoking vector indexing deletes vectors and cancels durable obligations.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import type { EmbeddingClient } from '../../lib/embedding/index.js';
import {
  setEmbeddingClientForTests,
  resetEmbeddingClientForTests,
} from '../../lib/embedding/index.js';
import { resolvers, type Context as GqlContext } from '../../api/graphql/schema/resolvers.js';
import { FRESH_PLAINTEXT_REQUIRED, stampEmbeddingObligation } from '../../services/embedding/obligation.js';
import { drainEmbeddingQueue } from '../../jobs/embedNodes.js';
import { EncryptedVectorIndexNotAcknowledgedError } from '../../lib/entityRef/errors.js';
import { generateDataKey, parseDataKey } from '../../lib/crypto.js';
import { encryptNodeFieldsWithKey } from '../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';

const DIM = 768;

function stubClient(): EmbeddingClient {
  const fixed = new Array(DIM).fill(0);
  fixed[0] = 1;
  return {
    provider: 'test',
    model: 'stub-model',
    dim: DIM,
    async embed(texts: string[]) {
      return texts.map(() => [...fixed]);
    },
  };
}

let orgId: string;
let adminId: string;

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stubClient());

  const org = await db.organization.create({
    data: { id: generateId(), name: 'us5-org', urn: 'us5-org' },
  });
  orgId = org.id;
  const admin = await db.user.create({
    data: { githubId: 9905, githubUsername: 'us5-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' },
  });
  adminId = admin.id;
});

afterAll(() => {
  resetEmbeddingClientForTests();
  sessionKeyCache.clear();
  delete process.env.EMBEDDING_API_URL;
});

function adminCtx(): GqlContext {
  return { db, roles: ['ADMIN'], userId: adminId };
}

/**
 * Seed a knowledge memory that's already vector-indexed (class-derived default),
 * then flip it to encrypted via direct DB writes. This bypasses the encryptMemory
 * resolver (which is separately scoped) so the test stays focused on the FR-026
 * surface — the updateMemory ack gate.
 */
async function seedEncryptedIndexedMemory(): Promise<{ id: string; urn: string }> {
  const mem = await resolvers.Mutation.createMemory(
    {},
    { orgId, name: `us5-${generateId().slice(0, 6)}` },
    adminCtx(),
  );
  // The knowledge-class memory starts vector-indexed (class default).
  // To exercise FR-026 we need an encrypted memory that is NOT yet indexed.
  // Flip the index OFF directly so the next updateMemory call IS the
  // "enabling on an encrypted memory" path the contract gates.
  await db.memory.update({
    where: { id: mem.id },
    data: { vectorIndexEnabled: false, isEncrypted: true },
  });
  return { id: mem.id, urn: mem.urn };
}

describe('US5 — encrypted-memory vector index opt-in (FR-026)', () => {
  it('enable on encrypted memory without ack → EncryptedVectorIndexNotAcknowledgedError', async () => {
    const { id, urn } = await seedEncryptedIndexedMemory();
    await expect(
      resolvers.Mutation.updateMemory(
        {},
        { id, vectorIndexEnabled: true },
        adminCtx(),
      ),
    ).rejects.toBeInstanceOf(EncryptedVectorIndexNotAcknowledgedError);
    // The CHECK + the resolver gate are belt-and-suspenders — the row must
    // still be in its pre-call state.
    const after = await db.memory.findUnique({ where: { id } });
    expect(after?.vectorIndexEnabled).toBe(false);
    expect(after?.vectorIndexEncryptedAckAt).toBeNull();
    // The friendly error carries the memory URN for the disclosure UI.
    try {
      await resolvers.Mutation.updateMemory({}, { id, vectorIndexEnabled: true }, adminCtx());
    } catch (e) {
      expect(e).toBeInstanceOf(EncryptedVectorIndexNotAcknowledgedError);
      expect((e as EncryptedVectorIndexNotAcknowledgedError).memoryRef).toBe(urn);
      expect((e as Error).message).toMatch(/acknowledgeVectorInversionRisk/);
    }
  });

  it('enable on encrypted memory WITH ack → succeeds, vectorIndexEncryptedAckAt stamped', async () => {
    const { id } = await seedEncryptedIndexedMemory();
    const before = Date.now();
    const updated = await resolvers.Mutation.updateMemory(
      {},
      { id, vectorIndexEnabled: true, acknowledgeVectorInversionRisk: true },
      adminCtx(),
    );
    expect(updated.vectorIndexEnabled).toBe(true);
    expect(updated.vectorIndexEncryptedAckAt).not.toBeNull();
    expect(updated.vectorIndexEncryptedAckAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('re-acking an already-acked memory leaves the original timestamp alone', async () => {
    const { id } = await seedEncryptedIndexedMemory();
    const first = await resolvers.Mutation.updateMemory(
      {},
      { id, vectorIndexEnabled: true, acknowledgeVectorInversionRisk: true },
      adminCtx(),
    );
    const firstAckAt = first.vectorIndexEncryptedAckAt!;
    // Disable then re-enable; the original audit-relevant ack moment must
    // not get clobbered. (The contract treats the FIRST opt-in as the
    // audit-significant one.)
    await resolvers.Mutation.updateMemory(
      {},
      { id, vectorIndexEnabled: false },
      adminCtx(),
    );
    // A second ack on a memory that ALREADY has vectorIndexEncryptedAckAt
    // set: the gate doesn't fire (the second condition is "ackAt IS NULL"),
    // so no new timestamp is stamped — the original survives the round-trip.
    const reEnabled = await resolvers.Mutation.updateMemory(
      {},
      { id, vectorIndexEnabled: true, acknowledgeVectorInversionRisk: true },
      adminCtx(),
    );
    expect(reEnabled.vectorIndexEncryptedAckAt!.getTime()).toBe(firstAckAt.getTime());
  });

  it('non-encrypted memory: ack flag is a harmless no-op', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId, name: `us5-plain-${generateId().slice(0, 6)}` },
      adminCtx(),
    );
    // Knowledge → already vector-indexed. Toggle it off then back on with the
    // ack flag set; nothing about the ack should fire because !isEncrypted.
    await resolvers.Mutation.updateMemory(
      {},
      { id: mem.id, vectorIndexEnabled: false },
      adminCtx(),
    );
    const updated = await resolvers.Mutation.updateMemory(
      {},
      {
        id: mem.id,
        vectorIndexEnabled: true,
        acknowledgeVectorInversionRisk: true,
      },
      adminCtx(),
    );
    expect(updated.vectorIndexEnabled).toBe(true);
    // Non-encrypted memories never get the ack timestamp — the field is
    // FR-026-scoped (encrypted-only audit).
    expect(updated.vectorIndexEncryptedAckAt).toBeNull();
  });

  it('revoke (vectorIndexEnabled → false): deletes vectors AND clears all marker fields', async () => {
    // Set up: plaintext-knowledge memory with one node that has an embedding
    // queued and (after drain) stored.
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId, name: `us5-revoke-${generateId().slice(0, 6)}` },
      adminCtx(),
    );
    const nodeId = generateId();
    await db.node.create({
      data: {
        id: nodeId,
        memoryId: mem.id,
        loc: 'rev1',
        name: 'rev1',
        abstract: 'an abstract',
        content: 'body',
        embeddingPendingAt: new Date(), embeddingWorkToken: randomUUID(),
        embeddingAttempts: 0,
      },
    });
    await drainEmbeddingQueue(db);
    const beforeRevoke = await db.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*) AS c FROM node_embeddings WHERE memory_id = ${mem.id}
    `;
    expect(Number(beforeRevoke[0].c)).toBeGreaterThan(0);

    // Revoke
    await resolvers.Mutation.updateMemory(
      {},
      { id: mem.id, vectorIndexEnabled: false },
      adminCtx(),
    );

    // Vectors gone
    const afterRevoke = await db.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*) AS c FROM node_embeddings WHERE memory_id = ${mem.id}
    `;
    expect(Number(afterRevoke[0].c)).toBe(0);
    // All marker columns reset (embeddingAttempts MUST be 0, not null —
    // it's a non-null Int and clearing to null would violate the schema).
    const node = await db.node.findUnique({ where: { id: nodeId } });
    expect(node?.embeddingPendingAt).toBeNull();
    expect(node?.embeddingFailedAt).toBeNull();
    expect(node?.embeddingError).toBeNull();
    expect(node?.embeddingAttempts).toBe(0);
  });

  it('R132: ciphertext-only work stays visibly pending without a keyless sweep attempt', async () => {
    // Goal: pin the T024 `encrypted-no-plaintext (#206)` branch in embedNode.
    // The sweep path can't decrypt (MCP read asymmetry, #206), so when a
    // ciphertext-at-rest row is selected with no in-closure plaintext AND
    // no cached session key, embedNode MUST mark it as a permanent failure
    // rather than eating the attempts cap.
    //
    // Faithful reproduction: a node that was written with an active session
    // key (abstract + content encrypted at rest by upsertNode's encryption
    // pass), session later ended, sweep runs without a key. We bypass the
    // upsertNode + startAgentSession + endAgentSession orchestration and
    // stamp the encrypted-at-rest state directly — this is the post-session
    // DB state the sweep encounters.
    const mem = await resolvers.Mutation.createMemory(
      {},
      { orgId, name: `us5-perma-${generateId().slice(0, 6)}` },
      adminCtx(),
    );
    // Flip to encrypted + ack via the standard path (index already on by
    // class default, so we toggle off→on to land the ack timestamp).
    await resolvers.Mutation.updateMemory(
      {},
      { id: mem.id, vectorIndexEnabled: false },
      adminCtx(),
    );
    await db.memory.update({
      where: { id: mem.id },
      data: { isEncrypted: true },
    });
    await resolvers.Mutation.updateMemory(
      {},
      {
        id: mem.id,
        vectorIndexEnabled: true,
        acknowledgeVectorInversionRisk: true,
      },
      adminCtx(),
    );

    // Seed a node whose abstract + content are ALREADY encrypted at rest —
    // the state upsertNode would have left after a since-ended session.
    const key = parseDataKey(generateDataKey().raw.toString('base64'));
    const enc = encryptNodeFieldsWithKey(
      { abstract: 'plaintext abstract', content: 'plaintext body' },
      key,
    );
    const nodeId = generateId();
    await db.node.create({
      data: {
        id: nodeId,
        memoryId: mem.id,
        loc: 'p1',
        name: 'p1',
        abstract: enc.abstract ?? null,
        content: enc.content ?? null,
        // Re-enabling the index would have stamped this already; the
        // backfill in updateMemory runs over LIVE nodes at the moment it
        // executes. This node was created AFTER, so stamp manually.
        embeddingPendingAt: new Date(), embeddingWorkToken: randomUUID(),
      },
    });

    const capturedToken = await db.$transaction(tx => stampEmbeddingObligation(tx, nodeId, mem.id));
    await drainEmbeddingQueue(db);

    const after = await db.node.findUnique({ where: { id: nodeId } });
    // R132 replaces the old terminal encrypted-no-plaintext behavior. The sweep
    // cannot obtain a new holder/key, and must leave this obligation recoverable
    // only by fresh authorized plaintext.
    expect(after?.embeddingPendingAt).not.toBeNull();
    expect(after?.embeddingWorkToken).toBe(capturedToken);
    expect(after?.embeddingFailedAt).toBeNull();
    expect(after?.embeddingError).toBe(FRESH_PLAINTEXT_REQUIRED);
    expect(after?.abstract).toBe(enc.abstract);
    expect(after?.embeddingAttempts).toBe(0);
  });
});
