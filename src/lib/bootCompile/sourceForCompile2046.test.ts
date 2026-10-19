import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { sourceForCompile } from './sourceForCompile.js';

let ownMemory: string;
let installMemory: string;
const workerId = 'immutable-worker-id';
const put = (memoryId: string, loc: string, extra = {}) => db.node.create({ data: {
  id: generateId(), memoryId, loc, name: 'Synthetic source', content: '{{worker.name}}', role: 'boot-prompt', ...extra,
} });
const select = (target: Parameters<typeof sourceForCompile>[1]) => db.$transaction((tx) => sourceForCompile(tx, target));
beforeEach(async () => {
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db);
  ownMemory = graph.id;
  installMemory = (await db.memory.create({ data: { id: generateId(), name: 'Install fixture', class: 'group', urn: `fixture:${generateId()}`, organizationId: org.id } })).id;
});

describe('#2046 exact-address source selection (internal, no compile entry)', () => {
  it('selects only the Agent own address, preserving raw text and revision identity', async () => {
    await put(ownMemory, 'other:boot', { content: 'not selected' });
    await put(installMemory, 'boot:source', { content: 'not inherited' });
    const source = await put(ownMemory, 'boot:source', { revSeq: 3 });
    expect(await select({ kind: 'AGENT', agentMemoryId: ownMemory })).toMatchObject({ id: source.id, revSeq: 3, content: '{{worker.name}}' });
  });

  it('does not role-scan or follow a moved source or base memory', async () => {
    await put(ownMemory, 'moved:source');
    await put(installMemory, 'boot:source');
    await expect(select({ kind: 'AGENT', agentMemoryId: ownMemory })).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_NO_SOURCE' } });
  });

  it('uses a live App own source before the Agent source', async () => {
    await put(ownMemory, 'boot:source');
    const app = await put(installMemory, 'boot:source');
    expect(await select({ kind: 'APP_AGENT', agentMemoryId: ownMemory, installMemoryId: installMemory })).toMatchObject({ id: app.id });
  });

  it.each(['absent', 'deleted', 'no-install'] as const)('R83 App %s source falls back to exact Agent source', async (state) => {
    const agent = await put(ownMemory, 'boot:source');
    if (state === 'deleted') await put(installMemory, 'boot:source', { deletedAt: new Date(), role: 'notes' });
    expect(await select({ kind: 'APP_AGENT', agentMemoryId: ownMemory, installMemoryId: state === 'no-install' ? null : installMemory })).toMatchObject({ id: agent.id });
  });

  it.each([{ role: 'notes' }, { role: null }, { nodeType: 'compiled-boot-prompt' }])('live invalid App occupant refuses without fallback (%j)', async (extra) => {
    await put(ownMemory, 'boot:source');
    await put(installMemory, 'boot:source', extra);
    await expect(select({ kind: 'APP_AGENT', agentMemoryId: ownMemory, installMemoryId: installMemory })).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_SOURCE_INVALID' } });
  });

  it('selects only the requested worker own address, allowing a boot role subfamily', async () => {
    await put(installMemory, 'boot:source');
    await put(installMemory, 'boot:workers:other:source');
    const source = await put(installMemory, `boot:workers:${workerId}:source`, { role: 'boot-prompt.worker' });
    expect(await select({ kind: 'WORKER', workerId, installMemoryId: installMemory })).toMatchObject({ id: source.id });
  });

  it.each([false, true])('worker absent/deleted own source never falls back (deleted=%s)', async (deleted) => {
    await put(installMemory, 'boot:source');
    await put(installMemory, 'boot:workers:other:source');
    if (deleted) await put(installMemory, `boot:workers:${workerId}:source`, { deletedAt: new Date() });
    await expect(select({ kind: 'WORKER', workerId, installMemoryId: installMemory })).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_NO_SOURCE' } });
  });

  it('does not fall back from a deleted Agent source or a worker without an install', async () => {
    await put(ownMemory, 'boot:source', { deletedAt: new Date() });
    await put(installMemory, 'boot:source');
    await expect(select({ kind: 'AGENT', agentMemoryId: ownMemory })).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_NO_SOURCE' } });
    await expect(select({ kind: 'WORKER', workerId, installMemoryId: null })).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_NO_SOURCE' } });
  });

  it.each(['AGENT', 'WORKER'] as const)('a live compiled source is invalid for %s too', async (kind) => {
    if (kind === 'AGENT') {
      await put(ownMemory, 'boot:source', { nodeType: 'compiled-boot-prompt' });
      await expect(select({ kind, agentMemoryId: ownMemory })).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_SOURCE_INVALID' } });
    } else {
      await put(installMemory, `boot:workers:${workerId}:source`, { nodeType: 'compiled-boot-prompt' });
      await expect(select({ kind, workerId, installMemoryId: installMemory })).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_SOURCE_INVALID' } });
    }
  });

  it('refuses source/output memory-loc collision rather than returning an overwrite candidate', async () => {
    await put(ownMemory, 'boot:source');
    await expect(db.$transaction((tx) => sourceForCompile(tx, { kind: 'AGENT', agentMemoryId: ownMemory }, {
      memoryId: ownMemory, loc: 'boot:source',
    }))).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
  });
});
