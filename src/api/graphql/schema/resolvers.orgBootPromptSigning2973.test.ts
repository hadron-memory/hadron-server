/**
 * #2973 PR2 (cor:agt:040:09; rulings:0262 G1, R35) — the organisation boot-prompt signing switch: its audience, its read,
 * its preview, and the preview-acknowledgement token a switch-on must carry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { dbNowMs, mintSigningPreviewToken, SIGNING_PREVIEW_TOKEN_TTL_MS } from '../../../lib/bootPrompt/signingSwitch.js';
import { resolvers, type Context } from './resolvers.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';
const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let org: any, other: any, admin: any, owner: any, contributor: any, revoked: any, platformAdmin: any, outsider: any, signer: any;
let app: any;
let seq = 0;

const ctxOf = (user: any, extra: Partial<Context> = {}): Context => ({ db, userId: user.id, roles: user.roles ?? [], ...extra });
const caught = async (p: Promise<unknown>) => {
  try { await p; return { ok: true as const }; } catch (e: any) { return { ok: false as const, code: e?.extensions?.code as string, message: e?.message as string }; }
};
const status = () => db.organization.findUniqueOrThrow({ where: { id: org.id }, select: { bootPromptSigningRequired: true } }).then((o) => o.bootPromptSigningRequired);
const preview = (c: Context = ctxOf(admin), args: Record<string, unknown> = {}) => Q.orgBootPromptSigningPreview({}, { org: org.id, ...args }, c);
const turnOn = (token: string | null | undefined, c: Context = ctxOf(admin), orgRef = org.id) =>
  M.setOrgBootPromptSigning({}, { org: orgRef, required: true, previewToken: token }, c);
const turnOff = (c: Context = ctxOf(admin), orgRef = org.id) => M.setOrgBootPromptSigning({}, { org: orgRef, required: false }, c);

const prov = (): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src', revNo: 1, hash: sha256Hex('src'), selection: { rev: null, approved: true, signed: false } }],
});
async function compiledIn(memoryId: string, agentId: string, content: string) {
  const node = await withCompileWrite(() => db.node.create({ data: { id: generateId(), memoryId, loc: `boot:${generateId()}`, name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, provenance: prov() as never, occurrenceCount: 1 } });
  await approve(node.id);
  return node.id as string;
}
async function approve(nodeId: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.node.update({ where: { id: nodeId }, data: { approvedRevNo: n.revSeq, approvedAt: new Date(), approvedByInfo: 't', approvalHash: computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content }) } });
}
/** A newer revision (the old kept as a history row with its approval copied on), approved when `ok`. */
async function recompile(nodeId: string, memoryId: string, agentId: string, content: string, ok = true) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({ data: { nodeId, memoryId, loc: n.loc, name: n.name, content: n.content, revNo: n.revSeq, tags: [], approvedAt: n.approvedAt, approvedByInfo: n.approvedByInfo, approvalHash: n.approvalHash } as never });
  await withCompileWrite(() => db.node.update({ where: { id: nodeId }, data: { content, revSeq: n.revSeq + 1, contentRevSeq: n.revSeq + 1 } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: nodeId, compiledRevNo: n.revSeq + 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, provenance: prov() as never, occurrenceCount: 1 } });
  if (ok) await approve(nodeId);
}
async function sign(nodeId: string, memoryId: string, opts: { firstWindow?: boolean } = {}) {
  const key = softPasskey();
  await insertSoftPasskey(db, signer.id, key, { firstWindow: opts.firstWindow ?? false, label: 'Switch signer', rpId: RP });
  const req = await db.$transaction((tx) => createSigningRequestInTransaction(tx, nodeId, { memoryId, requester: { userId: signer.id, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true }));
  await db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
    memoryId, signerId: signer.id, credentialId: key.credentialId,
    assertion: key.assert({ payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId, approvalHash: req.approvalHash, requestId: req.id }), origin: ORIGIN, rpId: RP }),
    mayWrite: async () => true,
  }));
}

