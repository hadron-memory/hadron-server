/**
 * #2046 (S9-4) — the compile's writer option `forceRevision`: an identical-content
 * save still leaves one revision, but only inside withCompileWrite.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, withCompileWrite } from '../bootPrompt.js';
import { writeNodeCore } from '../../api/graphql/schema/resolvers.mutation.node.js';
import type { Context } from '../../api/graphql/context.js';

let memoryId: string;
let ctx: Context;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'fr-org', urn: 'fr-org' } });
  const user = await db.user.create({ data: { id: generateId(), email: `${generateId()}@fr.test`, name: 'U' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: 'fr-org:sys', organizationId: org.id } })).id;
  ctx = { db, userId: user.id, roles: [], clientId: `user:${user.id}` } as unknown as Context;
});

const revCount = (nodeId: string) => db.nodeRevision.count({ where: { nodeId } });
const resave = (loc: string, force: boolean) =>
  writeNodeCore({ memoryId, loc, name: 'N', content: 'same' } as never, ctx, 'update', { forceRevision: force });

describe('#2046 S9-4 — forceRevision', () => {
  it('inside the compile an identical save leaves one more revision and advances revSeq', async () => {
    const node = await withCompileWrite(() => db.node.create({
      data: { id: generateId(), memoryId, loc: 'c', name: 'N', content: 'same', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
    }));
    const before = { revs: await revCount(node.id), seq: node.revSeq };
    await withCompileWrite(() => resave('c', true));
    expect(await revCount(node.id)).toBe(before.revs + 1);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq).toBe(before.seq + 1);
  });

  it('inside the compile, without the option, an identical save is still a no-op', async () => {
    const node = await withCompileWrite(() => db.node.create({
      data: { id: generateId(), memoryId, loc: 'c', name: 'N', content: 'same', role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE },
    }));
    const before = await revCount(node.id);
    await withCompileWrite(() => resave('c', false));
    expect(await revCount(node.id)).toBe(before);
  });

  it('outside the compile the option is ignored', async () => {
    const node = await db.node.create({ data: { id: generateId(), memoryId, loc: 'plain', name: 'N', content: 'same' } });
    const before = await revCount(node.id);
    await resave('plain', true);
    expect(await revCount(node.id)).toBe(before);
  });
});
