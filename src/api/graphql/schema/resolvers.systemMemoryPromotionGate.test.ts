/**
 * Promoting an existing memory to an Agent's system memory (createAgent's
 * `systemMemoryId`, updateAgent's first attach and its locked re-check) is
 * gated on the TARGET, not only on the caller's role in the org:
 *
 * - the caller must be able to read the target. A missing, deleted or
 *   unreadable target answers one `MEMORY_NOT_FOUND`, byte for byte
 *   (cor:api:140:03, an unreadable memory answers as a missing one);
 * - a memory an Agent holds for one person (`userMemoryOfAgentId`) or for an
 *   App (`sharedMemoryOfAgentId`) is never promoted, even by its owner.
 *
 * One helper beside `assertNotInstallMemory` answers both, at all three sites.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

const userCtx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try {
    await p;
  } catch (e) {
    return e as GraphQLError;
  }
  throw new Error('expected a rejection');
}

/** The bytes a client sees: message plus every extension. */
const wire = (e: GraphQLError) => JSON.stringify({ message: e.message, extensions: e.extensions ?? {} });

let org: { id: string; urn: string };
let admin: { id: string }; // org ADMIN, cannot read the holding
let reader: { id: string }; // org READER who chats with the Agent
let ownerAdmin: { id: string }; // org ADMIN who chats with the Agent (owns their holding)
let agentA: { id: string; systemMemoryId: string };
let holding: { id: string }; // reader's per-user holding of Agent A
let ownHolding: { id: string }; // ownerAdmin's per-user holding of Agent A

async function seedConversations(systemMemoryId: string) {
  const nodes = [
    { loc: 'conversations', name: 'conversations' },
    { loc: 'conversations:research', name: 'research', data: { stageOrder: ['scope'], isSetup: false } },
    { loc: 'conversations:research:scope', name: 'scope', data: { promptRef: 'prompts:research:scope' } },
    { loc: 'prompts', name: 'prompts' },
    { loc: 'prompts:research', name: 'research' },
    { loc: 'prompts:research:scope', name: 'scope', content: 'Scope the research.' },
  ];
  for (const n of nodes) {
    await db.node.create({ data: {
      id: generateId(), memoryId: systemMemoryId, loc: n.loc, name: n.name, nodeType: 'system',
      data: ((n as { data?: object }).data ?? null) as never, content: (n as { content?: string }).content ?? null,
    } });
  }
}

async function holdingOf(userId: string): Promise<{ id: string }> {
  const out = await M.startChat(null, { agentId: agentA.id }, userCtx(userId));
  expect(out.chatId).toMatch(/^chats:/);
  return db.memory.findFirstOrThrow({
    where: { userMemoryOfAgentId: agentA.id, createdBy: userId, deletedAt: null },
    select: { id: true },
  });
}

/** An org Agent with no system memory yet (the updateAgent first-attach shape). */
async function brainlessAgent(name: string): Promise<{ id: string }> {
  const created = await M.createAgent({}, { orgId: org.id, name }, userCtx(admin.id));
  await db.agent.update({ where: { id: created.id }, data: { systemMemoryId: null } });
  return { id: created.id };
}

async function expectUnpromoted(memoryId: string) {
  const m = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  expect(m.class).toBe('knowledge');
  expect(await db.agent.findFirst({ where: { systemMemoryId: memoryId } })).toBeNull();
}

/**
 * A context whose FIRST plain `memory.findUnique` on `memoryId` (updateAgent's
 * pre-lock read) answers the row with its holding links cleared, as if the
 * link landed after that read. The deciding transaction's re-read is real.
 */
function staleHoldingCtx(userId: string, memoryId: string): { ctx: Context; staleReads: () => number } {
  let stale = 0;
  const memoryDelegate = new Proxy(db.memory, {
    get(target, prop, receiver) {
      if (prop === 'findUnique') {
        return async (args: any) => {
          const row = await (target as any).findUnique(args);
          if (stale === 0 && row?.id === memoryId && !args?.select) {
            stale++;
            return { ...row, userMemoryOfAgentId: null, sharedMemoryOfAgentId: null };
          }
          return row;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const staleDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'memory') return memoryDelegate;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ctx: { db: staleDb as typeof db, userId, roles: ['READER'] } as Context, staleReads: () => stale };
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'promote-gate', urn: `promote-gate-${suffix}.com` },
  });
  const mk = (n: number) =>
    db.user.create({ data: { id: generateId(), githubId: 930240 + n, githubUsername: `promote-${n}-${suffix}`, roles: ['READER'] } });
  admin = await mk(1);
  reader = await mk(2);
  ownerAdmin = await mk(3);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: reader.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: ownerAdmin.id, role: 'ADMIN' } });

  agentA = await M.createAgent({}, { orgId: org.id, name: 'Agent A', visibility: 'ORGANIZATION' }, userCtx(admin.id));
  await seedConversations(agentA.systemMemoryId);
  await serveEveryAgent(db);

  holding = await holdingOf(reader.id);
  ownHolding = await holdingOf(ownerAdmin.id);
});

