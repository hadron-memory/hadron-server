/**
 * #2973 PR1 (cor:agt:040:10) — the BIND surface of the signed serve: where the serving organisation has switched
 * signing on and the deployment ships signing, a bind whose boot prompt has no signed revision is refused
 * BOOT_PROMPT_NOT_SIGNED and rolls back whole (no session, no record); a signed one binds and records. The in-transaction
 * resolve (`serveBindInTransaction`, resolvers.worker.ts) judges the check under the bind's own locks, pinned directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../../test/softPasskey.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../../../lib/bootCompile/provenance.js';
import { signaturePayloadBytes, SIGNATURE_PAYLOAD_V3 } from '../../../lib/signing/payload.js';
import { clearSignatureVerifyCache } from '../../../lib/signing/verify.js';
import { completeSigningRequestInTransaction, createSigningRequestInTransaction } from '../../../lib/signing/requests.js';
import { resolvers, type Context } from './resolvers.js';
import { serveBindInTransaction } from './resolvers.worker.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';

const M = resolvers.Mutation as any;
let org: any, app: any, agent: any, admin: any, worker: any, signerId: string, memoryId: string;
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: admin.id, roles: ['READER'], ...extra });
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };
const bind = () => M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef: worker.id, force: true, llmModel: 'm-1' } }, ctx());
const records = () => db.servedPrompt.findMany({ orderBy: { servedAt: 'asc' } });

const provenance = (): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src', revNo: 1, hash: sha256Hex('src'), selection: { rev: null, approved: true, signed: false } }],
});
async function compiled(content: string) {
  const node = await withCompileWrite(() => db.node.create({ data: { id: generateId(), memoryId, loc: `boot:${generateId().slice(0, 6)}`, name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agent.id, provenance: provenance() as never, occurrenceCount: 1 } });
  await approve(node.id);
  return node.id as string;
}
async function approve(nodeId: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.node.update({ where: { id: nodeId }, data: { approvedRevNo: n.revSeq, approvedAt: new Date(), approvedByInfo: 't', approvalHash: computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content }) } });
}
/** Sign the node's current revision through the real ceremony. */
async function sign(nodeId: string) {
  const key = softPasskey();
  await insertSoftPasskey(db, signerId, key, { label: 'Bind signer', rpId: RP });
  const req = await db.$transaction((tx) => createSigningRequestInTransaction(tx, nodeId, {
    memoryId, requester: { userId: signerId, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true,
  }));
  await db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
    memoryId, signerId, credentialId: key.credentialId,
    assertion: key.assert({
      payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId, approvalHash: req.approvalHash, requestId: req.id }),
      origin: ORIGIN, rpId: RP,
    }),
    mayWrite: async () => true,
  }));
}
const pointAgent = (id: string) => db.agent.update({ where: { id: agent.id }, data: { bootPromptNodeId: id, bootPromptUrn: `u:${id}` } });

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  process.env.PASSKEY_SIGNING_ENABLED = 'true'; // the deployment ships signing (G2)
  const n = generateId().toLowerCase();
  org = await db.organization.create({ data: { name: 'Serve', urn: `serve-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 297332, githubUsername: `serve-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'Role', personaRole: 'tester', description: 'LEGACY {{worker.name}}' }, ctx());
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const made = await M.castWorker({}, { appRef: app.id, agentRef: agent.id, name: 'Iris' }, ctx());
  worker = await db.worker.findUniqueOrThrow({ where: { id: made.id } });
  memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: `${org.urn}:sys`, organizationId: org.id } })).id;
  signerId = (await db.user.create({ data: { githubId: 297333, githubUsername: `signer-${n}`, roles: [] } })).id;
});
afterEach(() => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
  delete process.env.PASSKEY_SIGNING_ENABLED;
});

describe('#2973 bind surface', () => {
  it('an approved but unsigned prompt refuses the bind BOOT_PROMPT_NOT_SIGNED and rolls back whole (no session, no record)', async () => {
    await db.organization.update({ where: { id: org.id }, data: { bootPromptSigningRequired: true } });
    const node = await compiled('unsigned');
    await pointAgent(node);
    const sessions = await db.session.count();
    expect(await code(bind())).toBe('BOOT_PROMPT_NOT_SIGNED');
    expect(await db.session.count()).toBe(sessions);
    expect(await records()).toEqual([]);
  });

  it('a signed prompt binds and records the served revision', async () => {
    await db.organization.update({ where: { id: org.id }, data: { bootPromptSigningRequired: true } });
    const node = await compiled('signed for {{worker.name}}');
    await sign(node);
    await pointAgent(node);
    const session = await bind();
    const [rec] = await records();
    expect(rec).toMatchObject({ kind: 'BIND', sessionId: session.id, appId: app.id, agentId: agent.id, pointerLevel: 'AGENT', compiledNodeId: node, servedRevSeq: 1 });
  });

  it('the in-transaction resolve refuses with the same typed refusal, so the bind transaction rolls back', async () => {
    await db.organization.update({ where: { id: org.id }, data: { bootPromptSigningRequired: true } });
    const node = await compiled('unsigned');
    await pointAgent(node);
    // serveBindInTransaction is the leg that runs INSIDE the bind's transaction, after the session row exists
    // (resolvers.worker.ts): its refusal must roll the whole bind back, leaving no record behind.
    const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: admin.id, agentId: agent.id } });
    await expect(db.$transaction(async (tx) => {
      await serveBindInTransaction(tx as never, ctx(), { sessionId: session.id, workerId: worker.id, appId: app.id, agentId: agent.id, llmModel: 'm-1' });
    })).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_NOT_SIGNED' } });
    expect(await records()).toEqual([]);
  });
});
