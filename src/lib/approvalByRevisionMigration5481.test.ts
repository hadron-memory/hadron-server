/**
 * #5481 — the one-time re-anchoring of 20261128150000_approval_by_revision, and the read-only pre-deploy census
 * (scripts/db/approval-by-revision-predeploy-5481.sql), run as the real SQL against a fixture in the shape the OLD
 * server left: history rows carry an approval only at the revision it was recorded at.
 *
 * What the step must do (Holger, 2026-11-28: "It is ok to bless whatever is served today"): record, AT each revision
 * the old rule read approved through another revision's record, that record (original approver, time and hash, and
 * the revision it was recorded at), so the day after the deploy serves what the day before served. Only in an Agent's
 * system memory or an install memory, never in an encrypted one, never deleting anything, never refusing.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../test/softPasskey.js';
import { generateId } from './id.js';
import { computeApprovalHash } from './approvalHash.js';
import { approveNodeInTransaction, newestApprovedRevisionOf, revisionApprovalOf } from './nodeApproval.js';
import { buildNodeRevisionSnapshot, createNodeRevision, revisionStateHashRefreshMarker } from './nodeRevisionSnapshot.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from './bootPrompt.js';
import { sha256Hex } from './bootCompile/provenance.js';
import { signaturePayloadBytes, SIGNATURE_PAYLOAD_V3 } from './signing/payload.js';
import { clearSignatureVerifyCache } from './signing/verify.js';
import { completeSigningRequestInTransaction, createSigningRequestInTransaction } from './signing/requests.js';
import { resolveServedBootPrompt } from './bootPrompt/serve.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

const migration = readFileSync(new URL('../../prisma/migrations/20261128150000_approval_by_revision/migration.sql', import.meta.url), 'utf8');
const census = readFileSync(new URL('../../scripts/db/approval-by-revision-predeploy-5481.sql', import.meta.url), 'utf8');

const ORIGIN = 'https://sign.example.test';
const RP = 'example.test';

let orgId: string;
let placed: string; // an Agent's system memory: in the step's scope
let ordinary: string; // a knowledge memory: out of scope
let agentId: string;
let appId: string;
let approver: string;
let notices: string[] = [];

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  c.on('notice', (n) => { notices.push(String(n.message)); });
  try { return await fn(c); } finally { await c.end(); }
}
const runMigration = () => withClient((c) => c.query(migration));
type Finding = { finding: string; loc: string; node_id: string; in_migration_scope: boolean; today_rev: number | null; new_rule_rev: number | null; text_differs: boolean | null; re_anchored: boolean | null; detail: string | null };
const runCensus = () => withClient(async (c) => {
  const results = await c.query(census) as unknown as pg.QueryResult[];
  return results.find((r) => r.command === 'SELECT')!.rows as Finding[];
});

beforeEach(async () => {
  await cleanDb(db);
  clearSignatureVerifyCache();
  notices = [];
  process.env.SIGNING_CEREMONY_ORIGINS = ORIGIN;
  process.env.PASSKEY_RP_ID = RP;
  delete process.env.PASSKEY_SIGNING_ENABLED;
  const org = await db.organization.create({ data: { id: generateId(), name: 'mig-org', urn: 'mig5481' } });
  orgId = org.id;
  approver = (await db.user.create({ data: { githubId: 548151, githubUsername: 'r5481-approver', roles: [] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: approver, role: 'ADMIN' } });
  placed = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: 'mig5481:sys', organizationId: orgId } })).id;
  ordinary = (await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'kb', urn: 'mig5481:kb', organizationId: orgId } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'Ada', urn: 'mig5481:ada', organizationId: orgId, systemMemoryId: placed } })).id;
  appId = (await db.app.create({ data: { id: generateId(), name: 'App', urn: 'mig5481:app', organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId } as never });
});
afterEach(() => {
  delete process.env.SIGNING_CEREMONY_ORIGINS;
  delete process.env.PASSKEY_RP_ID;
  delete process.env.PASSKEY_SIGNING_ENABLED;
});

const at = (rev: number) => new Date(Date.UTC(2026, 0, rev, 12));
const hashOf = (loc: string, content: string) => computeApprovalHash({ title: loc, abstract: null, content });

/**
 * A node as the OLD server left it: revisions 1..n hold `texts`, the last one live. A history row carries an approval
 * only when its number is in `recordedAt` (its own record); the node holds the newest of those as its approval.
 */
