/**
 * #910 — in an app-class memory, chat extraction used to merge every member's
 * values into one flat `loc:'data'` bag, so member A's answer became member
 * B's prompt variable and routing operand. These pin the per-person layout
 * (`data.users[<userId>]`) and the read rule built to Vera's PROPOSAL on
 * cor:acl:030:01: a value about one person is only ever read for that person.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { compileTemplate } from '../../../lib/template.js';
import { buildPrismaMemoryLayer } from '../../../lib/edge-conditions/prisma-memory-layer.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let alice: { id: string };
let bob: { id: string };
let outsider: { id: string };
let agent: { id: string };
let systemMemoryId: string;

const ctxFor = (userId: string): Context => ({ db, roles: ['READER'], userId });

/** The scope stage's prompt, which every startChat/sendChatMessage compiles. */
const PROMPT = 'industry={{industry}};region={{region}};legacy={{legacyField}};listed={{listedField}};others={{users}}';

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'org-910', urn: 'org-910' } });
  alice = await db.user.create({ data: { githubId: 9101, githubUsername: 'alice-910', roles: ['READER'] } });
  bob = await db.user.create({ data: { githubId: 9102, githubUsername: 'bob-910', roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 9103, githubUsername: 'outsider-910', roles: ['READER'] } });
  const admin = await db.user.create({ data: { githubId: 9100, githubUsername: 'admin-910', roles: ['ADMIN'] } });
  for (const u of [admin, alice, bob]) {
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role: u === admin ? 'ADMIN' : 'CONTRIBUTOR' } });
  }
  const created = await resolvers.Mutation.createAgent(
    {}, { orgId: org.id, name: 'intake-agent', visibility: 'ORGANIZATION' },
    { db, roles: ['ADMIN'], userId: admin.id },
  );
  agent = created;
  systemMemoryId = created.systemMemoryId!;
  const app = await db.app.create({
    data: {
      id: generateId(), name: 'intake-app', urn: `${org.urn}:intake-app`,
      organizationId: org.id, appAgents: { create: { agentId: agent.id } },
    },
  });
  for (const u of [alice, bob]) {
    await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  }
  const nodes: Array<{ loc: string; data?: unknown; content?: string }> = [
    // `region` is declared memory-wide; `industry` is personal (unprefixed).
    { loc: 'config', data: { agentExtractionSpec: [{ field: 'memory.region' }] } },
    { loc: 'conversations' },
    {
      loc: 'conversations:intake',
      data: { stageOrder: ['scope'], isSetup: false, extractionSpec: [{ field: 'industry' }] },
    },
    { loc: 'conversations:intake:scope', data: { promptRef: 'prompts:intake:scope' } },
    { loc: 'prompts' },
    { loc: 'prompts:intake' },
    { loc: 'prompts:intake:scope', content: PROMPT },
  ];
  for (const n of nodes) {
    await db.node.upsert({
      where: { loc_memoryId: { loc: n.loc, memoryId: systemMemoryId } },
      update: { data: (n.data ?? undefined) as never, content: n.content ?? undefined },
      create: {
        id: generateId(), memoryId: systemMemoryId, loc: n.loc,
        name: n.loc.split(':').pop()!, nodeType: 'system',
        data: (n.data ?? null) as never, content: n.content ?? null,
      },
    });
  }
  // #2712: chats are served the Agent's boot prompt; an Agent without one is refused.
  await serveEveryAgent(db);
});

async function startShared(userId: string) {
  return resolvers.Mutation.startChat({}, { agentId: agent.id, scope: 'shared' }, ctxFor(userId));
}
async function extract(userId: string, chatId: string, data: Record<string, unknown>) {
  return resolvers.Mutation.processChatResponse(
    {}, { chatId, toolResponse: { message: 'ok', data, next_stage: 'scope', onTrack: true } },
    ctxFor(userId),
  );
}
async function promptFor(userId: string, chatId: string) {
  const sent = await resolvers.Mutation.sendChatMessage({}, { chatId, userMessage: 'hi' }, ctxFor(userId));
  return sent.systemMessage as string;
}
async function dataNodeOf(chatId: string) {
  const chat = await chatNodeByLocOrThrow(db, chatId);
  const node = await db.node.findFirst({ where: { memoryId: chat.memoryId, loc: 'data', deletedAt: null } });
  return { memoryId: chat.memoryId, data: (node?.data ?? null) as Record<string, unknown> | null };
}