const user = (name: string, roles: string[] = []) => db.user.create({ data: { githubId: 297400 + ++seq, githubUsername: `${name}-${seq}-${generateId().slice(0, 4)}`, roles: roles as never } });
/** A fresh Agent with its OWN system memory (the serve's approval walk and the signing fence resolve a node's memory to its one owner). */
async function mkAgent(name: string, orgRow: any) {
  const memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: `sys-${name}`, urn: `${orgRow.urn}:sys-${name}-${generateId().slice(0, 4)}`, organizationId: orgRow.id } })).id as string;
  const agentId = (await db.agent.create({ data: { id: generateId(), name, urn: `${orgRow.urn}:${name}-${generateId().slice(0, 4)}`, organizationId: orgRow.id, systemMemoryId: memoryId } })).id as string;
  return { agentId, memoryId };
}
/** A served prompt for `agent` in `app`: install-level pointer at a compiled node. */
async function installed(agentName: string, content: string, opts: { sign?: boolean; pending?: boolean } = {}) {
  const { agentId, memoryId } = await mkAgent(agentName, org);
  await db.appAgent.create({ data: { appId: app.id, agentId } as never });
  const nodeId = await compiledIn(memoryId, agentId, content);
  if (opts.sign) await sign(nodeId, memoryId, { firstWindow: opts.pending });
  await db.appAgent.update({ where: { appId_agentId: { appId: app.id, agentId } }, data: { bootPromptNodeId: nodeId, bootPromptUrn: `u:${nodeId}` } });
  return { agentId, nodeId, memoryId };
}

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  delete process.env.PASSKEY_SIGNING_ENABLED;
  const n = generateId().toLowerCase().slice(0, 8);
  org = await db.organization.create({ data: { name: 'Sw', urn: `sw-${n}.example` } });
  other = await db.organization.create({ data: { name: 'Other', urn: `other-${n}.example` } });
  admin = await user('admin');
  owner = await user('owner');
  contributor = await user('contrib');
  revoked = await user('revoked');
  outsider = await user('outsider');
  platformAdmin = await user('platform', ['ADMIN']);
  signer = await user('signer');
  for (const [u, role] of [[admin, 'ADMIN'], [owner, 'OWNER'], [contributor, 'CONTRIBUTOR'], [signer, 'ADMIN']] as const) {
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role } });
  }
  await db.orgMember.create({ data: { organizationId: org.id, userId: revoked.id, role: 'ADMIN', deletedAt: new Date() } });
  await db.orgMember.create({ data: { organizationId: other.id, userId: outsider.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
});
afterEach(() => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
  delete process.env.PASSKEY_SIGNING_ENABLED;
});

describe('G1 audience (rulings:0262): who may read, preview and switch', () => {
  const nonexistent = 'does-not-exist-9f3a.example';
  const shapes: Array<[string, () => Context]> = [
    ['a non-member', () => ctxOf(outsider)],
    ['a revoked member', () => ctxOf(revoked)],
    ['a member below ADMIN', () => ctxOf(contributor)],
    ['a platform ADMIN who is not a member', () => ctxOf(platformAdmin)],
    ['an App key', () => ({ ...ctxOf(admin), appId: app.id, appKeyId: generateId() })],
    ['an App-scoped credential carrying only appId', () => ({ ...ctxOf(admin), appId: app.id })],
    ['a credential carrying only appKeyId', () => ({ ...ctxOf(admin), appKeyId: generateId() })],
    ['a worker session, even one held by an admin', () => ({ ...ctxOf(admin), sessionId: generateId() })],
    ['impersonation', () => ({ ...ctxOf(admin), impersonation: { orgId: org.id } as never })],
    ['an App run principal', () => ({ ...ctxOf(admin), appId: app.id, clientId: 'run:abc' })],
    ['no user at all', () => ({ db } as Context)],
  ];

  it.each(shapes)('%s is refused FORBIDDEN on read, preview, switch-on and switch-off, and nothing changes', async (_n, mk) => {
    const token = (await preview()).previewToken as string;
    for (const call of [
      () => Q.orgBootPromptSigning({}, { org: org.id }, mk()),
      () => preview(mk()),
      () => turnOn(token, mk()),
      () => turnOff(mk()),
    ]) {
      const r = await caught(call());
      expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'Forbidden' });
    }
    expect(await status()).toBe(false);
  });

  it('an admin on a missing organisation is refused byte-identically to a non-member of a real one (no existence oracle)', async () => {
    const real = await caught(Q.orgBootPromptSigning({}, { org: org.id }, ctxOf(outsider)));
    const missing = await caught(Q.orgBootPromptSigning({}, { org: nonexistent.includes('.') ? `urn:org:${nonexistent}` : nonexistent }, ctxOf(outsider)));
    expect(missing).toEqual(real);
    const realOn = await caught(turnOn(null, ctxOf(outsider)));
    const missingOn = await caught(turnOn(null, ctxOf(outsider), `urn:org:${nonexistent}`));
    expect(missingOn).toEqual(realOn);
  });

  it('a revoked admin is refused even holding a token an admin fetched; a live OWNER is admitted', async () => {
    const token = (await preview(ctxOf(owner))).previewToken as string;
    expect(await caught(turnOn(token, ctxOf(revoked)))).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await caught(turnOn(token, ctxOf(owner)))).toEqual({ ok: true });
    expect(await status()).toBe(true);
  });
});

