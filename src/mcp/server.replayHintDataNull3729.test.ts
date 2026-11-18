/**
 * #3729 — the replay-hint helper must not route a generic `data: null` update
 * to a governed door whose registered schema cannot accept it.
 *
 * Since #3721 the generic `hadron_update_node` schema takes `data: null`
 * (clears the bag). The task/review update doors (`governedDoorArgs.data`)
 * take an OPTIONAL OBJECT and never null, so a refusal that says "Over MCP,
 * use hadron_update_task" for a `data: null` write sends the reader to a door
 * that will refuse the same argument. `mcpDoorCanReplay` already treats
 * `content: null` / `abstract: null` as non-replayable for exactly this
 * reason; `data: null` must join them. Helper-eligibility fix only — no
 * schema, admission or persistence change (issue acceptance 4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer, GOVERNED_MCP_DOOR_FIELDS, mcpDoorCanReplay } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

// #3754: a factory whose function carries its own implementation, so neither clearAllMocks nor a Vitest version's reset can strip it.
vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn(async () => undefined),
}));

let admin: { id: string };
let memory: { id: string; urn: string };
const auth = (): AuthContext => ({
  userId: admin.id,
  roles: ['ADMIN'],
  clientId: `user:${admin.id}`,
});

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'mcp-rh3729-org', urn: 'mcp-rh3729-org' },
  });
  admin = await db.user.create({
    data: { githubId: 37291, githubUsername: 'mcp-rh3729-admin', handle: 'mcp-rh3729-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:nodes`,
      name: 'nodes',
      class: 'knowledge',
    },
  });
});

const seed = (loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      loc,
      name: loc,
      content: 'version one',
      abstract: 'summary one',
      ...extra,
    },
  });

const urnFor = (loc: string) => `hrn:node:${memory.urn}:${loc}`;

/** The stored facts acceptance 2 wants proven untouched by a refused write. */
const snapshot = async (id: string) => {
  const node = await db.node.findUniqueOrThrow({ where: { id } });
  return {
    data: JSON.stringify(node.data ?? null),
    // #3754 item 1: content and abstract too, so "state unchanged" is proven for every field a refused write could touch.
    content: node.content,
    abstract: node.abstract,
    revSeq: node.revSeq,
    revisions: await db.nodeRevision.count({ where: { nodeId: id } }),
  };
};

