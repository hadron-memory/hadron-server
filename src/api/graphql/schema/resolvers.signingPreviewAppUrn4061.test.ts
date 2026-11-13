/** #4061 — BootPromptSigningPreviewRow.appUrn is the canonical v2 URN like its sibling agentUrn/workerUrn (hrn:node:hadronmemory.com:specs:cor:urn:010:01). */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex } from '../../../lib/bootCompile/provenance.js';
import { signingPreviewDigest } from '../../../lib/bootPrompt/signingSwitch.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const api = new ApolloServer<Context>({ typeDefs, resolvers });
afterAll(() => api.stop());
const Q = resolvers.Query!;
let orgId: string, authorRoot: string, servingRoot: string, appId: string, agentId: string, workerId: string, adminId: string, memberId: string;
const context = (userId = adminId): Context => ({ db, userId, roles: [] });
const preview = (ctx = context()) => Q.orgBootPromptSigningPreview!({}, { org: orgId }, ctx) as Promise<any>;

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
  const suffix = generateId().slice(0, 10).toLowerCase();
  authorRoot = `author-${suffix}.example`; servingRoot = `serving-${suffix}.example`;
  const author = await db.organization.create({ data: { name: 'Author', urn: authorRoot } });
  const org = await db.organization.create({ data: { name: 'Serving', urn: servingRoot } }); orgId = org.id;
  const admin = await db.user.create({ data: { githubId: 401701, githubUsername: `admin-${suffix}` } }); adminId = admin.id;
  const member = await db.user.create({ data: { githubId: 401702, githubUsername: `member-${suffix}` } }); memberId = member.id;
  await db.orgMember.createMany({ data: [
    { organizationId: orgId, userId: adminId, role: 'ADMIN' },
    { organizationId: orgId, userId: memberId, role: 'CONTRIBUTOR' },
  ] });
  const memory = await db.memory.create({ data: { class: 'system', name: 'System', urn: `${authorRoot}:system`, organizationId: author.id } });
  const agent = await db.agent.create({ data: { name: 'Display agent is not its slug', urn: `${authorRoot}:agent-slug`, organizationId: author.id, systemMemoryId: memory.id } }); agentId = agent.id;
  const app = await db.app.create({ data: { name: 'Display team', urn: `${servingRoot}:team-slug`, organizationId: orgId } }); appId = app.id;
  const node = await withCompileWrite(() => db.node.create({ data: { memoryId: memory.id, loc: 'boot:compiled', name: 'Compiled', content: 'Approved unsigned', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE } }));
  await db.compiledPromptRevision.create({ data: { compiledNodeId: node.id, compiledRevNo: node.revSeq, contentHash: sha256Hex(node.content!), targetKind: 'AGENT', targetAgentId: agentId,
    provenance: { version: 1, occurrences: [{ order: 0, depth: 0, parent: null, kind: 'source', nodeId: 'source', revNo: 1, hash: sha256Hex('source'), selection: { rev: null, approved: true, signed: false } }] }, occurrenceCount: 1 } });
  await db.node.update({ where: { id: node.id }, data: { approvedRevNo: node.revSeq, approvedAt: new Date(), approvedByInfo: 'fixture', approvalHash: computeApprovalHash({ title: node.name, abstract: node.abstract, content: node.content }) } });
  await db.appAgent.create({ data: { appId, agentId, bootPromptNodeId: node.id, bootPromptUrn: 'fixture-pointer' } });
  const worker = await db.worker.create({ data: { appId, agentId, name: 'Display Worker + punctuation', slug: 'worker-slug-2', signature: '', trailer: '', bootPromptNodeId: node.id, bootPromptUrn: 'fixture-pointer' } }); workerId = worker.id;
});
afterEach(() => vi.unstubAllEnvs());

describe('#4061 signing preview appUrn', () => {
  it('emits the canonical v2 form for a canonically stored App, with canonical siblings on the same row', async () => {
    const { rows } = await preview();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.appUrn).toBe(`hrn:app:${servingRoot}:team-slug`);
    expect(rows.find((r: any) => r.workerId === workerId).workerUrn).toBe(`hrn:worker:${servingRoot}:team-slug:worker-slug-2`);
  });

  it('emits canonical v2 for an App stored in the legacy double-colon spelling, and the Worker address agrees', async () => {
    await db.app.update({ where: { id: appId }, data: { urn: `${servingRoot}::team-slug` } });
    const { rows } = await preview();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.appUrn).toBe(`hrn:app:${servingRoot}:team-slug`);
    expect(rows.find((r: any) => r.workerId === workerId).workerUrn).toBe(`hrn:worker:${servingRoot}:team-slug:worker-slug-2`);
  });

  it('emits the same bytes over GraphQL, and the appUrn spelling stays outside the digest and the row order', async () => {
    const canonical = await preview();
    const digest = signingPreviewDigest(canonical.rows);
    const order = canonical.rows.map((r: any) => `${r.appId}/${r.agentId}/${r.workerId}`);
    await db.app.update({ where: { id: appId }, data: { urn: `${servingRoot}::team-slug` } });
    const legacy = await preview();
    expect(legacy.rows.map((r: any) => `${r.appId}/${r.agentId}/${r.workerId}`)).toEqual(order);
    expect(signingPreviewDigest(legacy.rows)).toBe(digest);
    const result = await api.executeOperation({ query: `query($org:ID!){orgBootPromptSigningPreview(org:$org){rows{appUrn}}}`, variables: { org: orgId } }, { contextValue: context() });
    if (result.body.kind !== 'single') throw new Error('Unexpected incremental result');
    expect(result.body.singleResult.errors).toBeUndefined();
    expect((result.body.singleResult.data as any).orgBootPromptSigningPreview.rows).toEqual([{ appUrn: `hrn:app:${servingRoot}:team-slug` }, { appUrn: `hrn:app:${servingRoot}:team-slug` }]);
  });

  it('keeps the row non-null for an App whose stored form cannot emit (null semantics unchanged: raw stored value)', async () => {
    await db.app.update({ where: { id: appId }, data: { urn: 'invalid app address' } });
    const { rows } = await preview();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.appUrn).toBe('invalid app address');
  });
});
