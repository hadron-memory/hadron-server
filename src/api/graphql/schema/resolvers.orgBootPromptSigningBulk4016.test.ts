/**
 * #4016 (#4008 slice 2) — the org signing preview and switch-on's digest recompute on the SET-WISE path.
 *
 * Pins: (1) every row equals what the per-target serve decides (a differential against `previewServedBootPrompt`, the
 * oracle, over every shape the fast path treats differently); (2) the cost per row falls by an order of magnitude from
 * the #4014 baseline of 23, EXACTLY (not `<=`), for the preview and for switch-on's recompute, with a multi-revision
 * unsigned fixture (servedRevSeq > 1) so the walk-inclusive count has a ceiling; (3) a 2,000-row organisation completes
 * both the preview and `requireFreshSigningPreview` well inside the 30 s transaction; (4) the audience gate still runs
 * before any preview read; (5) the preview row at the scan-ceiling boundary agrees with the enforced serve.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../../test/softPasskey.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../../../lib/bootCompile/provenance.js';
import { NEWEST_APPROVED_REVISION_SCAN_BATCHES, NEWEST_APPROVED_REVISION_SCAN_CAP, newestApprovedAndSignedRevisionForServe } from '../../../lib/nodeApproval.js';
import { lazyRevisionSignatureStatus } from '../../../lib/signing/revisionSignatureCounts.js';
import { signaturePayloadBytes, SIGNATURE_PAYLOAD_V3 } from '../../../lib/signing/payload.js';
import { clearSignatureVerifyCache } from '../../../lib/signing/verify.js';
import { completeSigningRequestInTransaction, createSigningRequestInTransaction } from '../../../lib/signing/requests.js';
import { previewServedBootPrompt, resolveServedBootPrompt } from '../../../lib/bootPrompt/serve.js';
import {
  computeSigningPreviewRows, dbNowMs, mintSigningPreviewToken, requireFreshSigningPreview, signingPreviewDigest,
  type SigningPreviewRow,
} from '../../../lib/bootPrompt/signingSwitch.js';
import { resolvers, type Context } from './resolvers.js';

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';

let statements = 0;
let statementText: string[] = [];
const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
logged.$on('query', (e) => { statements += 1; statementText.push(e.query); });
afterAll(() => logged.$disconnect());

const prov = (): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src', revNo: 1, hash: sha256Hex('src'), selection: { rev: null, approved: true, signed: false } }],
});

let org: any, app: any, admin: any;
beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  delete process.env.PASSKEY_SIGNING_ENABLED;
  const n = generateId().toLowerCase().slice(0, 8);
  org = await db.organization.create({ data: { name: 'Bulk', urn: `bulk-${n}.example` } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  admin = await db.user.create({ data: { githubId: 401600, githubUsername: `bulk-admin-${n}`, roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
});
afterEach(() => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
  delete process.env.PASSKEY_SIGNING_ENABLED;
});

const hashOf = (content: string) => computeApprovalHash({ title: 'compiled', abstract: null, content });

/** `count` installs, each a fresh Agent with an approved, unsigned, first-revision compiled prompt as its install pointer; bulk-seeded. */
async function seedInstalls(count: number, from = 0, appId: string = app.id) {
  const ids = Array.from({ length: count }, (_, k) => {
    const i = from + k;
    return { i, memoryId: generateId(), agentId: generateId(), nodeId: generateId(), tag: generateId().slice(0, 6), content: 'seeded prompt' };
  });
  await db.memory.createMany({ data: ids.map((x) => ({ id: x.memoryId, class: 'system', name: `sys-${x.i}`, urn: `${org.urn}:sys-${x.i}-${x.tag}`, organizationId: org.id })) as never });
  await db.agent.createMany({ data: ids.map((x) => ({ id: x.agentId, name: `a${x.i}`, urn: `${org.urn}:a${x.i}-${x.tag}`, organizationId: org.id, systemMemoryId: x.memoryId })) as never });
  await withCompileWrite(() => db.node.createMany({
    data: ids.map((x) => ({
      id: x.nodeId, memoryId: x.memoryId, loc: `boot:${x.nodeId}`, name: 'compiled', content: x.content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE,
    })) as never,
  }));
  // approval cannot be set at insert; every seeded node holds the same text, so one update approves them all
  await db.node.updateMany({ where: { id: { in: ids.map((x) => x.nodeId) } }, data: { approvedRevNo: 1, approvedAt: new Date(), approvedByInfo: 't', approvalHash: hashOf('seeded prompt') } });
  await db.compiledPromptRevision.createMany({
    data: ids.map((x) => ({ compiledNodeId: x.nodeId, compiledRevNo: 1, contentHash: sha256Hex(x.content), targetKind: 'AGENT', targetAgentId: x.agentId, provenance: prov() as never, occurrenceCount: 1 })) as never,
  });
  await db.appAgent.createMany({ data: ids.map((x) => ({ appId, agentId: x.agentId, bootPromptNodeId: x.nodeId, bootPromptUrn: `u:${x.nodeId}` })) as never });
  return ids;
}

