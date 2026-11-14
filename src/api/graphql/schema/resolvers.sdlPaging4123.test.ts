import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildSchema, isObjectType, parse, validate } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { withInheritedNodeProjection } from './resolvers.inheritedNode.js';
import { withInstallConcealment, INSTALL_CONCEALED } from './installMemory.js';
import { listPolls } from '../../../lib/webfetchClient.js';
vi.mock('../../../lib/webfetchClient.js', () => ({ listPolls: vi.fn(), cancelPoll: vi.fn(), fetchUrl: vi.fn(), httpRequest: vi.fn(), createPoll: vi.fn(), getPoll: vi.fn() }));
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: any, c: Context) => Promise<any>>;
const N = (resolvers as unknown as {
    Node: typeof Q;
}).Node;
let orgId: string, userId: string, appId: string, runId: string, nodeId: string;
afterEach(() => vi.useRealTimers());
const ctx = (): Context => ({ db, userId, roles: [] });
beforeEach(async () => {
    await cleanDb(db);
    vi.clearAllMocks();
    vi.mocked(listPolls).mockResolvedValue({ jobs: [] });
    const org = await db.organization.create({ data: { name: 'Paging', urn: 'paging4123.example' } });
    orgId = org.id;
    userId = (await db.user.create({ data: { email: 'paging4123@example.test' } })).id;
    await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'ADMIN' } });
    const app = await db.app.create({ data: { organizationId: orgId, name: 'Paging', urn: 'paging4123.example:app' } });
    appId = app.id;
    const agent = await db.agent.create({ data: { organizationId: orgId, name: 'Paging', urn: 'paging4123.example:agent', visibility: 'ORGANIZATION' } });
    runId = (await db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId, agentId: agent.id, triggerKind: 'MANUAL', entryNodeUrn: 'flow:start', status: 'RUNNING' } })).id;
    const mem = await resolvers.Mutation.createMemory(null, { orgId, name: 'Paging' }, ctx());
    nodeId = (await db.node.create({ data: { memoryId: mem.id, loc: 'sign', name: 'Sign' } })).id;
});
it('SDL preserves the portal page type and exposes distinct marketplace/page/cursor contracts', () => {
    const schema = buildSchema(typeDefs);
    expect(schema.getType('MarketplaceResourcePage')).toBeDefined();
    expect(schema.getType('PublicResourceRefPage')).toBeUndefined();
    const nodeType = schema.getType('Node');
    if (!isObjectType(nodeType)) throw new Error('Missing Node type');
    expect(nodeType.getFields().signingRequests.args.map(a => a.name)).toEqual(['state', 'first']);
    expect(schema.getQueryType()!.getFields().webPolls.args.map(a => a.name)).toEqual(['orgRef', 'first']);
    expect(validate(schema, parse('query { publicOrganization(ref:"x") { publicMemoriesPage { items { id } total hasMore } } }')).map(x => x.message)).toEqual([]);
    const errors = validate(schema, parse('query { webPollsPage(orgRef:"x",first:20,after:null,offset:null) { items { jobId } total hasMore nextCursor } node(ref:"x") { signingRequestsPage(state:OPEN,first:20,after:null,offset:null) { items { id } total hasMore nextCursor } } }'));
    expect(errors.map(x => x.message)).toEqual([]);
});
it('poll pages default to 20, continue without duplicates, clamp at cap, and retain legacy array shape', async () => {
    const ids = Array.from({ length: 105 }, (_, i) => `job-${String(i).padStart(3, '0')}`);
    await db.webFetchPollBinding.createMany({ data: ids.map(jobId => ({ jobId, sourceRunId: runId, organizationId: orgId, appId, entryNodeUrn: 'flow:start', url: 'https://example.test/watch' })) });
    vi.mocked(listPolls).mockResolvedValue({ jobs: [...ids].reverse().map(jobId => ({ jobId, status: 'active', expiresAt: '2030-01-01T00:00:00Z', triggerCount: 0, consecutiveFailures: 0 })) });
    const a = await Q.webPollsPage(null, { orgRef: orgId }, ctx());
    expect(a.items.map((x: any) => x.jobId)).toEqual(ids.slice(0, 20));
    expect(a.hasMore).toBe(true);
    expect(a.nextCursor).toEqual(expect.any(String));
    const b = await Q.webPollsPage(null, { orgRef: orgId, after: a.nextCursor }, ctx());
    expect(b.items.map((x: any) => x.jobId)).toEqual(ids.slice(20, 40));
    for (const first of [100, 10000]) {
        const capped = await Q.webPollsPage(null, { orgRef: orgId, first }, ctx());
        expect(capped.items).toHaveLength(100); expect(capped.hasMore).toBe(true);
        const tail = await Q.webPollsPage(null, { orgRef: orgId, after: capped.nextCursor }, ctx());
        expect(tail.items.map((x: any) => x.jobId)).toEqual(ids.slice(100));
        expect(tail.hasMore).toBe(false); expect(tail.nextCursor).toBeNull();
    }
    expect(await Q.webPolls(null, { orgRef: orgId }, ctx())).toHaveLength(20);
    await expect(Q.webPollsPage(null, { orgRef: orgId, after: 'garbage' }, ctx())).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
});
it('poll authorization and policy run before the sidecar read on the new field', async () => {
    const other = await db.user.create({ data: { email: 'other4123@example.test' } });
    await expect(Q.webPollsPage(null, { orgRef: orgId }, { ...ctx(), userId: other.id })).rejects.toThrow('Forbidden');
    expect(listPolls).not.toHaveBeenCalled();
    await db.organization.update({ where: { id: orgId }, data: { policy: { allow: [] } } });
    await expect(Q.webPollsPage(null, { orgRef: orgId }, ctx())).rejects.toMatchObject({ extensions: { code: 'POLICY_DENIED' } });
    expect(listPolls).not.toHaveBeenCalled();
});
it('signing pages filter effective expiry before paging and continue through the rest', async () => {
    const now = Date.now();
    const ids = Array.from({ length: 25 }, () => generateId());
    await db.signingRequest.createMany({ data: ids.map((id, i) => ({ id, nodeId, revision: 1, requesterUserId: userId, approvalHash: 'a'.repeat(64), payloadVersion: 'hadron-signature-v3', state: 'open', createdAt: new Date(now - 60000 - i * 1000), expiresAt: new Date(i % 2 === 0 ? now + 60000 : now + 3600000) })) });
    const ordered = await db.signingRequest.findMany({ where: { nodeId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const expired = new Set(ids.filter((_, i) => i % 2 === 0));
    const expected = ordered.filter(x => expired.has(x.id)).map(x => x.id);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + 120000);
    const a = await N.signingRequestsPage({ id: nodeId }, { state: 'EXPIRED', first: 5 }, ctx());
    expect(a.items.map((x: any) => x.id)).toEqual(expected.slice(0, 5));
    expect(a.hasMore).toBe(true);
    const b = await N.signingRequestsPage({ id: nodeId }, { state: 'EXPIRED', first: 100, after: a.nextCursor }, ctx());
    expect(b.items.map((x: any) => x.id)).toEqual(expected.slice(5));
    expect(b.hasMore).toBe(false);
    expect(b.nextCursor).toBeNull();
    expect((await N.signingRequests({ id: nodeId }, { state: 'EXPIRED', first: 5 }, ctx()))).toHaveLength(5);
});
it('new signing pages suppress inherited and concealed payloads before the loader runs', async () => {
    const load = vi.fn(async (_parent: unknown, _args: unknown, _ctx: Context) => ({ items: [{ id: 'private-request' }], hasMore: false, nextCursor: null }));
    const fields = withInstallConcealment(withInheritedNodeProjection({ signingRequestsPage: load }));
    for (const parent of [{ id: nodeId, inheritedFrom: { via: 'child' } }, { id: nodeId, [INSTALL_CONCEALED]: true }]) {
        expect(await fields.signingRequestsPage(parent, {}, ctx())).toEqual({ items: [], total: 0, hasMore: false, nextCursor: null });
        await expect(Promise.resolve().then(() => fields.signingRequestsPage(parent, { after: 'opaque', offset: 0 }, ctx()))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }
    expect(load).not.toHaveBeenCalled();
    expect((await fields.signingRequestsPage({ id: nodeId }, {}, ctx())).items).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);
});

async function pollRows(ids: string[]) {
    await db.webFetchPollBinding.createMany({ data: ids.map(jobId => ({ jobId, sourceRunId: runId, organizationId: orgId, appId, entryNodeUrn: 'flow:start', url: 'https://example.test/watch' })) });
}
function jobs(ids: string[]) {
    vi.mocked(listPolls).mockResolvedValue({ jobs: ids.map(jobId => ({ jobId, status: 'active', expiresAt: '2030-01-01T00:00:00Z', triggerCount: 0, consecutiveFailures: 0 })) });
}
it('keyset survives a deleted poll anchor and insertions on either side of its boundary, with exact totals', async () => {
    await pollRows(['a', 'b', 'c', 'd', '0', '00', 'bc']); jobs(['a', 'b', 'c', 'd']);
    const first = await Q.webPollsPage(null, { orgRef: orgId, first: 2 }, ctx());
    expect(first.items.map((x: any) => x.jobId)).toEqual(['a', 'b']);
    await db.webFetchPollBinding.delete({ where: { jobId: 'b' } });
    jobs(['0', '00', 'a', 'bc', 'c', 'd']);
    const next = await Q.webPollsPage(null, { orgRef: orgId, first: 2, after: first.nextCursor }, ctx());
    expect(next.items.map((x: any) => x.jobId)).toEqual(['bc', 'c']);
    const last = await Q.webPollsPage(null, { orgRef: orgId, first: 2, after: next.nextCursor }, ctx());
    expect(last.items.map((x: any) => x.jobId)).toEqual(['d']);
    expect(first.total).toBe(4); expect(next.total).toBe(6); expect(last.total).toBe(6);
    expect(last.hasMore).toBe(false); expect(last.nextCursor).toBeNull();
    const offset = await Q.webPollsPage(null, { orgRef: orgId, first: 2, offset: 2 }, ctx());
    expect(offset.items.map((x: any) => x.jobId)).toEqual(['a', 'bc']);
});
it('cursor plus explicit offset refuses before any list or authorization lookup', async () => {
    const noReads = { ...ctx(), db: new Proxy(db, { get() { throw new Error('unexpected DB lookup'); } }) };
    await expect(Q.webPollsPage(null, { orgRef: orgId, after: 'opaque', offset: 0 }, noReads)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(N.signingRequestsPage({ id: nodeId }, { after: 'opaque', offset: 0 }, noReads)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(listPolls).not.toHaveBeenCalled();
});
it('forged, edited and filter-mismatched cursors have the same refusal and never fetch sidecar rows', async () => {
    await pollRows(['a', 'b', 'c']); jobs(['a', 'b', 'c']);
    const page = await Q.webPollsPage(null, { orgRef: orgId, first: 1 }, ctx());
    const edited = page.nextCursor.slice(0, 10) + (page.nextCursor[10] === 'A' ? 'B' : 'A') + page.nextCursor.slice(11);
    const forged = Buffer.from(JSON.stringify({ scope: `webPolls:${orgId}`, offset: 1 })).toString('base64url');
    vi.mocked(listPolls).mockClear();
    for (const after of [forged, edited, 'invalid']) {
        await expect(Q.webPollsPage(null, { orgRef: orgId, after }, ctx())).rejects.toMatchObject({ message: 'Invalid page cursor or size.', extensions: { code: 'BAD_USER_INPUT' } });
    }
    await expect(N.signingRequestsPage({ id: nodeId }, { after: page.nextCursor }, ctx())).rejects.toMatchObject({ message: 'Invalid page cursor or size.', extensions: { code: 'BAD_USER_INPUT' } });
    expect(listPolls).not.toHaveBeenCalled();
});
it('signing keyset does not repeat a row when a newer request is inserted before page two; total remains exact', async () => {
    const input = () => ({ id: generateId(), nodeId, revision: 1, requesterUserId: userId, approvalHash: 'a'.repeat(64), payloadVersion: 'hadron-signature-v3', state: 'open', expiresAt: new Date(Date.now() + 3600000) });
    await db.signingRequest.createMany({ data: Array.from({ length: 5 }, input) });
    const ordered = await db.signingRequest.findMany({ where: { nodeId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const first = await N.signingRequestsPage({ id: nodeId }, { first: 2 }, ctx());
    expect(first.items.map((x: any) => x.id)).toEqual(ordered.slice(0, 2).map(x => x.id));
    const inserted = await db.signingRequest.create({ data: input() });
    expect(inserted.createdAt.getTime()).toBeGreaterThan(ordered[0].createdAt.getTime());
    const next = await N.signingRequestsPage({ id: nodeId }, { first: 100, after: first.nextCursor }, ctx());
    expect(next.items.map((x: any) => x.id)).toEqual(ordered.slice(2).map(x => x.id));
    expect(first.total).toBe(5); expect(next.total).toBe(6); expect(next.nextCursor).toBeNull();
    await expect(N.signingRequestsPage({ id: nodeId }, { state: 'EXPIRED', after: first.nextCursor }, ctx())).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
});
it('legacy arrays stay independent of cursor encryption configuration', async () => {
    await pollRows(['a', 'b']); jobs(['a', 'b']);
    await db.signingRequest.createMany({ data: Array.from({ length: 2 }, () => ({ id: generateId(), nodeId, revision: 1, requesterUserId: userId, approvalHash: 'a'.repeat(64), payloadVersion: 'hadron-signature-v3', state: 'open', expiresAt: new Date(Date.now() + 3600000) })) });
    const key = process.env.HADRON_ENCRYPTION_KEY;
    delete process.env.HADRON_ENCRYPTION_KEY;
    try {
        expect(await Q.webPolls(null, { orgRef: orgId, first: 1 }, ctx())).toHaveLength(1);
        expect(await N.signingRequests({ id: nodeId }, { first: 1 }, ctx())).toHaveLength(1);
    } finally {
        if (key === undefined) delete process.env.HADRON_ENCRYPTION_KEY;
        else process.env.HADRON_ENCRYPTION_KEY = key;
    }
});
