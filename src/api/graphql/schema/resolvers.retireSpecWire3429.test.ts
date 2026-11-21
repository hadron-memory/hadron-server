/**
 * #3429 (4669 blind P3): the retire door as the WIRE sees it. A direct resolver call proves only the thrown object; this
 * runs the mutation through the real HTTP schema (serialized `extensions`, masking included) and reads the raw MCP tool
 * result, error flag and all.
 */
import { randomBytes } from 'node:crypto';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { USER_API_KEY_PREFIX, hashUserApiKey } from '../../../middleware/auth.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { closeServerIfStarted, createServerOnCleanDb } from '../../../test/startServerFixture.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/mirrorNodeMove.js', () => ({ mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined) }));

let http: Server;
let base: string;
let rawKey: string;
let userId: string;
let memoryId: string;
const ctx = (): Context => ({ db, userId, roles: [] });

beforeAll(async () => {
  http = httpServer(await createServerOnCleanDb());
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => { await closeServerIfStarted(http); await cleanDb(db); });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Wire Org', urn: 'wire-org.example' } });
  userId = (await db.user.create({ data: { githubId: 342911, githubUsername: 'wire-admin', roles: [] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const k = `${USER_API_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  await db.userApiKey.create({ data: { userId, oauthScopes: [], keyHash: hashUserApiKey(k), keyPreview: k.slice(-4) } });
  rawKey = k;
  memoryId = (await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'wire-specs', draftCorpus: true }, ctx())).id;
});

const spec = async (loc: string) => (await resolvers.Mutation.createSpecNode(null, { input: {
  memoryId, loc, name: `Spec ${loc}`, role: 'spec', content: `# T ${loc}\n\nBody.`, abstract: `About ${loc}.`, tags: ['spec'],
} } as never, ctx())) as { id: string };
const revision = async (id: string) => (await db.node.findUniqueOrThrow({ where: { id } })).revSeq;
const gql = async (query: string, variables: unknown) => (await fetch(`${base}/graphql`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${rawKey}` }, body: JSON.stringify({ query, variables }),
})).json() as Promise<{ data?: Record<string, unknown> | null; errors?: Array<{ message: string; extensions: Record<string, unknown> }> }>;

const MUTATION = `mutation($i: RetireSpecInput!) { retireSpec(input: $i) { node { id tags abstract } successorEdge { name } } }`;

describe('#3429 the retire door over the real GraphQL wire', () => {
  it('a rescind succeeds end to end through the schema', async () => {
    const x = await spec('w:010:01');
    const res = await gql(MUTATION, { i: { ref: x.id, form: 'RESCIND', expectedRevision: await revision(x.id), reason: 'gone', summary: 'old' } });
    expect(res.errors, JSON.stringify(res.errors)).toBeUndefined();
    expect((res.data!.retireSpec as { node: { tags: string[] }; successorEdge: unknown }).node.tags).toContain('superseded');
    expect((res.data!.retireSpec as { successorEdge: unknown }).successorEdge).toBeNull();
  });

  it('an over-cap abstract is the TYPED error on the wire, not a masked internal error', async () => {
    const x = await spec('w:010:02');
    const res = await gql(MUTATION, { i: { ref: x.id, form: 'RESCIND', expectedRevision: await revision(x.id), reason: 'r', summary: 's'.repeat(1990) } });
    expect(res.errors).toHaveLength(1);
    expect(res.errors![0]!.extensions).toMatchObject({ code: 'NodeAbstractTooLongError', max: 2000 });
    expect(res.errors![0]!.message).toContain('Abstract exceeds 2000-character cap');
    expect(JSON.stringify(res)).not.toContain('INTERNAL_SERVER_ERROR');
  });

  it('a stale expectedRevision and an unreadable ref keep their codes on the wire', async () => {
    const x = await spec('w:010:03');
    const stale = await gql(MUTATION, { i: { ref: x.id, form: 'RESCIND', expectedRevision: (await revision(x.id)) + 9, reason: 'r', summary: 's' } });
    expect(stale.errors![0]!.extensions.code).toBe('NODE_WRITE_CONFLICT');
    const missing = await gql(MUTATION, { i: { ref: generateId(), form: 'RESCIND', expectedRevision: 1, reason: 'r', summary: 's' } });
    expect(missing.errors![0]!.extensions.code).toBe('NODE_NOT_FOUND');
  });
});

describe('#3429 the MCP tool result, as the client receives it', () => {
  const mcp = () => createTestableMcpServer({ userId, roles: [], clientId: `user:${userId}` });

  it('an over-cap abstract is an error result carrying the typed prose, never an internal-error one', async () => {
    const x = await spec('w:020:01');
    const result = await mcp().callTool('hadron_retire_spec', { ref: x.id, form: 'rescind', expectedRevision: await revision(x.id), reason: 'r', summary: 's'.repeat(1990) }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Abstract exceeds 2000-character cap');
    expect(result.content[0]!.text.toLowerCase()).not.toContain('internal');
  });

  it('a state conflict is an error result with the typed code; a success is not an error result', async () => {
    const x = await spec('w:020:02');
    const ok = await mcp().callTool('hadron_retire_spec', { ref: x.id, form: 'rescind', expectedRevision: await revision(x.id), reason: 'r', summary: 's' }) as { isError?: boolean };
    expect(ok.isError).not.toBe(true);
    const again = await mcp().callTool('hadron_retire_spec', { ref: x.id, form: 'rescind', expectedRevision: await revision(x.id), reason: 'r', summary: 's' }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toContain('[node_write_conflict]');
  });
});