describe('fixture', () => {
  it('the holdings are App-less knowledge memories linked to Agent A, and the admin cannot read the reader\'s', async () => {
    for (const h of [holding, ownHolding]) {
      const m = await db.memory.findUniqueOrThrow({ where: { id: h.id } });
      expect(m).toMatchObject({ class: 'knowledge', appId: null, userMemoryOfAgentId: agentA.id, organizationId: org.id });
    }
    const { getAccessibleMemoryIds } = await import('./resolvers.helpers.js');
    expect(await getAccessibleMemoryIds(userCtx(admin.id), holding.id)).toEqual([]);
    expect(await getAccessibleMemoryIds(userCtx(ownerAdmin.id), ownHolding.id)).toEqual([ownHolding.id]);
  });
});

describe('createAgent(systemMemoryId)', () => {
  it('an org ADMIN who cannot read a member\'s holding cannot promote it', async () => {
    const err = await refusal(M.createAgent({}, { orgId: org.id, name: 'B', systemMemoryId: holding.id }, userCtx(admin.id)));
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.extensions?.code).toBe('MEMORY_NOT_FOUND');
    await expectUnpromoted(holding.id);
  });

  it('the holding\'s own owner cannot promote it either', async () => {
    const err = await refusal(M.createAgent({}, { orgId: org.id, name: 'B', systemMemoryId: ownHolding.id }, userCtx(ownerAdmin.id)));
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.extensions?.code).toBe('BAD_USER_INPUT');
    expect(err.message).toBe("A memory an Agent holds for a person or an App cannot become an Agent's system memory.");
    await expectUnpromoted(ownHolding.id);
  });

  it('unreadable, missing and deleted targets answer byte-identically', async () => {
    const deleted = await db.memory.create({
      data: { id: generateId(), name: 'gone', urn: `gone-${generateId()}`, organizationId: org.id, class: 'knowledge', deletedAt: new Date() },
    });
    const answers = [];
    for (const target of [holding.id, generateId(), deleted.id]) {
      answers.push(wire(await refusal(M.createAgent({}, { orgId: org.id, name: 'B', systemMemoryId: target }, userCtx(admin.id)))));
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0]!)).toEqual({ message: 'Memory not found', extensions: { code: 'MEMORY_NOT_FOUND' } });
  });

  it('CONTROL: a readable plain org memory is still promoted', async () => {
    const plain = await db.memory.create({
      data: { id: generateId(), name: 'plain', urn: `plain-${generateId()}`, organizationId: org.id, class: 'knowledge' },
    });
    const b = await M.createAgent({}, { orgId: org.id, name: 'B', systemMemoryId: plain.id }, userCtx(admin.id));
    expect(b.systemMemoryId).toBe(plain.id);
    expect((await db.memory.findUniqueOrThrow({ where: { id: plain.id } })).class).toBe('system');
  });
});

