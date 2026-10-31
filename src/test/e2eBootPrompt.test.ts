/**
 * #2725 local review P2 (Dorian) and QA (Chip): the E2E seed's stock Agents lost their literal prompt in #2712, and with
 * serving mandatory a seeded worker refused every bind. This runs the seed's OWN stock-Agent step (seedE2eStockAgents,
 * which scripts/e2e/seed.ts calls) on the seed's org shape and binds each worker for real through startSession.
 *
 * The first fix seeded each Agent's prompt before the next Agent was created on the same shared system memory, and
 * attaching an Agent to a system memory ENDS every boot-prompt approval in it (boot_prompt_approval_entry_agent,
 * prisma/boot-prompt-approval-invariants.sql), so the coordinator came up BOOT_PROMPT_NOT_APPROVED in the real stack.
 * The earlier test hand-built the Agents first and missed it; calling the seed's own function closes that gap.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from '../integrations/db/client.js';
import { cleanDb } from './helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { composeWorkerPrompt } from '../api/graphql/schema/resolvers.worker.js';
import { resolveServedBootPrompt } from '../lib/bootPrompt/serve.js';
import { E2E_BOOT_PROMPT, E2E_STOCK_ROLES, seedE2eStockAgents } from './e2eBootPrompt.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };
let admin: any, app: any, orgUrn: string, organizationId: string, systemMemoryId: string, appMemoryId: string;
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: admin.id, roles: ['READER'], ...extra });
const bind = (w: { id: string }) => M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef: w.id, force: true, llmModel: 'm-1' } }, ctx());
// The seed's deterministic id scheme, salted per test run.
const salt = generateId();
const id = (name: string) => createHash('sha256').update(`${salt}:${name}`).digest('hex').slice(0, 32);
const workers = () => db.worker.findMany({ where: { appId: app.id }, include: { agent: true }, orderBy: { name: 'asc' } });

beforeEach(async () => {
  await cleanDb(db);
  orgUrn = `e2e-${generateId().toLowerCase()}`;
  organizationId = (await db.organization.create({ data: { name: orgUrn, urn: orgUrn } })).id;
  admin = await db.user.create({ data: { githubId: 92725000, githubUsername: orgUrn, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId, userId: admin.id, role: 'OWNER' } });
  app = await db.app.create({ data: { organizationId, urn: `${orgUrn}:team`, name: 'team', surfaces: ['chat', 'web'], createdBy: admin.id } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'admin' } });
  appMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId, urn: `${orgUrn}:app`, name: 'app', class: 'app', appId: app.id } })).id;
  systemMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId, urn: `${orgUrn}:system`, name: 'system', class: 'system' } })).id;
});

const seed = () => seedE2eStockAgents(db, { org: orgUrn, organizationId, appId: app.id, systemMemoryId, appMemoryId, id, approvedAt: new Date('2026-01-01T00:00:00Z') });

describe('#2712 E2E seed: stock Agents serve an approved compiled boot prompt', () => {
  it('every stock worker the seed builds resolves a servable bind prompt (the seed --check, on the shared system memory)', async () => {
    await seed();
    const all = await workers();
    expect(all.map(w => w.role).sort()).toEqual([...E2E_STOCK_ROLES].sort());
    for (const w of all) {
      const served = await resolveServedBootPrompt(db, { surface: 'bind', appId: w.appId, agent: w.agent, workerId: w.id }).catch(e => e?.extensions?.code);
      expect(typeof served === 'string' ? served : served.content).toBe(E2E_BOOT_PROMPT);
    }
  });

  it('both stock workers bind through startSession and are served the seeded text with variables filled', async () => {
    await seed();
    for (const w of await workers()) {
      const session = await bind(w);
      const record = await db.servedPrompt.findFirstOrThrow({ where: { sessionId: session.id } });
      expect(record).toMatchObject({ kind: 'BIND', workerId: w.id, agentId: w.agentId, pointerLevel: 'AGENT' });
      const row = await db.worker.findUniqueOrThrow({ where: { id: w.id } });
      const text = (await composeWorkerPrompt(ctx({ sessionId: session.id }), row as never)).text!;
      expect(text).toContain(`You are ${w.name}, the synthetic ${w.role} fixture.`);
    }
  });

  it('control: attaching another Agent to the system memory ends a prompt approved before it (why the seed attaches first)', async () => {
    await seed();
    const [first] = await workers();
    await db.agent.create({ data: { id: generateId(), organizationId, urn: `${orgUrn}:late`, name: 'late', systemMemoryId } });
    expect(await code(resolveServedBootPrompt(db, { surface: 'bind', appId: app.id, agent: first!.agent, workerId: first!.id }))).toBe('BOOT_PROMPT_NOT_APPROVED');
  });
});
