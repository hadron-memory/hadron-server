/**
 * #1707 — a worker's model family (cor:agt:060:04): the derivation from a
 * session's reported model and tool, the explicit `family` argument on
 * startSession and hadron_start_session, and `Worker.family`, which follows
 * the binding — set while a session is live, gone once it ends.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { deriveFamily, normalizeFamily } from './family.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const WorkerField = (resolvers as any).Worker;

describe('deriveFamily (Proposed, cor:agt:060:04): llmModel first, then tool, else none', () => {
  it('a GLM session in Claude Code is glm, not claude (#1707)', () => {
    expect(deriveFamily({ tool: 'claude-code', llmModel: 'glm-4.6' })).toBe('glm');
    expect(deriveFamily({ tool: 'claude-code', llmModel: 'GLM-4.5-Air' })).toBe('glm');
  });

  it('Claude, Codex and Gemini model ids classify by their model', () => {
    expect(deriveFamily({ tool: 'claude-code', llmModel: 'claude-opus-5-5' })).toBe('claude');
    expect(deriveFamily({ llmModel: 'sonnet' })).toBe('claude');
    expect(deriveFamily({ tool: 'codex', llmModel: 'gpt-5-codex' })).toBe('codex');
    expect(deriveFamily({ llmModel: 'o3' })).toBe('codex');
    expect(deriveFamily({ llmModel: 'o4-mini' })).toBe('codex');
    expect(deriveFamily({ llmModel: 'gemini-2.5-pro' })).toBe('gemini');
  });

  it('claude-code alone classifies NOTHING: GLM runs inside it too', () => {
    expect(deriveFamily({ tool: 'claude-code' })).toBeNull();
  });

  it('a tool that runs one family classifies when no model is reported', () => {
    expect(deriveFamily({ tool: 'codex' })).toBe('codex');
    expect(deriveFamily({ tool: 'Codex-CLI' })).toBe('codex');
  });

  it('an unrecognized model is not guessed from the tool', () => {
    expect(deriveFamily({ tool: 'codex', llmModel: 'mystery-7b' })).toBeNull();
    expect(deriveFamily({ tool: 'claude-code', llmModel: 'kimi-k2' })).toBeNull();
    expect(deriveFamily({})).toBeNull();
    // A model id that only CONTAINS "o3" inside a word is not an o-series model.
    expect(deriveFamily({ llmModel: 'foo3bar' })).toBeNull();
  });

  it('normalizeFamily lowercases a token and refuses anything else', () => {
    expect(normalizeFamily(' Claude ')).toBe('claude');
    expect(normalizeFamily('glm-4')).toBe('glm-4');
    expect(normalizeFamily('not a family')).toBeNull();
    expect(normalizeFamily('-x')).toBeNull();
  });
});

describe('startSession family, and Worker.family following the binding', () => {
  let app: { id: string };
  let mia: { id: string };
  let worker: { id: string; appId: string };

  const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });
  const familyOf = () => WorkerField.family(worker, {}, ctx(mia.id), { operation: { operation: 'mutation' } });

  beforeEach(async () => {
    await cleanDb(db);
    const n = Math.floor(Math.random() * 1_000_000);
    const org = await db.organization.create({ data: { name: 'Fam', urn: `fam-${n}.example` } });
    const admin = await db.user.create({ data: { githubId: 800_000 + n, githubUsername: `fm-admin-${n}`, roles: ['READER'] } });
    mia = await db.user.create({ data: { githubId: 900_000 + n, githubUsername: `fm-mia-${n}`, roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
    const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
    app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `fam-${n}.example:team` }, select: { id: true } });
    await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
    worker = await db.worker.create({ data: { appId: app.id, agentId: agent.id, name: 'Kit', slug: 'kit' }, select: { id: true, appId: true } });
  });

  const start = (input: Record<string, unknown>) =>
    M.startSession({}, { input: { id: generateId(), workerRef: worker.id, appRef: app.id, ...input } }, ctx(mia.id));

  it('an explicit family is stored, normalized; Worker.family reads it while bound', async () => {
    const s = await start({ family: 'Codex', tool: 'claude-code', llmModel: 'claude-opus-5-5' });
    expect(s.family).toBe('codex'); // explicit wins over the derivation
    expect(await familyOf()).toBe('codex');
  });

  it('omitted, it is derived: a GLM session in Claude Code binds as glm', async () => {
    const s = await start({ tool: 'claude-code', llmModel: 'glm-4.6' });
    expect(s.family).toBe('glm');
    expect(await familyOf()).toBe('glm');
  });

  it('a session nothing classifies gets no family', async () => {
    const s = await start({ tool: 'claude-code' });
    expect(s.family).toBeNull();
    expect(await familyOf()).toBeNull();
  });

  it('a family in no token shape is refused, and nothing is written', async () => {
    await expect(start({ family: 'Claude Opus' })).rejects.toSatisfy(
      (e: unknown) => e instanceof GraphQLError && e.extensions?.code === 'BAD_USER_INPUT',
    );
    expect(await db.session.count({ where: { workerId: worker.id } })).toBe(0);
  });

  it('cleared on unbind: once the session ends, Worker.family is null', async () => {
    const s = await start({ family: 'claude' });
    expect(await familyOf()).toBe('claude');
    await M.endSession({}, { id: s.id }, ctx(mia.id));
    expect(await familyOf()).toBeNull();
  });

  it('a rebind with another family replaces it (the newest live session is the binding)', async () => {
    await start({ family: 'claude' });
    await start({ family: 'codex', force: true });
    expect(await familyOf()).toBe('codex');
  });

  it('the database refuses a family in no token shape (chk_sessions_family)', async () => {
    await expect(db.session.create({ data: { id: generateId(), family: 'Claude' } })).rejects.toThrow(/chk_sessions_family/);
  });
});
