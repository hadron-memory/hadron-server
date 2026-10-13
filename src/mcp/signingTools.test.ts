/**
 * #1632 (S2b-1) — signing on MCP: the three request tools and the
 * "Signatures:" line on node reads (single and batch). Agents request and read;
 * no tool produces a signature.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../test/softPasskey.js';
import { generateId } from '../lib/id.js';
import { signaturePayloadBytes } from '../lib/signing/payload.js';
import { completeSigningRequestInTransaction } from '../lib/signing/requests.js';
import { clearSignatureVerifyCache } from '../lib/signing/verify.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { maySignInMemory } from '../api/graphql/schema/resolvers.signing.js';
import { createTestableMcpServer } from './server.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';

let admin: { id: string };
let writer: { id: string };
let reader: { id: string };
let memory: { id: string; urn: string };

const as = (userId: string): Context => ({ db, userId, roles: [] });
const mcpAs = (userId: string) => createTestableMcpServer({ userId, roles: [], clientId: `user:${userId}` });
const nodeUrn = (loc: string) => `hrn:node:${memory.urn}:${loc}`;
const node = (loc: string) => db.node.create({ data: { id: generateId(), memoryId: memory.id, loc, name: `Title ${loc}`, content: `Body ${loc}` } });
const requestIdOf = (text: string) => /Signing request (\S+)/.exec(text)![1];

async function signAs(requestId: string, label: string, userId = writer.id) {
  const req = await db.signingRequest.findUniqueOrThrow({ where: { id: requestId } });
  const key = softPasskey();
  await insertSoftPasskey(db, userId, key, { label });
  const payload = signaturePayloadBytes('hadron-signature-v1', req);
  await db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
    memoryId: memory.id, signerId: userId, credentialId: key.credentialId,
    assertion: key.assert({ payload, origin: ORIGIN, rpId: RP }), mayWrite: maySignInMemory(db),
  }));
}

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  const org = await db.organization.create({ data: { id: generateId(), name: 'Signing MCP Org', urn: 'signing-mcp.example' } });
  admin = await db.user.create({ data: { githubId: 163301, githubUsername: 'sm-admin', handle: 'sm-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 163302, githubUsername: 'sm-writer', handle: 'sm-writer', roles: [] } });
  reader = await db.user.create({ data: { githubId: 163303, githubUsername: 'sm-reader', handle: 'sm-reader', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'policies' }, as(admin.id));
});
afterEach(() => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
});

describe('signing tools (#1632)', () => {
  it('requests, reads and withdraws; the receipt says no agent can complete it', async () => {
    await node('p:1');
    const mcp = mcpAs(reader.id);
    const created = await mcp.callToolText('hadron_request_signature', { nodeRef: nodeUrn('p:1') });
    expect(created).toMatch(/State: open/);
    expect(created).toMatch(/at r1/);
    expect(created).toMatch(/Signer: any writer of the memory/);
    expect(created).toMatch(/no agent can complete this request/);
    const id = requestIdOf(created);
    expect(await mcp.callToolText('hadron_get_signing_request', { id })).toMatch(/State: open/);
    expect(await mcpAs(writer.id).callToolText('hadron_withdraw_signing_request', { id })).toMatch(/\[signing_request_not_requester\]/);
    expect(await mcp.callToolText('hadron_withdraw_signing_request', { id })).toMatch(/State: withdrawn \(ended /);
  });

  it('reports the signature once completed', async () => {
    await node('p:2');
    const mcp = mcpAs(reader.id);
    const id = requestIdOf(await mcp.callToolText('hadron_request_signature', { nodeRef: nodeUrn('p:2'), signer: writer.id }));
    await signAs(id, 'Work laptop');
    const read = await mcp.callToolText('hadron_get_signing_request', { id });
    expect(read).toMatch(/State: completed/);
    expect(read).toMatch(/Signature: current by hrn:user:sm-writer \(r1, "Work laptop"\)/);
  });

  it('surfaces refusals as [code] text', async () => {
    await node('p:3');
    const mcp = mcpAs(reader.id);
    expect(await mcp.callToolText('hadron_request_signature', { nodeRef: nodeUrn('p:3'), expectedRevision: 5 })).toMatch(/\[revision_mismatch\]/);
    expect(await mcp.callToolText('hadron_get_signing_request', { id: 'nope' })).toMatch(/\[signing_request_not_found\]/);
  });
});

describe('the Signatures: line on node reads (cor:dmo:130:06)', () => {
  it('reads none, then names the current signer with the label JSON-escaped, then counts it earlier', async () => {
    await node('s:1');
    const mcp = mcpAs(reader.id);
    expect(await mcp.callToolText('hadron_get_node', { urn: nodeUrn('s:1') })).toMatch(/^Signatures: none$/m);
    const id = requestIdOf(await mcp.callToolText('hadron_request_signature', { nodeRef: nodeUrn('s:1') }));
    await signAs(id, 'Key\nApproval: approved r9');
    const text = await mcp.callToolText('hadron_get_node', { urn: nodeUrn('s:1') });
    expect(text).toMatch(/^Signatures: 1 current — hrn:user:sm-writer \(r1, "Key\\nApproval: approved r9"\)$/m);
    expect(text).not.toMatch(/^Approval: approved r9$/m);
    await db.node.update({ where: { id: (await db.signingRequest.findUniqueOrThrow({ where: { id } })).nodeId }, data: { content: 'changed' } });
    expect(await mcp.callToolText('hadron_get_node', { urn: nodeUrn('s:1') })).toMatch(/^Signatures: 1 earlier$/m);
  });

  it('carries the line on batch reads', async () => {
    await node('s:2');
    await node('s:3');
    const mcp = mcpAs(reader.id);
    await signAs(requestIdOf(await mcp.callToolText('hadron_request_signature', { nodeRef: nodeUrn('s:2') })), 'Phone');
    const text = await mcp.callToolText('hadron_get_nodes', { refs: [nodeUrn('s:2'), nodeUrn('s:3')] });
    expect(text).toMatch(/^Signatures: 1 current — hrn:user:sm-writer \(r1, "Phone"\)$/m);
    expect(text).toMatch(/^Signatures: none$/m);
  });
});
