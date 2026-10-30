/**
 * #2736 (Holger R2, cor:agt:040:03): a bind's served-prompt record of an empty, ended binding is not a reference to
 * the miscast worker, and goes with the stint. A session that did work still blocks the repair, record or not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));
const M = resolvers.Mutation as any;
let ctx: Context;
let appId: string;
let agentId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Repair', urn: 'repair2736.com' } });
  const user = await db.user.create({ data: { id: generateId(), githubId: 273600, githubUsername: 'repair2736' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  ctx = { db, userId: user.id, roles: ['READER'] };
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Repair role' }, ctx)).id;
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Repair team', urn: `${org.urn}:team` } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId } });
});
afterEach(() => sessionKeyCache.clear());

const remove = (workerRef: string) => M.deleteWorker({}, { workerRef, confirmNoExternalAttribution: true }, ctx);

/** A cast, bound, ended and released worker whose bind was recorded, as a serving deployment writes it. */
async function boundWorker() {
  const worker = await M.castWorker({}, { appRef: appId, agentRef: agentId, name: 'Miscast' }, ctx);
  const session = await M.startSession({}, { input: { id: generateId(), appRef: appId, workerRef: worker.id, tool: 'test' } }, ctx);
  await M.endSession({}, { id: session.id }, ctx);
  await M.releaseWorker({}, { workerRef: worker.id }, ctx);
  const record = await db.servedPrompt.create({
    data: {
      kind: 'BIND', sessionId: session.id, workerId: worker.id, appId, agentId, pointerLevel: 'AGENT',
      compiledNodeId: generateId(), servedRevSeq: 3, provenanceRevSeq: 2, compiledContentHash: 'h',
    } as never,
  });
  return { worker, session, record };
}
const recordsNaming = (workerId: string, sessionId: string) => db.servedPrompt.count({ where: { OR: [{ workerId }, { sessionId }] } });

describe('#2736 empty-stint repair and the served-prompt record', () => {
  it('a. repairs a worker whose only reference is its bind record, and no record names it afterwards', async () => {
    const { worker, session } = await boundWorker();
    expect(await recordsNaming(worker.id, session.id)).toBe(1);
    expect(await remove(worker.id)).toBe(true);
    expect(await db.worker.findUnique({ where: { id: worker.id } })).toBeNull();
    expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await recordsNaming(worker.id, session.id)).toBe(0);
  });

  it('b. a session with an outcome still refuses WORKER_IN_USE, and its record stays', async () => {
    const { worker, session } = await boundWorker();
    await db.session.update({ where: { id: session.id }, data: { outcome: 1 } });
    await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
    expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
    expect(await recordsNaming(worker.id, session.id)).toBe(1);
  });

  it('c. an open (unended) binding with a record still refuses, and its record stays', async () => {
    const { worker, session } = await boundWorker();
    await db.session.update({ where: { id: session.id }, data: { endedAt: null } });
    await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
    expect(await recordsNaming(worker.id, session.id)).toBe(1);
  });

  it('d. another reference besides the record still refuses, and the record stays', async () => {
    const { worker, session } = await boundWorker();
    await db.node.create({ data: { id: generateId(), memoryId: (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).systemMemoryId!, loc: 'work', name: 'Work', createdByWorkerId: worker.id } });
    await expect(remove(worker.id)).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
    expect(await recordsNaming(worker.id, session.id)).toBe(1);
  });

  it('e. the record of ANOTHER worker is untouched by this repair', async () => {
    const mine = await boundWorker();
    const other = await M.castWorker({}, { appRef: appId, agentRef: agentId, name: 'Other' }, ctx);
    const otherSession = await M.startSession({}, { input: { id: generateId(), appRef: appId, workerRef: other.id, tool: 'test' } }, ctx);
    await db.servedPrompt.create({
      data: {
        kind: 'BIND', sessionId: otherSession.id, workerId: other.id, appId, agentId, pointerLevel: 'AGENT',
        compiledNodeId: generateId(), servedRevSeq: 3, provenanceRevSeq: 2, compiledContentHash: 'h',
      } as never,
    });
    expect(await remove(mine.worker.id)).toBe(true);
    expect(await recordsNaming(other.id, otherSession.id)).toBe(1);
  });

  it('f. the record stays immutable: a direct delete while its session exists is still refused', async () => {
    const { record } = await boundWorker();
    await expect(db.servedPrompt.delete({ where: { id: record.id } })).rejects.toThrow(/go only with their owner/);
  });
});