async function mkAgent(name: string) {
  const memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: `sys-${name}`, urn: `${org.urn}:sys-${name}-${generateId().slice(0, 4)}`, organizationId: org.id } })).id as string;
  const agentId = (await db.agent.create({ data: { id: generateId(), name, urn: `${org.urn}:${name}-${generateId().slice(0, 4)}`, organizationId: org.id, systemMemoryId: memoryId } })).id as string;
  return { agentId, memoryId };
}
async function compiled(memoryId: string, agentId: string, content: string, approve = true) {
  const node = await withCompileWrite(() => db.node.create({ data: { id: generateId(), memoryId, loc: `boot:${generateId()}`, name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, provenance: prov() as never, occurrenceCount: 1 } });
  if (approve) await approveLive(node.id);
  return node.id as string;
}
async function approveLive(nodeId: string) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.node.update({ where: { id: nodeId }, data: { approvedRevNo: n.revSeq, approvedAt: new Date(), approvedByInfo: 't', approvalHash: computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content }) } });
}
/** A newer revision (the old kept as a history row with its approval copied on); approved when `ok`. */
async function recompile(nodeId: string, memoryId: string, agentId: string, content: string, ok = true) {
  const n = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  await db.nodeRevision.create({ data: { nodeId, memoryId, loc: n.loc, name: n.name, content: n.content, revNo: n.revSeq, tags: [], approvedAt: n.approvedAt, approvedByInfo: n.approvedByInfo, approvalHash: n.approvalHash } as never });
  await withCompileWrite(() => db.node.update({ where: { id: nodeId }, data: { content, revSeq: n.revSeq + 1, contentRevSeq: n.revSeq + 1 } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: nodeId, compiledRevNo: n.revSeq + 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, provenance: prov() as never, occurrenceCount: 1 } });
  if (ok) await approveLive(nodeId);
}
const installPointer = (agentId: string, nodeId: string | null, appId: string = app.id) =>
  db.appAgent.create({ data: { appId, agentId, ...(nodeId ? { bootPromptNodeId: nodeId, bootPromptUrn: `u:${nodeId}` } : {}) } as never });

/**
 * The oracle: #4014's per-target algorithm, kept verbatim in shape — `previewServedBootPrompt` decides what is served
 * today, `lazyRevisionSignatureStatus` and the serve's own walk decide the state.
 */
