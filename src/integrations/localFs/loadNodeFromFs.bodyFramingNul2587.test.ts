/**
 * #2587: the shared body-framing fixture (v2) carries a NUL row. The codecs
 * agree on it (the #2391 suite reads and writes every row, this one included),
 * and the server's store write refuses it, so a later codec change cannot drift
 * between server and CLI unnoticed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import fixture from './markdownBodyFraming.fixture.json' with { type: 'json' };

vi.mock('../github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

type Case = { name: string; kind: string; stored?: string | null; store?: string };
const cases = fixture.cases as Case[];
const refused = cases.filter((c) => c.store === 'refused');

describe('#2587 NUL row in the shared body-framing fixture', () => {
  it('is version v2 and holds a roundtrip row whose body contains a NUL', () => {
    expect(fixture.version).toBe('markdown-body-framing-v2');
    const nul = cases.find((c) => c.name === 'nul-in-body');
    expect(nul).toMatchObject({ kind: 'roundtrip', stored: 'A\u0000B', store: 'refused' });
  });

  describe('the server write path refuses every store-refused row', () => {
    let ctx: Context;
    let memoryId: string;
    beforeEach(async () => {
      await cleanDb(db);
      const org = await db.organization.create({ data: { id: generateId(), name: 'org', urn: 'nul2587.test' } });
      const user = await db.user.create({ data: { githubId: 258701, githubUsername: 'u2587' } });
      await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
      ctx = { db, userId: user.id, roles: [] };
      memoryId = (await (resolvers.Mutation as any).createMemory({}, { orgId: org.id, name: 'framing' }, ctx)).id;
    });

    it.each(refused.map((c) => [c.name, c] as const))('%s: createNode rejects and leaves no node', async (_name, c) => {
      await expect(
        (resolvers.Mutation as any).createNode({}, { input: { memoryId, loc: 'nul', name: 'nul', content: c.stored } }, ctx),
      ).rejects.toThrow();
      expect(await db.node.count({ where: { memoryId, loc: 'nul' } })).toBe(0);
    });

    it('an ordinary row from the same fixture is accepted (negative control)', async () => {
      const ok = cases.find((c) => c.kind === 'roundtrip' && c.store === undefined && typeof c.stored === 'string')!;
      const node = await (resolvers.Mutation as any).createNode(
        {}, { input: { memoryId, loc: 'ok', name: 'ok', content: ok.stored } }, ctx);
      expect(node.content).toBe(ok.stored);
    });
  });
});