describe('MCP replay hint vs data:null (#3729)', () => {
  describe('helper eligibility (mcpDoorCanReplay)', () => {
    it('update: a present data:null is NOT replayable for task or review', () => {
      // The doors take an object for data (optional, never nullable), so a
      // write that CLEARS the bag cannot replay through them.
      expect(mcpDoorCanReplay({ name: 'n', data: null }, 'task', 'update')).toBe(false);
      expect(mcpDoorCanReplay({ name: 'n', data: null }, 'review', 'update')).toBe(false);
    });

    it('create: a present data:null is not replayable either (unit coverage only)', () => {
      // Reachability distinction (#3729 issue): the generic CREATE schema
      // still refuses data:null BEFORE the callback, so this arm cannot be
      // reached from hadron_create_node; it pins the helper's own contract.
      expect(mcpDoorCanReplay({ name: 'n', data: null }, 'task', 'create')).toBe(false);
      expect(mcpDoorCanReplay({ name: 'n', data: null }, 'review', 'create')).toBe(false);
    });

    it('controls: record data and omitted data stay replayable; content/abstract null still are not', () => {
      expect(mcpDoorCanReplay({ name: 'n', data: { k: 'v' } }, 'task', 'update')).toBe(true);
      expect(mcpDoorCanReplay({ name: 'n', data: { k: 'v' } }, 'review', 'update')).toBe(true);
      expect(mcpDoorCanReplay({ name: 'n' }, 'task', 'update')).toBe(true);
      expect(mcpDoorCanReplay({ name: 'n' }, 'review', 'update')).toBe(true);
      // Existing no-replay behavior for null content/abstract (#1305).
      expect(mcpDoorCanReplay({ name: 'n', content: null }, 'task', 'update')).toBe(false);
      expect(mcpDoorCanReplay({ name: 'n', abstract: null }, 'review', 'update')).toBe(false);
    });
  });

  describe('registered schemas (doors and generic tools)', () => {
    it('task/review update doors still REJECT data:null and still accept an object', () => {
      const client = createTestableMcpServer(auth());
      expect(() => client.toolParamSchema('hadron_update_task', 'data').parse(null)).toThrow();
      expect(() => client.toolParamSchema('hadron_update_review', 'data').parse(null)).toThrow();
      // Control: the same doors still take a record.
      expect(client.toolParamSchema('hadron_update_task', 'data').parse({ stage: 1 })).toEqual({ stage: 1 });
      expect(client.toolParamSchema('hadron_update_review', 'data').parse({ stage: 1 })).toEqual({ stage: 1 });
    });

    it('#3754 parity: every governed field whose null the generic update accepts but a door rejects is NOT replayable as null (derived from the registered schemas)', () => {
      const client = createTestableMcpServer(auth());
      const takesNull = (tool: string, field: string): boolean | 'absent' => {
        try {
          client.toolParamSchema(tool, field).parse(null);
          return true;
        } catch (e) {
          return String((e as Error).message).includes('has no parameter') ? 'absent' : false;
        }
      };
      // A null the generic update schema refuses never reaches the helper, so only these fields can be replayed wrongly.
      const reachable = GOVERNED_MCP_DOOR_FIELDS.filter((f) => takesNull('hadron_update_node', f) === true);
      expect(reachable.length, 'the derivation found no nullable generic field: the pin would be vacuous').toBeGreaterThan(0);
      for (const [kind, door] of [['task', 'hadron_update_task'], ['review', 'hadron_update_review']] as const) {
        for (const field of reachable) {
          const doorTakes = takesNull(door, field);
          if (doorTakes === 'absent') continue; // a door that does not carry the field is refused by the field-list check instead
          expect(mcpDoorCanReplay({ name: 'n', [field]: null }, kind, 'update'), `${kind} door vs ${field}:null (door takes null: ${doorTakes})`).toBe(doorTakes);
        }
      }
    });

    it('generic update accepts data:null (#3721) while generic create still refuses it', () => {
      const client = createTestableMcpServer(auth());
      expect(client.toolParamSchema('hadron_update_node', 'data').parse(null)).toBe(null);
      expect(() => client.toolParamSchema('hadron_create_node', 'data').parse(null)).toThrow();
    });
  });

  describe('the registered generic update path (live task / live review)', () => {
    it('task: refuses with [role_governed] and names NO door for data:null; state unchanged', async () => {
      const node = await seed('rh3729:task', { isRunnable: true, data: { stage: 1 } });
      const before = await snapshot(node.id);
      const client = createTestableMcpServer(auth());
      const text = await client.callToolText('hadron_update_node', {
        urn: urnFor(node.loc),
        data: null,
      });
      // The governed refusal itself remains: admission and the door gate are
      // untouched (§10 / acceptance 2).
      expect(text).toMatch(/^\[role_governed\]/);
      // The misleading route: hadron_update_task cannot accept data:null, so
      // it must not be named. The honest answer is the no-route wording.
      expect(text).not.toContain('hadron_update_task');
      expect(text).toContain('There is no route to suggest');
      expect(await snapshot(node.id)).toEqual(before);
    });

    it('review: refuses with [role_governed] and names NO door for data:null; state unchanged', async () => {
      const node = await seed('rh3729:review', { role: 'review', data: { stage: 2 } });
      const before = await snapshot(node.id);
      const client = createTestableMcpServer(auth());
      const text = await client.callToolText('hadron_update_node', {
        urn: urnFor(node.loc),
        data: null,
      });
      expect(text).toMatch(/^\[role_governed\]/);
      expect(text).not.toContain('hadron_update_review');
      expect(text).toContain('There is no route to suggest');
      expect(await snapshot(node.id)).toEqual(before);
    });

    it('controls: record data and omitted data still earn the door hint; content:null still earns none', async () => {
      const node = await seed('rh3729:task2', { isRunnable: true });
      const client = createTestableMcpServer(auth());
      const withRecord = await client.callToolText('hadron_update_node', {
        urn: urnFor(node.loc),
        data: { k: 'v' },
      });
      expect(withRecord).toMatch(/^\[role_governed\]/);
      expect(withRecord).toContain('hadron_update_task');
      const omittedData = await client.callToolText('hadron_update_node', {
        urn: urnFor(node.loc),
        content: 'new body',
      });
      expect(omittedData).toMatch(/^\[role_governed\]/);
      expect(omittedData).toContain('hadron_update_task');
      const nullContent = await client.callToolText('hadron_update_node', {
        urn: urnFor(node.loc),
        content: null,
      });
      expect(nullContent).toMatch(/^\[role_governed\]/);
      expect(nullContent).not.toContain('hadron_update_task');
    });

    it('#3754 review controls: record data and omitted data still earn the review door hint; content:null still earns none', async () => {
      const node = await seed('rh3729:review2', { role: 'review' });
      const client = createTestableMcpServer(auth());
      const withRecord = await client.callToolText('hadron_update_node', { urn: urnFor(node.loc), data: { k: 'v' } });
      expect(withRecord).toMatch(/^\[role_governed\]/);
      expect(withRecord).toContain('hadron_update_review');
      const omittedData = await client.callToolText('hadron_update_node', { urn: urnFor(node.loc), content: 'new body' });
      expect(omittedData).toMatch(/^\[role_governed\]/);
      expect(omittedData).toContain('hadron_update_review');
      const nullContent = await client.callToolText('hadron_update_node', { urn: urnFor(node.loc), content: null });
      expect(nullContent).toMatch(/^\[role_governed\]/);
      expect(nullContent).not.toContain('hadron_update_review');
    });

    it('missing target: data:null still reads as plain not-found (no new entity-existence signal)', async () => {
      const client = createTestableMcpServer(auth());
      const missing = urnFor('rh3729:missing');
      const text = await client.callToolText('hadron_update_node', { urn: missing, data: null });
      // #3754 item 3: the WHOLE refusal equals a non-null write's to the same missing URN, so any extra leaked text fails.
      const control = await client.callToolText('hadron_update_node', { urn: missing, content: 'x' });
      expect(text).toContain('Node not found');
      expect(text).toBe(control);
    });

    it('ungoverned target: data:null still clears the bag — the fix adds no new refusal', async () => {
      // `isRunnable: false` and no `role` is the ungoverned predicate this relies on: no governed kind applies, so no door is named
      // and nothing is refused. (It seeds an ungoverned row; it does not run a retirement workflow.)
      const node = await seed('rh3729:retired', { isRunnable: false, data: { stage: 3 } });
      const client = createTestableMcpServer(auth());
      const text = await client.callToolText('hadron_update_node', {
        urn: urnFor(node.loc),
        data: null,
      });
      expect(text).toContain('Node updated');
      const stored = await db.node.findUniqueOrThrow({ where: { id: node.id } });
      expect(stored.data ?? null).toBeNull();
    });
  });
});