async function oracleRows(d: any, orgId: string): Promise<Array<Pick<SigningPreviewRow, 'appId' | 'agentId' | 'workerId' | 'compiledNodeId' | 'servedRevSeq' | 'state' | 'changesToRevSeq'>>> {
  const apps = await d.app.findMany({ where: { organizationId: orgId, deletedAt: null, uninstalledAt: null }, select: { id: true } });
  const out: any[] = [];
  for (const a of apps) {
    const installs = await d.appAgent.findMany({ where: { appId: a.id }, select: { agentId: true, agent: { select: { name: true } } } });
    const workers = await d.worker.findMany({ where: { appId: a.id, retiredAt: null, bootPromptNodeId: { not: null } }, select: { id: true, agentId: true, agent: { select: { name: true } } } });
    const targets = [
      ...installs.map((i: any) => ({ agentId: i.agentId, name: i.agent.name, workerId: null as string | null })),
      ...workers.map((w: any) => ({ agentId: w.agentId, name: w.agent.name, workerId: w.id as string | null })),
    ];
    for (const t of targets) {
      const today = await previewServedBootPrompt(d, { surface: 'bind', appId: a.id, agent: { id: t.agentId, name: t.name }, workerId: t.workerId });
      if (!today.served) continue;
      const { compiledNodeId, servedRevSeq } = today.served;
      const status = lazyRevisionSignatureStatus(d, compiledNodeId, 'compiled-boot-prompt');
      if ((await status(servedRevSeq)).counts) continue;
      const walk = servedRevSeq <= 1 ? { found: null } : await newestApprovedAndSignedRevisionForServe(d, compiledNodeId, async (r) => (await status(r)).counts);
      const base = { appId: a.id, agentId: t.agentId, workerId: t.workerId, compiledNodeId, servedRevSeq };
      if (walk.found) out.push({ ...base, state: 'REVISION_CHANGES', changesToRevSeq: (walk.found as any).revNo });
      else out.push({ ...base, state: (await status(servedRevSeq)).pending ? 'SIGNATURE_PENDING' : 'UNSIGNED_STOPS', changesToRevSeq: null });
    }
  }
  const key = (r: any) => `${r.appId}\u0000${r.agentId}\u0000${r.workerId ?? ''}`;
  return out.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
}
const project = (rows: SigningPreviewRow[]) => rows.map((r) => ({ appId: r.appId, agentId: r.agentId, workerId: r.workerId, compiledNodeId: r.compiledNodeId, servedRevSeq: r.servedRevSeq, state: r.state, changesToRevSeq: r.changesToRevSeq }));

