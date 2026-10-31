/**
 * #2725 local review P2 (Dorian): the E2E seed's stock Agents lost their literal prompt in #2712, and with serving now
 * mandatory a seeded worker refused every bind BOOT_PROMPT_NOT_SET. This builds the seed's own Agent/AppAgent/Worker
 * shape (scripts/e2e/seed.ts, raw rows, no castWorker) and binds it for real through startSession.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from './helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { composeWorkerPrompt } from '../api/graphql/schema/resolvers.worker.js';
import { E2E_BOOT_PROMPT, seedE2eBootPrompt } from './e2eBootPrompt.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };
let admin: any, app: any, systemMemoryId: string;
const workers: Record<string, any> = {};
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: admin.id, roles: ['READER'], ...extra });
const bind = (w: any) => M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef: w.id, force: true, llmModel: 'm-1' } }, ctx());

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  const org = await db.organization.create({ data: { name: 'E2E', urn: `e2e-${n}` } });
  admin = await db.user.create({ data: { githubId: 92725000, githubUsername: `e2e-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'OWNER' } });
  app = await db.app.create({ data: { organizationId: org.id, urn: `${org.urn}:team`, name: 'team', surfaces: ['chat', 'web'], createdBy: admin.id } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'admin' } });
  const appMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'app', class: 'app', appId: app.id } })).id;
  systemMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:system`, name: 'system', class: 'system' } })).id;
  for (const role of ['coordinator', 'qa-engineer'] as const) {
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${role}`, name: role,
      personaRole: role, systemMemoryId, visibility: 'ORGANIZATION' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.agentMemoryItem.create({ data: { id: generateId(), agentId: agent.id, memoryId: appMemoryId, role: 'read' } });
    const workerMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, appId: app.id,
      urn: `${org.urn}:${role}-working`, name: `${role} working`, class: 'app' } })).id;
    workers[role] = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id,
      name: role === 'coordinator' ? 'Test Coordinator' : 'Test Reviewer', slug: role === 'coordinator' ? 'test-coordinator' : 'test-reviewer',
      role, memoryId: workerMemoryId } });
  }
});

const seedPrompts = async () => {
  for (const role of ['coordinator', 'qa-engineer'] as const) {
    await seedE2eBootPrompt(db, { agentId: workers[role].agentId, memoryId: systemMemoryId, slot: role, approvedAt: new Date('2026-01-01T00:00:00Z'),
      idFor: () => generateId() });
  }
};

describe('#2712 E2E seed: stock Agents serve an approved compiled boot prompt', () => {
  it('control: the seed shape without a compiled prompt refuses the bind BOOT_PROMPT_NOT_SET', async () => {
    expect(await code(bind(workers.coordinator))).toBe('BOOT_PROMPT_NOT_SET');
  });

  it('with the seeded prompt, both stock workers bind and are served the seeded text with variables filled', async () => {
    await seedPrompts();
    for (const [role, w] of Object.entries(workers)) {
      const session = await bind(w);
      const record = await db.servedPrompt.findFirstOrThrow({ where: { sessionId: session.id } });
      expect(record).toMatchObject({ kind: 'BIND', workerId: w.id, agentId: w.agentId, pointerLevel: 'AGENT' });
      const row = await db.worker.findUniqueOrThrow({ where: { id: w.id } });
      const text = (await composeWorkerPrompt(ctx({ sessionId: session.id }), row as never)).text!;
      expect(text).toContain(`You are ${w.name}, the synthetic ${role} fixture.`);
    }
    expect(E2E_BOOT_PROMPT).toContain('{{worker.name}}');
  });
});
