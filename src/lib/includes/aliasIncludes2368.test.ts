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
    await recordUrnRename(tx, { entityType: 'NODE', entityId: target.id, oldUrn: oldRef.slice(9), newUrn: `${memory.urn}:parts:moved` });
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

async function unavailable() {
  expect(await read()).toBe(`before ${BROKEN_INCLUDE_NOTICE} after`);
  await expect(write()).rejects.toMatchObject({ extensions: { code: 'INCLUDE_TARGET_UNAVAILABLE' } });
  await expect(assembleBootPrompt(db, input)).rejects.toMatchObject({ code: 'BOOT_PROMPT_INCLUDE_UNAVAILABLE' });
}
describe('alias selection never adds authority or changes settings', () => {
  it('a live node at the old address beats the moved-node alias', async () => {
    await moveTarget();
    const replacement = await db.node.create({ data: { memoryId: memory.id, loc: 'parts:target', name: 'Replacement', content: 'Replacement text' } });
    expect(await read()).toBe('before Replacement text after');
    expect(await write()).toEqual([{ targetId: replacement.id }]);
    expect((await assembleBootPrompt(db, input)).occurrences[1]).toMatchObject({ nodeId: replacement.id });
  });
  it('reusing a memory prefix with a live node beats the historical memory', async () => {
    await renameMemory();
    const other = await db.memory.create({ data: { name: 'New holder', urn: memory.urn, class: 'knowledge', organizationId: (await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).organizationId } });
    await db.node.create({ data: { memoryId: other.id, loc: target.loc, name: 'New target', content: 'New holder' } });
    expect(await spliceIncludes(db, { memoryId: { in: [memory.id, other.id] } }, text(), source, { foreign: true })).toBe('before New holder after');
    await expect(db.$transaction(tx => assertIncludesWritable(tx, source, text(), [memory.id]))).rejects.toMatchObject({ extensions: { code: 'INCLUDE_TARGET_UNAVAILABLE' } });
  });
  it('ambiguous live node aliases refuse rather than choosing', async () => {
    await moveTarget();
    const second = await db.node.create({ data: { memoryId: memory.id, loc: 'parts:second', name: 'Second', content: 'Second text' } });
    await recordUrnRename(db, { entityType: 'NODE', entityId: second.id, oldUrn: oldRef.slice(9), newUrn: `${memory.urn}:parts:second` });
    await unavailable();
  });
  it('an aliased deleted node is unavailable', async () => {
    await moveTarget(); await db.node.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    await unavailable();
  });
  it('an aliased deleted memory is unavailable', async () => {
    await renameMemory(); await db.memory.update({ where: { id: memory.id }, data: { deletedAt: new Date() } });
    expect(await read()).toBe(`before ${BROKEN_INCLUDE_NOTICE} after`);
    await expect(write()).rejects.toMatchObject({ extensions: { code: 'INCLUDE_TARGET_UNAVAILABLE' } });
  });
  it('the resolved target still passes through the reader and writer access filters', async () => {
    await renameMemory();
    expect(await spliceIncludes(db, { memoryId: { in: [] } }, text(), source, { foreign: true })).toBe(`before ${BROKEN_INCLUDE_NOTICE} after`);
    await expect(db.$transaction(tx => assertIncludesWritable(tx, source, text(), []))).rejects.toMatchObject({ extensions: { code: 'INCLUDE_TARGET_UNAVAILABLE' } });
  });
  it('a moved target with rev=1 serves that revision on read and compile', async () => {
    await moveTarget();
    const content = `{{> ${oldRef} rev=1}}`;
    expect(await spliceIncludes(db, { memoryId: memory.id }, content, source, { foreign: true })).toBe('Target text');
    await db.node.update({ where: { id: source.id }, data: { content } });
    const plan = await assembleBootPrompt(db, input);
    expect(plan.text).toBe('Target text');
    expect(plan.occurrences[1]).toMatchObject({ nodeId: target.id, revNo: 1 });
  });
  it('an alias cannot bypass an approved selector when no revision qualifies', async () => {
    await moveTarget(); const content = `{{> ${oldRef} approved}}`;
    expect(await spliceIncludes(db, { memoryId: memory.id }, content, source, { foreign: true })).toBe(BROKEN_INCLUDE_NOTICE);
    await db.node.update({ where: { id: source.id }, data: { content } });
    await expect(assembleBootPrompt(db, input)).rejects.toMatchObject({ code: 'BOOT_PROMPT_INCLUDE_REVISION_UNAVAILABLE' });
  });
  it('a renamed prefix followed by a node move still reaches the same identity', async () => {
    await renameMemory();
    const current = 'alias2368.example:renamed';
    await recordUrnRename(db, { entityType: 'NODE', entityId: target.id, oldUrn: `${current}:parts:target`, newUrn: `${current}:parts:moved` });
    await db.node.update({ where: { id: target.id }, data: { loc: 'parts:moved' } });
    expect(await read()).toBe('before Target text after');
    expect(await write()).toEqual([{ targetId: target.id }]);
    expect((await assembleBootPrompt(db, input)).text).toBe('before Target text after');
  });
});
