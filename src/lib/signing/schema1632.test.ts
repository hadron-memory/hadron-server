/**
 * #1632 / cor:dmo:130 (S2b-1) — the database half of signing: the request
 * guard (one end, DB-clock times, pinned fields), the append-only signature
 * record, the content-change marker and staleness triggers. Raw SQL on
 * purpose: these guards must hold for every write path, not just ours.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../id.js';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const RP = 'example.test';
/** authenticatorData whose rpIdHash is SHA-256(rp), as the guard requires. */
const authData = (rp = RP) => Buffer.concat([createHash('sha256').update(rp).digest(), Buffer.alloc(5)]);

let signerId: string;
let otherUserId: string;
let memoryId: string;
let nodeId: string;

beforeEach(async () => {
  await cleanDb(db);
  signerId = (await db.user.create({ data: { githubId: 1632001, githubUsername: 'signing-signer', roles: [] } })).id;
  otherUserId = (await db.user.create({ data: { githubId: 1632002, githubUsername: 'signing-other', roles: [] } })).id;
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'signing-org', graphName: 'signing' });
  memoryId = graph.id;
  nodeId = (await createDbNode(db, { loc: 'policy', memoryId, content: 'Retention is 30 days.' })).id;
});

/** Refusals surface as a raw-query error carrying the SQLSTATE in meta.code. */
const refused = (op: Promise<unknown>, state = '23514') =>
  expect(op).rejects.toMatchObject({ code: 'P2010', meta: { code: state } });

async function passkey(ownerId = signerId): Promise<string> {
  const id = generateId();
  await db.$executeRaw`INSERT INTO passkey_credentials
    (id, owner_id, credential_id, public_key, algorithm, user_handle, enrollment_rp_id, label, registered_at, counter, transports, backup_eligible, backed_up)
    VALUES (${id}, ${ownerId}, ${Buffer.from(`cred-${id}`)}, ${Buffer.from('pk')}, -7, ${Buffer.alloc(32, 1)}, ${RP}, 'YubiKey',
      (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3), 0, ARRAY['usb'], false, false)`;
  return id;
}

async function request(opts: { ttl?: string; named?: string | null; node?: string } = {}): Promise<string> {
  const id = generateId();
  await db.$executeRawUnsafe(
    `INSERT INTO signing_requests (id, node_id, revision, approval_hash, payload_version, named_signer_id, requester_user_id, expires_at)
     VALUES ($1, $2, 1, $3, 'hadron-signature-v1', $4, $5, (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) + interval '${opts.ttl ?? '1 hour'}')`,
    id, opts.node ?? nodeId, HASH, opts.named ?? null, otherUserId,
  );
  return id;
}

async function sign(requestId: string, opts: { signer?: string; key?: string; hash?: string; rpId?: string; authRp?: string } = {}) {
  const id = generateId();
  await db.$executeRaw`INSERT INTO node_signatures
    (id, node_id, signing_request_id, signer_id, passkey_credential_id, revision, approval_hash, payload_version,
     rp_id, authenticator_data, client_data_json, signature)
    VALUES (${id}, ${nodeId}, ${requestId}, ${opts.signer ?? signerId}, ${opts.key ?? (await passkey())}, 1,
      ${opts.hash ?? HASH}, 'hadron-signature-v1', ${opts.rpId ?? RP}, ${authData(opts.authRp ?? opts.rpId ?? RP)},
      ${Buffer.from('{}')}, ${Buffer.from('sig')})`;
  return id;
}

const stateOf = async (id: string) =>
  (await db.signingRequest.findUniqueOrThrow({ where: { id } }));

