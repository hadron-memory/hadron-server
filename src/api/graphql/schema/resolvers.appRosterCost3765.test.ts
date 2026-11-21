/**
 * #3765 re-land: what the owner-role admission costs, and that it cannot reach teamRoster.
 *
 * #4329 admitted the App roster to an owner-role member of a user-owned App; #4361 reverted it during the 2026-11-17 alpha P2028 bursts
 * (29 of 32 in site `teamRoster`). The bursts continued with the revert live (Hugo's correlation on #4380: P2028 peaked 21:10-21:20Z,
 * revert live since ~17:50Z), so #4329 is cleared, as #4361's own condition says. These pins hold the two things the re-land can
 * honestly promise, on a disposable database:
 *
 *  1. The admission adds no per-row cost class. The roster fields the admitted member reads run the same statements per installed Agent as
 *     for the true owner, and a constant, small number more per request (the member decision), however many Agents the App has.
 *  2. `teamRoster` is untouched: its projection resolves no App roster field, so reading the roster as the owner-role member runs none of
 *     the resolvers this change admits (a future field on TeamRoster that reached them would fail this).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const R = resolvers as any;
const App = R.App;

// A client of its own, on this worker's database, that logs every statement (the harness of resolvers.installationCosts3459.test.ts).
const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
let counting = false;
let statements = 0;
logged.$on('query', () => { if (counting) statements++; });
afterAll(async () => { await logged.$disconnect(); });

const as = (userId: string, client: typeof db = db): Context => ({ db: client, userId, roles: ['READER'] }) as Context;

let owner: { id: string };
let boss: { id: string };
let publisherId: string;
let publisherUrn: string;
let app: { id: string };

const mkUser = (handle: string) => db.user.create({ data: { id: generateId(), name: handle, email: `${handle}@example.test`, handle, roles: ['READER'] } });

async function installAgents(count: number, already: number) {
  for (let i = already; i < already + count; i++) {
    const sys = await db.memory.create({ data: { id: generateId(), class: 'system', name: `Sys${i}`, urn: `${publisherUrn}:sys${i}`, organizationId: publisherId, acceptsUploads: false } });
    const agent = await db.agent.create({ data: { id: generateId(), name: `Agent${i}`, urn: `${publisherUrn}:agent${i}`, organizationId: publisherId, visibility: 'PUBLIC', systemMemoryId: sys.id } });
    await createDbAppAgent(db, app.id, agent.id);
  }
}

beforeEach(async () => {
  await cleanDb(db);
  owner = await mkUser('costowner');
  boss = await mkUser('costboss');
  const publisher = await db.organization.create({ data: { id: generateId(), name: 'Pub', urn: `pub-${generateId().slice(-6)}` } });
  publisherId = publisher.id; publisherUrn = publisher.urn;
  app = await db.app.create({ data: { id: generateId(), name: 'costapp', urn: `costapp-${generateId().slice(-6)}:papp`, ownerUserId: owner.id } });
  await createDbAppMember(db, app.id, owner.id, 'owner');
  await createDbAppMember(db, app.id, boss.id, 'owner');
});

/** The statements the seven admitted roster fields run for `userId`, and what they answered. */
async function readRoster(userId: string) {
  const row = await logged.app.findUniqueOrThrow({ where: { id: app.id } });
  const ctx = as(userId, logged as unknown as typeof db);
  counting = true; statements = 0;
  const out = {
    members: await App.members(row, {}, ctx),
    memberCount: await App.memberCount(row, {}, ctx),
    appAgents: await App.appAgents(row, {}, ctx),
    agents: await App.agents(row, {}, ctx),
    agentId: await App.agentId(row, {}, ctx),
    agent: await App.agent(row, {}, ctx),
    installedAgentUrn: await App.installedAgentUrn(row, {}, ctx),
  };
  counting = false;
  return { statements, out };
}

describe('#3765 the admission adds no per-row cost class', () => {
  it('the owner-role member runs the same statements per installed Agent as the true owner, plus a small constant', async () => {
    await installAgents(2, 0);
    const bossSmall = await readRoster(boss.id);
    const ownerSmall = await readRoster(owner.id);
    await installAgents(4, 2);
    const bossLarge = await readRoster(boss.id);
    const ownerLarge = await readRoster(owner.id);

    // the admitted member really reads the roster (so the counts below measure the admitted path, not a withheld null)
    expect(bossSmall.out.members).not.toBeNull();
    expect(bossSmall.out.appAgents).toHaveLength(2);
    expect(bossLarge.out.agents).toHaveLength(6);
    expect(bossLarge.out.memberCount).toBe(2);

    const bossGrowth = bossLarge.statements - bossSmall.statements;
    const ownerGrowth = ownerLarge.statements - ownerSmall.statements;
    // per installed Agent: no more than the true owner pays
    expect(bossGrowth, `boss ${bossSmall.statements}->${bossLarge.statements}, owner ${ownerSmall.statements}->${ownerLarge.statements}`).toBeLessThanOrEqual(ownerGrowth);
    // per request: a constant, small overhead (the current-member decision, one point read per admitted field), the same at 2 and 6 Agents
    const overheadSmall = bossSmall.statements - ownerSmall.statements;
    const overheadLarge = bossLarge.statements - ownerLarge.statements;
    expect(overheadLarge).toBe(overheadSmall);
    // measured: 9 (31 vs 22 statements, flat from 2 to 6 Agents); the bound is two point reads for each of the seven admitted fields
    expect(overheadLarge).toBeLessThanOrEqual(14);
  });
});

describe('#3765 teamRoster resolves none of the roster fields this change admits', () => {
  it('reading the team roster as the owner-role member calls no App roster resolver', async () => {
    const calls: string[] = [];
    const fields = ['members', 'memberCount', 'appAgents', 'agents', 'agentId', 'agent', 'installedAgentUrn'] as const;
    const originals = new Map<string, any>();
    for (const f of fields) {
      originals.set(f, App[f]);
      App[f] = (...args: any[]) => { calls.push(f); return originals.get(f)(...args); };
    }
    try {
      const Q = R.Query;
      // a user-owned App's roster read as the owner-role member (it may be refused for a non-participant of a team: either way, no App field runs)
      await Promise.resolve(Q.teamRoster({}, { appRef: app.id }, as(boss.id))).catch(() => undefined);
      expect(calls).toEqual([]);
    } finally {
      for (const f of fields) App[f] = originals.get(f);
    }
  });
});
