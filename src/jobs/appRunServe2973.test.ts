/**
 * #2973 PR1 (cor:agt:040:10) — the RUN surface of the signed serve: where the serving organisation has switched signing
 * on and the deployment ships signing, a headless run whose boot prompt has no signed revision is refused
 * BOOT_PROMPT_NOT_SIGNED at launch (no run, no record); a signed one records with the run. The in-transaction resolve
 * (appRuns.ts `createAndRecord`) judges the check under the launch transaction's own locks, pinned by flipping the
 * switch between the refusal preflight and the transaction.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../test/softPasskey.js';
import { generateId } from '../lib/id.js';
import { computeApprovalHash } from '../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../lib/bootCompile/provenance.js';
import { signaturePayloadBytes, SIGNATURE_PAYLOAD_V3 } from '../lib/signing/payload.js';
import { clearSignatureVerifyCache } from '../lib/signing/verify.js';
import { completeSigningRequestInTransaction, createSigningRequestInTransaction } from '../lib/signing/requests.js';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
const attention = vi.hoisted(() => ({ text: '' }));
vi.mock('../lib/channelReadState.js', async (orig) => ({
  ...(await orig<typeof import('../lib/channelReadState.js')>()),
  renderAttentionSection: vi.fn(async () => ({ text: attention.text, captured: [] })),
}));

import { mintAppRun } from './appRuns.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';

let orgId: string, appId: string, userId: string, agentId: string, signerId: string, memoryId: string;

const mint = (extra: Record<string, unknown> = {}) =>
  mintAppRun(db, { organizationId: orgId, appId, triggerKind: 'MANUAL', entryNodeUrn: 'run-org::runmem::tasks:briefing', publish: false, ...extra } as never);
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };

const provenance = (): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src', revNo: 1, hash: sha256Hex('src'), selection: { rev: null, approved: true, signed: false } }],
});
async function compiledPointer(content: string) {
  const node = await withCompileWrite(() => db.node.create({ data: { id: generateId(), memoryId, loc: 'boot:compiled', name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, provenance: provenance() as never, occurrenceCount: 1 } });
  await db.node.update({ where: { id: node.id }, data: { approvedRevNo: 1, approvedAt: new Date(), approvedByInfo: 't', approvalHash: computeApprovalHash({ title: 'compiled', abstract: null, content }) } });
  await db.agent.update({ where: { id: agentId }, data: { bootPromptNodeId: node.id, bootPromptUrn: `u:${node.id}` } });
  return node.id as string;
}
/** Sign the node's current revision through the real ceremony. */
async function sign(nodeId: string) {
  const key = softPasskey();
  await insertSoftPasskey(db, signerId, key, { label: 'Run signer', rpId: RP });
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

beforeEach(async () => {
  vi.clearAllMocks();
  attention.text = '';
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  process.env.PASSKEY_SIGNING_ENABLED = 'true'; // the deployment ships signing (G2)
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'run-org', urn: 'run-org' } })).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'run-app', urn: 'run-org::run-app' } })).id;
  userId = (await db.user.create({ data: { githubId: 297334, githubUsername: 'run-user', roles: ['READER'] } })).id;
  signerId = (await db.user.create({ data: { githubId: 297335, githubUsername: 'run-signer', roles: [] } })).id;
  // The signer manages the agent (org ADMIN), so the ceremony's stamp carries the manager grade the signed serve
  // requires; a writer-grade stamp would leave the run refused NOT_SIGNED (pinned in the predicate's own tests).
  await db.orgMember.create({ data: { organizationId: orgId, userId: signerId, role: 'ADMIN' } });
  await db.appMember.create({ data: { appId, userId, role: 'member' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: 'run-org:sys', organizationId: orgId } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'Runner', urn: 'run-org:runner', organizationId: orgId, systemMemoryId: memoryId } })).id;
  await db.appAgent.create({ data: { appId, agentId } as never });
});
afterEach(() => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
  delete process.env.PASSKEY_SIGNING_ENABLED;
});

describe('#2973 run surface', () => {
  it('an approved but unsigned prompt refuses the launch BOOT_PROMPT_NOT_SIGNED and no run is created', async () => {
    await db.organization.update({ where: { id: orgId }, data: { bootPromptSigningRequired: true } });
    await compiledPointer('v1');
    const runs = await db.appRun.count();
    expect(await code(mint({ userId, agentId }))).toBe('BOOT_PROMPT_NOT_SIGNED');
    expect(await db.appRun.count()).toBe(runs);
    expect(await db.servedPrompt.count()).toBe(0);
  });

  it('a signed prompt records the serve with the run', async () => {
    await db.organization.update({ where: { id: orgId }, data: { bootPromptSigningRequired: true } });
    const node = await compiledPointer('v1');
    await sign(node);
    const run = await mint({ userId, agentId });
    const rec = await db.servedPrompt.findFirstOrThrow({ where: { runId: run.id } });
    expect(rec).toMatchObject({ kind: 'RUN', appId, agentId, pointerLevel: 'AGENT', compiledNodeId: node, servedRevSeq: 1 });
  });

  it('the in-transaction resolve refuses too: the switch flipped on between the preflight and the transaction rolls the launch back', async () => {
    await compiledPointer('v1'); // switch still OFF at the refusal preflight
    const racing = new Proxy(db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== '$transaction') return typeof v === 'function' ? v.bind(target) : v;
        return async (...args: unknown[]) => {
          // Between the preflight and the transaction: the organisation switches signing on.
          await db.organization.update({ where: { id: orgId }, data: { bootPromptSigningRequired: true } });
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as typeof db;
    const runs = await db.appRun.count();
    expect(await code(mintAppRun(racing, { organizationId: orgId, appId, agentId, userId, triggerKind: 'MANUAL', entryNodeUrn: 'run-org::runmem::tasks:briefing', publish: false } as never))).toBe('BOOT_PROMPT_NOT_SIGNED');
    expect(await db.appRun.count()).toBe(runs);
    expect(await db.servedPrompt.count()).toBe(0);
  });
});
