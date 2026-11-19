/** #4017 — preview display addresses obey the row gate and do not change acknowledgement identity. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex } from '../../../lib/bootCompile/provenance.js';
import { requireFreshSigningPreview, signingPreviewDigest } from '../../../lib/bootPrompt/signingSwitch.js';
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

describe('#4017 signing preview URNs', () => {
  it('documents both nullable display addresses in the SDL', () => {
    const fields = (buildSchema(typeDefs).getType('BootPromptSigningPreviewRow') as GraphQLObjectType).getFields();
    expect(fields.agentUrn?.type.toString()).toBe('String');
    expect(fields.agentUrn?.description).toMatch(/agent/i);
    expect(fields.workerUrn?.type.toString()).toBe('String');
    expect(fields.workerUrn?.description).toMatch(/worker/i);
  });
  it('exposes nullable, documented agent/worker URNs through the actual GraphQL surface on both row kinds', async () => {
    const result = await api.executeOperation({ query: `query($org:ID!){orgBootPromptSigningPreview(org:$org){rows{agentId agentUrn workerId workerUrn}}}`, variables: { org: orgId } }, { contextValue: context() });
    expect(result.body.kind).toBe('single');
    if (result.body.kind !== 'single') throw new Error('Unexpected incremental result');
    expect(result.body.singleResult.errors).toBeUndefined();
    const rows = (result.body.singleResult.data as any).orgBootPromptSigningPreview.rows;
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ agentId, agentUrn: `hrn:agent:${authorRoot}:agent-slug`, workerId: null, workerUrn: null });
    expect(rows).toContainEqual({ agentId, agentUrn: `hrn:agent:${authorRoot}:agent-slug`, workerId, workerUrn: `hrn:worker:${servingRoot}:team-slug:worker-slug-2` });
  });

  it('derives agent addresses from the author, worker addresses from stored slugs, never display names', async () => {
    const { rows } = await preview();
    expect(rows.map((r: any) => r.agentUrn)).toEqual([`hrn:agent:${authorRoot}:agent-slug`, `hrn:agent:${authorRoot}:agent-slug`]);
    expect(rows.find((r: any) => r.workerId === workerId)).toMatchObject({ workerUrn: `hrn:worker:${servingRoot}:team-slug:worker-slug-2` });
    expect(rows.find((r: any) => r.workerId === null)).toMatchObject({ workerUrn: null });
  });

  it('emits canonical addresses from stored legacy double-colon forms', async () => {
    await db.agent.update({ where: { id: agentId }, data: { urn: `${authorRoot}::agent-slug` } });
    await db.app.update({ where: { id: appId }, data: { urn: `${servingRoot}::team-slug` } });
    const { rows } = await preview();
    expect(rows[0].agentUrn).toBe(`hrn:agent:${authorRoot}:agent-slug`);
    expect(rows.find((r: any) => r.workerId === workerId).workerUrn).toBe(`hrn:worker:${servingRoot}:team-slug:worker-slug-2`);
  });

  it('returns null, not fabricated or raw addresses, when stored forms cannot emit', async () => {
    await db.agent.update({ where: { id: agentId }, data: { urn: 'invalid agent address' } });
    await db.app.update({ where: { id: appId }, data: { urn: 'invalid app address' } });
    const { rows } = await preview();
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.agentUrn === null && r.workerUrn === null)).toBe(true);
  });

  it.each(['member', 'worker-session'] as const)('preserves the existing uniform refusal for %s before exposing rows', async shape => {
    const ctx = shape === 'member' ? context(memberId) : { ...context(), sessionId: generateId() };
    await expect(preview(ctx)).rejects.toMatchObject({ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } });
  });

  it('keeps display URNs outside the full digest and accepts a token across address-only changes', async () => {
    const before = await preview();
    const digest = signingPreviewDigest(before.rows);
    expect(signingPreviewDigest(before.rows.map((r: any) => ({ ...r, agentUrn: 'changed-agent', workerUrn: 'changed-worker' })))).toBe(digest);
    await db.agent.update({ where: { id: agentId }, data: { urn: `${authorRoot}:renamed-agent` } });
    await db.app.update({ where: { id: appId }, data: { urn: `${servingRoot}:renamed-team` } });
    const after = await preview();
    expect(after.rows[0].agentUrn).toBe(`hrn:agent:${authorRoot}:renamed-agent`);
    expect(signingPreviewDigest(after.rows)).toBe(digest);
    await expect(requireFreshSigningPreview(db, { token: before.previewToken, orgId, userId: adminId })).resolves.toBeUndefined();
  });
});
