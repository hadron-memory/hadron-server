/**
 * #1868 — the MCP modules that delegate to GraphQL carry the presented
 * hdr_user_ key (`auth.apiKeyId`) into their per-call Context, so the shared
 * authorized transaction re-checks it is still unrevoked at the write
 * (authorizedTx.ts). Each pin opens a connection with a real user key, revokes
 * the key, then writes: the write is refused and nothing lands.
 *
 * In production `handleMcpRequest` re-authenticates the bearer per request, so
 * only a revoke landing inside one in-flight request reaches this layer (the
 * residual #1868 hardens). The test drives that layer directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { mintUserApiKey, type AuthContext } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const as = (userId: string): Context => ({ db, userId, roles: [] });
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const code = (t: string) => /^\[([a-z_]+)\]/.exec(t)?.[1].toUpperCase() ?? 'NO_ERROR';

let admin: { id: string };
let member: { id: string };
let memory: { id: string; urn: string };
let app: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Key Org 1868', urn: `key1868-${generateId().toLowerCase()}.example` } });
  admin = await db.user.create({ data: { githubId: 186801, githubUsername: 'k-admin', handle: 'k-admin', roles: [] } });
  member = await db.user.create({ data: { githubId: 186802, githubUsername: 'k-member', handle: 'k-member', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: member.id, role: 'CONTRIBUTOR' },
  ] });
  memory = await M.createMemory(null, { orgId: org.id, name: 'discussion' }, as(admin.id));
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.id.toLowerCase()}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
});

/** A connection authenticated by `userId`'s user API key, and a way to revoke that key. */
async function keyedConnection(userId: string) {
  const { userApiKey } = await mintUserApiKey(db, { userId, createdBy: userId, label: 'presented key', issuedVia: 'portal' });
  const auth = { userId, apiKeyId: userApiKey.id, roles: ['READER'], clientId: `user:${userId}` } as AuthContext;
  const mcp = createTestableMcpServer(auth, { sessionId: `k-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
  return { mcp, revoke: () => M.revokeUserApiKey(null, { id: userApiKey.id }, as(userId)) };
}

describe('#1868: a revoked hdr_user_ key cannot write through the delegating MCP tools', () => {
  it('commentTools: hadron_create_comment is refused and writes no comment', async () => {
    const target = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 't:1', name: 'Target', content: 'Body' } });
    const { mcp, revoke } = await keyedConnection(member.id);
    await revoke();
    const t = text(await mcp.callTool('hadron_create_comment', { targetRef: target.id, body: 'after revocation' }));
    expect(code(t)).toBe('FORBIDDEN');
    expect(await db.node.count({ where: { nodeType: 'comment' } })).toBe(0);
  });

  it('agentTaskTools: hadron_task_create is refused and creates no task', async () => {
    const plain = await db.session.create({ data: { id: generateId(), userId: member.id }, select: { id: true } });
    const { mcp, revoke } = await keyedConnection(member.id);
    await revoke();
    const t = text(await mcp.callTool('hadron_task_create', { appRef: app.id, title: 'after revocation', session: plain.id }));
    expect(code(t)).toBe('FORBIDDEN');
    expect(await db.agentTask.count()).toBe(0);
  });

  it('tickerTools: hadron_ack_wakes is refused at the key check, before any proof is judged', async () => {
    const plain = await db.session.create({ data: { id: generateId(), userId: member.id }, select: { id: true } });
    const { mcp, revoke } = await keyedConnection(member.id);
    await revoke();
    const t = text(await mcp.callTool('hadron_ack_wakes', { proofs: ['x'], session: plain.id }));
    expect(code(t)).toBe('FORBIDDEN');
  });

  it('a live key still writes through the same tools (the control)', async () => {
    const target = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 't:2', name: 'Target', content: 'Body' } });
    const plain = await db.session.create({ data: { id: generateId(), userId: member.id }, select: { id: true } });
    const { mcp } = await keyedConnection(member.id);
    expect(code(text(await mcp.callTool('hadron_create_comment', { targetRef: target.id, body: 'live key' })))).toBe('NO_ERROR');
    expect(code(text(await mcp.callTool('hadron_task_create', { appRef: app.id, title: 'live key', session: plain.id })))).toBe('NO_ERROR');
    expect(code(text(await mcp.callTool('hadron_ack_wakes', { proofs: ['x'], session: plain.id })))).toBe('WAKE_PROOF_INVALID');
  });
});
