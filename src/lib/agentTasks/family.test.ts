import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1707 — a worker's model family (cor:agt:060:04): the derivation from a
 * session's reported model and tool, the explicit `family` argument on
 * startSession and hadron_start_session, and `Worker.family`, which follows
 * the binding — set while a session is live, gone once it ends.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { deriveFamily, normalizeFamily } from './family.js';
import { backfillSessionFamilies } from './familyBackfill.js';

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

  it('#2191 canonicalizes provider aliases and preserves custom family identity', () => {
    expect(normalizeFamily(' AnTHropic ')).toBe('claude');
    expect(normalizeFamily(' OPENAI ')).toBe('codex');
    expect(normalizeFamily(' Private.Model-7 ')).toBe('private.model-7');
    expect(normalizeFamily('claude-opus')).toBe('claude-opus');
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
    worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Kit', slug: 'kit' }, select: { id: true, appId: true } });
  });

  const start = (input: Record<string, unknown>) =>
    M.startSession({}, { input: { id: generateId(), workerRef: worker.id, appRef: app.id, ...input } }, ctx(mia.id));

  it('an explicit family is stored, normalized; Worker.family reads it while bound', async () => {
    const s = await start({ family: 'Codex', tool: 'claude-code', llmModel: 'claude-opus-5-5' });
    expect(s.family).toBe('codex'); // explicit wins over the derivation
    expect(await familyOf()).toBe('codex');
  });

  it('#2191 aliases use the same canonical storage on start and update', async () => {
    const s = await start({ family: ' Anthropic ' });
    expect(s.family).toBe('claude');
    expect((await M.updateSession({}, { id: s.id, family: ' OpenAI ' }, ctx(mia.id))).family).toBe('codex');
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

  it('updateSession refreshes the bound model family without rebind or tool aliasing (#1931)', async () => {
    const s = await start({ tool: 'claude-code' });
    const updated = await M.updateSession({}, { id: s.id, llmModel: 'glm-4.6' }, ctx(mia.id));
    expect(updated.id).toBe(s.id);
    expect(updated.tool).toBe('claude-code');
    expect(updated.llmModel).toBe('glm-4.6');
    expect(updated.family).toBe('glm');
    expect(await familyOf()).toBe('glm');
    await M.updateSession({}, { id: s.id, branch: 'recovered' }, ctx(mia.id));
    expect(await familyOf()).toBe('glm');
  });

  it('an explicit refresh wins over the model, normalizes, and invalid input writes nothing (#1931)', async () => {
    const s = await start({ family: 'codex' });
    const updated = await M.updateSession({}, { id: s.id, family: ' GLM ', llmModel: 'claude-opus-5-5' }, ctx(mia.id));
    expect(updated.family).toBe('glm');
    const before = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    await expect(M.updateSession({}, { id: s.id, family: 'not a family' }, ctx(mia.id))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.session.findUniqueOrThrow({ where: { id: s.id } })).toEqual(before);
  });

  it('operator backfill changes only the newest open null binding, previews without writing and preserves heartbeat (#1931)', async () => {
    const s = await start({ tool: 'claude-code' });
    const old = new Date('2026-01-01T00:00:00Z');
    await db.$executeRaw`UPDATE sessions SET updated_at = ${old} WHERE id = ${s.id}`;
    const before = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    const mapping = [{ workerId: worker.id, family: 'GLM' }];
    expect(await backfillSessionFamilies(db, mapping)).toEqual([{ workerId: worker.id, sessionId: s.id, family: 'glm' }]);
    expect(await db.session.findUniqueOrThrow({ where: { id: s.id } })).toEqual(before);
    await expect(backfillSessionFamilies(db, [...mapping, { workerId: 'other', family: 'invalid family' }], true)).rejects.toThrow('valid model-family');
    expect(await db.session.findUniqueOrThrow({ where: { id: s.id } })).toEqual(before);
    await backfillSessionFamilies(db, mapping, true);
    expect(await db.session.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ family: 'glm', tool: 'claude-code', updatedAt: before.updatedAt });
    expect(await backfillSessionFamilies(db, [{ workerId: worker.id, family: 'claude' }], true)).toEqual([]);
    await M.endSession({}, { id: s.id }, ctx(mia.id));
    expect(await backfillSessionFamilies(db, mapping, true)).toEqual([]);
  });

  it('the pinned operator inventory backfills disposable bindings without inferring tool families (#1931)', async () => {
    const mapping = JSON.parse(readFileSync(new URL('../../../scripts/backfill-session-families-1931.json', import.meta.url), 'utf8'));
    const template = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const snapshots = new Map<string, any>();
    for (const row of mapping) {
      await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: row.workerId, appId: app.id, agentId: template.agentId, name: row.worktreeSlug, slug: row.worktreeSlug } });
      const session = await db.session.create({ data: { id: generateId(), workerId: row.workerId, appId: app.id, userId: mia.id, tool: 'claude-code', family: null } });
      snapshots.set(session.id, session);
    }
    expect(await backfillSessionFamilies(db, mapping)).toHaveLength(mapping.length);
    for (const [id, before] of snapshots) expect(await db.session.findUniqueOrThrow({ where: { id } })).toEqual(before);
    const changed = await backfillSessionFamilies(db, mapping, true);
    expect(changed).toHaveLength(mapping.length);
    for (const row of changed) {
      const before = snapshots.get(row.sessionId);
      expect(await db.session.findUniqueOrThrow({ where: { id: row.sessionId } })).toEqual({ ...before, family: row.family });
    }
    expect(await backfillSessionFamilies(db, mapping, true)).toEqual([]);
    for (const slug of ['hugo-2', 'xan', 'xylon']) expect(mapping.find((r: any) => r.worktreeSlug === slug).family).toBe('glm');
  });

  it('the database refuses a family in no token shape (chk_sessions_family)', async () => {
    await expect(db.session.create({ data: { id: generateId(), family: 'Claude' } })).rejects.toThrow(/chk_sessions_family/);
  });
});
