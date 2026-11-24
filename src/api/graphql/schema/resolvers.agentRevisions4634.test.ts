/**
 * #4634 F2 — `agentRevisions` reads the Agent's published pin and its revision rows in ONE snapshot.
 *
 * Before: the pin came from one statement and the rows from a later one, so a publish of B plus a delete of A
 * committing between them showed the pin on A against rows that no longer held A: a list with NO published
 * revision, a state that never existed (cor:dmo:050:23 keeps the pin off a deleted revision on the write side).
 * The interleaving is forced, not raced: the wrapped list function commits the publish and the delete on another
 * connection exactly where the second statement used to run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

// Runs once, just before the revision rows are read: the window between the pin read and the row read.
const hook: { beforeRows: (() => Promise<void>) | null } = { beforeRows: null };
vi.mock('../../../lib/agentRevisions.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../lib/agentRevisions.js')>();
  return {
    ...orig,
    listAgentRevisions: async (...args: Parameters<typeof orig.listAgentRevisions>) => {
      const run = hook.beforeRows;
      hook.beforeRows = null;
      if (run) await run();
      return orig.listAgentRevisions(...args);
    },
  };
});

let manager: { id: string };
let agent: { id: string; systemMemoryId: string | null };
const ctx = (): Context => ({ db, roles: ['READER'], userId: manager.id });
const save = () => resolvers.Mutation.createRevision({}, { agentRef: agent.id }, ctx());
const publish = (loc: string) => resolvers.Mutation.publishRevision({}, { agentRef: agent.id, revisionLoc: loc }, ctx());
const del = (loc: string) => resolvers.Mutation.deleteAgentRevision({}, { agentRef: agent.id, revisionLoc: loc }, ctx());
const list = () => resolvers.Query.agentRevisions({}, { agentRef: agent.id }, ctx());

beforeEach(async () => {
  hook.beforeRows = null;
  await cleanDb(db);
  manager = await db.user.create({ data: { githubId: 8841, githubUsername: 'rev4634-mgr', roles: ['READER'] } });
  const org = await db.organization.create({ data: { id: generateId(), name: 'rev4634', urn: 'rev4634' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await resolvers.Mutation.createAgent({}, { orgRef: org.id, name: 'agent-4634', visibility: 'PERSONAL' }, ctx());
});

describe('#4634 F2: agentRevisions pin and rows are one snapshot', () => {
  it('a publish of B and a delete of A between the pin read and the row read never show a list with no published revision', async () => {
    await save(); await save();
    await publish('revisions:rev-1');
    hook.beforeRows = async () => {
      await publish('revisions:rev-2');
      await del('revisions:rev-1');
    };
    const r = await list();
    expect(hook.beforeRows).toBeNull(); // the interleaving really ran
    const published = r.revisions.filter((x: { published: boolean }) => x.published);
    expect(published).toHaveLength(1);
    // Whichever state was seen, the pin and the rows agree: the published row is a listed row.
    expect(r.revisions.map((x: { revisionLoc: string }) => x.revisionLoc)).toContain(published[0].revisionLoc);
    // The committed truth afterwards is the post-publish state, read in a later request.
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).publishedRevisionLoc).toBe('revisions:rev-2');
    const after = await list();
    expect(after.revisions.map((x: { revisionLoc: string; published: boolean }) => [x.revisionLoc, x.published])).toEqual([['revisions:rev-2', true]]);
  });
});