async function history(memoryId: string, loc: string, texts: string[], recordedAt: number[], opts: { role?: string; by?: string | null } = {}) {
  const live = texts.length;
  const by = opts.by === undefined ? approver : opts.by;
  const record = (rev: number) => ({ approvedBy: by, approvedByInfo: by ? null : 'app:legacy', approvedAt: at(rev), approvalHash: hashOf(loc, texts[rev - 1]) });
  let contentRevSeq = live;
  while (contentRevSeq > 1 && texts[contentRevSeq - 2] === texts[live - 1]) contentRevSeq--;
  const n = await db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: texts[live - 1], role: opts.role ?? null } });
  const newest = recordedAt.length ? Math.max(...recordedAt) : null;
  await db.node.update({
    where: { id: n.id },
    data: { revSeq: live, contentRevSeq, ...(newest ? { approvedRevNo: newest, ...record(newest) } : {}) },
  });
  for (let rev = 1; rev < live; rev++) {
    await db.nodeRevision.create({
      data: { id: generateId(), nodeId: n.id, memoryId, revNo: rev, loc, name: loc, content: texts[rev - 1], tags: [], ...(recordedAt.includes(rev) ? record(rev) : {}) },
    });
  }
  return n.id;
}
const rowOf = (nodeId: string, revNo: number) => db.nodeRevision.findFirstOrThrow({ where: { nodeId, revNo } });
const stateOf = async (nodeId: string, revNo: number) => (await revisionApprovalOf(db, nodeId, revNo)).state;
const newest = async (nodeId: string) => (await newestApprovedRevisionOf(db, nodeId)).found?.revNo ?? null;
const everything = async () => ({
  revisions: await db.nodeRevision.count(),
  nodes: await db.node.count(),
  signatures: await db.nodeSignature.count(),
  servedPrompts: await db.servedPrompt.count(),
  compileRows: await db.compiledPromptRevision.count(),
});

