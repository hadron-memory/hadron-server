/**
 * #5355 (cor:api:120:03, amended 2026-11-24; follows #5026 / #5337): `hadron_list_memories` lists the no-App knowledge
 * holding `startChat` provisions, for its CREATOR and for no other caller. GraphQL `memories()` lists it since #5337; MCP's
 * list folded only `userId` + personal/private rows, and the access map skips every `userMemoryOfAgentId` row.
 *
 * H is written in the exact shape the retired `startChat` route wrote (#5394 retired the route; see the fixture). Other hand-built
 * rows are labelled SYNTHETIC: each asserts that the list admits nothing for that shape. The list never exceeds the node-read gate (`canReadMemory`), and the displayed level
 * equals `canWriteToMemory`'s answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { runAuthContext } from '../lib/auth/runPrincipal.js';
import { canReadMemory, canWriteToMemory } from './access-control.js';
import { createTestableMcpServer } from './server.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import type { AuthContext } from '../middleware/auth.js';
import { testRunAgentId } from '../test/runAgent.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const Q = resolvers.Query as any;
const LOC = 'chat:entry';
let f: Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const suffix = generateId().toLowerCase();
  const orgO = await db.organization.create({ data: { name: 'Agent org', urn: `agentorg-${suffix}.example` } });
  const elsewhere = await db.organization.create({ data: { name: 'Elsewhere', urn: `else-${suffix}.example` } });
  const user = async (h: string, roles: ('ADMIN' | 'READER')[] = ['READER']) =>
    db.user.create({ data: { id: generateId(), handle: `${h}-${suffix}`, roles } as never });
  const creatorOut = await user('creator-out'); // not in the Agent's org
  const creatorIn = await user('creator-in'); // a member of the Agent's org
  const contributor = await user('contributor');
  const orgAdmin = await user('orgadmin');
  const orgOwner = await user('orgowner');
  const outsider = await user('outsider');
  const platformAdmin = await user('platform', ['ADMIN']);
  await db.orgMember.createMany({ data: [
    { organizationId: orgO.id, userId: creatorIn.id, role: 'READER' },
    { organizationId: orgO.id, userId: contributor.id, role: 'CONTRIBUTOR' },
    { organizationId: orgO.id, userId: orgAdmin.id, role: 'ADMIN' },
    { organizationId: orgO.id, userId: orgOwner.id, role: 'OWNER' },
  ] });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgO.id, name: 'Holder', urn: `${orgO.urn}:holder`, visibility: 'PUBLIC' } as never });
  const sys = await db.memory.create({ data: { id: generateId(), urn: `${orgO.urn}:sys`, name: 'sys', organizationId: orgO.id, class: 'system' } as never });
  await db.agent.update({ where: { id: agent.id }, data: { systemMemoryId: sys.id } as never });
  for (const [loc, data, content] of [
    ['conversations', null, null],
    ['conversations:c', { stageOrder: ['s'], isSetup: false }, null],
    ['conversations:c:s', { promptRef: 'prompts:c:s' }, null],
    ['prompts', null, null], ['prompts:c', null, null], ['prompts:c:s', null, 'Hi.'],
  ] as const) {
    await db.node.create({ data: { id: generateId(), memoryId: sys.id, loc, name: loc.split(':').pop()!, nodeType: 'system', data: data as never, content } });
  }
  await serveAgentBootPrompt(db, agent.id, 'Hi.');

  // H: #5394 retired the real startChat route for this shape (a start with no App identified refuses CHAT_APP_NOT_IDENTIFIED and
  // writes nothing, pinned in access-control.noAppHolding3519.test.ts), so H is written by hand in the exact shape that route
  // wrote. Holdings of this shape still exist, so the list arm still matters.
  const startAs = async (u: { id: string }) =>
    db.memory.create({ data: {
      organizationId: orgO.id, urn: `${orgO.urn}:${generateId().toLowerCase()}`, name: `${agent.name} — ${u.id}`, userId: null,
      class: 'knowledge', visibility: 'ORGANIZATION', userMemoryOfAgentId: agent.id, createdBy: u.id,
    } as never });
  const hOut = await startAs(creatorOut);
  const hIn = await startAs(creatorIn);
  for (const h of [hOut, hIn]) {
    expect(h).toMatchObject({ class: 'knowledge', appId: null, userId: null, ownerUserId: null, userMemoryOfAgentId: agent.id });
  }

  const { app, appKey } = await createDbAppWithKey(db, 'unrelated5355', elsewhere.id);
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: creatorOut.id } as never });
  const synthetic = async (slug: string, extra: Record<string, unknown>) =>
    db.memory.create({ data: {
      name: slug, urn: `${orgO.urn}:${slug}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: orgO.id,
      userMemoryOfAgentId: agent.id, createdBy: creatorOut.id, ...extra,
    } as never });
  const appSet = await synthetic('appset', { appId: app.id }); // SYNTHETIC: App-bound holding
  const groupRow = await synthetic('grouprow', { class: 'group', visibility: 'GROUP' }); // SYNTHETIC
  const nonHolding = await synthetic('nonholding', { userMemoryOfAgentId: null }); // SYNTHETIC: not a holding
  const anonCreated = await synthetic('anoncreated', { createdBy: app.id }); // SYNTHETIC: createdBy is an App id
  const foreign = await synthetic('foreign', { createdBy: outsider.id }); // SYNTHETIC: another user's holding
  const deleted = await synthetic('deleted', { deletedAt: new Date() }); // SYNTHETIC: soft-deleted holding of the creator
  const personal = await db.memory.create({ data: {
    name: 'personal', urn: `${orgO.urn}:personal`, class: 'personal', organizationId: orgO.id, userId: creatorOut.id, createdBy: creatorOut.id,
  } as never });

  const ctx = (u: { id: string }, extra: Partial<AuthContext> = {}): AuthContext =>
    ({ userId: u.id, roles: ['READER'], ...extra }) as AuthContext;
  const run = await db.appRun.create({ data: {
    id: generateId(), organizationId: elsewhere.id, appId: app.id, agentId: await testRunAgentId(db, elsewhere.id, app.id), userId: creatorOut.id, triggerKind: 'SCHEDULE',
    triggerId: (await db.agentSchedule.create({ data: { id: generateId(), organizationId: elsewhere.id, appId: app.id, name: 'S', cron: '* * * * *', entryNodeUrn: `hrn:node:${hOut.urn}:${LOC}` } })).id,
    entryNodeUrn: `hrn:node:${hOut.urn}:${LOC}`,
  } as never });
  const runPrincipal = runAuthContext(run);
  return { orgO, agent, creatorOut, creatorIn, contributor, orgAdmin, orgOwner, outsider, platformAdmin, hOut, hIn, app, appKey, session,
    appSet, groupRow, nonHolding, anonCreated, foreign, deleted, personal, ctx, runPrincipal };
}
beforeEach(async () => { await cleanDb(db); f = await fixture(); }, 60_000);

const listText = (auth: AuthContext) => createTestableMcpServer(auth).callToolText('hadron_list_memories', {});
/** The `- **<urn>** — name (level)` lines, by memory urn. */
const levelOf = (text: string, m: { urn: string }) => /\((?:[a-z]+, )?(read-write|read-only)\)/.exec(text.split('\n').find(l => l.includes(m.urn)) ?? '')?.[1];
const SHAPES = (): { urn: string }[] => [f.appSet, f.groupRow, f.nonHolding, f.anonCreated, f.foreign, f.deleted];