describe('signing requests: one end, DB-clock times, pinned fields (#1632)', () => {
  it('begins open with created_at from the DB clock, whatever the writer sent', async () => {
    const id = generateId();
    await db.$executeRaw`INSERT INTO signing_requests (id, node_id, revision, approval_hash, payload_version, requester_user_id, created_at, expires_at)
      VALUES (${id}, ${nodeId}, 1, ${HASH}, 'hadron-signature-v1', ${otherUserId}, '2000-01-01', (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) + interval '1 hour')`;
    const row = await stateOf(id);
    expect(row.state).toBe('open');
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    await refused(db.$executeRaw`INSERT INTO signing_requests (id, node_id, revision, approval_hash, payload_version, requester_user_id, state, ended_at, expires_at)
      VALUES (${generateId()}, ${nodeId}, 1, ${HASH}, 'hadron-signature-v1', ${otherUserId}, 'withdrawn', now(), now() + interval '1 hour')`);
  });

  it('refuses a request on a node in an encrypted memory', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
    await refused(request());
  });

  it('refuses a malformed hash, an unknown payload version, and a requester-less row', async () => {
    await refused(db.$executeRaw`INSERT INTO signing_requests (id, node_id, revision, approval_hash, payload_version, requester_user_id, expires_at)
      VALUES (${generateId()}, ${nodeId}, 1, ${HASH.toUpperCase()}, 'hadron-signature-v1', ${otherUserId}, now() + interval '1 hour')`);
    await refused(db.$executeRaw`INSERT INTO signing_requests (id, node_id, revision, approval_hash, payload_version, requester_user_id, expires_at)
      VALUES (${generateId()}, ${nodeId}, 1, ${HASH}, 'hadron-signature-v2', ${otherUserId}, now() + interval '1 hour')`);
    await refused(db.$executeRaw`INSERT INTO signing_requests (id, node_id, revision, approval_hash, payload_version, expires_at)
      VALUES (${generateId()}, ${nodeId}, 1, ${HASH}, 'hadron-signature-v1', now() + interval '1 hour')`);
  });

  it('keeps every pinned field immutable', async () => {
    const id = await request();
    for (const set of [`approval_hash = '${OTHER_HASH}'`, 'revision = 2', `named_signer_id = '${signerId}'`,
      `requester_user_id = '${signerId}'`, "expires_at = expires_at + interval '1 day'", "created_at = created_at - interval '1 day'",
      "payload_version = 'hadron-signature-v3'"]) {
      await refused(db.$executeRawUnsafe(`UPDATE signing_requests SET ${set} WHERE id = $1`, id));
    }
  });

  it('ends exactly once, with ended_at from the DB clock', async () => {
    const id = await request();
    await db.$executeRaw`UPDATE signing_requests SET state = 'withdrawn', ended_at = '2000-01-01' WHERE id = ${id}`;
    const row = await stateOf(id);
    expect(row.state).toBe('withdrawn');
    expect(Math.abs(row.endedAt!.getTime() - Date.now())).toBeLessThan(60_000);
    for (const next of ['open', 'declined', 'completed', 'stale', 'expired']) {
      await refused(db.$executeRawUnsafe(`UPDATE signing_requests SET state = $1 WHERE id = $2`, next, id));
    }
  });

  it('expires only after its deadline, ending at the deadline; no other end after it', async () => {
    const early = await request();
    await refused(db.$executeRaw`UPDATE signing_requests SET state = 'expired' WHERE id = ${early}`);
    const id = await request({ ttl: '200 milliseconds' });
    await db.$executeRaw`SELECT pg_sleep(0.3)`;
    await refused(db.$executeRaw`UPDATE signing_requests SET state = 'withdrawn' WHERE id = ${id}`);
    await db.$executeRaw`UPDATE signing_requests SET state = 'expired' WHERE id = ${id}`;
    const row = await stateOf(id);
    expect(row.state).toBe('expired');
    expect(row.endedAt!.getTime()).toBe(row.expiresAt.getTime());
  });

  it('completes only with its signature record', async () => {
    const id = await request();
    await refused(db.$executeRaw`UPDATE signing_requests SET state = 'completed' WHERE id = ${id}`);
    await sign(id);
    await db.$executeRaw`UPDATE signing_requests SET state = 'completed' WHERE id = ${id}`;
    expect((await stateOf(id)).state).toBe('completed');
  });

  it('is kept for the node\'s lifetime: no delete while the node exists, gone with a hard delete', async () => {
    const id = await request();
    await refused(db.$executeRaw`DELETE FROM signing_requests WHERE id = ${id}`);
    await db.node.update({ where: { id: nodeId }, data: { deletedAt: new Date() } });
    await refused(db.$executeRaw`DELETE FROM signing_requests WHERE id = ${id}`);
    await db.$executeRaw`DELETE FROM nodes WHERE id = ${nodeId}`;
    expect(await db.signingRequest.count()).toBe(0);
  });
});

