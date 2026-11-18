/**
 * #4008 — the cost of `orgBootPromptSigningPreview` per row. Counts the SQL statements the full preview runs for N and
 * N+K installs (one dedicated logging client, so every statement is observed) and pins the MARGINAL statements per row:
 * wall-clock timings are host-dependent, a statement count is not.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex, type CompiledProvenance } from '../../../lib/bootCompile/provenance.js';
import { computeSigningPreviewRows, mintSigningPreviewToken, requireFreshSigningPreview, signingPreviewDigest, dbNowMs } from '../../../lib/bootPrompt/signingSwitch.js';

let statements = 0;
const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
logged.$on('query', () => { statements += 1; });
afterAll(() => logged.$disconnect());

const prov = (): CompiledProvenance => ({
  version: 1,
  occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'src', revNo: 1, hash: sha256Hex('src'), selection: { rev: null, approved: true, signed: false } }],
});

let org: any, app: any;
beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase().slice(0, 8);
  org = await db.organization.create({ data: { name: 'Cost', urn: `cost-${n}.example` } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
});

/** One install of a fresh Agent whose approved, unsigned compiled boot prompt is the install-level pointer. */
async function install(i: number) {
  const memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: `sys-${i}`, urn: `${org.urn}:sys-${i}-${generateId().slice(0, 4)}`, organizationId: org.id } })).id as string;
  const agentId = (await db.agent.create({ data: { id: generateId(), name: `a${i}`, urn: `${org.urn}:a${i}-${generateId().slice(0, 4)}`, organizationId: org.id, systemMemoryId: memoryId } })).id as string;
  await db.appAgent.create({ data: { appId: app.id, agentId } as never });
  const content = `prompt ${i}`;
  const node = await withCompileWrite(() => db.node.create({ data: { id: generateId(), memoryId, loc: `boot:${generateId()}`, name: 'compiled', content, role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: node.id, compiledRevNo: 1, contentHash: sha256Hex(content), targetKind: 'AGENT', targetAgentId: agentId, provenance: prov() as never, occurrenceCount: 1 } });
  const n = await db.node.findUniqueOrThrow({ where: { id: node.id } });
  await db.node.update({ where: { id: node.id }, data: { approvedRevNo: n.revSeq, approvedAt: new Date(), approvedByInfo: 't', approvalHash: computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content }) } });
  await db.appAgent.update({ where: { appId_agentId: { appId: app.id, agentId } }, data: { bootPromptNodeId: node.id, bootPromptUrn: `u:${node.id}` } });
}

async function statementsFor() {
  statements = 0;
  const rows = await computeSigningPreviewRows(logged as never, org.id);
  return { rows: rows.length, statements };
}

describe('#4008 preview cost per row', () => {
  it('runs a bounded number of statements per additional row', async () => {
    for (let i = 0; i < 3; i++) await install(i);
    const small = await statementsFor();
    for (let i = 3; i < 13; i++) await install(i);
    const large = await statementsFor();
    expect(small.rows).toBe(3);
    expect(large.rows).toBe(13);
    const perRow = (large.statements - small.statements) / (large.rows - small.rows);
    // Main ran 32 per row (the serve's own walk plus a second full revision walk). Now 23 on these first-revision fixtures: the second walk is skipped
    // for a served revision that is signed or is a first revision. The rest is the serve's own per-target reads.
    expect(perRow).toBeLessThanOrEqual(24);
  }, 60_000);

  it("switch-on's own digest recompute (requireFreshSigningPreview) costs the same bounded statements per row", async () => {
    const userId = generateId();
    const redeem = async () => {
      const digest = signingPreviewDigest(await computeSigningPreviewRows(db, org.id));
      const token = mintSigningPreviewToken({ orgId: org.id, userId, digest, iatMs: await dbNowMs(db) });
      statements = 0;
      await requireFreshSigningPreview(logged as never, { token, orgId: org.id, userId });
      return statements;
    };
    for (let i = 0; i < 3; i++) await install(i);
    const small = await redeem();
    for (let i = 3; i < 13; i++) await install(i);
    const large = await redeem();
    expect((large - small) / 10).toBeLessThanOrEqual(24);
  }, 60_000);
});
