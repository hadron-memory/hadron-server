/** #2973 PR3: real ceremony signatures, resolved reads and strict compile share signed selection. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { createSigningRequestInTransaction, completeSigningRequestInTransaction } from '../signing/requests.js';
import { signaturePayloadBytes, SIGNATURE_PAYLOAD_V3 } from '../signing/payload.js';
import { clearSignatureVerifyCache } from '../signing/verify.js';
import { computeApprovalHash } from '../approvalHash.js';
import { assembleBootPrompt, type AssembleInput } from '../bootCompile/assemble.js';
import { lintWarningPageForNodeId } from '../bootPromptLint.js';
import { withCompileWrite } from '../bootPrompt.js';
import { sha256Hex } from '../bootCompile/provenance.js';
import { BROKEN_INCLUDE_NOTICE } from './spliceIncludes.js';
import { setResolutionLimits } from './resolutionBudget.js';
import { revisionSignatureCounts } from '../signing/revisionSignatureCounts.js';
import { generateId } from '../id.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const ORIGIN = 'https://sign.example.test', RP = 'example.test';
let orgId: string, memoryId: string, agentId: string, adminId: string, writerId: string, partId: string, sourceId: string;
interface NodeResolvers { content(node: unknown, args: object, ctx: Context, info: object): Promise<string> }
const nodeResolvers = (resolvers as unknown as { Node: NodeResolvers }).Node;
const context = (): Context => ({ db, userId: adminId, roles: [] });

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', ORIGIN);
  vi.stubEnv('PASSKEY_RP_ID', RP);
  orgId = (await db.organization.create({ data: { name: 'Includes', urn: 'include2973.test', bootPromptSigningRequired: false } })).id;
  adminId = (await db.user.create({ data: { handle: 'include-admin' } })).id;
  writerId = (await db.user.create({ data: { handle: 'include-writer' } })).id;
  await db.orgMember.createMany({ data: [{ organizationId: orgId, userId: adminId, role: 'ADMIN' }, { organizationId: orgId, userId: writerId, role: 'CONTRIBUTOR' }] });
  memoryId = (await db.memory.create({ data: { name: 'System', urn: 'include2973.test:system', class: 'system', organizationId: orgId } })).id;
  agentId = (await db.agent.create({ data: { name: 'Engineer', urn: 'include2973.test:engineer', organizationId: orgId, systemMemoryId: memoryId } })).id;
  partId = (await db.node.create({ data: { memoryId, loc: 'part', name: 'Part', content: 'v1' } })).id;
  sourceId = (await db.node.create({ data: { memoryId, loc: 'boot:source', name: 'Source', role: 'boot-prompt', content: '{{> part signed}}' } })).id;
});
afterEach(() => { vi.unstubAllEnvs(); setResolutionLimits(null); });

/** Sign the current part through completion, recording the real writer-grade ceremony stamp. */
async function signPart(pending = false) {
  const key = softPasskey();
  const passkeyId = pending ? generateId() : await insertSoftPasskey(db, writerId, key, { rpId: RP });
  // A pending first-key credential needs `window_ends_at` in the future while `registered_at` is 71 hours old. The offset
  // function is replaced INSIDE this transaction (Postgres DDL is transactional), so it is visible only to this
  // transaction's inserts and is put back to 0 before the commit: no other connection or test ever sees the offset.
  if (pending) await db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.hadron_passkey_clock_offset() RETURNS interval LANGUAGE sql STABLE AS $$ SELECT interval '-71 hours' $$`);
    await tx.$executeRaw`INSERT INTO passkey_credentials
      (id, owner_id, credential_id, public_key, algorithm, user_handle, enrollment_rp_id, label, registered_at, counter,
       transports, backup_eligible, backed_up, registration_method, window_ends_at)
      VALUES (${passkeyId}, ${writerId}, ${key.credentialId}, ${key.cosePublicKey}, -7, ${Buffer.alloc(32, 7)}, ${RP}, 'Pending',
        public.hadron_passkey_now(), 0, ARRAY['internal'], false, false, 'github', public.hadron_passkey_now() + interval '72 hours')`;
    await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.hadron_passkey_clock_offset() RETURNS interval LANGUAGE sql STABLE AS $$ SELECT interval '0' $$`);
  });
  const req = await db.$transaction(tx => createSigningRequestInTransaction(tx, partId, {
    memoryId, requester: { userId: writerId, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true,
  }));
  await db.$transaction(tx => completeSigningRequestInTransaction(tx, req.id, {
    memoryId, signerId: writerId, credentialId: key.credentialId, mayWrite: async () => true,
    assertion: key.assert({ payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId: partId, approvalHash: req.approvalHash, requestId: req.id }), origin: ORIGIN, rpId: RP }),
  }));
  return passkeyId;
}

