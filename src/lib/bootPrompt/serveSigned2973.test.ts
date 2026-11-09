/**
 * #2973 PR1 (cor:agt:040:10 R35/R36, G2) — the signed serve matrix: where the serving organisation has switched signing
 * on AND the deployment ships signing, the serve picks the newest revision that is BOTH approved and signed, refusing
 * BOOT_PROMPT_NOT_SIGNED when an approved revision exists but none of them is signed (a pending-only signature
 * included), and BOOT_PROMPT_NOT_APPROVED when nothing is approved. Either conjunct false keeps today's approval-only
 * serving, and an App with no organisation has no switch at all (today's behaviour, rest on the open question
 * cor:agt:040:09 "does a user-owned App ever require signing").
 *
 * The refusals stay byte-identical in shape on bind, chat and run (the surface and the Agent only — no node, no
 * revision), because they are #2047's one typed refusal list; this file pins that the signed walk reuses it.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { generateId } from '../id.js';
import { computeApprovalHash } from '../approvalHash.js';
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
let signerId: string; // org ADMIN: manages the agent, so live signatures carry the stamp's manager grade
let writerId: string; // org CONTRIBUTOR: a lawful writer who manages nothing (the stamp's writer grade)

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  delete process.env.PASSKEY_SIGNING_ENABLED; // each test states the deployment policy it wants (G2's env term)
  const org = await db.organization.create({ data: { id: generateId(), name: 'sv-org', urn: 'sv-org' } });
  orgId = org.id;
  signerId = (await db.user.create({ data: { githubId: 297331, githubUsername: 'r2973-serve-signer', roles: [] } })).id;
  writerId = (await db.user.create({ data: { githubId: 297332, githubUsername: 'r2973-serve-writer', roles: [] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: signerId, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: writerId, role: 'CONTRIBUTOR' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: 'sv-org:sys', organizationId: orgId } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'Ada', urn: 'sv-org:ada', organizationId: orgId, systemMemoryId: memoryId } })).id;
  appId = (await db.app.create({ data: { id: generateId(), name: 'App', urn: 'sv-org:app', organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } as never });
  workerId = (await db.worker.create({ data: { id: generateId(), appId, agentId, name: 'W', slug: 'w', signature: '', trailer: '' } })).id;
});
afterEach(() => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
  delete process.env.PASSKEY_SIGNING_ENABLED;
});

/** The deployment's signing policy (G2's env term), read per call by the serve. */
const signingShips = (on: boolean) => {
  if (on) process.env.PASSKEY_SIGNING_ENABLED = 'true';
  else delete process.env.PASSKEY_SIGNING_ENABLED;
};
/** The organisation's switch (PR2 adds the control API; PR1 tests set the column directly). */
const switchOn = () => db.organization.update({ where: { id: orgId }, data: { bootPromptSigningRequired: true } });

const prov = (hash: string): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src-node', revNo: 1, hash, selection: { rev: null, approved: true, signed: false } }],
});

/** A compiled node at revision 1 holding `content`, with its compile row. Approved when `approve`. */
async function compiled(content: string, approve = true) {
  const node = await withCompileWrite(() => db.node.create({
    data: { id: generateId(), memoryId, loc: `boot:${generateId().slice(0, 6)}`, name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
  }));
  await db.compiledPromptRevision.create({
    data: { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, provenance: prov(sha256Hex('src')) as never, occurrenceCount: 1 },
  });
  if (approve) await approveLive(node.id);
  return node.id as string;
}
async function approveLive(nodeId: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.node.update({
    where: { id: nodeId },
    data: { approvedRevNo: n.revSeq, approvedAt: new Date(), approvedByInfo: 'test', approvalHash: computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content }) },
  });
}
/** A newer revision holding `content` (the old one kept as a history row with its approval copied onto it); approved when `approve`. */
async function recompile(nodeId: string, content: string, approve = true) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({
    data: {
      nodeId, memoryId, loc: n.loc, name: n.name, content: n.content, revNo: n.revSeq, tags: [],
      approvedAt: n.approvedAt, approvedByInfo: n.approvedByInfo, approvalHash: n.approvalHash,
    } as never,
  });
  await withCompileWrite(() => db.node.update({
    where: { id: nodeId },
    data: { content, revSeq: n.revSeq + 1, contentRevSeq: n.revSeq + 1 },
  }));
  await db.compiledPromptRevision.create({
    data: { compiledNodeId: nodeId, compiledRevNo: n.revSeq + 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, provenance: prov(sha256Hex('src2')) as never, occurrenceCount: 1 },
  });
  if (approve) await approveLive(nodeId);
}

