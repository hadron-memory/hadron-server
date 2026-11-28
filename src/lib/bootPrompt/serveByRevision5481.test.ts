/**
 * #5481 (cor:agt:040:10; Holger, 2026-11-28, decision record section 7) — which revision of a compiled boot prompt a
 * bind, a chat and a run are served: the newest revision an approval is recorded at, never a later one whose text
 * equals a text approved earlier. With signing on, the newest revision both approved at that revision and signed.
 *
 * Revisions here are made by the real revision writer (`createNodeRevision`) and approvals by the real approval
 * writer (`approveNodeInTransaction`), so each history row is what production makes of it; only the compile and the
 * manager's gate around them are skipped.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { generateId } from '../id.js';
import { approveNodeInTransaction } from '../nodeApproval.js';
import { buildNodeRevisionSnapshot, createNodeRevision, revisionStateHashRefreshMarker } from '../nodeRevisionSnapshot.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../bootCompile/provenance.js';
import { signaturePayloadBytes, SIGNATURE_PAYLOAD_V3 } from '../signing/payload.js';
import { clearSignatureVerifyCache } from '../signing/verify.js';
import { completeSigningRequestInTransaction, createSigningRequestInTransaction } from '../signing/requests.js';
import { resolveServedBootPrompt } from './serve.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';

let orgId: string;
let memoryId: string;
let agentId: string;
let appId: string;
let workerId: string;
let signerId: string;

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  delete process.env.PASSKEY_SIGNING_ENABLED;
  const org = await db.organization.create({ data: { id: generateId(), name: 'br-org', urn: 'br-org' } });
  orgId = org.id;
  signerId = (await db.user.create({ data: { githubId: 548131, githubUsername: 'r5481-serve-signer', roles: [] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: signerId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: 'br-org:sys', organizationId: orgId } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'Ada', urn: 'br-org:ada', organizationId: orgId, systemMemoryId: memoryId } })).id;
  appId = (await db.app.create({ data: { id: generateId(), name: 'App', urn: 'br-org:app', organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } as never });
  workerId = (await db.worker.create({ data: { id: generateId(), appId, agentId, name: 'W', slug: 'w', signature: '', trailer: '' } })).id;
});
afterEach(() => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
  delete process.env.PASSKEY_SIGNING_ENABLED;
});

const prov = (hash: string): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src-node', revNo: 1, hash, selection: { rev: null, approved: true, signed: false } }],
});
const compileRow = (nodeId: string, revNo: number, content: string) => db.compiledPromptRevision.create({
  data: { compiledNodeId: nodeId, compiledRevNo: revNo, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, provenance: prov(sha256Hex(`src ${revNo}`)) as never, occurrenceCount: 1 },
});

/** A compiled node at revision 1 holding `content`, with its compile row, pointed at by the Agent. Not approved. */
async function compiled(content: string): Promise<string> {
  const node = await withCompileWrite(() => db.node.create({
    data: { id: generateId(), memoryId, loc: `boot:${generateId().slice(0, 6)}`, name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
  }));
  await compileRow(node.id, 1, content);
  await db.agent.update({ where: { id: agentId }, data: { bootPromptNodeId: node.id, bootPromptUrn: `br-org:sys:${node.id}` } });
  return node.id;
}
/** A compile: a new revision through the real revision writer. The same `content` is a compile that changes no text (it still makes a revision). */
async function recompile(nodeId: string, content: string): Promise<number> {
  const revNo = await withCompileWrite(() => db.$transaction(async (tx) => {
    const current = await tx.node.findUniqueOrThrow({ where: { id: nodeId } });
    await createNodeRevision(tx, buildNodeRevisionSnapshot(current as never, { userId: null, info: 'test:compile' }, { changes: current.content === content ? [] : ['content'] }));
    const after = await tx.node.update({ where: { id: nodeId }, data: { content, revisionContentHash: revisionStateHashRefreshMarker() } });
    return after.revSeq;
  }));
  await compileRow(nodeId, revNo, content);
  return revNo;
}
/** The manager approves the current revision (the real approval writer; a placed prompt's gate is the resolver's, not pinned here). */
const approve = (nodeId: string) => db.$transaction((tx) => approveNodeInTransaction(tx, nodeId, {
  memoryId, approver: { userId: signerId }, key: null, bootPromptGate: { placed: false },
}));
/** Sign the node's CURRENT revision through the real ceremony, as the Agent's manager. */
async function sign(nodeId: string) {
  const key = softPasskey();
  await insertSoftPasskey(db, signerId, key, { firstWindow: false, label: 'Serve signer', rpId: RP });
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
const signingOn = async () => {
  process.env.PASSKEY_SIGNING_ENABLED = 'true';
  await db.organization.update({ where: { id: orgId }, data: { bootPromptSigningRequired: true } });
};

const SURFACES = [['bind', true], ['chat', false], ['run', false]] as const;
const serve = (surface: 'bind' | 'chat' | 'run' = 'bind', withWorker = true) =>
  resolveServedBootPrompt(db, { surface, appId, agent: { id: agentId, name: 'Ada' }, workerId: withWorker ? workerId : null });
const code = async (p: Promise<unknown>) => {
  try { await p; return 'SERVED'; } catch (e) { return (e as { extensions?: { code?: string } }).extensions?.code ?? (e as Error).message; }
};

/** The issue's table on one compiled node: rev 1 = A approved, rev 2 = B approved, rev 3 = C, rev 4 = A again. */
async function table(): Promise<string> {
  const id = await compiled('text A');
  await approve(id); // revision 1
  await recompile(id, 'text B');
  await approve(id); // revision 2
  await recompile(id, 'text C'); // revision 3, never approved
  await recompile(id, 'text A'); // revision 4, never approved: the text of revision 1 again
  return id;
}

describe('#5481 the four-revision table at the serve', () => {
  it('after revision 4 a bind, a chat and a run are all served revision 2 (text B), never revision 4', async () => {
    await table();
    for (const [surface, withWorker] of SURFACES) {
      expect(await serve(surface, withWorker), surface).toMatchObject({ servedRevSeq: 2, provenanceRevSeq: 2, content: 'text B', compiledContentHash: sha256Hex('text B') });
    }
  });

  it('approving revision 4 then serves revision 4; a further unapproved compile keeps serving it', async () => {
    const id = await table();
    await approve(id); // recorded AT revision 4
    for (const [surface, withWorker] of SURFACES) expect(await serve(surface, withWorker), surface).toMatchObject({ servedRevSeq: 4, content: 'text A' });
    await recompile(id, 'text D'); // revision 5, unapproved
    await recompile(id, 'text B'); // revision 6 repeats the text approved at revision 2, unapproved
    for (const [surface, withWorker] of SURFACES) expect(await serve(surface, withWorker), surface).toMatchObject({ servedRevSeq: 4, content: 'text A' });
  });

  it('a compile back to the ONLY approved text is not served as a new revision: the approved revision stays the one served', async () => {
    const id = await compiled('text A');
    await approve(id); // revision 1
    await recompile(id, 'text B'); // revision 2, unapproved: ends the approval
    await recompile(id, 'text A'); // revision 3: the approved text again, with no approval act
    expect(await serve()).toMatchObject({ servedRevSeq: 1, provenanceRevSeq: 1, content: 'text A' });
  });
});

describe('#5481 a compile that changes no text (a non-content revision) after an approval', () => {
  it('serves the approved text on every surface, before and after a later unapproved compile, and never refuses', async () => {
    const id = await compiled('text A');
    await approve(id); // revision 1
    await recompile(id, 'text A'); // revision 2: same text, the approval is still in force
    for (const [surface, withWorker] of SURFACES) expect(await serve(surface, withWorker), surface).toMatchObject({ servedRevSeq: 2, content: 'text A' });
    await recompile(id, 'text B'); // revision 3, unapproved
    for (const [surface, withWorker] of SURFACES) expect(await serve(surface, withWorker), surface).toMatchObject({ servedRevSeq: 2, content: 'text A' });
    // The history row of revision 2 carries the approval that was in force at it, with the revision it was recorded at.
    const row = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: id, revNo: 2 } });
    expect(row).toMatchObject({ approvedBy: signerId, approvedRevNo: 1 });
    expect(row.approvalHash).not.toBeNull();
  });
});