// The real writers, for the cases that need a real compiled prompt, a real signature and a real serve.
const compileRow = (nodeId: string, revNo: number, content: string) => db.compiledPromptRevision.create({
  data: {
    compiledNodeId: nodeId, compiledRevNo: revNo, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, occurrenceCount: 1,
    provenance: { version: 1, occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src-node', revNo: 1, hash: sha256Hex(`src ${revNo}`), selection: { rev: null, approved: true, signed: false } }] } as never,
  },
});
async function compiled(content: string): Promise<string> {
  const node = await withCompileWrite(() => db.node.create({
    data: { id: generateId(), memoryId: placed, loc: `boot:${generateId().slice(0, 6)}`, name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
  }));
  await compileRow(node.id, 1, content);
  await db.agent.update({ where: { id: agentId }, data: { bootPromptNodeId: node.id, bootPromptUrn: `mig5481:sys:${node.id}` } });
  return node.id;
}
async function recompile(nodeId: string, content: string): Promise<number> {
  const revNo = await withCompileWrite(() => db.$transaction(async (tx) => {
    const current = await tx.node.findUniqueOrThrow({ where: { id: nodeId } });
    await createNodeRevision(tx, buildNodeRevisionSnapshot(current as never, { userId: null, info: 'test:compile' }, { changes: current.content === content ? [] : ['content'] }));
    return (await tx.node.update({ where: { id: nodeId }, data: { content, revisionContentHash: revisionStateHashRefreshMarker() } })).revSeq;
  }));
  await compileRow(nodeId, revNo, content);
  return revNo;
}
const approve = (nodeId: string) => db.$transaction((tx) => approveNodeInTransaction(tx, nodeId, {
  memoryId: placed, approver: { userId: approver }, key: null, bootPromptGate: { placed: false },
}));
async function sign(nodeId: string) {
  const key = softPasskey();
  await insertSoftPasskey(db, approver, key, { firstWindow: false, label: 'Signer', rpId: RP });
  const req = await db.$transaction((tx) => createSigningRequestInTransaction(tx, nodeId, {
    memoryId: placed, requester: { userId: approver, appId: null, workerId: null, sessionId: null }, mayWrite: async () => true,
  }));
  await db.$transaction((tx) => completeSigningRequestInTransaction(tx, req.id, {
    memoryId: placed, signerId: approver, credentialId: key.credentialId,
    assertion: key.assert({ payload: signaturePayloadBytes(SIGNATURE_PAYLOAD_V3, { nodeId, approvalHash: req.approvalHash, requestId: req.id }), origin: ORIGIN, rpId: RP }),
    mayWrite: async () => true,
  }));
}
/** Make the node's history rows what the OLD server wrote: an approval only on the row of the revision it was recorded at. */
const asTheOldServerLeftIt = (nodeId: string) => db.$executeRaw`
  UPDATE node_revisions SET approved_by = NULL, approved_by_info = NULL, approved_at = NULL, approval_hash = NULL, approved_rev_no = NULL
  WHERE node_id = ${nodeId} AND approved_rev_no IS NOT NULL`;
const serve = () => resolveServedBootPrompt(db, { surface: 'bind', appId, agent: { id: agentId, name: 'Ada' }, workerId: null });
const code = async (p: Promise<unknown>) => {
  try { await p; return 'SERVED'; } catch (e) { return (e as { extensions?: { code?: string } }).extensions?.code ?? (e as Error).message; }
};

describe('#5481 the SQL approval hash is approval hash v1, byte for byte', () => {
  it('agrees with computeApprovalHash on nulls, empty strings, line endings and multi-byte text', async () => {
    const create = /CREATE OR REPLACE FUNCTION pg_temp\.approval_hash_5481[\s\S]*?\$fn\$;/.exec(migration)![0];
    const cases: Array<[string, string | null, string | null]> = [
      ['Retention', null, 'Keep 90 days.\r\n'],
      ['t', '', ''],
      ['t', null, null],
      ['line\rendings', 'a\r\nb\rc\nd', '\r\r\n\n\r'],
      ['Ünïcödé — title', 'abstract ✓', 'content 🚀 with\ttabs and "quotes" and \\ backslashes'],
      ['title 3', 'abstract null', 'content 12\nhadron-approval-v1\n'],
      ['long', null, 'x'.repeat(200_000)],
    ];
    await withClient(async (c) => {
      await c.query(create);
      for (const [title, abstract, content] of cases) {
        const { rows } = await c.query('SELECT pg_temp.approval_hash_5481($1, $2, $3) AS h', [title, abstract, content]);
        expect(rows[0].h, JSON.stringify([title, abstract, (content ?? '').slice(0, 20)])).toBe(computeApprovalHash({ title, abstract, content }));
      }
    });
  });
});

describe('#5481 the re-anchoring step', () => {
  it('records the covering approval AT each revision the old rule read approved, with the original approver, time, hash and revision', async () => {
    // A later non-content revision while the approval stands: rows 2 and 3 are the same text as the approved revision 1.
    const standing = await history(placed, 'standing', ['A', 'A', 'A', 'A'], [1]);
    // The same after a content change: row 2 was in force, row 3 is the new text.
    const superseded = await history(placed, 'superseded', ['A', 'A', 'C', 'D'], [1]);
    // The approved text comes back later in history (rows 3 and 5), with unapproved text in between.
    const recurs = await history(placed, 'recurs', ['A', 'B', 'A', 'C', 'A', 'D'], [1]);

    await runMigration();

    for (const [id, revs] of [[standing, [2, 3]], [superseded, [2]], [recurs, [3, 5]]] as const) {
      const loc = (await db.node.findUniqueOrThrow({ where: { id } })).loc;
      for (const rev of revs) {
        expect(await rowOf(id, rev), `${loc} r${rev}`).toMatchObject({
          approvedBy: approver, approvedByInfo: null, approvedAt: at(1), approvalHash: hashOf(loc, 'A'), approvedRevNo: 1,
        });
        expect(await revisionApprovalOf(db, id, rev), `${loc} r${rev}`).toMatchObject({ state: 'APPROVED', record: { revision: 1, approvedBy: approver } });
      }
    }
    // Rows whose text no record covers stay as they were.
    for (const [id, rev] of [[superseded, 3], [recurs, 2], [recurs, 4]] as const) {
      expect(await rowOf(id, rev)).toMatchObject({ approvedBy: null, approvedByInfo: null, approvedAt: null, approvalHash: null, approvedRevNo: null });
      expect(await stateOf(id, rev)).toBe('NOT_APPROVED');
    }
    // The record's own row is not rewritten.
    expect(await rowOf(recurs, 1)).toMatchObject({ approvedAt: at(1), approvedRevNo: null });
    expect(await newest(standing)).toBe(4); // live, by the standing approval
    expect(await newest(superseded)).toBe(2);
    expect(await newest(recurs)).toBe(5);
    expect(notices.join('\n')).toContain('re-anchored 5 history row(s) and 0 live node(s)');
  });

  it('re-anchors a LIVE node whose text an earlier record covers, at its current revision (the four-revision table)', async () => {
    const table = await history(placed, 'table', ['A', 'B', 'C', 'A'], [1, 2]);
    expect(await db.node.findUniqueOrThrow({ where: { id: table } })).toMatchObject({ approvedRevNo: 2, contentRevSeq: 4, approvalHash: hashOf('table', 'B') });
    expect(await newest(table)).toBe(2); // the new rule, before the step
    await runMigration();
    expect(await db.node.findUniqueOrThrow({ where: { id: table } })).toMatchObject({
      revSeq: 4, approvedRevNo: 4, approvedBy: approver, approvedByInfo: null, approvedAt: at(1), approvalHash: hashOf('table', 'A'),
    });
    expect(await newest(table)).toBe(4); // what the old rule served
    // The approval of revision 2 is still on its own row, and revision 3 was never approved.
    expect(await revisionApprovalOf(db, table, 2)).toMatchObject({ state: 'APPROVED', record: { revision: 2 } });
    expect(await stateOf(table, 3)).toBe('NOT_APPROVED');
    expect(notices.join('\n')).toContain('re-anchored 0 history row(s) and 1 live node(s)');
  });

  it('leaves alone: an ordinary memory, an encrypted memory, a tampered record, another capture memory, a row with approval columns, a revision older than its record', async () => {
    const outOfScope = await history(ordinary, 'out', ['A', 'B', 'A', 'C'], [1]);
    const encMemory = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'enc', urn: 'mig5481:enc', organizationId: orgId } })).id;
    await db.agent.create({ data: { id: generateId(), name: 'Enc', urn: 'mig5481:enc-agent', organizationId: orgId, systemMemoryId: encMemory } });
    const encrypted = await history(encMemory, 'enc', ['A', 'B', 'A', 'C'], [1]);
    const encryptedLive = await history(encMemory, 'enc-live', ['A', 'B', 'A'], [1]); // its LIVE text recurs
    // A node of the plain placed memory whose record and repeat were both captured while it lived in the encrypted one.
    const encryptedCapture = await history(placed, 'enc-capture', ['A', 'B', 'A', 'C'], [1]);
    await db.nodeRevision.updateMany({ where: { nodeId: encryptedCapture, revNo: { in: [1, 3] } }, data: { memoryId: encMemory } });
    await db.memory.update({ where: { id: encMemory }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    const tampered = await history(placed, 'tampered', ['A', 'B', 'A', 'C'], [1]);
    await db.nodeRevision.updateMany({ where: { nodeId: tampered, revNo: 1 }, data: { content: 'altered' } });
    const foreign = await history(placed, 'foreign', ['A', 'B', 'A', 'C'], [1]);
    await db.nodeRevision.updateMany({ where: { nodeId: foreign, revNo: 1 }, data: { memoryId: ordinary } });
    const ended = await history(placed, 'ended', ['A', 'B', 'A', 'C'], [1]);
    // Row 3 keeps who and when of an approval that ENDED (no hash): never overwritten.
    await db.nodeRevision.updateMany({ where: { nodeId: ended, revNo: 3 }, data: { approvedByInfo: 'app:earlier', approvedAt: at(9) } });
    const later = await history(placed, 'later', ['A', 'B', 'A', 'C'], [3]);
    const liveForeign = await history(placed, 'live-foreign', ['A', 'B', 'A'], [1]);
    await db.nodeRevision.updateMany({ where: { nodeId: liveForeign, revNo: 1 }, data: { memoryId: ordinary } });

    const before = {
      rows: await db.nodeRevision.findMany({ orderBy: { id: 'asc' } }),
      nodes: await db.node.findMany({ orderBy: { id: 'asc' } }),
    };
    await runMigration();
    expect(await db.nodeRevision.findMany({ orderBy: { id: 'asc' } })).toEqual(before.rows);
    expect(await db.node.findMany({ orderBy: { id: 'asc' } })).toEqual(before.nodes);
    expect(notices.join('\n')).toContain('re-anchored 0 history row(s) and 0 live node(s)');
    for (const id of [outOfScope, encrypted, tampered, foreign, ended, encryptedCapture]) expect(await rowOf(id, 3)).toMatchObject({ approvalHash: null, approvedRevNo: null });
    expect(await db.node.findUniqueOrThrow({ where: { id: encryptedLive } })).toMatchObject({ approvedRevNo: 1, revSeq: 3 });
    expect(await stateOf(later, 1)).toBe('NOT_APPROVED'); // no approval is recorded before its revision exists
  });

  it('never refuses on an approver who is gone: the row keeps a note, and the node satisfies its completeness check', async () => {
    const row = await history(placed, 'gone-row', ['A', 'A', 'C'], [1], { by: null });
    await db.nodeRevision.updateMany({ where: { nodeId: row, revNo: 1 }, data: { approvedBy: null, approvedByInfo: null } });
    const live = await history(placed, 'gone-live', ['A', 'B', 'A'], [1], { by: null });
    await db.nodeRevision.updateMany({ where: { nodeId: live, revNo: 1 }, data: { approvedBy: null, approvedByInfo: null } });
    await db.$executeRaw`UPDATE nodes SET approved_rev_no = NULL, approved_by = NULL, approved_by_info = NULL, approved_at = NULL, approval_hash = NULL WHERE id = ${live}`;
    await runMigration();
    expect(await rowOf(row, 2)).toMatchObject({ approvedBy: null, approvedByInfo: 'unknown', approvedAt: at(1), approvedRevNo: 1 });
    expect(await db.node.findUniqueOrThrow({ where: { id: live } })).toMatchObject({ approvedRevNo: 3, approvedBy: null, approvedByInfo: 'unknown', approvedAt: at(1) });
    expect(await newest(live)).toBe(3);
  });

  it('runs twice to the same state, deletes nothing, and is a no-op on a database with nothing to re-anchor', async () => {
    await runMigration(); // nothing in scope yet
    expect(notices.join('\n')).toContain('re-anchored 0 history row(s) and 0 live node(s)');
    await history(placed, 'twice', ['A', 'B', 'A', 'C', 'A'], [1]);
    const counts = await everything();
    await runMigration();
    const once = { rows: await db.nodeRevision.findMany({ orderBy: { id: 'asc' } }), nodes: await db.node.findMany({ orderBy: { id: 'asc' } }) };
    notices = [];
    await runMigration();
    expect(await db.nodeRevision.findMany({ orderBy: { id: 'asc' } })).toEqual(once.rows);
    expect(await db.node.findMany({ orderBy: { id: 'asc' } })).toEqual(once.nodes);
    expect(notices.join('\n')).toContain('re-anchored 0 history row(s) and 0 live node(s)');
    expect(await everything()).toEqual(counts);
    expect(migration).not.toMatch(/RAISE\s+EXCEPTION|DELETE\s+FROM|TRUNCATE/i);
  });
});