/**
 * Sign the node's CURRENT revision through the real ceremony (create + complete; the signer was eligible when it was
 * made). The org ADMIN signs by default (the stamp's manager grade, which counts for the boot prompt); `as:
 * 'contributor'` signs as a lawful writer who manages nothing — admitted by the ceremony, but the stamp carries the
 * writer grade alone and the serve refuses NOT_SIGNED on it. `firstWindow` registers a first passkey whose 72-hour
 * window is still open, so the signature starts PENDING — the shape cor:dmo:130:04 reads as pending until the window
 * ends normally.
 */
async function sign(nodeId: string, opts: { firstWindow?: boolean; as?: 'admin' | 'contributor' } = {}) {
  const who = opts.as === 'contributor' ? writerId : signerId;
  const key = softPasskey();
  await insertSoftPasskey(db, who, key, { firstWindow: opts.firstWindow ?? false, label: 'Serve signer', rpId: RP });
  const req = await db.$transaction((tx) => createSigningRequestInTransaction(tx, nodeId, {
    memoryId, requester: { userId: who, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true,
  }));
  await db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
    memoryId, signerId: who, credentialId: key.credentialId,
    assertion: key.assert({
      payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId, approvalHash: req.approvalHash, requestId: req.id }),
      origin: ORIGIN, rpId: RP,
    }),
    mayWrite: async () => true,
  }));
}

const pointAgent = (id: string) => db.agent.update({ where: { id: agentId }, data: { bootPromptNodeId: id, bootPromptUrn: `sv-org:sys:${id}` } });
const serve = (surface: 'bind' | 'chat' | 'run' = 'bind', withWorker = true) =>
  resolveServedBootPrompt(db, { surface, appId, agent: { id: agentId, name: 'Ada' }, workerId: withWorker ? workerId : null });
const code = async (p: Promise<unknown>) => {
  try { await p; return 'SERVED'; } catch (e) { return (e as { extensions?: { code?: string } }).extensions?.code ?? (e as Error).message; }
};
const refusalOf = async (p: Promise<unknown>): Promise<{ code: string; message: string; extensions: Record<string, unknown> } | null> => {
  try { await p; return null; } catch (e) {
    const err = e as { message?: string; extensions?: Record<string, unknown> };
    return { code: String(err.extensions?.code), message: String(err.message), extensions: err.extensions ?? {} };
  }
};