describe('the read', () => {
  it('reports the stored switch and the truth: enforced is false while the deployment does not ship signing', async () => {
    expect(await Q.orgBootPromptSigning({}, { org: org.id }, ctxOf(admin))).toEqual({ required: false, enforced: false, deploymentSigns: false });
    await db.organization.update({ where: { id: org.id }, data: { bootPromptSigningRequired: true } });
    expect(await Q.orgBootPromptSigning({}, { org: org.id }, ctxOf(admin))).toEqual({ required: true, enforced: false, deploymentSigns: false });
    process.env.PASSKEY_SIGNING_ENABLED = 'true';
    expect(await Q.orgBootPromptSigning({}, { org: org.id }, ctxOf(admin))).toEqual({ required: true, enforced: true, deploymentSigns: true });
  });
});

describe('the preview', () => {
  it('lists exactly the prompts the switch would change, with the right state each, while signing is not yet shipped', async () => {
    const signedOk = await installed('Fine', 'v1', { sign: true }); // signed: no row
    const unsigned = await installed('Bare', 'v1'); // approved, never signed: stops
    const pending = await installed('Wait', 'v1', { sign: true, pending: true }); // pending signature
    const falls = await installed('Fall', 'v1', { sign: true });
    await recompile(falls.nodeId, falls.memoryId, falls.agentId, 'v2'); // r2 approved, unsigned: falls back to r1
    const p = await preview();
    expect(p).toMatchObject({ enforced: false, deploymentSigns: false, total: 3, hasMore: false });
    const byAgent = new Map<string, any>(p.rows.map((r: any) => [r.agentId, r]));
    expect(byAgent.has(signedOk.agentId)).toBe(false);
    expect(byAgent.get(unsigned.agentId)).toMatchObject({ state: 'UNSIGNED_STOPS', servedRevSeq: 1, changesToRevSeq: null, workerId: null, appId: app.id, compiledNodeId: unsigned.nodeId });
    expect(byAgent.get(pending.agentId)).toMatchObject({ state: 'SIGNATURE_PENDING', servedRevSeq: 1 });
    expect(byAgent.get(falls.agentId)).toMatchObject({ state: 'REVISION_CHANGES', servedRevSeq: 2, changesToRevSeq: 1 });
    expect(byAgent.get(unsigned.agentId).compiledNodeUrn).toEqual(expect.stringContaining('boot:'));
  });

  it('#4008 the signed-served shortcut and the older-signed walk agree with the revision history (several revisions)', async () => {
    const newerSigned = await installed('NewerSigned', 'v1', { sign: true });
    await recompile(newerSigned.nodeId, newerSigned.memoryId, newerSigned.agentId, 'v2');
    await sign(newerSigned.nodeId, newerSigned.memoryId); // r2 approved AND signed: served and signed, no row
    const deep = await installed('Deep', 'v1', { sign: true });
    await recompile(deep.nodeId, deep.memoryId, deep.agentId, 'v2'); // r2 approved, unsigned
    await recompile(deep.nodeId, deep.memoryId, deep.agentId, 'v3'); // r3 approved, unsigned: serves r3, would change to r1
    const unapprovedAbove = await installed('Above', 'v1', { sign: true });
    await recompile(unapprovedAbove.nodeId, unapprovedAbove.memoryId, unapprovedAbove.agentId, 'v2', false); // r2 not approved: r1 serves and is signed
    const p = await preview();
    const byAgent = new Map<string, any>(p.rows.map((r: any) => [r.agentId, r]));
    expect(byAgent.has(newerSigned.agentId)).toBe(false);
    expect(byAgent.has(unapprovedAbove.agentId)).toBe(false);
    expect(byAgent.get(deep.agentId)).toMatchObject({ state: 'REVISION_CHANGES', servedRevSeq: 3, changesToRevSeq: 1 });
    expect(p.total).toBe(1);
  });

  it('includes a shared Agent from another organisation served in this organisation\'s Apps, and nothing else of that organisation\'s', async () => {
    const { agentId: foreignAgent, memoryId: foreignMem } = await mkAgent('Shared', other);
    const foreignNode = await compiledIn(foreignMem, foreignAgent, 'foreign v1');
    await db.appAgent.create({ data: { appId: app.id, agentId: foreignAgent } as never });
    await db.appAgent.update({ where: { appId_agentId: { appId: app.id, agentId: foreignAgent } }, data: { bootPromptNodeId: foreignNode, bootPromptUrn: `u:${foreignNode}` } });
    // The other organisation's OWN App and its prompt are not this organisation's to see.
    const otherApp = await db.app.create({ data: { id: generateId(), organizationId: other.id, name: 'Theirs', urn: `${other.urn}:theirs` } });
    const { agentId: theirAgent, memoryId: theirMem } = await mkAgent('Theirs', other);
    const theirNode = await compiledIn(theirMem, theirAgent, 'theirs');
    await db.appAgent.create({ data: { appId: otherApp.id, agentId: theirAgent, bootPromptNodeId: theirNode, bootPromptUrn: `u:${theirNode}` } as never });
    const p = await preview();
    expect(p.rows.map((r: any) => r.agentId)).toEqual([foreignAgent]);
    expect(p.rows[0]).toMatchObject({ appId: app.id, state: 'UNSIGNED_STOPS' });
  });

  it('lists a worker with its own pointer as its own row', async () => {
    const inst = await installed('Role', 'v1', { sign: true });
    const own = await compiledIn(inst.memoryId, inst.agentId, 'custom');
    const w = await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: inst.agentId, name: 'Iris', slug: 'iris', signature: '', trailer: '', bootPromptNodeId: own, bootPromptUrn: `u:${own}` } as never });
    const p = await preview();
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ workerId: w.id, workerName: 'Iris', compiledNodeId: own, state: 'UNSIGNED_STOPS' });
  });

  it('does not list a retired worker', async () => {
    const inst = await installed('Role', 'v1', { sign: true });
    const own = await compiledIn(inst.memoryId, inst.agentId, 'custom');
    await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: inst.agentId, name: 'Gone', slug: 'gone', signature: '', trailer: '', bootPromptNodeId: own, bootPromptUrn: `u:${own}`, retiredAt: new Date() } as never });
    expect((await preview()).rows).toEqual([]);
  });

  it('pages with a cursor: every page agrees on the total and the token, and the pages cover every row exactly once', async () => {
    for (const n of ['A1', 'A2', 'A3', 'A4', 'A5']) await installed(n, 'v1');
    const seen: string[] = [];
    let after: string | null = null;
    let firstPageToken: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: any = await preview(ctxOf(admin), { first: 2, after });
      expect(page.total).toBe(5);
      firstPageToken ??= page.previewToken as string;
      seen.push(...page.rows.map((r: any) => r.agentId));
      if (!page.hasMore) break;
      after = page.endCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // The token binds the digest of the FULL preview (cor:agt:040:09, cor:api:120:04: the preview is the whole list across every
    // page). Tokens differ per page (each carries its own `iat`), so the pin is behavioural: page one's token, kept while every later
    // page was read, switches signing on. A digest of only the current page's rows would be refused STALE here (#4119).
    expect(await caught(turnOn(firstPageToken))).toEqual({ ok: true });
    expect(await status()).toBe(true);
    for (const bad of [0, -1, 1.5]) {
      expect(await caught(preview(ctxOf(admin), { first: bad }))).toMatchObject({ ok: false, code: 'BAD_USER_INPUT' });
    }
    expect(await caught(preview(ctxOf(admin), { first: 1, after: 'not-a-cursor' }))).toMatchObject({ ok: false, code: 'BAD_USER_INPUT' });
  });

  it("a page-one token goes stale when a row on a LATER page changes (the digest covers the whole list, #4119)", async () => {
    const insts: any[] = [];
    for (const n of ['B1', 'B2', 'B3', 'B4', 'B5']) insts.push(await installed(n, 'v1'));
    const p1: any = await preview(ctxOf(admin), { first: 2 });
    const firstPageIds = new Set(p1.rows.map((r: any) => r.agentId));
    const later = insts.find((i) => !firstPageIds.has(i.agentId));
    await recompile(later.nodeId, later.memoryId, later.agentId, 'changed');
    expect(await caught(turnOn(p1.previewToken))).toMatchObject({ ok: false, code: 'BOOT_PROMPT_SIGNING_PREVIEW_STALE' });
    expect(await status()).toBe(false);
  });

  it('defaults to a page of 20 and serves a request over the cap at the cap (cor:api:120:04)', async () => {
    for (let i = 0; i < 22; i++) await installed(`D${i}`, 'v1');
    const d: any = await preview();
    expect(d.rows).toHaveLength(20);
    expect(d).toMatchObject({ total: 22, hasMore: true });
    const big: any = await preview(ctxOf(admin), { first: 100000 });
    expect(big.rows).toHaveLength(22);
    expect(big.hasMore).toBe(false);
  });

  it('is empty once the switch is enforced (nothing would change)', async () => {
    await installed('Bare', 'v1');
    await db.organization.update({ where: { id: org.id }, data: { bootPromptSigningRequired: true } });
    process.env.PASSKEY_SIGNING_ENABLED = 'true';
    expect(await preview()).toMatchObject({ enforced: true, total: 0, rows: [] });
  });
});