describe('#910 — per-person extraction in an app-class host', () => {
  it("separate chats: A's value never reaches B's prompt; each then sees only their own", async () => {
    const a = await startShared(alice.id);
    const b = await startShared(bob.id);
    await extract(alice.id, a.chatId, { industry: 'A-construction' });

    expect(await promptFor(bob.id, b.chatId)).not.toContain('A-construction');
    expect(await promptFor(alice.id, a.chatId)).toContain('industry=A-construction;');

    await extract(bob.id, b.chatId, { industry: 'B-farming' });
    const bobPrompt = await promptFor(bob.id, b.chatId);
    const alicePrompt = await promptFor(alice.id, a.chatId);
    expect(bobPrompt).toContain('industry=B-farming;');
    expect(bobPrompt).not.toContain('A-construction');
    expect(alicePrompt).toContain('industry=A-construction;');
    expect(alicePrompt).not.toContain('B-farming');
    // A new chat compiles its first prompt through startChat, not send.
    const bobFresh = await startShared(bob.id);
    expect(bobFresh.systemMessage).toContain('industry=B-farming;');
    expect(bobFresh.systemMessage).not.toContain('A-construction');
  });

  it('one shared chat, alternating speakers: the speaker, not the creator, owns each value', async () => {
    const chat = await startShared(alice.id);
    await extract(alice.id, chat.chatId, { industry: 'A-construction' });
    expect(await promptFor(bob.id, chat.chatId)).not.toContain('A-construction');
    await extract(bob.id, chat.chatId, { industry: 'B-farming' });
    expect(await promptFor(alice.id, chat.chatId)).toContain('industry=A-construction;');
    expect(await promptFor(bob.id, chat.chatId)).toContain('industry=B-farming;');

    const { data } = await dataNodeOf(chat.chatId);
    const users = data?.users as Record<string, Record<string, unknown>>;
    expect(users[alice.id]).toEqual({ industry: 'A-construction' });
    expect(users[bob.id]).toEqual({ industry: 'B-farming' });
    // Nothing personal is left in the memory-wide bag.
    expect(data).not.toHaveProperty('industry');
  });

  it('concurrent extractions keep every namespace and the memory-wide defaults', async () => {
    const a = await startShared(alice.id);
    const b = await startShared(bob.id);
    await extract(alice.id, a.chatId, { region: 'EU' });
    // Ten turns at once, each adding its own field: without serialization on
    // the `data` loc, a read-modify-write loses someone's bucket entry.
    const fields = ['f0', 'f1', 'f2', 'f3', 'f4'];
    await Promise.all(fields.flatMap((f) => [
      extract(alice.id, a.chatId, { [f]: `A-${f}` }),
      extract(bob.id, b.chatId, { [f]: `B-${f}` }),
    ]));
    const { data } = await dataNodeOf(a.chatId);
    const users = data?.users as Record<string, Record<string, unknown>>;
    expect(users[alice.id]).toEqual(Object.fromEntries(fields.map((f) => [f, `A-${f}`])));
    expect(users[bob.id]).toEqual(Object.fromEntries(fields.map((f) => [f, `B-${f}`])));
    expect(data?.region).toBe('EU');
  });

  it('declared memory-wide values reach everyone; personal values override only for their owner', async () => {
    const a = await startShared(alice.id);
    const b = await startShared(bob.id);
    await extract(alice.id, a.chatId, { region: 'EU' });
    expect(await promptFor(bob.id, b.chatId)).toContain('region=EU;');
    expect(await promptFor(alice.id, a.chatId)).toContain('region=EU;');
    const { data } = await dataNodeOf(a.chatId);
    expect(data?.region).toBe('EU');
    expect(data?.users).toBeUndefined();
  });

  it('a legacy unqualified value is preserved but read for nobody; a classified one is shared', async () => {
    const a = await startShared(alice.id);
    const b = await startShared(bob.id);
    const { memoryId } = await dataNodeOf(a.chatId);
    await db.node.create({
      data: {
        id: generateId(), memoryId, loc: 'data', name: 'data', nodeType: 'info',
        data: { legacyField: 'LEGACY-someone', listedField: 'LISTED', memoryWideKeys: ['listedField'] },
      },
    });
    for (const [userId, chatId] of [[alice.id, a.chatId], [bob.id, b.chatId]] as const) {
      const prompt = await promptFor(userId, chatId);
      expect(prompt).not.toContain('LEGACY-someone');
      expect(prompt).toContain('listed=LISTED;');
    }
    await extract(bob.id, b.chatId, { industry: 'B-farming' });
    const { data } = await dataNodeOf(a.chatId);
    // Kept for explicit repair, and given no invented owner.
    expect(data?.legacyField).toBe('LEGACY-someone');
    expect(data?.memoryWideKeys).toEqual(['listedField']);
    expect(Object.keys(data?.users as object)).toEqual([bob.id]);
  });

  it('the storage map is never a prompt variable, so no template can address another member', async () => {
    const a = await startShared(alice.id);
    const b = await startShared(bob.id);
    await extract(alice.id, a.chatId, { industry: 'A-construction' });
    const { memoryId } = await dataNodeOf(a.chatId);
    const probe = await compileTemplate(
      `{{#users}}{{${alice.id}.industry}}{{/users}}|{{users.${alice.id}.industry}}`,
      null, memoryId, db, {}, bob.id,
    );
    expect(probe).toBe('|');
  });

  it('a cross-node {{data.…}} reference reads the same filtered view, never the raw bag', async () => {
    const a = await startShared(alice.id);
    await extract(alice.id, a.chatId, { industry: 'A-construction' });
    const { memoryId } = await dataNodeOf(a.chatId);
    await db.node.update({
      where: { loc_memoryId: { loc: 'data', memoryId } },
      data: { data: { ...(await dataNodeOf(a.chatId)).data, legacyField: 'LEGACY-someone' } as never },
    });
    const tpl = `{{data.users.${alice.id}.industry}}|{{data.legacyField}}|{{data.industry}}`;
    expect(await compileTemplate(tpl, null, memoryId, db, {}, bob.id)).toBe('||');
    expect(await compileTemplate(tpl, null, memoryId, db, {})).toBe('||');
    expect(await compileTemplate(tpl, null, memoryId, db, {}, alice.id)).toBe('||A-construction');
  });

  it('a field listed in memoryWideKeys is filed memory-wide on write, as it is read', async () => {
    const a = await startShared(alice.id);
    const b = await startShared(bob.id);
    const { memoryId } = await dataNodeOf(a.chatId);
    await db.node.create({
      data: {
        id: generateId(), memoryId, loc: 'data', name: 'data', nodeType: 'info',
        data: { tier: 'OLD', memoryWideKeys: ['tier'] },
      },
    });
    await extract(alice.id, a.chatId, { tier: 'NEW' });
    const { data } = await dataNodeOf(b.chatId);
    expect(data?.tier).toBe('NEW');
    expect(data?.users).toBeUndefined();
    expect(await compileTemplate('t={{tier}}', null, memoryId, db, {}, bob.id)).toBe('t=NEW');
    expect(await compileTemplate('t={{tier}}', null, memoryId, db, {}, alice.id)).toBe('t=NEW');
  });

  it('a field declared memory-wide at one level and personal at another stays personal', async () => {
    await db.node.update({
      where: { loc_memoryId: { loc: 'conversations:intake:scope', memoryId: systemMemoryId } },
      data: { data: { promptRef: 'prompts:intake:scope', extractionSpec: [{ field: 'memory.industry' }] } },
    });
    const a = await startShared(alice.id);
    await extract(alice.id, a.chatId, { industry: 'A-construction' });
    const { data } = await dataNodeOf(a.chatId);
    expect(data).not.toHaveProperty('industry');
    expect((data?.users as Record<string, unknown>)[alice.id]).toEqual({ industry: 'A-construction' });
  });

  it('a turn with no attributable person writes no personal value and reads none', async () => {
    const a = await startShared(alice.id);
    await extract(alice.id, a.chatId, { industry: 'A-construction' });
    const { memoryId } = await dataNodeOf(a.chatId);
    expect(await compileTemplate('i={{industry}}', null, memoryId, db, {})).toBe('i=');
  });

  it('participation is unchanged: a non-creator member takes part, an outsider is still refused', async () => {
    const chat = await startShared(alice.id);
    await expect(extract(bob.id, chat.chatId, { industry: 'B-farming' })).resolves.toBeDefined();
    await expect(extract(outsider.id, chat.chatId, { industry: 'X' })).rejects.toThrow();
    await expect(promptFor(outsider.id, chat.chatId)).rejects.toThrow();
    const { data } = await dataNodeOf(chat.chatId);
    expect(Object.keys(data?.users as object)).toEqual([bob.id]);
  });
});

