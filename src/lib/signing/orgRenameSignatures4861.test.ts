/**
 * #4861 (part of #4534; cor:urn:010:01 "whether any signature covers the URN text", cor:urn:030:01/:02): the platform's own
 * org is renamed (hadronmemory.com -> amalit.ai) and the old name is kept as an alias. This pins the audit's answer for the
 * two passkey-signed artifact kinds. The NODE is signed through the real completion path; the GRANT record is built to the
 * production row shape (the same fixture as signerOwnerBinding3827.test.ts; the real ceremony needs a browser nonce) and read back
 * through the real read path. The rename is the production `updateOrganization` resolver, alias row included:
 *
 *   - a signed NODE (`hadron-signature-v3`: node id, approval hash over title/abstract/content, request id) still reads
 *     CURRENT after the org's memories are rewritten, even when its own content quotes the old URN text (the cascade
 *     rewrites `memories`, `agents` and `apps` URN columns only; a node's text is never touched);
 *   - a signed GRANT (`hadron-grant-signature-v1`: grant id, version, terms hash over ids) still reads CURRENT after the
 *     org's Apps, Agents and Memories are rewritten.
 *
 * Neither payload contains a URN, so both are GREEN on main: this is a regression pin for the audit's claim, not a fix. If a
 * future payload version binds URN text, one of these goes red and the rename must wait for that kind's own issue.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbNode, createDbOrgAndGraph } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { DB_NOW, dropTestActions, insertGrant, seedWorld } from '../grants/grantFixtures3668.js';
import { grantTermsFromRow, grantTermsHash } from '../grants/terms.js';
import { generateId } from '../id.js';
import { computeApprovalHash } from '../approvalHash.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { grantSignaturePayloadBytes, GRANT_SIGNATURE_PAYLOAD_V1 } from './grantPayload.js';
import { loadGrantSignatureStatuses } from './grantStatus.js';
import { signaturePayloadBytes, SIGNATURE_PAYLOAD_V3 } from './payload.js';
import { completeSigningRequestInTransaction, createSigningRequestInTransaction, newSigningRequestId } from './requests.js';
import { loadSignatureStatuses } from './status.js';
import { clearSignatureVerifyCache } from './verify.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const NEW_ORG = 'renamed4861.example';
const exec = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);

/**
 * The PRODUCTION rename: the `updateOrganization` resolver (resolvers.mutation.org.ts), which mints the new root principal,
 * records the org's own alias (#1079) and runs `propagateOrgUrnRename` in one transaction. Calling it, not re-implementing
 * it, so the alias row and any other table it touches are part of what the signatures are re-read against.
 */
async function renameOrg(organizationId: string): Promise<string> {
  const before = (await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { urn: true } })).urn;
  const admin = await db.user.create({ data: { githubId: 4861900 + Math.floor(Math.random() * 90000), githubUsername: `rename-admin-${generateId()}`, roles: ['ADMIN'] } });
  await resolvers.Mutation.updateOrganization({}, { ref: organizationId, urn: NEW_ORG }, { db, userId: admin.id, roles: ['ADMIN'] } as unknown as Context);
  expect((await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { urn: true } })).urn).toBe(NEW_ORG);
  // The old name is kept as an alias (cor:urn:030:01): the audit's claim holds with the alias in place, not only without it.
  expect(await db.urnAlias.count({ where: { entityType: 'ORGANIZATION', entityId: organizationId, urn: before } })).toBeGreaterThan(0);
  clearSignatureVerifyCache(); // never let a cached verdict stand in for re-verification
  return before;
}