describe('switch-on: the preview token (C4)', () => {
  const stale = { ok: false, code: 'BOOT_PROMPT_SIGNING_PREVIEW_STALE' };

  it('with a fresh token for this organisation and caller, the switch goes on and enforced follows the deployment', async () => {
    await installed('Bare', 'v1');
    const token = (await preview()).previewToken;
    expect(await turnOn(token)).toEqual({ required: true, enforced: false, deploymentSigns: false });
    expect(await status()).toBe(true);
    process.env.PASSKEY_SIGNING_ENABLED = 'true';
    expect(await Q.orgBootPromptSigning({}, { org: org.id }, ctxOf(admin))).toMatchObject({ required: true, enforced: true });
  });

  it('refuses PREVIEW_STALE, changing nothing, for a missing token', async () => {
    expect(await caught(turnOn(null))).toMatchObject(stale);
    expect(await caught(turnOn(undefined))).toMatchObject(stale);
    expect(await caught(turnOn(''))).toMatchObject(stale);
    expect(await status()).toBe(false);
  });

  it('refuses for a forged token (a payload edited under the real signature, a made-up signature, junk)', async () => {
    const token = (await preview()).previewToken as string;
    const [body, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    const edited = `${Buffer.from(JSON.stringify({ ...payload, digest: 'f'.repeat(64) })).toString('base64url')}.${sig}`;
    for (const bad of [edited, `${body}.${'A'.repeat(sig.length)}`, 'junk', `${body}`, `${body}.${sig}.extra`]) {
      expect(await caught(turnOn(bad))).toMatchObject(stale);
    }
    expect(await status()).toBe(false);
  });

  it("refuses another organisation's token and another caller's token", async () => {
    const token = (await preview()).previewToken as string; // admin, org
    const otherOrgToken = (await Q.orgBootPromptSigningPreview({}, { org: other.id }, ctxOf(outsider))).previewToken as string;
    expect(await caught(turnOn(otherOrgToken))).toMatchObject(stale);
    expect(await caught(turnOn(token, ctxOf(owner)))).toMatchObject(stale); // minted for admin
    expect(await status()).toBe(false);
  });

  it('refuses an expired token and a future-dated one, and pins the TTL edge on the database clock', async () => {
    const digestOf = async () => {
      const t = (await preview()).previewToken as string;
      return JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString()).digest as string;
    };
    const digest = await digestOf();
    const mint = (iatMs: number) => mintSigningPreviewToken({ orgId: org.id, userId: admin.id, digest, iatMs });
    const now = await dbNowMs(db);
    expect(await caught(turnOn(mint(now - SIGNING_PREVIEW_TOKEN_TTL_MS - 5_000)))).toMatchObject(stale); // just expired
    expect(await caught(turnOn(mint(now + 60_000)))).toMatchObject(stale); // future-dated
    expect(await status()).toBe(false);
    expect(await caught(turnOn(mint(now - SIGNING_PREVIEW_TOKEN_TTL_MS + 30_000)))).toEqual({ ok: true }); // still inside the window
  });

  it('refuses a token whose preview changed in between (a newly approved unsigned revision), and a fresh preview then succeeds', async () => {
    const inst = await installed('Role', 'v1', { sign: true });
    const token = (await preview()).previewToken as string; // no rows
    await recompile(inst.nodeId, inst.memoryId, inst.agentId, 'v2'); // approved, unsigned: the preview now has a row
    expect(await caught(turnOn(token))).toMatchObject(stale);
    expect(await status()).toBe(false);
    const fresh = await preview();
    expect(fresh.rows).toHaveLength(1);
    expect(await caught(turnOn(fresh.previewToken))).toEqual({ ok: true });
  });

  it('judges the token only AFTER the audience: a non-member with a garbage token gets FORBIDDEN, never STALE', async () => {
    expect(await caught(turnOn('junk', ctxOf(outsider)))).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('is idempotent: on again with a valid token succeeds and changes nothing; off needs no token and is idempotent', async () => {
    const token = (await preview()).previewToken;
    await turnOn(token);
    const before = await db.organization.findUniqueOrThrow({ where: { id: org.id }, select: { updatedAt: true } });
    expect(await turnOn((await preview()).previewToken)).toMatchObject({ required: true });
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id }, select: { updatedAt: true } })).updatedAt).toEqual(before.updatedAt);
    expect(await turnOff()).toMatchObject({ required: false });
    expect(await status()).toBe(false);
    expect(await turnOff()).toMatchObject({ required: false });
  });

  it('two switch-ons racing on one token both end with the switch on, and neither errors beyond PREVIEW_STALE', async () => {
    await installed('Bare', 'v1');
    const token = (await preview()).previewToken;
    const results = await Promise.all([caught(turnOn(token)), caught(turnOn(token))]);
    for (const r of results) if (!r.ok) expect(r.code).toBe('BOOT_PROMPT_SIGNING_PREVIEW_STALE');
    expect(results.some((r) => r.ok)).toBe(true);
    expect(await status()).toBe(true);
  });

  it('a preview-changing write racing a switch-on lands either before its snapshot (the token is stale) or after the commit (the switch went on first)', async () => {
    const inst = await installed('Role', 'v1', { sign: true });
    const token = (await preview()).previewToken as string;
    const [on] = await Promise.all([caught(turnOn(token)), recompile(inst.nodeId, inst.memoryId, inst.agentId, 'v2')]);
    if (on.ok) {
      expect(await status()).toBe(true); // the write was ordered after the switch-on
    } else {
      expect(on).toMatchObject({ code: 'BOOT_PROMPT_SIGNING_PREVIEW_STALE' });
      expect(await status()).toBe(false);
    }
    // Deterministic order 1: the write committed BEFORE the switch-on's snapshot — stale.
    await db.organization.update({ where: { id: org.id }, data: { bootPromptSigningRequired: false } });
    const t2 = (await preview()).previewToken as string;
    await recompile(inst.nodeId, inst.memoryId, inst.agentId, 'v3');
    expect(await caught(turnOn(t2))).toMatchObject(stale);
    // Deterministic order 2: the write lands AFTER the switch-on's commit — the switch is on and stays on.
    const t3 = (await preview()).previewToken as string;
    expect(await caught(turnOn(t3))).toEqual({ ok: true });
    await recompile(inst.nodeId, inst.memoryId, inst.agentId, 'v4');
    expect(await status()).toBe(true);
  });

  it('the switch-on takes the organisation row lock even when it would write nothing: a holder of a share lock on the row makes it wait', async () => {
    await installed('Bare', 'v1');
    await db.organization.update({ where: { id: org.id }, data: { bootPromptSigningRequired: true } }); // already on: the no-write path
    const token = (await preview()).previewToken as string;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${org.id} FOR SHARE`;
      locked();
      await held;
    });
    await lockedP;
    let settled = false;
    const on = turnOn(token).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 600));
    expect(settled).toBe(false); // waiting on the row lock, not decided on a stale read
    release();
    await holder;
    await on;
    expect(await status()).toBe(true);
  });

  it('a revoker that commits while the switch waits on the authority anchor is seen: the audience is re-read on a fresh snapshot (Dorian P2)', async () => {
    const token = (await preview()).previewToken as string;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const revoker = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('authorization:org'), hashtext(${org.id}))`;
      locked();
      await held;
      await tx.orgMember.updateMany({ where: { organizationId: org.id, userId: admin.id }, data: { deletedAt: new Date() } });
    });
    await lockedP;
    const on = caught(turnOn(token));
    const off = caught(turnOff());
    await new Promise((r) => setTimeout(r, 700)); // both are parked on the anchor with a snapshot that predates the revocation
    release();
    await revoker;
    expect(await on).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await off).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await status()).toBe(false);
  });

  it('refuses when the caller is revoked between the preview and the switch-on (the audience is judged live)', async () => {
    const token = (await preview()).previewToken as string;
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: admin.id }, data: { deletedAt: new Date() } });
    expect(await caught(turnOn(token))).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(await status()).toBe(false);
  });
});