describe('signature records: append-only (#1632, cor:dmo:130:05/:07)', () => {
  it('stores a record against an open request, with verified_at from the DB clock', async () => {
    const id = await sign(await request());
    const row = await db.nodeSignature.findUniqueOrThrow({ where: { id } });
    expect(Math.abs(row.verifiedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('never updates and never deletes while the node exists', async () => {
    const id = await sign(await request());
    for (const set of ['revision = 2', `approval_hash = '${OTHER_HASH}'`, "signature = decode('00','hex')",
      `signer_id = '${otherUserId}'`, "verified_at = verified_at - interval '1 day'", "rp_id = 'other.test'"]) {
      await refused(db.$executeRawUnsafe(`UPDATE node_signatures SET ${set} WHERE id = $1`, id));
    }
    await refused(db.$executeRaw`DELETE FROM node_signatures WHERE id = ${id}`);
  });

  it('goes with its node on a hard delete, and survives a soft delete', async () => {
    await sign(await request());
    await db.node.update({ where: { id: nodeId }, data: { deletedAt: new Date() } });
    expect(await db.nodeSignature.count()).toBe(1);
    await db.$executeRaw`DELETE FROM nodes WHERE id = ${nodeId}`;
    expect(await db.nodeSignature.count()).toBe(0);
  });

  it('refuses a record for an ended or expired request', async () => {
    const withdrawn = await request();
    await db.$executeRaw`UPDATE signing_requests SET state = 'withdrawn' WHERE id = ${withdrawn}`;
    await refused(sign(withdrawn));
    const late = await request({ ttl: '200 milliseconds' });
    await db.$executeRaw`SELECT pg_sleep(0.3)`;
    await refused(sign(late));
  });

  it('refuses a record that does not sign exactly what the request pinned', async () => {
    await refused(sign(await request(), { hash: OTHER_HASH }));
  });

  it('refuses anyone but the named signer, and a passkey that is not the signer\'s own or is revoked', async () => {
    await refused(sign(await request({ named: otherUserId })));
    await refused(sign(await request(), { key: await passkey(otherUserId) }));
    const key = await passkey();
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id = ${key}`;
    await refused(sign(await request(), { key }));
  });

  it('records the RP ID the assertion was made under, and refuses one that does not match its rpIdHash (#10470)', async () => {
    const id = await sign(await request());
    expect((await db.nodeSignature.findUniqueOrThrow({ where: { id } })).rpId).toBe(RP);
    await refused(sign(await request(), { rpId: 'other.test', authRp: RP }));
    await refused(sign(await request(), { rpId: '' }));
  });

  it('allows one record per request only', async () => {
    const id = await request();
    await sign(id);
    await refused(sign(id), '23505');
  });
});

describe('content-change marker and staleness (#1632, #10015, #10017)', () => {
  const marker = async () => (await db.node.findUniqueOrThrow({ where: { id: nodeId } })).contentChangedAt;

  it('starts null and ignores a writer that sets it', async () => {
    expect(await marker()).toBeNull();
    await db.$executeRaw`UPDATE nodes SET content_changed_at = '2030-01-01' WHERE id = ${nodeId}`;
    expect(await marker()).toBeNull();
  });

  for (const [field, set] of [['title', "name = 'renamed'"], ['abstract', "abstract = 'new abstract'"], ['content', "content = 'Retention is 90 days.'"]] as const) {
    it(`a ${field} change sets the marker and ends open requests stale`, async () => {
      const id = await request();
      await db.$executeRawUnsafe(`UPDATE nodes SET ${set} WHERE id = $1`, nodeId);
      expect(await marker()).toBeInstanceOf(Date);
      const row = await stateOf(id);
      expect(row.state).toBe('stale');
      expect(row.endedAt).toBeInstanceOf(Date);
    });
  }

  it('tags, properties and other fields leave the marker and the request alone', async () => {
    const id = await request();
    await db.node.update({ where: { id: nodeId }, data: { tags: ['x'], role: 'policy' } });
    expect(await marker()).toBeNull();
    expect((await stateOf(id)).state).toBe('open');
  });

  it('an unchanged rewrite of the content is not a change', async () => {
    const id = await request();
    await db.$executeRaw`UPDATE nodes SET content = content, name = name WHERE id = ${nodeId}`;
    expect(await marker()).toBeNull();
    expect((await stateOf(id)).state).toBe('open');
  });

  it('a content change after the deadline ends the request expired at its deadline, not stale', async () => {
    const id = await request({ ttl: '200 milliseconds' });
    await db.$executeRaw`SELECT pg_sleep(0.3)`;
    await db.$executeRaw`UPDATE nodes SET content = 'changed' WHERE id = ${nodeId}`;
    const row = await stateOf(id);
    expect(row.state).toBe('expired');
    expect(row.endedAt!.getTime()).toBe(row.expiresAt.getTime());
  });

  it('the marker never moves backwards: a later change has a later time', async () => {
    await db.$executeRaw`UPDATE nodes SET content = 'one' WHERE id = ${nodeId}`;
    const first = (await marker())!;
    await db.$executeRaw`SELECT pg_sleep(0.01)`;
    await db.$executeRaw`UPDATE nodes SET content = 'two' WHERE id = ${nodeId}`;
    expect((await marker())!.getTime()).toBeGreaterThan(first.getTime());
  });

  it('encrypting the memory in place ends its open requests stale', async () => {
    const open = await request();
    const other = (await createDbOrgAndGraph(db, { orgName: 'signing-org-2', graphName: 'other' })).graph;
    const elsewhere = await createDbNode(db, { loc: 'elsewhere', memoryId: other.id });
    const untouched = await request({ node: elsewhere.id });
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
    expect((await stateOf(open)).state).toBe('stale');
    expect((await stateOf(untouched)).state).toBe('open');
  });
});

describe('one source of signing SQL', () => {
  it('the migration and both schema-push paths carry the same guard', () => {
    const source = readFileSync('prisma/signing-invariants.sql', 'utf8');
    expect(readFileSync('prisma/migrations/20261013160000_signing_requests/migration.sql', 'utf8').endsWith(source)).toBe(true);
    expect(readFileSync('prisma/post-push.sql', 'utf8')).toContain('\\ir signing-invariants.sql');
    expect(readFileSync('src/test/globalSetup.ts', 'utf8')).toContain('../../prisma/signing-invariants.sql');
  });
});