const saved = { origins: process.env.SIGNING_CEREMONY_ORIGINS, rp: process.env.PASSKEY_RP_ID };
const restore = (k: 'SIGNING_CEREMONY_ORIGINS' | 'PASSKEY_RP_ID', v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
});
afterEach(() => {
  restore('SIGNING_CEREMONY_ORIGINS', saved.origins);
  restore('PASSKEY_RP_ID', saved.rp);
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

describe('#4861 a signed node survives the org rename', () => {
  it('reads CURRENT before and after, with its own content quoting the old URN text', async () => {
    const requester = (await db.user.create({ data: { githubId: 4861100 + Math.floor(Math.random() * 9000), githubUsername: `rename-req-${generateId()}`, roles: [] } })).id;
    const signerId = (await db.user.create({ data: { githubId: 4862100 + Math.floor(Math.random() * 9000), githubUsername: `rename-signer-${generateId()}`, roles: [] } })).id;
    const { org, graph } = await createDbOrgAndGraph(db, { orgName: 'rename-org-4861', graphName: 'rename-4861' });
    const oldOrgUrn = (await db.organization.findUniqueOrThrow({ where: { id: org.id }, select: { urn: true } })).urn;
    const memoryId = graph.id;
    const nodeId = (await createDbNode(db, {
      loc: 'policies:retention', memoryId, name: 'Retention', content: `See hrn:node:${oldOrgUrn}:other:thing. Retention is 30 days.`,
    })).id;
    const key = softPasskey();
    await insertSoftPasskey(db, signerId, key, { label: 'rename key' });
    const req = await db.$transaction((tx) => createSigningRequestInTransaction(tx, nodeId, {
      memoryId, requester: { userId: requester, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true,
    }));
    const assertion = key.assert({
      payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId: req.nodeId, approvalHash: req.approvalHash, requestId: req.id }),
      origin: ORIGIN, rpId: RP,
    });
    await db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
      memoryId, signerId, credentialId: key.credentialId, assertion, mayWrite: async () => true,
    }));
    const read = async () => (await loadSignatureStatuses(db, [nodeId])).get(nodeId)!;
    const nodeHash = async () => {
      const n = await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { name: true, abstract: true, content: true } });
      return computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content });
    };
    const hashBefore = await nodeHash();
    expect(hashBefore).toBe(req.approvalHash); // the hash the person signed is the node's own
    expect(await read()).toMatchObject({ state: 'CURRENT', integrityProblems: 0 });

    await renameOrg(org.id);

    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { urn: true } })).urn.startsWith(`${NEW_ORG}:`)).toBe(true);
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { content: true } })).content).toContain(`hrn:node:${oldOrgUrn}:`);
    expect(await nodeHash()).toBe(hashBefore); // the cascade never touched the signed text
    const after = await read();
    expect(after).toMatchObject({ state: 'CURRENT', integrityProblems: 0 });
    expect(after.signatures).toHaveLength(1);
  });
});

describe('#4861 a signed grant survives the org rename', () => {
  it('reads CURRENT before and after the org\'s Apps, Agents and Memories are rewritten', async () => {
    const w = await seedWorld();
    const g = await insertGrant(w, { user_id: null, worker_id: w.workerId });
    const row = await db.grant.findUniqueOrThrow({ where: { id: g } });
    const termsHash = grantTermsHash(grantTermsFromRow({
      appId: row.appId, userId: row.userId, agentId: row.agentId, workerId: row.workerId, granteeAppId: row.granteeAppId,
      action: row.action, values: row.values, startsAt: row.startsAt, expiresAt: row.expiresAt, maxUses: row.maxUses, reason: row.reason,
    }));
    const r = newSigningRequestId();
    await exec(`INSERT INTO grant_signing_requests (id, grant_id, version, terms_hash, payload_version, requester_user_id, created_at, expires_at)
      VALUES ($1, $2, 1, $3, $4, $5, ${DB_NOW}, ${DB_NOW} + interval '1 hour')`, r, g, termsHash, GRANT_SIGNATURE_PAYLOAD_V1, w.userId);
    const key = softPasskey();
    const passkeyId = await insertSoftPasskey(db, w.user2Id, key, { rpId: RP, label: 'Signer key' });
    const a = key.assert({
      payload: grantSignaturePayloadBytes(GRANT_SIGNATURE_PAYLOAD_V1, { grantId: g, recordVersion: 1, termsHash, requestId: r }),
      origin: ORIGIN, rpId: RP,
    });
    await exec(`INSERT INTO grant_signatures (id, grant_id, signing_request_id, signer_id, passkey_credential_id, version, terms_hash,
        holder_kind, holder_id, payload_version, rp_id, authenticator_data, client_data_json, signature)
      VALUES ($1, $2, $3, $4, $5, 1, $6, 'worker', $7, $8, $9, $10, $11, $12)`,
    `gs-${g}`, g, r, w.user2Id, passkeyId, termsHash, w.workerId, GRANT_SIGNATURE_PAYLOAD_V1, RP, a.authenticatorData, a.clientDataJson, a.signature);
    await exec(`UPDATE grant_signing_requests SET state = 'completed' WHERE id = $1`, r);
    const read = async () => (await loadGrantSignatureStatuses(db, [g])).get(g)!;
    expect(await read()).toMatchObject({ state: 'CURRENT', integrityProblems: 0 });

    const app = await db.app.findUniqueOrThrow({ where: { id: row.appId }, select: { organizationId: true, urn: true } });
    const oldAppUrn = app.urn;
    await renameOrg(app.organizationId!);

    expect((await db.app.findUniqueOrThrow({ where: { id: row.appId }, select: { urn: true } })).urn).not.toBe(oldAppUrn);
    const orgId = app.organizationId!;
    const urns = [
      ...(await db.app.findMany({ where: { organizationId: orgId }, select: { urn: true } })),
      ...(await db.agent.findMany({ where: { organizationId: orgId }, select: { urn: true } })),
      ...(await db.memory.findMany({ where: { organizationId: orgId }, select: { urn: true } })),
    ].map((x) => x.urn);
    expect(urns.length).toBeGreaterThan(0);
    expect(urns.every((u) => u.startsWith(`${NEW_ORG}:`))).toBe(true); // Apps, Agents and Memories alike
    expect(await read()).toMatchObject({ state: 'CURRENT', integrityProblems: 0 });
  });
});