/** Snapshot the part then edit it; metadata-only revisions retain all signed fields. */
async function revise(content?: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: partId } });
  await db.nodeRevision.create({ data: { nodeId: n.id, memoryId, loc: n.loc, name: n.name, abstract: n.abstract, content: n.content, revNo: n.revSeq, tags: [],
    approvedBy: n.approvedBy, approvedAt: n.approvedAt, approvalHash: n.approvalHash } });
  await db.node.update({ where: { id: partId }, data: { revSeq: n.revSeq + 1, ...(content === undefined ? { description: 'metadata edit' } : { content, contentRevSeq: n.revSeq + 1 }), approvedRevNo: null, approvedBy: null, approvedAt: null, approvalHash: null } });
}

/** Give the current revision a genuine hash-matched approval; only the signature comes through a ceremony here. */
async function approve() {
  const n = await db.node.findUniqueOrThrow({ where: { id: partId } });
  await db.node.update({ where: { id: partId }, data: { approvedRevNo: n.revSeq, approvedBy: adminId, approvedAt: new Date(), approvalHash: computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content }) } });
}

async function source(settings = 'signed') {
  await db.node.update({ where: { id: sourceId }, data: { content: `before {{> part ${settings}}} after` } });
}
async function read() {
  const n = await resolvers.Query.node(null, { ref: sourceId } as never, context());
  return nodeResolvers.content(n, {}, context(), {});
}
const input = (): AssembleInput => ({ target: { kind: 'AGENT', agentId }, source: { nodeId: sourceId, memoryId }, installMemoryId: null,
  recipient: { kind: 'org', orgId }, callerCanRead: async () => true });
const compile = () => assembleBootPrompt(db, input());
async function parity(text: string, revision?: number) {
  expect(await read()).toBe(`before ${text} after`);
  const plan = await compile();
  expect(plan.text).toBe(`before ${text} after`);
  if (revision !== undefined) expect(plan.occurrences[1]?.revNo).toBe(revision);
}
async function broken() {
  expect(await read()).toBe(`before ${BROKEN_INCLUDE_NOTICE} after`);
  await expect(compile()).rejects.toMatchObject({ code: 'BOOT_PROMPT_INCLUDE_REVISION_UNAVAILABLE' });
}