describe('#2973 serve matrix — switch on and signing shipped (the conjunction true)', () => {
  it('serves the approved and signed revision', async () => {
    await switchOn();
    signingShips(true);
    const node = await compiled('signed text');
    await sign(node);
    await pointAgent(node);
    expect(await serve()).toMatchObject({ pointerLevel: 'AGENT', compiledNodeId: node, servedRevSeq: 1, content: 'signed text' });
  });

  it('refuses BOOT_PROMPT_NOT_SIGNED for an approved but unsigned revision, byte-identical in shape on every surface', async () => {
    await switchOn();
    signingShips(true);
    const node = await compiled('unsigned text');
    await pointAgent(node);
    const refusals = {
      bind: await refusalOf(serve('bind')),
      chat: await refusalOf(serve('chat', false)),
      run: await refusalOf(serve('run', false)),
    };
    for (const [surface, r] of Object.entries(refusals)) {
      expect(r, surface).not.toBeNull();
      expect(r!.code, surface).toBe('BOOT_PROMPT_NOT_SIGNED');
      // R26: the refusal names the surface and the Agent only — no node id, loc or revision.
      expect(Object.keys(r!.extensions).sort(), surface).toEqual(['agentName', 'code', 'surface']);
      expect(r!.extensions.agentName, surface).toBe('Ada');
      expect(r!.extensions.surface, surface).toBe(surface);
      expect(r!.message, surface).not.toContain(node);
    }
    // One builder (#2047 refusal.ts): the message is the same for all three surfaces.
    expect(refusals.bind!.message).toBe(refusals.chat!.message);
    expect(refusals.bind!.message).toBe(refusals.run!.message);
  });

  it('refuses BOOT_PROMPT_NOT_APPROVED, never NOT_SIGNED, when no revision is approved', async () => {
    await switchOn();
    signingShips(true);
    const node = await compiled('x', false); // never approved
    await pointAgent(node);
    expect(await code(serve())).toBe('BOOT_PROMPT_NOT_APPROVED');
  });

  it('refuses BOOT_PROMPT_NOT_SIGNED when the only signature is pending (its first-key window still open)', async () => {
    await switchOn();
    signingShips(true);
    const node = await compiled('pending text');
    await sign(node, { firstWindow: true }); // PENDING: the window is open
    await pointAgent(node);
    expect(await code(serve())).toBe('BOOT_PROMPT_NOT_SIGNED');
  });

  it('refuses BOOT_PROMPT_NOT_SIGNED when the only signature is a lawful writer-grade one (a non-manager signed it)', async () => {
    await switchOn();
    signingShips(true);
    const node = await compiled('writer text');
    await sign(node, { as: 'contributor' }); // the ceremony admits the writer; the stamp carries no manager grade
    await pointAgent(node);
    // The row exists, is verified and current — but cor:dmo:130:09 names the boot prompt's signers as WHOEVER
    // MANAGES its Agent, so a writer-grade stamp does not satisfy it. The node needs a manager's signature.
    const rows = await db.nodeSignature.count({ where: { nodeId: node } });
    expect(rows).toBe(1);
    expect(await code(serve())).toBe('BOOT_PROMPT_NOT_SIGNED');
    await sign(node); // the manager signs the same revision
    expect(await serve()).toMatchObject({ servedRevSeq: 1, content: 'writer text' });
  });

  it('serves the newest revision that is BOTH approved and signed when a newer approved revision is unsigned (R35)', async () => {
    await switchOn();
    signingShips(true);
    const node = await compiled('v1');
    await sign(node); // revision 1: approved + signed
    await recompile(node, 'v2'); // revision 2: approved, unsigned
    await pointAgent(node);
    expect(await serve()).toMatchObject({ servedRevSeq: 1, content: 'v1' });
  });

  it('a pending signature on the newer revision is not a signed one: the older approved and signed revision serves', async () => {
    await switchOn();
    signingShips(true);
    const node = await compiled('v1');
    await sign(node); // revision 1: approved + signed
    await recompile(node, 'v2');
    await sign(node, { firstWindow: true }); // the newer revision: approved, only a PENDING signature
    await pointAgent(node);
    expect(await serve()).toMatchObject({ servedRevSeq: 1, content: 'v1' });
  });
});

describe('#2973 G2 — the deployment policy AND the organisation switch', () => {
  it('switch on, signing NOT shipped: approval-only serving holds (the newest approved revision serves, signatures ignored)', async () => {
    await switchOn();
    signingShips(false);
    const node = await compiled('v1');
    await sign(node); // revision 1 signed
    await recompile(node, 'v2'); // revision 2 approved, unsigned
    await pointAgent(node);
    expect(await serve()).toMatchObject({ servedRevSeq: 2, content: 'v2' });
  });

  it('switch off, signing shipped: approval-only serving holds (an unsigned approved revision serves)', async () => {
    signingShips(true);
    const node = await compiled('unsigned text'); // switch stays off (the column defaults false)
    await pointAgent(node);
    expect(await serve()).toMatchObject({ servedRevSeq: 1, content: 'unsigned text' });
  });

  it('an App with no organisation has no switch: it serves on approval alone even while signing ships', async () => {
    signingShips(true);
    // A personal App (organizationId null) and its personal Agent; today's behaviour, no "stays fixed" wording.
    const owner = signerId;
    const personalApp = (await db.app.create({ data: { id: generateId(), name: 'Personal', urn: `handle-${generateId().slice(0, 6)}:personal`, ownerUserId: owner } })).id;
    const personalAgent = (await db.agent.create({ data: { id: generateId(), name: 'Solo', urn: `handle-${generateId().slice(0, 6)}:solo`, ownerUserId: owner } })).id;
    const node = await compiled('personal text'); // approved, unsigned, in the org's memory: the serve never reads the memory's org
    await db.agent.update({ where: { id: personalAgent }, data: { bootPromptNodeId: node, bootPromptUrn: `sv-org:sys:${node}` } });
    expect(await resolveServedBootPrompt(db, { surface: 'chat', appId: personalApp, agent: { id: personalAgent, name: 'Solo' } }))
      .toMatchObject({ servedRevSeq: 1, content: 'personal text' });
  });
});
