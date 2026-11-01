import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import * as rootFs from '../../../integrations/localFs/saveNodeToFs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
afterEach(() => vi.restoreAllMocks());

const M = resolvers.Mutation as any;
let org: any, app: any, agent: any, admin: any, outsider: any;
const ctx = (userId: string): Context => ({ db, userId, roles: [] });
const graphEntries = () => readdirSync(process.env.GRAPHS_PATH!).length;

/** Assert a refused create leaves no graph residue, with `interleave` run between the snapshots. */
async function refusedWithoutResidue(create: () => Promise<unknown>, interleave: () => void = () => {}) {
  const entries = graphEntries();
  interleave();
  await expect(create()).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  expect(await db.memory.count()).toBe(0);
  expect(await db.node.count()).toBe(0);
  expect(graphEntries()).toBe(entries);
}

type Door = { label: string; create: (name: string, who?: string) => Promise<any> };
const doors = (): Door[] => [
  { label: 'createMemory', create: (name, who = admin.id) => M.createMemory({}, { orgId: org.id, name }, ctx(who)) },
  { label: 'createAppMemory', create: (name, who = admin.id) => M.createAppMemory({}, { appRef: app.id, name }, ctx(who)) },
  { label: 'createMemoryInApp', create: (name, who = admin.id) => M.createMemoryInApp(
    {}, { appRef: app.id, agentRef: agent.id, memoryClass: 'app', name }, ctx(who)) },
];

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'org', urn: 'rootloc2730.test' } });
  agent = await db.agent.create({ data: { id: generateId(), name: 'coach', urn: `${org.urn}:coach`, organizationId: org.id } });
  const seeded = await createDbAppWithKey(db, 'coach-app', org.id);
  app = seeded.app;
  await createDbAppAgent(db, app.id, agent.id);
  admin = await db.user.create({ data: { githubId: 273001, githubUsername: 'admin2730' } });
  outsider = await db.user.create({ data: { githubId: 273002, githubUsername: 'outsider2730' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await createDbAppMember(db, app.id, admin.id, 'owner');
});

const unprojectable: [string, string][] = [
  ['a trailing colon', 'abc:'],
  ['a 300-character atom', 'x'.repeat(300)],
  ['a 256-byte atom', 'x'.repeat(256)],
  ['a multibyte atom over 255 bytes', 'é'.repeat(128)],
  ['a long atom after a legal one', `ok:${'y'.repeat(256)}`],
  ['a NUL', 'a\0b'],
  ['a slash', 'a/b'],
];
const admitted: [string, string][] = [
  ['spaces', 'Has Space'],
  ['unicode', 'ünï notes'],
  ['an internal empty atom', 'a::b'],
  ['a 255-byte atom', 'z'.repeat(255)],
  ['a multibyte 253-byte atom', 'a' + 'é'.repeat(126)],
];

for (const door of ['createMemory', 'createAppMemory', 'createMemoryInApp']) {
  describe(`#2730 ${door} root loc`, () => {
    const d = () => doors().find(x => x.label === door)!;
    for (const [label, name] of unprojectable) {
      it(`refuses ${label} as BAD_USER_INPUT and leaves no residue`, async () => {
        await refusedWithoutResidue(() => d().create(name));
      });
    }
    for (const [label, name] of admitted) {
      it(`still creates a memory and root for ${label}`, async () => {
        const memory = await d().create(name);
        expect(await db.node.findMany({ where: { memoryId: memory.id } })).toMatchObject([{ loc: name }]);
      });
    }
    it('#2796 an entry another worker adds to the shared run root between the snapshots is not residue', async () => {
      // The run's graph root is shared by every worker (#1951); simulate a concurrent file writing a node.
      const other = join(process.env.GRAPHS_PATH!, `other-worker-2796-${generateId()}`);
      try {
        await refusedWithoutResidue(() => d().create('abc:'), () => mkdirSync(other));
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
    it('keeps the authorization refusal ahead of the name refusal', async () => {
      const code = await d().create('abc:', outsider.id).catch(e => e.extensions?.code);
      expect(code).not.toBe('BAD_USER_INPUT');
      expect(code).toBeDefined();
      expect(await db.memory.count()).toBe(0);
    });
    it('still reports a non-input filesystem fault as a server fault', async () => {
      vi.spyOn(rootFs, 'saveNodeToFs').mockResolvedValue({ error: 'injected root failure' });
      const err = await d().create('Fine name').catch(e => e);
      expect(err.message).toContain('injected root failure');
      expect(err.extensions?.code).not.toBe('BAD_USER_INPUT');
    });
  });
}

describe('#2730 MCP delegates', () => {
  const auth = () => ({ userId: admin.id, roles: [] as any[], clientId: `user:${admin.id}` });
  it('hadron_create_memory refuses an unprojectable name with the input message', async () => {
    const text = await createTestableMcpServer(auth()).callToolText('hadron_create_memory', { name: 'abc:', org: org.id });
    expect(text).toMatch(/^Error: .*loc|segment|empty/i);
    expect(text).not.toMatch(/internal/i);
    expect(await db.memory.count()).toBe(0);
  });
  it('hadron_create_app_memory refuses an unprojectable name with the input message', async () => {
    const text = await createTestableMcpServer(auth()).callToolText('hadron_create_app_memory', { app: app.id, name: 'x'.repeat(300) });
    expect(text).not.toMatch(/internal/i);
    expect(text).toMatch(/^Error: /);
    expect(await db.memory.count()).toBe(0);
  });
});