describe('#4016 the set-wise preview equals the per-target serve, row for row', () => {
  it('over every shape the fast path judges differently from a plain first revision', async () => {
    // plain first revision, approved
    await seedInstalls(2);
    // several approved revisions (servedRevSeq 3), no signatures
    const multi = await mkAgent('multi');
    const multiNode = await compiled(multi.memoryId, multi.agentId, 'v1');
    await recompile(multiNode, multi.memoryId, multi.agentId, 'v2');
    await recompile(multiNode, multi.memoryId, multi.agentId, 'v3');
    await installPointer(multi.agentId, multiNode);
    // newer unapproved edit above an approved one (served revision 1, head unapproved)
    const edited = await mkAgent('edited');
    const editedNode = await compiled(edited.memoryId, edited.agentId, 'e1');
    await recompile(editedNode, edited.memoryId, edited.agentId, 'e2 unapproved', false);
    await installPointer(edited.agentId, editedNode);
    // pointer only on the Agent (install without its own)
    const viaAgent = await mkAgent('viaAgent');
    const viaAgentNode = await compiled(viaAgent.memoryId, viaAgent.agentId, 'agent-level');
    await db.agent.update({ where: { id: viaAgent.agentId }, data: { bootPromptNodeId: viaAgentNode, bootPromptUrn: `u:${viaAgentNode}` } });
    await installPointer(viaAgent.agentId, null);
    // a customised worker with its own pointer, over an install with another
    const wk = await mkAgent('wk');
    const wkInstall = await compiled(wk.memoryId, wk.agentId, 'install text');
    const wkOwn = await compiled(wk.memoryId, wk.agentId, 'worker text');
    await installPointer(wk.agentId, wkInstall);
    await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: wk.agentId, name: 'W', slug: 'w', signature: '', trailer: '', bootPromptNodeId: wkOwn, bootPromptUrn: `u:${wkOwn}` } as never });
    // refused today: no pointer anywhere, unapproved, soft-deleted target, hard-deleted target, no compile record
    const none = await mkAgent('none');
    await installPointer(none.agentId, null);
    const unapproved = await mkAgent('unapproved');
    await installPointer(unapproved.agentId, await compiled(unapproved.memoryId, unapproved.agentId, 'u', false));
    const softGone = await mkAgent('softGone');
    const softNode = await compiled(softGone.memoryId, softGone.agentId, 's');
    await installPointer(softGone.agentId, softNode);
    await db.node.update({ where: { id: softNode }, data: { deletedAt: new Date() } });
    // approved, then the text changed with no snapshot: the approval no longer covers it
    const stale = await mkAgent('stale');
    const staleNode = await compiled(stale.memoryId, stale.agentId, 'before');
    await withCompileWrite(() => db.node.update({ where: { id: staleNode }, data: { content: 'after the approval' } }));
    await installPointer(stale.agentId, staleNode);
    // approved, then a newer revision with the SAME text and no snapshot: the hash still matches but the approval is superseded
    const superseded = await mkAgent('superseded');
    const supNode = await compiled(superseded.memoryId, superseded.agentId, 'same');
    await withCompileWrite(() => db.node.update({ where: { id: supNode }, data: { revSeq: 2, contentRevSeq: 2 } }));
    await installPointer(superseded.agentId, supNode);
    // approved in an encrypted memory, and one whose memory is soft-deleted
    const enc = await mkAgent('enc');
    await installPointer(enc.agentId, await compiled(enc.memoryId, enc.agentId, 'enc'));
    await db.memory.update({ where: { id: enc.memoryId }, data: { isEncrypted: true } });
    const memGone = await mkAgent('memGone');
    await installPointer(memGone.agentId, await compiled(memGone.memoryId, memGone.agentId, 'mg'));
    await db.memory.update({ where: { id: memGone.memoryId }, data: { deletedAt: new Date() } });
    const noCompile = await mkAgent('noCompile');
    const bare = await withCompileWrite(() => db.node.create({ data: { id: generateId(), memoryId: noCompile.memoryId, loc: `boot:${generateId()}`, name: 'compiled', content: 'x', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
    await approveLive(bare.id);
    await installPointer(noCompile.agentId, bare.id);
    // a compile record whose provenance does not parse: the serve throws, so the preview must throw the same thing
    // (checked separately below), so it is not part of the row comparison
    const ours = project(await computeSigningPreviewRows(db, org.id));
    const theirs = await oracleRows(db, org.id);
    expect(ours).toEqual(theirs);
    expect(ours.length).toBeGreaterThanOrEqual(7);
    expect(ours.some((r) => r.servedRevSeq === 3 && r.state === 'UNSIGNED_STOPS')).toBe(true);
    expect(ours.some((r) => r.workerId !== null)).toBe(true);
  }, 120_000);

  it('a compile record that does not parse is thrown exactly as the per-target serve throws it, never a silent row', async () => {
    const bad = await mkAgent('bad');
    const node = (await withCompileWrite(() => db.node.create({ data: { id: generateId(), memoryId: bad.memoryId, loc: `boot:${generateId()}`, name: 'compiled', content: 'bad', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }))).id as string;
    await db.compiledPromptRevision.create({ data: { compiledNodeId: node, compiledRevNo: 1, contentHash: sha256Hex('bad'), targetKind: 'AGENT', targetAgentId: bad.agentId, provenance: prov() as never, occurrenceCount: 7 } });
    await approveLive(node);
    await installPointer(bad.agentId, node);
    const oracle = await previewServedBootPrompt(db, { surface: 'bind', appId: app.id, agent: { id: bad.agentId, name: 'bad' } }).then(() => 'served', (e) => (e as Error).name);
    const ours = await computeSigningPreviewRows(db, org.id).then(() => 'rows', (e) => (e as Error).name);
    expect(oracle).toBe('CompiledRevisionIntegrityError');
    expect(ours).toBe(oracle);
  });
});

describe('#4016 statements per row', () => {
  async function previewStatements() {
    statements = 0;
    const rows = await computeSigningPreviewRows(logged as never, org.id);
    return { rows: rows.length, statements };
  }

  it('the preview adds NO statements per additional row on first-revision installs (was 23 per row at #4014)', async () => {
    await seedInstalls(3);
    const small = await previewStatements();
    await seedInstalls(10, 3);
    const large = await previewStatements();
    expect(small.rows).toBe(3);
    expect(large.rows).toBe(13);
    expect(large.statements - small.statements).toBe(0);
  }, 60_000);

  it('the walk-inclusive cost: installs served at revision 3 with several approved revisions add a fixed, exact number per row', async () => {
    const make = async (k: number) => {
      const a = await mkAgent(`m${k}`);
      const node = await compiled(a.memoryId, a.agentId, `m${k}v1`);
      await recompile(node, a.memoryId, a.agentId, `m${k}v2`);
      await recompile(node, a.memoryId, a.agentId, `m${k}v3`);
      await installPointer(a.agentId, node);
    };
    for (let k = 0; k < 2; k++) await make(k);
    const small = await previewStatements();
    for (let k = 2; k < 6; k++) await make(k);
    const large = await previewStatements();
    expect(large.rows - small.rows).toBe(4);
    // the serve's own approval walk (kept for a node with snapshots): 10 statements a node, no signature walk (a node with no
    // signature record cannot count a revision), against 23 + the second walk before.
    expect((large.statements - small.statements) / (large.rows - small.rows)).toBe(10);
  }, 60_000);

  it("switch-on's own digest recompute (requireFreshSigningPreview) adds NO statements per additional row", async () => {
    const userId = generateId();
    const redeem = async () => {
      const token = mintSigningPreviewToken({ orgId: org.id, userId, digest: signingPreviewDigest(await computeSigningPreviewRows(db, org.id)), iatMs: await dbNowMs(db) });
      statements = 0;
      await requireFreshSigningPreview(logged as never, { token, orgId: org.id, userId });
      return statements;
    };
    await seedInstalls(3);
    const small = await redeem();
    await seedInstalls(10, 3);
    const large = await redeem();
    expect(large - small).toBe(0);
  }, 60_000);
});

describe('#4016 a 2,000-row organisation', () => {
  it('completes the preview AND the switch-on recompute inside the 30 s transaction with margin, and the token it mints redeems', async () => {
    await seedInstalls(2000);
    const ctx: Context = { db, userId: admin.id, roles: [] };
    const t0 = Date.now();
    const page = await (resolvers.Query as any).orgBootPromptSigningPreview({}, { org: org.id, first: 50 }, ctx);
    const previewMs = Date.now() - t0;
    expect(page.total).toBe(2000);
    const t1 = Date.now();
    statements = 0;
    // the SAME 30 s snapshot the resolver uses, on the logging client so the statements are observed
    await logged.$transaction(async (tx) => {
      await requireFreshSigningPreview(tx, { token: page.previewToken, orgId: org.id, userId: admin.id });
    }, { timeout: 30_000, isolationLevel: 'RepeatableRead' as never });
    const redeemMs = Date.now() - t1;
    const redeemStatements = statements;
    // margin: half the transaction limit each (the per-target path at 2,000 rows ran ~46,000 statements)
    expect(previewMs).toBeLessThan(15_000);
    expect(redeemMs).toBeLessThan(15_000);
    // the token redeems the same preview, so switching on is not refused as stale
    expect(redeemStatements).toBeLessThan(200);
  }, 180_000);
});

describe('#4016 the audience gates still run before any preview read', () => {
  it('a non-member is refused FORBIDDEN, byte-identical to an unknown organisation, with no boot-prompt table read', async () => {
    await seedInstalls(2);
    const outsider = await db.user.create({ data: { githubId: 401601, githubUsername: `bulk-out-${generateId().slice(0, 5)}`, roles: [] } });
    const run = async (orgRef: string) => {
      statementText = [];
      const spy = new Proxy(logged, {}) as never;
      try { await (resolvers.Query as any).orgBootPromptSigningPreview({}, { org: orgRef, first: 1 }, { db: spy, userId: outsider.id, roles: [] } as Context); return null; }
      catch (e: any) { return { code: e?.extensions?.code, message: e?.message }; }
    };
    const member = await run(org.id);
    const unknown = await run('no-such-org.example');
    expect(member?.code).toBe('FORBIDDEN');
    expect(member).toEqual(unknown);
    expect(statementText.join('\n')).not.toMatch(/app_agents|compiled_prompt_revisions|node_signatures|FROM "public"\."nodes"/);
  });
});

describe('#4016 the preview row at the scan ceiling agrees with the enforced serve', () => {
  async function ceilingFixture(n: number) {
    const signer = await db.user.create({ data: { githubId: 401602, githubUsername: `bulk-signer-${generateId().slice(0, 5)}`, roles: [] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: signer.id, role: 'ADMIN' } });
    const a = await mkAgent('ceil');
    const node = await compiled(a.memoryId, a.agentId, 'signed text');
    const key = softPasskey();
    await insertSoftPasskey(db, signer.id, key, { firstWindow: false, label: 'Ceiling signer', rpId: RP });
    const req = await db.$transaction((tx) => createSigningRequestInTransaction(tx, node, { memoryId: a.memoryId, requester: { userId: signer.id, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true }));
    await db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
      memoryId: a.memoryId, signerId: signer.id, credentialId: key.credentialId,
      assertion: key.assert({ payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId: node, approvalHash: req.approvalHash, requestId: req.id }), origin: ORIGIN, rpId: RP }),
      mayWrite: async () => true,
    }));
    // n-1 approved-but-unsigned snapshots above the signed revision 1, an unapproved head (the #2973 bury shape)
    const live = await db.node.findUniqueOrThrow({ where: { id: node } });
    await db.nodeRevision.create({ data: { nodeId: node, memoryId: a.memoryId, loc: live.loc, name: live.name, content: live.content, revNo: live.revSeq, tags: [], approvedAt: live.approvedAt, approvedByInfo: live.approvedByInfo, approvalHash: live.approvalHash } as never });
    await db.nodeRevision.createMany({ data: Array.from({ length: n - 1 }, (_, i) => {
      const content = `approved unsigned ${i}`;
      return { nodeId: node, memoryId: a.memoryId, loc: live.loc, name: live.name, content, revNo: live.revSeq + 1 + i, tags: [], approvedAt: new Date(), approvedByInfo: 'test', approvalHash: computeApprovalHash({ title: live.name, abstract: null, content }) };
    }) as never });
    await withCompileWrite(() => db.node.update({ where: { id: node }, data: { content: 'unapproved head', revSeq: live.revSeq + n, contentRevSeq: live.revSeq + n } }));
    await db.compiledPromptRevision.create({ data: { compiledNodeId: node, compiledRevNo: live.revSeq + n, contentHash: sha256Hex('unapproved head'), targetKind: 'AGENT', targetAgentId: a.agentId, provenance: prov() as never, occurrenceCount: 1 } });
    await installPointer(a.agentId, node);
    return { agentId: a.agentId, node };
  }
  const ceiling = NEWEST_APPROVED_REVISION_SCAN_CAP * NEWEST_APPROVED_REVISION_SCAN_BATCHES;
  const enforcedServe = async (agentId: string) => {
    await db.organization.update({ where: { id: org.id }, data: { bootPromptSigningRequired: true } });
    process.env.PASSKEY_SIGNING_ENABLED = 'true';
    try { return await resolveServedBootPrompt(db, { surface: 'bind', appId: app.id, agent: { id: agentId, name: 'ceil' } }); }
    catch (e: any) { return e?.extensions?.code as string; }
    finally { delete process.env.PASSKEY_SIGNING_ENABLED; await db.organization.update({ where: { id: org.id }, data: { bootPromptSigningRequired: false } }); }
  };

  it('n = ceiling - 1: the signed revision is the last one the walk reaches; the preview names it and the serve serves it', async () => {
    const { agentId } = await ceilingFixture(ceiling - 1);
    const rows = await computeSigningPreviewRows(db, org.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'REVISION_CHANGES', changesToRevSeq: 1, servedRevSeq: ceiling - 1 });
    expect(await enforcedServe(agentId)).toMatchObject({ servedRevSeq: 1 });
  }, 240_000);

  it('n = ceiling: one past it the walk stops; the preview says UNSIGNED_STOPS and the serve refuses NOT_SIGNED', async () => {
    const { agentId } = await ceilingFixture(ceiling);
    const rows = await computeSigningPreviewRows(db, org.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'UNSIGNED_STOPS', changesToRevSeq: null });
    expect(await enforcedServe(agentId)).toBe('BOOT_PROMPT_NOT_SIGNED');
  }, 240_000);
});