describe('#910 — routing reads the same per-person view', () => {
  it("a condition operand is the reader's own value, a declared default, or nothing", async () => {
    const a = await startShared(alice.id);
    const b = await startShared(bob.id);
    await extract(alice.id, a.chatId, { industry: 'A-construction', region: 'EU' });
    const { memoryId } = await dataNodeOf(a.chatId);

    const asBob = await buildPrismaMemoryLayer(db, 'user-memory', memoryId, '', bob.id);
    expect(await asBob.read('industry')).toEqual({ ok: true, value: undefined });
    expect(await asBob.read(`users.${alice.id}.industry`)).toEqual({ ok: true, value: undefined });
    expect(await asBob.read('region')).toEqual({ ok: true, value: 'EU' });

    const asAlice = await buildPrismaMemoryLayer(db, 'user-memory', memoryId, '', alice.id);
    expect(await asAlice.read('industry')).toEqual({ ok: true, value: 'A-construction' });

    // A source at or under `data` repeats the root as an ancestor; every
    // occurrence reads the filtered view.
    await db.node.update({
      where: { loc_memoryId: { loc: 'data', memoryId } },
      data: { data: { ...(await dataNodeOf(a.chatId)).data, legacyField: 'LEGACY-someone' } as never },
    });
    for (const sourceLoc of ['data', 'data:child']) {
      for (const person of [bob.id, null]) {
        const layer = await buildPrismaMemoryLayer(db, 'user-memory', memoryId, sourceLoc, person);
        expect(await layer.read(`users.${alice.id}.industry`)).toEqual({ ok: true, value: undefined });
        expect(await layer.read('industry')).toEqual({ ok: true, value: undefined });
        expect(await layer.read('legacyField')).toEqual({ ok: true, value: undefined });
        expect(await layer.read('region')).toEqual({ ok: true, value: 'EU' });
      }
    }

    // The runner has no person: memory-wide values only.
    const asNobody = await buildPrismaMemoryLayer(db, 'edge-memory', memoryId, '');
    expect(await asNobody.read('industry')).toEqual({ ok: true, value: undefined });
    expect(await asNobody.read('region')).toEqual({ ok: true, value: 'EU' });
  });
});