describe('#5355 hadron_list_memories lists the no-App holding for its creator', () => {
  it('RED: the creator (outside the Agent org) lists H, and the header counts it', async () => {
    const text = await listText(f.ctx(f.creatorOut));
    expect(text).toContain(f.hOut.urn);
    expect(text).not.toContain(f.hIn.urn);
    expect(text).toMatch(/\b\d+ accessible memories/);
  }, 30_000);
  it('RED: the creator inside the Agent org lists their own H and not the other creator\'s', async () => {
    const text = await listText(f.ctx(f.creatorIn));
    expect(text).toContain(f.hIn.urn);
    expect(text).not.toContain(f.hOut.urn);
  }, 30_000);
  it('RED: the creator with an unrelated active App (hybrid selection) lists H', async () => {
    expect(await listText(f.ctx(f.creatorOut, { appId: f.app.id }))).toContain(f.hOut.urn);
  }, 30_000);
  it('the displayed level equals canWriteToMemory\'s answer for the shape (not invented)', async () => {
    for (const [who, h] of [[f.creatorOut, f.hOut], [f.creatorIn, f.hIn]] as const) {
      const auth = f.ctx(who);
      const expected = (await canWriteToMemory(db, auth, h.id)) ? 'read-write' : 'read-only';
      expect(levelOf(await listText(auth), h), who.id).toBe(expected);
    }
  }, 30_000);
  it('parity: the MCP list and memories() return the same holding ids for the creator', async () => {
    const auth = f.ctx(f.creatorOut);
    const gql = await Q.memories(null, { filter: null, orgRef: null }, { db, ...auth });
    const gqlIds = new Set<string>(gql.items.map((m: { id: string }) => m.id));
    const text = await listText(auth);
    for (const h of [f.hOut, f.hIn]) expect(gqlIds.has(h.id), `gql ${h.id}`).toBe(text.includes(h.urn));
    expect(gqlIds.has(f.hOut.id)).toBe(true);
  }, 30_000);
});