describe('updateAgent(systemMemoryId) first attach', () => {
  it('pre-lock site: an org ADMIN who cannot read a member\'s holding cannot attach it', async () => {
    const c = await brainlessAgent('C');
    const err = await refusal(M.updateAgent({}, { ref: c.id, systemMemoryId: holding.id }, userCtx(admin.id)));
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.extensions?.code).toBe('MEMORY_NOT_FOUND');
    await expectUnpromoted(holding.id);
  });

  it('pre-lock site: the holding\'s owner cannot attach it', async () => {
    const c = await brainlessAgent('C');
    const err = await refusal(M.updateAgent({}, { ref: c.id, systemMemoryId: ownHolding.id }, userCtx(ownerAdmin.id)));
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.extensions?.code).toBe('BAD_USER_INPUT');
    expect(err.message).toBe("A memory an Agent holds for a person or an App cannot become an Agent's system memory.");
    await expectUnpromoted(ownHolding.id);
  });

  it('locked site: a holding link that lands after the pre-lock read is refused under the locks', async () => {
    const c = await brainlessAgent('C');
    const { ctx, staleReads } = staleHoldingCtx(ownerAdmin.id, ownHolding.id);
    const err = await refusal(M.updateAgent({}, { ref: c.id, systemMemoryId: ownHolding.id }, ctx));
    expect(staleReads()).toBe(1); // the pre-lock read really saw no link
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.extensions?.code).toBe('BAD_USER_INPUT');
    expect(err.message).toBe("A memory an Agent holds for a person or an App cannot become an Agent's system memory.");
    await expectUnpromoted(ownHolding.id);
    expect((await db.agent.findUniqueOrThrow({ where: { id: c.id } })).systemMemoryId).toBeNull();
  });

  it('unreadable, missing and deleted targets answer byte-identically', async () => {
    const c = await brainlessAgent('C');
    const deleted = await db.memory.create({
      data: { id: generateId(), name: 'gone', urn: `gone-${generateId()}`, organizationId: org.id, class: 'knowledge', deletedAt: new Date() },
    });
    const answers = [];
    for (const target of [holding.id, generateId(), deleted.id]) {
      answers.push(wire(await refusal(M.updateAgent({}, { ref: c.id, systemMemoryId: target }, userCtx(admin.id)))));
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0]!)).toEqual({ message: 'Memory not found', extensions: { code: 'MEMORY_NOT_FOUND' } });
  });

  it('CONTROL: a readable plain org memory is still attached', async () => {
    const c = await brainlessAgent('C');
    const plain = await db.memory.create({
      data: { id: generateId(), name: 'plain', urn: `plain-${generateId()}`, organizationId: org.id, class: 'knowledge' },
    });
    const updated = await M.updateAgent({}, { ref: c.id, systemMemoryId: plain.id }, userCtx(admin.id));
    expect(updated.systemMemoryId).toBe(plain.id);
  });
});