describe('#910 — the default data node is always the compiled memory\'s own (Cooper on #1990)', () => {
  it("another readable memory's data node never stands in for the chat memory's own", async () => {
    // A team-readable knowledge memory with its own `data` node, created
    // FIRST so an unscoped findFirst over the caller's readable set finds it.
    const team = await db.memory.create({
      data: {
        id: generateId(), name: 'team-910', urn: `${org.urn}:team-910`,
        organizationId: org.id, class: 'knowledge', visibility: 'ORGANIZATION',
      } as never,
    });
    await db.node.create({
      data: { id: generateId(), memoryId: team.id, loc: 'data', name: 'data', nodeType: 'info', data: { industry: 'TEAM-motto' } },
    });
    for (const [user, value] of [[alice, 'A-own'], [bob, 'B-own']] as const) {
      const chat = await resolvers.Mutation.startChat({}, { agentId: agent.id }, ctxFor(user.id));
      await extract(user.id, chat.chatId, { industry: value });
      const prompt = await promptFor(user.id, chat.chatId);
      expect(prompt).toContain(`industry=${value};`);
      expect(prompt).not.toContain('TEAM-motto');
    }
  });

  it('a {{data.…}} reference also reads the compiled memory\'s own node', async () => {
    const other = await db.memory.create({
      data: {
        id: generateId(), name: 'other-910', urn: `${org.urn}:other-910`,
        organizationId: org.id, class: 'knowledge', visibility: 'ORGANIZATION',
      } as never,
    });
    const own = await db.memory.create({
      data: {
        id: generateId(), name: 'own-910', urn: `${org.urn}:own-910`,
        organizationId: org.id, class: 'knowledge', visibility: 'ORGANIZATION',
      } as never,
    });
    for (const [m, v] of [[other, 'OTHER'], [own, 'OWN']] as const) {
      await db.node.create({ data: { id: generateId(), memoryId: m.id, loc: 'data', name: 'data', nodeType: 'info', data: { x: v } } });
    }
    const filter = { memoryId: { in: [other.id, own.id] } };
    expect(await compileTemplate('{{x}}|{{data.x}}', null, own.id, db, filter)).toBe('OWN|OWN');
    // The access filter still gates: an unreadable own memory yields nothing.
    expect(await compileTemplate('{{x}}|{{data.x}}', null, own.id, db, { memoryId: { in: [other.id] } })).toBe('|');
  });
});

describe('#910 — single-human hosts keep the flat bag', () => {
  it('a personal-memory chat still folds extraction flat and reads it back whole', async () => {
    const chat = await resolvers.Mutation.startChat({}, { agentId: agent.id }, ctxFor(alice.id));
    await extract(alice.id, chat.chatId, { industry: 'A-construction', users: 'literal' });
    const { memoryId, data } = await dataNodeOf(chat.chatId);
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    expect(memory.class).not.toBe('app');
    expect(data).toEqual({ industry: 'A-construction', users: 'literal' });
    expect(await promptFor(alice.id, chat.chatId)).toContain('industry=A-construction;');
    const layer = await buildPrismaMemoryLayer(db, 'user-memory', memoryId, '');
    expect(await layer.read('industry')).toEqual({ ok: true, value: 'A-construction' });
  });
});
