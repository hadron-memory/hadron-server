/**
 * #3598 (from #3588 LOCAL 6682351090): the team-chat post shares `withChatRootLock` with the chatbot doors, so a team
 * chat whose root was admitted and then vanished before the locked read answers the same typed CHAT_NOT_FOUND, echoing
 * the addressed loc, and the append's insert never runs.
 *
 * The root is removed at the last step before the append (`postToChannelRoot`'s encryption-info read), after the App,
 * the access gate and the locate-or-create step have all run. Deleting the root cascades its Channel, so nothing later can mistake it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { type Context } from './resolvers.js';
import { teamChatMutations } from './resolvers.teamChat.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

/** Armed with a root, the post's encryption-info read for that root's memory deletes the root first. */
const hook = vi.hoisted(() => ({ vanish: null as null | { rootId: string; memoryId: string } }));
const inserts = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../lib/nodeCrypto.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/nodeCrypto.js')>();
  return {
    ...real,
    getMemoryEncryptionInfo: async (...args: Parameters<typeof real.getMemoryEncryptionInfo>) => {
      const armed = hook.vanish;
      // Only the post's own read, after the root was located or created (`postToChannelRoot`), never the earlier one.
      if (armed && args[1] === armed.memoryId && (new Error().stack ?? '').includes('postToChannelRoot')) {
        hook.vanish = null;
        await db.node.delete({ where: { id: armed.rootId } });
      }
      return real.getMemoryEncryptionInfo(...args);
    },
  };
});
vi.mock('../../../lib/chatRoot.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/chatRoot.js')>();
  return {
    ...real,
    appendChatMessage: ((dbArg, chat, enc, insert, opts) => real.appendChatMessage(dbArg, chat, enc, async (args) => {
      inserts.count += 1;
      return insert(args);
    }, opts)) as typeof real.appendChatMessage,
  };
});

let app: { id: string };
let human: { id: string };
let memoryId: string;
let rootId: string;

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const say = (body: string) => teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body, replyToSeq: null, sessionRef: null }, ctx(human.id));
const messages = () => db.node.count({ where: { memoryId, nodeType: 'chat-message' } });

beforeEach(async () => {
  await cleanDb(db);
  hook.vanish = null;
  inserts.count = 0;
  const org = await db.organization.create({ data: { id: generateId(), name: 'vr-org', urn: 'vr-org-3598.com' } });
  human = await db.user.create({ data: { id: generateId(), handle: 'vr-human-3598', roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: human.id, role: 'ADMIN' } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: human.id, role: 'member' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:team-shared`, name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } })).id;
  const made = await ensureChannelWithRoot(db, { memoryId, loc: 'chats:team', name: 'team', createdBy: human.id, asDefaultOfAppId: app.id });
  rootId = made.rootId;
});

describe('#3598 the team-chat append path, root vanished before the locked read', () => {
  it('control: the same post into a live root is written, through the insert', async () => {
    await expect(say('hello')).resolves.toMatchObject({ seq: 1 });
    expect(inserts.count).toBe(1);
    expect(await messages()).toBe(1);
  });

  it('answers CHAT_NOT_FOUND for the addressed loc, never runs the insert, and writes no message', async () => {
    await say('first');
    const before = await messages();
    hook.vanish = { rootId, memoryId };
    const error = await say('after the root is gone').then(() => null, (e: unknown) => e);
    expect(hook.vanish).toBeNull(); // the hook fired: the root was admitted, then removed
    expect(error).toMatchObject({ message: 'Chat "chats:team" not found', extensions: { code: 'CHAT_NOT_FOUND' } });
    expect((error as { extensions: Record<string, unknown> }).extensions).toEqual({ code: 'CHAT_NOT_FOUND' });
    expect(inserts.count).toBe(1); // only the control post's
    expect(await messages()).toBe(before);
  });
});