describe('createAgent(systemMemoryId) is serialized with a revocation of the caller\'s access', () => {
  it('an org-member removal started while the promotion is deciding waits on its anchors and cannot commit mid-decision', async () => {
    // An org knowledge memory the promoting admin reads and writes through
    // their org membership; the revocation is removing them from the org.
    const target = await db.memory.create({
      data: { id: generateId(), name: 'race-knowledge', urn: `race-k-${generateId()}`, organizationId: org.id, class: 'knowledge' },
    });
    const memberRow = () => db.orgMember.findFirst({ where: { organizationId: org.id, userId: admin.id, deletedAt: null } });
    expect(await memberRow()).not.toBeNull();
    let removal: Promise<unknown> | null = null;
    let removalSettled = false;
    let blockedOnAnchor = false;
    let rowDuringPause: unknown = 'unread';
    // Pause the promotion's write (after its readability decision, inside its
    // transaction) and start the real revocation door from another connection.
    const paused = new Proxy(db, {
      get(base, key) {
        if (key === '$transaction') {
          return (fn: any, ...rest: any[]) => db.$transaction(async (tx: any) => {
            const memory = new Proxy(tx.memory, {
              get(d: any, k) {
                if (k === 'update') {
                  return async (a: any) => {
                    if (a.where?.id === target.id && a.data?.class === 'system' && !removal) {
                      removal = M.removeOrgMember({}, { orgId: org.id, userId: admin.id }, userCtx(ownerAdmin.id))
                        .finally(() => { removalSettled = true; });
                      try {
                        await waitForLockWaitersOfType(db, 'advisory', 1, 2_000);
                        blockedOnAnchor = true;
                      } catch { /* not blocked: the mutant case */ }
                      rowDuringPause = await memberRow();
                    }
                    return d.update(a);
                  };
                }
                const v = d[k];
                return typeof v === 'function' ? v.bind(d) : v;
              },
            });
            const wrapped = new Proxy(tx, { get(t: any, k) { if (k === 'memory') return memory; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
            return fn(wrapped);
          }, ...rest);
        }
        const v = (base as any)[key];
        return typeof v === 'function' ? v.bind(base) : v;
      },
    });

    const b = await M.createAgent({}, { orgId: org.id, name: 'Race B', systemMemoryId: target.id }, { ...userCtx(admin.id), db: paused as typeof db } as Context);
    expect(removal).not.toBeNull();
    expect(blockedOnAnchor).toBe(true); // the revocation waited on the promotion's anchors
    expect(rowDuringPause).not.toBeNull(); // and had not committed while the promotion decided
    // Serialized: the promotion decided while the membership was live and
    // committed first; the removal then committed after it.
    expect(b.systemMemoryId).toBe(target.id);
    const removalOutcome = await (removal as unknown as Promise<unknown>).then(() => 'committed', (e: Error) => e.message);
    expect(removalSettled).toBe(true);
    expect(removalOutcome).toBe('committed');
    expect(await memberRow()).toBeNull();
  });
});

describe('the target must be writable, not a group memory, and the platform ADMIN path is explicit', () => {
  const READ_ONLY = /not authorized|forbidden|write/i;
  const GROUP = "A group memory cannot become an Agent's system memory: its members would lose it.";

  async function groupMemory() {
    const g = await db.memory.create({
      data: { id: generateId(), name: 'grp', urn: `grp-${generateId()}`, organizationId: org.id, class: 'group', visibility: 'GROUP' },
    });
    await db.memoryMember.createMany({ data: [
      { memoryId: g.id, userId: ownerAdmin.id, role: 'owner' },
      { memoryId: g.id, userId: admin.id, role: 'reader' },
    ] });
    return g;
  }

  async function expectGroupUntouched(id: string) {
    const m = await db.memory.findUniqueOrThrow({ where: { id } });
    expect(m.class).toBe('group');
    expect(await db.agent.findFirst({ where: { systemMemoryId: id } })).toBeNull();
  }

  it('create: a group READER who is an org ADMIN is refused by the write gate', async () => {
    const g = await groupMemory();
    const err = await refusal(M.createAgent({}, { orgId: org.id, name: 'B', systemMemoryId: g.id }, userCtx(admin.id)));
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.extensions?.code).not.toBe('MEMORY_NOT_FOUND');
    expect(err.message).toMatch(READ_ONLY);
    await expectGroupUntouched(g.id);
  });

  it('update pre-lock: the same reader is refused', async () => {
    const g = await groupMemory();
    const c = await brainlessAgent('C');
    const err = await refusal(M.updateAgent({}, { ref: c.id, systemMemoryId: g.id }, userCtx(admin.id)));
    expect(err.message).toMatch(READ_ONLY);
    await expectGroupUntouched(g.id);
  });

  it('the group OWNER is refused too: a group memory is never promoted', async () => {
    const g = await groupMemory();
    const err = await refusal(M.createAgent({}, { orgId: org.id, name: 'B', systemMemoryId: g.id }, userCtx(ownerAdmin.id)));
    expect(err.extensions?.code).toBe('BAD_USER_INPUT');
    expect(err.message).toBe(GROUP);
    await expectGroupUntouched(g.id);
  });

  it('a platform ADMIN (accessible set = null) may promote a readable org memory, by design', async () => {
    const pa = await db.user.create({ data: { id: generateId(), githubId: 930299, githubUsername: `promote-pa-${generateId()}`, roles: ['ADMIN'] } });
    const plain = await db.memory.create({
      data: { id: generateId(), name: 'plain', urn: `plain-${generateId()}`, organizationId: org.id, class: 'knowledge' },
    });
    const b = await M.createAgent({}, { orgId: org.id, name: 'B', systemMemoryId: plain.id }, { db, userId: pa.id, roles: ['ADMIN'] } as Context);
    expect(b.systemMemoryId).toBe(plain.id);
  });

  it('a platform ADMIN still gets MEMORY_NOT_FOUND for a deleted target', async () => {
    const pa = await db.user.create({ data: { id: generateId(), githubId: 930298, githubUsername: `promote-pa2-${generateId()}`, roles: ['ADMIN'] } });
    const deleted = await db.memory.create({
      data: { id: generateId(), name: 'gone', urn: `gone-${generateId()}`, organizationId: org.id, class: 'knowledge', deletedAt: new Date() },
    });
    const err = await refusal(M.createAgent({}, { orgId: org.id, name: 'B', systemMemoryId: deleted.id }, { db, userId: pa.id, roles: ['ADMIN'] } as Context));
    expect(err.extensions?.code).toBe('MEMORY_NOT_FOUND');
  });
});