describe('#2973 PR3 selection on reads and compile', () => {
  it('enforces an unmet signed setting even though the org switch is off', async () => { await source(); await broken(); });
  it('uses the at-signing writer grade, not the manager grade, after that writer leaves', async () => {
    await signPart();
    const sig = await db.nodeSignature.findFirstOrThrow({ where: { nodeId: partId } });
    expect(sig.stampOwnerKind).toBeNull(); expect(sig.ceremonyStamp).not.toBeNull();
    await db.orgMember.delete({ where: { organizationId_userId: { organizationId: orgId, userId: writerId } } });
    await source(); await parity('v1', 1);
  });
  it('selects newest covered metadata revision, skipping a newer unsigned edit', async () => {
    await signPart(); await revise(); await revise('v3 unsigned'); await source(); await parity('v1', 2);
  });
  it('intersects approval and signing, rather than stopping on an unsigned newer approval', async () => {
    await signPart(); await approve(); await revise('v2'); await approve(); await source('approved signed'); await parity('v1', 1);
  });
  it.each(['signed', 'approved signed'])('continues past one candidate batch for %s', async settings => {
    await signPart(); await approve(); await revise('unsigned');
    await db.nodeRevision.createMany({ data: Array.from({ length: 101 }, (_, i) => ({
      nodeId: partId, memoryId, loc: 'part', name: 'Part', content: 'unsigned', revNo: i + 2, tags: [],
    })) });
    await db.node.update({ where: { id: partId }, data: { revSeq: 103, contentRevSeq: 103 } });
    await source(settings); await parity('v1', 1);
  });
  it('does not serve a signed but unapproved revision when both are required', async () => {
    await approve(); await revise('v2'); await signPart(); await source('approved signed'); await broken();
  });
  it('a pinned signed revision remains served after a later unsigned edit', async () => {
    await signPart(); await revise('v2'); await source('rev=1 signed'); await parity('v1', 1);
  });
  it('a retained pinned unsigned revision refuses even if another revision is signed', async () => {
    await revise('v2'); await signPart(); await source('rev=1 signed'); await broken();
  });
  it('a restore does not revive signing of the restored revision', async () => {
    await signPart(); await revise('v2'); await revise('v1'); await source('rev=3 signed'); await broken();
  });
  it('does not substitute different bytes between signature selection and retrieval', async () => {
    await signPart(); await revise('v2'); await source('rev=1 signed');
    let intercepted = false;
    const wrapped = db.$extends({ query: { nodeRevision: { async findFirst({ args, query }) {
      const row = await query(args);
      if (args.where?.nodeId === partId && args.where?.revNo === 1 && row && 'content' in row) {
        intercepted = true;
        return { ...row, content: 'SUBSTITUTED_UNSIGNED_TEXT' };
      }
      return row;
    } } } });
    const c = { ...context(), db: wrapped as never };
    const n = await resolvers.Query.node(null, { ref: sourceId } as never, c);
    expect(await nodeResolvers.content(n, {}, c, {})).toBe(`before ${BROKEN_INCLUDE_NOTICE} after`);
    expect(intercepted).toBe(true);
    await expect(assembleBootPrompt(wrapped as never, input())).rejects.toMatchObject({ code: 'BOOT_PROMPT_INCLUDE_REVISION_UNAVAILABLE' });
  });
  it('charges the signature predicate queries to a resolved read budget', async () => {
    await signPart(); await source('rev=1 signed');
    // Target and revision retrieval use two lookups; verifying a signature needs more.
    setResolutionLimits({ limits: { maxLookups: 2 } });
    await expect(read()).rejects.toMatchObject({ extensions: { code: 'CONTENT_RESOLUTION_LIMIT_EXCEEDED', limit: 'lookups' } });
  });
  it('can serve older signed text when the current body is null', async () => {
    await signPart(); await revise('changed');
    await db.node.update({ where: { id: partId }, data: { content: null } });
    await source(); await parity('v1', 1);
  });
  it('a valid signature without its historical eligibility stamp counts for no include', async () => {
    await signPart();
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE node_signatures SET ceremony_stamp = NULL, stamp_key_id = NULL, stamp_memory_id = NULL,
        stamp_owner_kind = NULL, stamp_owner_id = NULL WHERE node_id = ${partId}`;
    });
    await source(); await broken();
  });
  it('a key revoked after the window does not erase a signature', async () => {
    const passkeyId = await signPart();
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = public.hadron_passkey_wall_now() WHERE id = ${passkeyId}`;
    await source(); await parity('v1', 1);
  });
  it('a pending first-key signature does not satisfy an include', async () => {
    await signPart(true); await source(); await broken();
  });
  it('a cancelled first-key signature never satisfies an include', async () => {
    const passkeyId = await signPart(true);
    await db.$executeRaw`UPDATE passkey_credentials SET revoked_at = public.hadron_passkey_wall_now(),
      window_ended_at = public.hadron_passkey_wall_now(), window_outcome = 'cancelled' WHERE id = ${passkeyId}`;
    await source(); await broken();
  });
  it('the writer stamp counts only in its capture memory, including a move back', async () => {
    await signPart();
    const other = await db.memory.create({ data: { class: 'knowledge', name: 'Other', urn: 'include2973.test:other', organizationId: orgId } });
    expect(await revisionSignatureCounts(db, partId, 1, 'include')).toBe(true);
    await db.node.update({ where: { id: partId }, data: { memoryId: other.id } });
    expect(await revisionSignatureCounts(db, partId, 1, 'include')).toBe(false);
    await db.node.update({ where: { id: partId }, data: { memoryId } });
    expect(await revisionSignatureCounts(db, partId, 1, 'include')).toBe(true);
  });
  it('reads the deployment flag per call and restores unchecked selection on rollback', async () => {
    await source(); vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false'); await parity('v1', 1);
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true'); await broken();
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false'); await parity('v1', 1);
  });
  it('keeps unsigned and approved selection unchanged when signing is not shipped', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false'); await approve(); await revise('v2');
    await source('approved signed'); await parity('v1', 1);
    await source('rev=2 signed'); await parity('v2', 2);
  });
  it('conceals a hidden signed target exactly like an absent one', async () => {
    const foreign = await db.organization.create({ data: { name: 'Other', urn: 'other2973.test' } });
    const m = await db.memory.create({ data: { name: 'Hidden', urn: 'other2973.test:hidden', class: 'knowledge', organizationId: foreign.id, visibility: 'ORGANIZATION' } });
    await db.node.create({ data: { memoryId: m.id, loc: 'secret', name: 'Secret', content: 'PRIVATE' } });
    for (const loc of ['secret', 'absent']) {
      await db.node.update({ where: { id: sourceId }, data: { content: `{{> hrn:node:${m.urn}:${loc} signed}}` } });
      expect(await read()).toBe(BROKEN_INCLUDE_NOTICE);
      await expect(assembleBootPrompt(db, { ...input(), callerCanRead: async () => false })).rejects.toMatchObject({ code: 'BOOT_PROMPT_INCLUDE_UNAVAILABLE' });
    }
  });
  it('both lints drop SIGNING_NOT_CHECKED only while signing ships', async () => {
    await source();
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
    const plan = await compile();
    const compiled = await withCompileWrite(() => db.node.create({ data: { memoryId, loc: 'boot:compiled', name: 'Compiled', content: plan.text, role: 'boot-prompt', nodeType: 'compiled-boot-prompt' } }));
    await db.compiledPromptRevision.create({ data: { compiledNodeId: compiled.id, compiledRevNo: 1, targetKind: 'AGENT', targetAgentId: agentId,
      contentHash: sha256Hex(plan.text), occurrenceCount: plan.occurrences.length, provenance: { version: 1, occurrences: plan.occurrences } as never } });
    for (const flag of ['false', 'true', 'false']) {
      vi.stubEnv('PASSKEY_SIGNING_ENABLED', flag);
      for (const id of [sourceId, compiled.id]) {
        const page = await lintWarningPageForNodeId(context(), id);
        expect(page).not.toBeNull();
        expect(page!.items.some(w => w.kind === 'SIGNING_NOT_CHECKED')).toBe(flag === 'false');
        expect(page!.items.some(w => w.kind === 'NO_QUALIFYING_REVISION')).toBe(flag === 'true');
      }
    }
  });
});
