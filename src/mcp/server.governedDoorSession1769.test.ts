import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1769: the four governed-kind doors take the #1701 `session` argument.
 *
 * The caller-session gate advertises `session` on every writing tool, and the
 * governed doors spread their arguments straight into a resolver input, so the
 * settled argument reached `tx.node.upsert` and crashed it. These tests drive
 * each door WITH a live session and check the write lands, attributed.
 *
 * The doors also admit only the fields they advertise: `callTool` skips zod,
 * so a key that is not in the tool's shape (even one that names a real Node
 * column) must be dropped, not written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMcpServerInstance, createTestableMcpServer } from './server.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let mcp: ReturnType<typeof createTestableMcpServer>;
let userId: string;
let memoryUrn: string;
let memoryId: string;
let worker: { id: string };
let agent: { id: string };
let sessionId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Door 1769', urn: 'door1769.example' } });
  const user = await db.user.create({ data: { githubId: 176901, githubUsername: 'door-1769', handle: 'door-1769', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), urn: 'door1769.example:engineer', name: 'engineer', organizationId: org.id } });
  const app = await db.app.create({ data: { id: generateId(), name: 'Team', urn: 'door1769.example:team', organizationId: org.id } });
  const memory = await db.memory.create({ data: {
    id: generateId(), urn: 'door1769.example:team-shared', name: 'team-shared', class: 'app', appId: app.id, organizationId: org.id,
  } });
  memoryId = memory.id;
  memoryUrn = memory.urn;
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  sessionId = generateId();
  await db.session.create({
    data: { id: sessionId, appId: app.id, userId: user.id, workerId: worker.id, agentId: agent.id, type: 'DEVELOPER', startedAt: new Date() },
  });
  userId = user.id;
  mcp = createTestableMcpServer({ userId: user.id, roles: ['ADMIN'] });
});

const urn = (loc: string) => `hrn:node:${memoryUrn}:${loc}`;
const row = (loc: string) => db.node.findFirstOrThrow({ where: { memoryId, loc } });

describe('#1769 governed doors with a live session', () => {
  it.each([
    ['hadron_create_review', 'review'],
    ['hadron_create_task', 'task'],
  ])('%s accepts session and attributes the write', async (tool, kind) => {
    const loc = `door:${kind}`;
    const text = await mcp.callToolText(tool, { urn: urn(loc), name: loc, session: sessionId });
    expect(text).toMatch(/created/);
    expect(text).not.toMatch(/Unknown argument|Invalid `/);
    expect(await row(loc)).toMatchObject({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
  });

  it.each([
    ['hadron_update_review', 'hadron_create_review', 'review'],
    ['hadron_update_task', 'hadron_create_task', 'task'],
  ])('%s accepts session and attributes the edit', async (update, create, kind) => {
    const loc = `door:edit:${kind}`;
    await mcp.callToolText(create, { urn: urn(loc), name: loc, session: sessionId });
    const text = await mcp.callToolText(update, { urn: urn(loc), content: 'edited', session: sessionId });
    expect(text).toMatch(/updated/);
    expect(text).not.toMatch(/Unknown argument|Invalid `/);
    expect(await row(loc)).toMatchObject({ content: 'edited', updatedByWorkerId: worker.id, updatedByAgentId: agent.id });
  });
});

describe('#1769 governed doors admit only the fields they advertise', () => {
  it('drops keys that are not in the tool shape, including real Node columns', async () => {
    const loc = 'door:allowlist';
    const text = await mcp.callToolText('hadron_create_review', {
      urn: urn(loc), name: loc, session: sessionId,
      revSeq: 99, approvalHash: 'forged', createdBy: 'forged', mintedHash: 'forged', notAColumn: 'x',
    });
    expect(text).toMatch(/created/);
    const node = await row(loc);
    expect(node.revSeq).not.toBe(99);
    expect(node.approvalHash).toBeNull();
    expect(node.mintedHash).toBeNull();
    expect(node.createdBy).not.toBe('forged');
  });

  it('keeps the fields it does advertise', async () => {
    const loc = 'door:kept';
    await mcp.callToolText('hadron_create_review', {
      urn: urn(loc), name: 'Kept', description: 'd', content: 'c', role: 'review.security', session: sessionId,
    });
    expect(await row(loc)).toMatchObject({ name: 'Kept', description: 'd', content: 'c', role: 'review.security' });
  });
});

describe('#1769 forged columns through the UPDATE doors (writeNodeCore update path)', () => {
  it.each([
    ['hadron_update_review', 'hadron_create_review', 'review'],
    ['hadron_update_task', 'hadron_create_task', 'task'],
  ])('%s drops keys that are not in the tool shape', async (update, create, kind) => {
    const loc = `door:forged:${kind}`;
    await mcp.callToolText(create, { urn: urn(loc), name: loc, session: sessionId });
    const before = await row(loc);
    const text = await mcp.callToolText(update, {
      urn: urn(loc), content: 'edited', session: sessionId,
      revSeq: 99, approvalHash: 'forged', mintedHash: 'forged', createdBy: 'forged', createdByWorkerId: 'forged', notAColumn: 'x',
    });
    expect(text).toMatch(/updated/);
    const after = await row(loc);
    expect(after.content).toBe('edited');
    expect(after.revSeq).not.toBe(99);
    expect(after.approvalHash).toBeNull();
    expect(after.mintedHash).toBeNull();
    expect(after.createdBy).toBe(before.createdBy);
    expect(after.createdByWorkerId).toBe(before.createdByWorkerId);
  });
});

describe('#1769 the caller-session gate itself (probe tool, not a governed door)', () => {
  const probe = async (shape: Record<string, z.ZodTypeAny>, args: Record<string, unknown>) => {
    const instance = createMcpServerInstance({ userId, roles: ['ADMIN'] }, () => undefined, null, {});
    let seen: Record<string, unknown> | undefined;
    (instance as unknown as { tool: (...a: unknown[]) => unknown }).tool('hadron_probe_1769', shape, async (input: Record<string, unknown>) => {
      seen = input;
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    });
    const tools = (instance as unknown as {
      _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }>;
    })._registeredTools;
    await tools['hadron_probe_1769'].handler(args, {});
    return seen;
  };

  it('strips the argument it injected once the actor is settled, and keeps everything else', async () => {
    const seen = await probe({ x: z.string().optional() }, { x: 'kept', session: sessionId });
    expect(seen).toEqual({ x: 'kept' });
  });

  it('leaves alone a tool that declares `session` itself', async () => {
    const seen = await probe({ x: z.string().optional(), session: z.string().optional() }, { x: 'kept', session: sessionId });
    expect(seen).toEqual({ x: 'kept', session: sessionId });
  });
});
