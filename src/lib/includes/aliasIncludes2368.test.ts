/** #2368: every include consumer follows the shared published-URN alias rules. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { recordUrnRename } from '../urnAlias.js';
import { spliceIncludes, BROKEN_INCLUDE_NOTICE } from './spliceIncludes.js';
import { assertIncludesWritable, syncDerivedIncludesEdges } from './writeIncludes.js';
import { assembleBootPrompt, type AssembleInput } from '../bootCompile/assemble.js';

let memory: { id: string; urn: string };
let source: { id: string; memoryId: string; loc: string };
let target: { id: string; memoryId: string; loc: string };
let input: AssembleInput;
let oldRef: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Alias', urn: 'alias2368.example' } });
  memory = await db.memory.create({ data: { name: 'System', urn: `${org.urn}:system`, class: 'system', organizationId: org.id } });
  const agent = await db.agent.create({ data: { name: 'Agent', urn: `${org.urn}:agent`, organizationId: org.id, visibility: 'ORGANIZATION', systemMemoryId: memory.id } });
  oldRef = `hrn:node:${memory.urn}:parts:target`;
  target = await db.node.create({ data: { memoryId: memory.id, loc: 'parts:target', name: 'Target', content: 'Target text' } });
  source = await db.node.create({ data: { memoryId: memory.id, loc: 'boot:source', name: 'Source', role: 'boot-prompt', content: `before {{> ${oldRef}}} after` } });
  input = { target: { kind: 'AGENT', agentId: agent.id }, installMemoryId: null, source: { nodeId: source.id, memoryId: memory.id }, recipient: { kind: 'org', orgId: org.id }, callerCanRead: async () => true };
});
async function renameMemory() {
  await db.$transaction(async tx => {
    const urn = 'alias2368.example:renamed';
    await recordUrnRename(tx, { entityType: 'MEMORY', entityId: memory.id, oldUrn: memory.urn, newUrn: urn });
    await tx.memory.update({ where: { id: memory.id }, data: { urn } });
  });
}
async function moveTarget() {
  await db.$transaction(async tx => {
    await recordUrnRename(tx, { entityType: 'NODE', entityId: target.id, oldUrn: oldRef, newUrn: `hrn:node:${memory.urn}:parts:moved` });
    await tx.node.update({ where: { id: target.id }, data: { loc: 'parts:moved' } });
  });
}
const text = () => `before {{> ${oldRef}}} after`;
const read = () => spliceIncludes(db, { memoryId: memory.id }, text(), source, { foreign: true });
const write = () => db.$transaction(async tx => {
  const tags = await assertIncludesWritable(tx, source, text(), [memory.id]);
  await syncDerivedIncludesEdges(tx, source, tags, [memory.id]);
  return tx.edge.findMany({ where: { sourceId: source.id, governedKind: 'INCLUDE' }, select: { targetId: true } });
});
for (const [name, change] of [['memory rename', renameMemory], ['published node move', moveTarget]] as const) {
  describe(name, () => {
    it('read follows the old published address', async () => { await change(); expect(await read()).toBe('before Target text after'); });
    it('write accepts the old address and derives the current target', async () => { await change(); expect(await write()).toEqual([{ targetId: target.id }]); });
    it('compile follows the old address and records the resolved node', async () => {
      await change(); const plan = await assembleBootPrompt(db, input);
      expect(plan.text).toBe('before Target text after');
      expect(plan.occurrences[1]).toMatchObject({ nodeId: target.id });
    });
  });
}
it('a missing target keeps the generic read notice', async () => {
  await db.node.delete({ where: { id: target.id } });
  expect(await read()).toBe(`before ${BROKEN_INCLUDE_NOTICE} after`);
});