describe('#5481 day one serves what the day before served, with every reference to an older revision still resolving', () => {
  it('a compiled prompt whose approved text came back live keeps being served that text; nothing is deleted', async () => {
    const id = await compiled('text A');
    await approve(id); // revision 1
    await recompile(id, 'text B');
    await approve(id); // revision 2
    await recompile(id, 'text C'); // revision 3
    await recompile(id, 'text A'); // revision 4: what the old rule serves today
    // A session that is open on revision 2 keeps its record and its revision.
    const sessionId = generateId();
    const workerId = (await db.worker.create({ data: { id: generateId(), appId, agentId, name: 'W', slug: 'w', signature: '', trailer: '' } })).id;
    await db.session.create({ data: { id: sessionId, appId, agentId, workerId, type: 'DEVELOPER' } as never });
    await db.servedPrompt.create({ data: {
      id: generateId(), kind: 'BIND', sessionId, workerId, ordinal: 1, appId, agentId, pointerLevel: 'AGENT', compiledNodeId: id, servedRevSeq: 2, provenanceRevSeq: 2,
      compiledContentHash: sha256Hex('text B'), provenance: [] as never, variables: {} as never,
    } });
    const counts = await everything();
    expect(await serve()).toMatchObject({ servedRevSeq: 2, content: 'text B' }); // the new rule alone would move it

    await runMigration();

    expect(await serve()).toMatchObject({ servedRevSeq: 4, provenanceRevSeq: 4, content: 'text A' }); // as the day before
    expect(await everything()).toEqual(counts); // no revision, signature, served-prompt record or compile row is gone
    expect((await rowOf(id, 2)).content).toBe('text B'); // the open session's revision is still readable
    // From here the new rule governs: a further compile back to B is not served without a new approval.
    await recompile(id, 'text D');
    await recompile(id, 'text B');
    expect(await serve()).toMatchObject({ servedRevSeq: 4, content: 'text A' });
  });

  it('with signing on: a signature on a later non-content revision written by the old server keeps counting', async () => {
    process.env.PASSKEY_SIGNING_ENABLED = 'true';
    await db.organization.update({ where: { id: orgId }, data: { bootPromptSigningRequired: true } });
    const id = await compiled('text A');
    await approve(id); // revision 1
    await recompile(id, 'text A'); // revision 2: same text
    await sign(id); // signed at revision 2
    await recompile(id, 'text B'); // revision 3, unapproved
    await asTheOldServerLeftIt(id); // row 2 carries nothing, as before this change
    expect(await code(serve())).toBe('BOOT_PROMPT_NOT_SIGNED'); // the new rule alone would take the worker offline

    await runMigration();

    expect(await serve()).toMatchObject({ servedRevSeq: 2, content: 'text A' });
    expect(await rowOf(id, 2)).toMatchObject({ approvedBy: approver, approvedRevNo: 1 });
    expect(await db.nodeSignature.count({ where: { nodeId: id, revision: 2 } })).toBe(1);
  });

  it('a pinned `approved` include of a re-anchored revision keeps resolving; one in an ordinary memory does not', async () => {
    const ctx = (): Context => ({ db, userId: approver, roles: [] });
    const read = async (nodeId: string): Promise<string> => {
      const n = await resolvers.Query.node(null, { ref: nodeId } as never, ctx());
      return (await (resolvers as never as { Node: { content: (...a: unknown[]) => Promise<string> } }).Node.content(n, {}, ctx(), {}));
    };
    await history(placed, 'rule', ['A', 'B', 'A', 'C'], [1]);
    const inScope = (await db.node.create({ data: { id: generateId(), memoryId: placed, loc: 'src', name: 'src', content: '{{> rule rev=3 approved}}' } })).id;
    await history(ordinary, 'rule', ['A', 'B', 'A', 'C'], [1]);
    const outOfScope = (await db.node.create({ data: { id: generateId(), memoryId: ordinary, loc: 'src', name: 'src', content: '{{> rule rev=3 approved}}' } })).id;
    expect(await read(inScope)).toBe('[Include unavailable]'); // the new rule, before the step
    await runMigration();
    expect(await read(inScope)).toBe('A');
    expect(await read(outOfScope)).toBe('[Include unavailable]'); // out of the step's scope: listed by the census
  });
});

