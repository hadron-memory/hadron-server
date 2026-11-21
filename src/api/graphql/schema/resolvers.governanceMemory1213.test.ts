/** #1213 S2: signal attempts join the memory handshake; ordinary content-only writes do not. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import type { Context } from './resolvers.js';
import type { Prisma } from '../../../generated/prisma/index.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let memoryId: string;
let userId: string;
let nodeId: string;
const ctx = (): Context => ({ db, roles: ['ADMIN'], userId, clientId: `user:${userId}` });
beforeEach(async () => {
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db);
  memoryId = graph.id;
  const user = await db.user.create({ data: { id: generateId(), githubId: 121301, githubUsername: 'gov1213', roles: ['ADMIN'] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'OWNER' } });
  nodeId = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'ordinary', name: 'ordinary', content: 'before' } })).id;
});

async function observedWrite(patch: Record<string, unknown>, ownsKind?: 'review', mode: 'create' | 'update' = 'update') {
  const [{ key }] = await db.$queryRaw<Array<{ key: number }>>`SELECT hashtext(${'channel-host:' + memoryId}) AS key`;
  const acquisitions: number[] = [];
  await db.$transaction(async tx => {
    const observed = new Proxy(tx, { get(target, prop, receiver) {
      if (prop !== '$executeRaw') return Reflect.get(target, prop, receiver);
      return async (sql: TemplateStringsArray, ...values: unknown[]) => {
        if (/pg_advisory_xact_lock/.test(sql.join('')) && values.length === 1 && Number(values[0]) === key) acquisitions.push(key);
        return tx.$executeRaw(sql, ...values);
      };
    } });
    await writeNodeCore({ memoryId, loc: mode === 'create' ? 'new-node' : 'ordinary', name: 'ordinary', content: 'after', ...patch } as Parameters<typeof writeNodeCore>[0],
      ctx(), mode, { authoring: { kind: 'carry' }, ownsKind,
        ...(mode === 'update' ? { targetNodeId: nodeId } : {}),
        transaction: { tx: observed as Prisma.TransactionClient, pooledDb: db, afterCommit: () => {} },
      });
  });
  return acquisitions;
}

describe('#1213 input-triggered writer participation', () => {
  it.each([
    ['role null', { role: null }],
    ['role whitespace clearing', { role: '  ' }],
    ['runnable false', { isRunnable: false }],
    ['runnable null', { isRunnable: null }],
  ])('%s acquires the own-memory key even without inline edges', async (_label, patch) => {
    expect(await observedWrite(patch as Record<string, unknown>)).toHaveLength(1);
  });
  it('a kind-door content-only update joins even with omitted signals', async () => {
    expect(await observedWrite({}, 'review')).toHaveLength(1);
  });
  it('a create joins even with omitted signals', async () => {
    expect(await observedWrite({}, undefined, 'create')).toHaveLength(1);
  });
  it('an ordinary content-only update adds no governance key', async () => {
    expect(await observedWrite({})).toEqual([]);
  });
});