describe('#5481 with signing on', () => {
  it('serves the newest revision both approved at that revision and signed; a later signed revision with an earlier-approved text is neither served nor a reason to refuse', async () => {
    await signingOn();
    const id = await compiled('text A');
    await approve(id); // revision 1, approved, unsigned
    await recompile(id, 'text B');
    await approve(id); // revision 2, approved
    await sign(id); // and signed
    await recompile(id, 'text C'); // revision 3
    await recompile(id, 'text A'); // revision 4: the text approved at revision 1, never approved itself
    await sign(id); // a signature on revision 4 does not make it approved
    for (const [surface, withWorker] of SURFACES) expect(await serve(surface, withWorker), surface).toMatchObject({ servedRevSeq: 2, content: 'text B' });
  });

  it('with no revision both approved and signed the refusal is NOT_SIGNED, and the unapproved signed revision is not served', async () => {
    await signingOn();
    const id = await compiled('text A');
    await approve(id); // revision 1, approved, unsigned
    await recompile(id, 'text B'); // revision 2, unapproved
    await recompile(id, 'text A'); // revision 3: the approved text again, unapproved
    await sign(id); // signed at revision 3
    for (const [surface, withWorker] of SURFACES) expect(await code(serve(surface, withWorker)), surface).toBe('BOOT_PROMPT_NOT_SIGNED');
  });

  it('a signature made on a later non-content revision keeps counting after an unapproved compile: no worker goes offline', async () => {
    await signingOn();
    const id = await compiled('text A');
    await approve(id); // revision 1
    await recompile(id, 'text A'); // revision 2: same text
    await sign(id); // the manager signs what is current: revision 2
    expect(await serve()).toMatchObject({ servedRevSeq: 2, content: 'text A' });
    await recompile(id, 'text B'); // revision 3, unapproved
    for (const [surface, withWorker] of SURFACES) expect(await serve(surface, withWorker), surface).toMatchObject({ servedRevSeq: 2, content: 'text A' });
  });

  it('the same with the approved revision\'s neighbours pruned away: the signed revision carries its own approval', async () => {
    await signingOn();
    await db.memory.update({ where: { id: memoryId }, data: { maxRevCount: 2 } });
    const id = await compiled('text A');
    await approve(id); // revision 1
    for (let i = 0; i < 6; i++) await recompile(id, 'text A'); // revisions 2..7, same text
    await sign(id); // signed at revision 7
    for (let i = 0; i < 6; i++) await recompile(id, `draft ${i}`); // unapproved compiles; ordinary history is pruned
    const kept = (await db.nodeRevision.findMany({ where: { nodeId: id }, select: { revNo: true } })).map((r) => r.revNo);
    expect(kept).not.toContain(3); // the revisions between the record and the signature are gone
    expect(await serve()).toMatchObject({ servedRevSeq: 7, content: 'text A' });
  });
});