describe('#5481 the read-only pre-deploy census', () => {
  it('is one READ ONLY transaction with no writing statement', () => {
    const sql = census.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql.trim().startsWith('BEGIN TRANSACTION READ ONLY;')).toBe(true);
    expect(sql.trim().endsWith('ROLLBACK;')).toBe(true);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|COPY)\b/i);
    // It reads no column the migration adds (node_revisions.approved_rev_no), so it runs on the schema deployed today.
    expect(sql).not.toMatch(/\b(r|t|x)\.approved_rev_no\b/);
  });

  it('lists the nodes whose answer the new rule changes or empties, says which the step re-anchors, and is empty after it', async () => {
    const table = await history(placed, 'table', ['A', 'B', 'C', 'A'], [1, 2]); // text differs: A (rev 4) today, B (rev 2) by the rule
    const successor = await history(placed, 'successor', ['A', 'A', 'C'], [1]); // same text, the number moves: 2 today, 1 by the rule
    const out = await history(ordinary, 'out', ['A', 'B', 'A', 'C'], [1]); // out of scope: 3 today, 1 by the rule, not re-anchored
    const same = await history(placed, 'same', ['A', 'B', 'C'], [1, 2]); // no difference: not listed
    const later = await history(placed, 'later', ['A', 'B', 'A', 'C'], [3]); // no difference in the newest: not listed
    // A pin in the newest compile of a compiled prompt, on an old revision of `table`.
    const compiledNode = await withCompileWrite(() => db.node.create({
      data: { id: generateId(), memoryId: placed, loc: 'boot:compiled', name: 'compiled', content: 'x', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
    }));
    await db.compiledPromptRevision.create({ data: {
      compiledNodeId: compiledNode.id, compiledRevNo: 1, contentHash: sha256Hex('x'), targetKind: 'AGENT', targetAgentId: agentId, occurrenceCount: 2,
      provenance: { version: 1, occurrences: [
        { order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src-node', revNo: 1, hash: sha256Hex('s'), selection: { rev: null, approved: true, signed: false } },
        { order: 1, depth: 1, parent: 0, kind: 'include', nodeId: table, revNo: 1, hash: sha256Hex('A'), selection: { rev: 1, approved: true, signed: false } },
      ] } as never,
    } });
    await db.node.create({ data: { id: generateId(), memoryId: placed, loc: 'boot:source', name: 'source', role: 'boot-prompt', content: 'Intro\n{{> table rev=1 approved}}\n{{> same approved}}' } });

    const before = { rows: await db.nodeRevision.findMany({ orderBy: { id: 'asc' } }), nodes: await db.node.findMany({ orderBy: { id: 'asc' } }) };
    const findings = await runCensus();
    // The census wrote nothing.
    expect(await db.nodeRevision.findMany({ orderBy: { id: 'asc' } })).toEqual(before.rows);
    expect(await db.node.findMany({ orderBy: { id: 'asc' } })).toEqual(before.nodes);

    const served = findings.filter((f) => f.finding === 'served-revision');
    expect(served.map((f) => [f.node_id, f.in_migration_scope, f.today_rev, f.new_rule_rev, f.text_differs, f.re_anchored]).sort()).toEqual([
      [table, true, 4, 2, true, true],
      [successor, true, 2, 1, false, true],
      [out, false, 3, 1, false, false],
    ].sort());
    expect(findings.some((f) => f.node_id === same || f.node_id === later)).toBe(false);
    const pins = findings.filter((f) => f.finding === 'pinned-include');
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ node_id: compiledNode.id, today_rev: 4, new_rule_rev: 2 });
    expect(pins[0].detail).toContain('pins revision 1 of mig5481:sys table (approved)');
    const tags = findings.filter((f) => f.finding === 'pinned-tag');
    expect(tags.map((f) => [f.loc, f.detail])).toEqual([['boot:source', '{{> table rev=1 approved}}']]);

    await runMigration();
    const after = await runCensus();
    expect(after.filter((f) => f.finding === 'served-revision').map((f) => f.node_id)).toEqual([out]);
  });

  it('lists a signed revision that only today\'s rule reads approved', async () => {
    const id = await compiled('text A');
    await approve(id); // revision 1
    await recompile(id, 'text A'); // revision 2: same text
    await sign(id); // signed at revision 2, through the real ceremony
    await recompile(id, 'text B'); // revision 3, unapproved
    await asTheOldServerLeftIt(id);
    const findings = await runCensus();
    expect(findings.filter((f) => f.finding === 'signed-revision').map((f) => [f.node_id, f.today_rev, f.re_anchored, f.detail]))
      .toEqual([[id, 2, true, 'signature on revision 2 (1 signature row(s))']]);
    expect(findings.filter((f) => f.finding === 'served-revision').map((f) => [f.node_id, f.today_rev, f.new_rule_rev, f.text_differs, f.re_anchored]))
      .toEqual([[id, 2, 1, false, true]]);
  });
});