describe('#5355 controls: nobody else lists it (green on main and after)', () => {
  const absent = async (auth: AuthContext, ...ms: { urn: string }[]) => {
    const text = await listText(auth);
    for (const m of ms) expect(text, m.urn).not.toContain(m.urn);
  };
  it('a co-member, an org admin, an org owner, an outsider and a platform ADMIN who is not the creator', async () => {
    for (const who of [f.contributor, f.orgAdmin, f.orgOwner, f.outsider]) await absent(f.ctx(who), f.hIn, f.hOut);
    await absent(f.ctx(f.platformAdmin, { roles: ['ADMIN'] }), f.hIn, f.hOut);
  }, 60_000);
  it('an App key (pure, and carrying a user id), an impersonation, a run principal and a bound worker session', async () => {
    await absent({ appId: f.app.id, appKeyId: f.appKey.id, roles: [] } as unknown as AuthContext, f.hOut);
    await absent(f.ctx(f.creatorOut, { appId: f.app.id, appKeyId: f.appKey.id }), f.hOut);
    await absent(f.ctx(f.creatorOut, { impersonation: { actorUserId: f.platformAdmin.id } as never }), f.hOut);
    await absent({ db, ...f.runPrincipal } as AuthContext, f.hOut);
    for (const extra of [{ sessionId: f.session.id }, { requestSession: { sessionId: f.session.id, refused: false } }, { sessionBindingRefused: true }] as Partial<AuthContext>[]) {
      await absent(f.ctx(f.creatorOut, extra), f.hOut);
    }
  }, 60_000);
  it('SYNTHETIC shapes are never listed for the creator: App-bound, group, non-holding, App-id creator, another user\'s, soft-deleted', async () => {
    await absent(f.ctx(f.creatorOut), ...SHAPES());
  }, 30_000);
  it('the list never exceeds the node-read gate: every listed holding passes canReadMemory', async () => {
    const auth = f.ctx(f.creatorOut);
    const text = await listText(auth);
    for (const h of [f.hOut, f.hIn]) if (text.includes(h.urn)) expect(await canReadMemory(db, auth, h.id)).toBe(true);
  }, 30_000);
  it('an App-bound personal home and a free-standing personal memory of the creator are listed as before', async () => {
    expect(await listText(f.ctx(f.creatorOut))).toContain(f.personal.urn);
  }, 30_000);
});
