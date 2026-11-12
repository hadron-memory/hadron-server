/**
 * #4039 (gate B3/B4): the MCP node writers refuse an invalid or start-unavailable `data.entryCondition` on a conversation
 * node with the same code, reason and detail as the GraphQL writers, before any write: `hadron_create_node`,
 * `hadron_update_node` and `hadron_update_node_data`. The node is unchanged after every refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { emitNodeUrnV2 } from '../lib/urnEmit.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const CHAT_VAR = { '==': [{ var: 'chat.message_count' }, 0] };
let owner: string;
let memory: { id: string; urn: string };
const urnOf = (loc: string) => emitNodeUrnV2(memory.urn, loc);
const client = () => createTestableMcpServer({ userId: owner, roles: ['READER'], clientId: `user:${owner}` });

beforeEach(async () => {
  await cleanDb(db);
  owner = (await db.user.create({ data: { handle: `m4039-${generateId()}`, roles: ['READER'] } })).id;
  memory = await db.memory.create({
    data: { name: 'm4039', urn: `m4039-${generateId()}:private`, class: 'private', userId: owner, ownerUserId: owner, vectorIndexEnabled: false },
  });
});

describe('#4039 MCP entry-condition save check', () => {
  it('9 hadron_create_node: refused with code, reason and detail; nothing is created', async () => {
    const text = await client().callToolText('hadron_create_node', {
      urn: urnOf('conversations:welcome'), name: 'welcome', data: { stageOrder: ['s1'], entryCondition: CHAT_VAR },
    });
    expect(text).toContain('[invalid_entry_condition]');
    expect(text).toContain('reason: SCOPE_NOT_AVAILABLE_AT_START');
    expect(text).toContain('"field":"chat.message_count"');
    expect(text).not.toContain('messageId');
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'conversations:welcome' } })).toBe(0);
  });

  it('9 hadron_update_node: refused, the stored data is unchanged', async () => {
    const node = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'conversations:welcome', name: 'welcome', data: { stageOrder: ['s1'] } } });
    const text = await client().callToolText('hadron_update_node', {
      urn: urnOf('conversations:welcome'), data: { stageOrder: ['s1'], entryCondition: CHAT_VAR },
    });
    expect(text).toContain('[invalid_entry_condition]');
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).data).toEqual({ stageOrder: ['s1'] });
  });

  it('9 hadron_update_node_data: refused through the resolver, the stored data is unchanged', async () => {
    const node = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'conversations:welcome', name: 'welcome', data: { stageOrder: ['s1'] } } });
    const text = await client().callToolText('hadron_update_node_data', {
      nodeUrn: urnOf('conversations:welcome'), data: { entryCondition: CHAT_VAR },
    });
    expect(text).toContain('[invalid_entry_condition]');
    expect(text).toContain('reason: SCOPE_NOT_AVAILABLE_AT_START');
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).data).toEqual({ stageOrder: ['s1'] });
  });

  it('CONTROL: a valid memory.* condition saves through create and update', async () => {
    const cond = { '!': [{ var: 'memory.name' }] };
    expect(await client().callToolText('hadron_create_node', { urn: urnOf('conversations:welcome'), name: 'welcome', data: { entryCondition: cond } })).toContain('Node saved');
    expect(await client().callToolText('hadron_update_node', { urn: urnOf('conversations:welcome'), data: { entryCondition: cond, stageOrder: ['a'] } })).toContain('Node updated');
  });
});
