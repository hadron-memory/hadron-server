/**
 * #5109 — Node.specLint through the real resolvers: the findings carry the citation, rule, severity and sentence, and a
 * caller who cannot read the node never reaches the field (denied ≡ not found, the node gate).
 */
import { ApolloServer } from '@apollo/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const server = new ApolloServer<Context>({ typeDefs, resolvers });
afterAll(async () => { await server.stop(); });

let readerId: string, strangerId: string, memoryId: string;
const execute = async (query: string, variables: Record<string, unknown>, userId: string) => {
  const r = await server.executeOperation({ query, variables }, { contextValue: { db, userId, roles: [] } as Context });
  if (r.body.kind !== 'single') throw new Error('single result expected');
  return r.body.singleResult;
};
const FIELDS = 'citation rule severity message sentence line';
const read = (ref: string, userId = readerId) =>
  execute(`query($ref: ID!) { node(ref: $ref, raw: true) { id specLint { ${FIELDS} } } }`, { ref }, userId);

beforeEach(async () => {
  await cleanDb(db);
  const s = generateId().slice(-10);
  const org = await db.organization.create({ data: { name: 'Spec lint', urn: `speclint-${s}.test` } });
  readerId = (await db.user.create({ data: { handle: 'speclint-reader', roles: [] } })).id;
  strangerId = (await db.user.create({ data: { handle: 'speclint-stranger', roles: [] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: readerId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { name: 'Specs', urn: `${org.urn}:specs`, class: 'knowledge', organizationId: org.id } })).id;
});

const WHY = '## Why We Need This Rule';
const node = (loc: string, content: string | null, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { memoryId, loc, name: loc, content, ...extra } });

describe('#5109 Node.specLint', () => {
  it('a Rule with no Why fails, an empty Why fails, a one-line Why passes', async () => {
    const none = await node('cor:agt:100:03', '# Rule Spec: A\n\n## The Rule\n\nThe worker checks.\n', { role: 'spec.rule' });
    const empty = await node('cor:agt:100:04', `# Rule Spec: A\n\n${WHY}\n\n\n## Scenarios\n\nOne.\n`, { role: 'spec.rule' });
    const ok = await node('cor:agt:100:05', `# Rule Spec: A\n\n${WHY}\n\nA budget caps what one App spends in a day.\n`, { role: 'spec.rule' });
    expect((await read(none.id)).data?.node).toMatchObject({ specLint: [{ citation: 'cor:agt:100:03', rule: 'RULE_WHY_MISSING', severity: 'ERROR', sentence: null }] });
    expect((await read(empty.id)).data?.node).toMatchObject({ specLint: [{ citation: 'cor:agt:100:04', rule: 'RULE_WHY_EMPTY', severity: 'ERROR', line: 3 }] });
    expect((await read(ok.id)).data?.node).toMatchObject({ specLint: [] });
  });

  it('a restricting sentence warns and names itself; a because, or a link to a ruling, clears it', async () => {
    const bare = await node('cor:api:120:03', '# Feature Spec: L\n\nX is excluded from the list.\n', { role: 'spec.feature' });
    const because = await node('cor:api:120:04', '# Feature Spec: L\n\nX is excluded from the list because it is noisy.\n', { role: 'spec.feature' });
    const linked = await node('cor:api:120:05', '# Feature Spec: L\n\nX is excluded from the list ([[hrn:node:hadronmemory.com:rulings:0185|ruling 0185]]).\n', { role: 'spec.feature' });
    expect((await read(bare.id)).data?.node).toMatchObject({
      specLint: [{ citation: 'cor:api:120:03', rule: 'LIMIT_WITHOUT_REASON', severity: 'WARNING', sentence: 'X is excluded from the list.', line: 3 }],
    });
    expect((await read(because.id)).data?.node).toMatchObject({ specLint: [] });
    expect((await read(linked.id)).data?.node).toMatchObject({ specLint: [] });
  });

  it('a retired Rule and a node that is not a spec have no findings', async () => {
    const retired = await node('cor:agt:050:27', '# Rule Spec: A\n\nNever.\n', { role: 'spec.rule', tags: ['superseded'] });
    const other = await node('notes:todo', 'Never do this.');
    expect((await read(retired.id)).data?.node).toMatchObject({ specLint: [] });
    expect((await read(other.id)).data?.node).toMatchObject({ specLint: [] });
  });

  it('a caller who cannot read the node gets no node, so no findings (the node gate, byte-identical to a missing ref)', async () => {
    const n = await node('cor:agt:100:03', '# Rule Spec: A\n', { role: 'spec.rule' });
    const denied = await read(n.id, strangerId);
    const missing = await read(generateId(), strangerId);
    expect(denied.data?.node ?? null).toBeNull();
    expect(JSON.stringify(denied)).toBe(JSON.stringify(missing));
  });

  it('blind P3-4: text not loaded on the parent (content absent) is null, never a structural finding', async () => {
    const f = (resolvers as any).Node.specLint;
    expect(f({ loc: 'cor:agt:100:03', role: 'spec.rule' })).toBeNull();
    expect(f({ loc: 'cor:agt:100:03', role: 'spec.rule', content: null })).toEqual([]);
    expect(f({ loc: 'cor:agt:100:03', role: 'spec.rule', content: '# R\n' })).toEqual([expect.objectContaining({ rule: 'RULE_WHY_MISSING' })]);
  });

  it('blind P3-4: a list read (findNodes) hands specLint the same gate — an unreadable memory yields no nodes, a readable one findings', async () => {
    await node('cor:agt:100:03', '# Rule Spec: A\n\n## The Rule\n\nChecks.\n', { role: 'spec.rule' });
    const q = `query($m: ID!) { findNodes(mode: keyword, query: "Checks", filter: { memoryRefs: [$m] }) { hits { node { loc specLint { rule } } } } }`;
    const ok = await execute(q, { m: memoryId }, readerId);
    expect(ok.errors, JSON.stringify(ok.errors)).toBeUndefined();
    expect((ok.data as any).findNodes.hits[0].node).toMatchObject({ loc: 'cor:agt:100:03', specLint: [{ rule: 'RULE_WHY_MISSING' }] });
    const denied = await execute(q, { m: memoryId }, strangerId);
    expect(JSON.stringify(denied.data?.findNodes ?? denied.errors ?? null)).not.toContain('RULE_WHY_MISSING');
  });
});
