/** #4054 — aggregate, sanitized warning for un-emittable preview display addresses; digest identity controls. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeApprovalHash } from '../../../lib/approvalHash.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../../../lib/bootPrompt.js';
import { sha256Hex } from '../../../lib/bootCompile/provenance.js';
import { requireFreshSigningPreview, SIGNING_PREVIEW_STALE_CODE, signingPreviewDigest, type SigningPreviewRow } from '../../../lib/bootPrompt/signingSwitch.js';
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


const EVENT = 'signing.preview.address_composition_failed';
const SENTINEL = 'SENTINEL secret agent address';
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());
const events = () => (warn.mock.calls as unknown[][]).filter(c => c[0] === EVENT);
const breakAgent = () => db.agent.update({ where: { id: agentId }, data: { urn: SENTINEL } });
const breakApp = () => db.app.update({ where: { id: appId }, data: { urn: 'SENTINEL app address' } });

describe('#4054 address-composition diagnostic', () => {
  it('emits exactly one aggregate event with the four allowlisted keys and keeps rows and nulls', async () => {
    await breakAgent(); await breakApp();
    const { rows } = await preview();
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.agentUrn === null)).toBe(true);
    expect(rows.find((r: any) => r.workerId === workerId)).toMatchObject({ workerUrn: null, state: 'UNSIGNED_STOPS' });
    expect(events()).toHaveLength(1);
    const call = events()[0];
    expect(call).toHaveLength(2);
    expect(call[1]).toEqual({ schemaVersion: 1, reason: 'COMPOSITION_FAILED', agentFailures: 2, workerFailures: 1 });
    expect(Object.keys(call[1] as object).sort()).toEqual(['agentFailures', 'reason', 'schemaVersion', 'workerFailures']);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SENTINEL/);
  });
  it('isolates the failing side and never counts an install-level absent worker', async () => {
    await breakAgent();
    await preview();
    expect(events().map(c => c[1])).toEqual([{ schemaVersion: 1, reason: 'COMPOSITION_FAILED', agentFailures: 2, workerFailures: 0 }]);
    warn.mockClear();
    await db.agent.update({ where: { id: agentId }, data: { urn: `${authorRoot}:agent-slug` } });
    await breakApp();
    const { rows } = await preview();
    expect(rows.every((r: any) => r.agentUrn === `hrn:agent:${authorRoot}:agent-slug`)).toBe(true);
    expect(events().map(c => c[1])).toEqual([{ schemaVersion: 1, reason: 'COMPOSITION_FAILED', agentFailures: 0, workerFailures: 1 }]);
  });
  it('is silent for success', async () => {
    await preview();
    expect(events()).toHaveLength(0);
  });
  it('is silent for a legacy-separator agent URN', async () => {
    await db.agent.update({ where: { id: agentId }, data: { urn: `${authorRoot}::agent-slug` } });
    await preview();
    expect(events()).toHaveLength(0);
  });
  it('is silent for an enforced empty preview', async () => {
    await db.organization.update({ where: { id: orgId }, data: { bootPromptSigningRequired: true } });
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    expect((await preview()).rows).toEqual([]);
    expect(events()).toHaveLength(0);
  });
  it('is silent when a member caller is refused', async () => {
    await breakAgent();
    await expect(preview(context(memberId))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(events()).toHaveLength(0);
  });
  it('is silent when a caller with a different sessionId is refused', async () => {
    await breakAgent();
    await expect(preview({ ...context(), sessionId: generateId() })).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(events()).toHaveLength(0);
  });
  it('emits one event per computation, not per page or per failed row, and once on the token recheck', async () => {
    await breakAgent(); await breakApp();
    const result = await api.executeOperation({ query: `query($org:ID!){orgBootPromptSigningPreview(org:$org,first:1){rows{agentUrn workerUrn} hasMore}}`, variables: { org: orgId } }, { contextValue: context() });
    if (result.body.kind !== 'single') throw new Error('incremental');
    expect(result.body.singleResult.errors).toBeUndefined();
    expect(events()).toHaveLength(1);
    warn.mockClear();
    const before = await preview();
    warn.mockClear();
    await requireFreshSigningPreview(db, { token: before.previewToken, orgId, userId: adminId });
    expect(events()).toHaveLength(1);
  });
});

const row = (): SigningPreviewRow => ({
  appId: 'a', appUrn: 'x:app', agentId: 'g', agentName: 'Agent', agentUrn: 'hrn:agent:x:g', workerId: null, workerName: null, workerUrn: null,
  compiledNodeId: 'n', compiledNodeUrn: 'hrn:node:x:m:l', servedRevSeq: 2, state: 'UNSIGNED_STOPS', changesToRevSeq: null,
} as SigningPreviewRow);

describe('#4054 digest controls', () => {
  const base = signingPreviewDigest([row()]);
  it('is deterministic and row-count sensitive', () => {
    expect(signingPreviewDigest([row()])).toBe(base);
    expect(signingPreviewDigest([])).not.toBe(base);
    expect(signingPreviewDigest([row(), row()])).not.toBe(base);
  });
  it.each([
    ['appId', { appId: 'b' }], ['agentId', { agentId: 'h' }], ['workerId null to present', { workerId: 'w' }], ['compiledNodeId', { compiledNodeId: 'm' }],
    ['servedRevSeq', { servedRevSeq: 3 }], ['state', { state: 'SIGNATURE_PENDING' }], ['changesToRevSeq null to number', { changesToRevSeq: 5 }],
  ])('changes when %s changes', (_n, patch) => {
    expect(signingPreviewDigest([{ ...row(), ...patch } as SigningPreviewRow])).not.toBe(base);
  });
  it.each([
    ['appUrn', { appUrn: 'y:app' }], ['agentName', { agentName: 'Other' }], ['agentUrn', { agentUrn: null }], ['workerName', { workerName: 'W' }],
    ['workerUrn', { workerUrn: 'hrn:worker:x:a:w' }], ['compiledNodeUrn', { compiledNodeUrn: null }],
  ])('ignores display field %s', (_n, patch) => {
    expect(signingPreviewDigest([{ ...row(), ...patch } as SigningPreviewRow])).toBe(base);
  });
  it('keeps a token across a display-only change and refuses it as stale after a genuine row change', async () => {
    const before = await preview();
    await db.agent.update({ where: { id: agentId }, data: { name: 'Renamed display agent' } });
    await expect(requireFreshSigningPreview(db, { token: before.previewToken, orgId, userId: adminId })).resolves.toBeUndefined();
    await db.appAgent.deleteMany({ where: { appId, agentId } });
    const stale = requireFreshSigningPreview(db, { token: before.previewToken, orgId, userId: adminId });
    await expect(stale).rejects.toBeInstanceOf(GraphQLError);
    await expect(stale).rejects.toMatchObject({ extensions: { code: SIGNING_PREVIEW_STALE_CODE } });
  });
});
