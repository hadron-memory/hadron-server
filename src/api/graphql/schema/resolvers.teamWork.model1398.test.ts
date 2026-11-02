/**
 * #1398 — per-milestone model attribution on the team worklog.
 *
 * Pins the acceptance matrix: explicit report > session-model snapshot >
 * absent; a model switch inside one session leaves earlier rows immutable;
 * late records keep working; legacy rows and a pre-model schema declaration
 * converge/admit without breaking writers; a CUSTOM declaration stays
 * governed and still admits the field (non-strict); the gate matrix is
 * unchanged by the new argument.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { WORKLOG_LOC, WORKLOG_OBJECT_TYPE } from './resolvers.teamWork.js';
import type { AuthContext } from '../../../middleware/auth.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

function ctx(userId?: string, appId?: string): Context {
  return { db, userId, appId, roles: ['READER'] };
}

let org: { id: string; urn: string };
let admin: { id: string };
let contrib: { id: string };
let app: { id: string };
let session: { id: string };

const record = (args: Record<string, unknown> = {}) =>
  M.recordTeamWork(
    {},
    {
      appRef: app.id,
      sessionRef: session.id,
      tool: 'github',
      kind: 'pr',
      ref: 'o/r#1',
      action: 'opened',
      ...args,
    },
    ctx(contrib.id),
  );

const worklogMemory = async () => {
  // loc-scope-ok: deliberately spans the App's OWN app-class memories — the
  // relation filter is the tenant scope, mirroring the resolver (#947).
  const root = await db.node.findFirst({ where: { loc: WORKLOG_LOC, memory: { appId: app.id, class: 'app' } } });
  expect(root).not.toBeNull();
  return root!.memoryId;
};

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'wm-org', urn: `wm-${suffix}.com` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 95301, githubUsername: `wm-${suffix}`, roles: ['READER'] } });
  contrib = await db.user.create({ data: { id: generateId(), githubId: 95302, githubUsername: `wm-c-${suffix}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' } });

  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  await db.node.create({
    data: {
      id: generateId(), memoryId: agent.systemMemoryId, loc: 'roles:backend-engineer',
      name: 'backend-engineer', content: 'You are {{name}}, a {{role}}.', data: { names: ['Iris'] },
    },
  });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  session = await M.startSession(
    {},
    { input: { id: generateId(), appRef: app.id, tool: 'zcode' } },
    ctx(contrib.id),
  );
});

describe('#1398 — model attribution on worklog milestones', () => {
  it('an explicit model report wins over the session model — receipt AND stored row', async () => {
    await db.session.update({ where: { id: session.id }, data: { llmModel: 'claude-opus-5-5' } });
    const item = await record({ model: 'glm-5.3' });
    expect(item.model).toBe('glm-5.3');
    // Read the STORED row back: a precedence swap that only touched the
    // stored expression must not survive (Ella, #1401).
    const memoryId = await worklogMemory();
    const row = await db.node.findFirstOrThrow({
      where: { memoryId, objectType: WORKLOG_OBJECT_TYPE },
      orderBy: { createdAt: 'desc' },
    });
    expect((row.properties as Record<string, unknown>).model).toBe('glm-5.3');
    const page = await Q.teamWorkItems({}, { appRef: app.id }, ctx(contrib.id));
    expect(page.items[0].model).toBe('glm-5.3');
  });

  it('without an explicit report, the SESSION model is snapshotted at record time', async () => {
    await db.session.update({ where: { id: session.id }, data: { llmModel: 'claude-opus-5-5' } });
    expect((await record()).model).toBe('claude-opus-5-5');
  });

  it('no session model and no report: the key is absent and reads back null', async () => {
    const item = await record();
    expect(item.model).toBeNull();
    const memoryId = await worklogMemory();
    const row = await db.node.findFirstOrThrow({
      where: { memoryId, objectType: WORKLOG_OBJECT_TYPE },
      orderBy: { createdAt: 'desc' },
    });
    expect((row.properties as Record<string, unknown>).model).toBeUndefined();
  });

  it('a model switch inside one session never relabels the earlier row', async () => {
    await db.session.update({ where: { id: session.id }, data: { llmModel: 'glm-4.7' } });
    const first = await record({ ref: 'o/r#1' });
    const second = await record({ ref: 'o/r#2', model: 'glm-5.3' });
    expect(first.model).toBe('glm-4.7');
    expect(second.model).toBe('glm-5.3');
    // Immutable prior record: the stored row still carries its own snapshot.
    const memoryId = await worklogMemory();
    const firstRow = await db.node.findFirstOrThrow({
      where: { memoryId, objectType: WORKLOG_OBJECT_TYPE, properties: { path: ['ref'], equals: 'o/r#1' } },
    });
    expect((firstRow.properties as Record<string, unknown>).model).toBe('glm-4.7');
  });

  it('a LATE record against the ended session keeps attribution', async () => {
    await db.session.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    const item = await record({ model: 'glm-5.3' });
    expect(item.model).toBe('glm-5.3');
  });

  it('empty or whitespace model is refused, not silently treated as absent', async () => {
    for (const bad of ['', '   ']) {
      await expect(record({ model: bad })).rejects.toMatchObject({
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
  });

  it('an over-length model is refused loudly, never silently truncated', async () => {
    await expect(record({ model: 'x'.repeat(121) })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('an empty-string session model normalizes to null — receipt and read-back agree', async () => {
    await db.session.update({ where: { id: session.id }, data: { llmModel: '' } });
    const item = await record();
    expect(item.model).toBeNull();
    const page = await Q.teamWorkItems({}, { appRef: app.id }, ctx(contrib.id));
    expect(page.items[0].model).toBeNull();
  });

  it('an over-long SESSION model refuses the record rather than storing oversized (Codex P2)', async () => {
    await db.session.update({ where: { id: session.id }, data: { llmModel: 'm'.repeat(121) } });
    await expect(record()).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    // An explicit model still attributes the milestone over a broken session value.
    const item = await record({ model: 'glm-5.3' });
    expect(item.model).toBe('glm-5.3');
  });

  it('a PADDED session model stores trimmed — the persisted value obeys the bound exactly (Chip QA)', async () => {
    // ' ' + 120 m's + ' ': trimmed length 120 (legal), raw 122 (would violate).
    await db.session.update({
      where: { id: session.id },
      data: { llmModel: ` ${'m'.repeat(120)} ` },
    });
    const item = await record();
    expect(item.model).toBe('m'.repeat(120));
    const memoryId = await worklogMemory();
    const row = await db.node.findFirstOrThrow({
      where: { memoryId, objectType: WORKLOG_OBJECT_TYPE },
      orderBy: { createdAt: 'desc' },
    });
    expect(((row.properties as Record<string, unknown>).model as string).length).toBeLessThanOrEqual(120);
    // And one more padded char past the bound still refuses after trimming.
    await db.session.update({
      where: { id: session.id },
      data: { llmModel: ` ${'m'.repeat(121)} ` },
    });
    await expect(record({ ref: 'o/r#3' })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('a legacy record without the key reads back null, and the pre-model declaration converges', async () => {
    // First record bootstraps the canonical declaration (now WITH model).
    await record({ ref: 'o/r#1' });
    const memoryId = await worklogMemory();
    // Simulate a pre-#1398 deployment: strip model from the stored declaration
    // AND from the written row.
    const stripModel = (schema: unknown) => {
      const s = JSON.parse(JSON.stringify(schema));
      delete s.objectTypes[WORKLOG_OBJECT_TYPE].fields.model;
      return s;
    };
    await db.memory.update({ where: { id: memoryId }, data: { schema: stripModel(await db.memory.findUniqueOrThrow({ where: { id: memoryId } }).then((m) => m.schema)) } });
    const legacyRow = await db.node.findFirstOrThrow({
      where: { memoryId, objectType: WORKLOG_OBJECT_TYPE, properties: { path: ['ref'], equals: 'o/r#1' } },
    });
    await db.node.update({
      where: { id: legacyRow.id },
      data: { properties: { ...(legacyRow.properties as object), model: undefined } },
    });

    // The old row projects null…
    const page = await Q.teamWorkItems({}, { appRef: app.id }, ctx(contrib.id));
    const oldItem = page.items.find((i: { ref: string }) => i.ref === 'o/r#1');
    expect(oldItem.model).toBeNull();

    // …and the NEXT record converges the server-written pre-model declaration
    // in place (same rule as the pre-#974 convergence) and carries the model.
    const next = await record({ ref: 'o/r#2', model: 'glm-5.3' });
    expect(next.model).toBe('glm-5.3');
    const declared = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    expect(
      (declared.schema as { objectTypes: Record<string, { fields: Record<string, unknown> }> })
        .objectTypes[WORKLOG_OBJECT_TYPE].fields.model,
    ).toMatchObject({ type: 'text', required: false });
  });

  it('a CUSTOM (non-canonical) declaration stays governed and still admits model-bearing records', async () => {
    await record({ ref: 'o/r#1' }); // bootstrap canonical
    const memoryId = await worklogMemory();
    const customized = JSON.parse(
      JSON.stringify(await db.memory.findUniqueOrThrow({ where: { id: memoryId } }).then((m) => m.schema)),
    );
    customized.objectTypes[WORKLOG_OBJECT_TYPE].description = 'Deployment-custom worklog wording';
    await db.memory.update({ where: { id: memoryId }, data: { schema: customized } });

    const item = await record({ ref: 'o/r#2', model: 'glm-5.3' });
    expect(item.model).toBe('glm-5.3'); // non-strict: undeclared key admits, like `detail`
    const stored = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    expect((stored.schema as { objectTypes: Record<string, { description: string }> }).objectTypes[WORKLOG_OBJECT_TYPE].description)
      .toBe('Deployment-custom worklog wording'); // NOT overwritten
  });

  it('the session-App gate is unchanged: a foreign session refuses with or without model', async () => {
    const otherApp = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` },
    });
    const foreignSession = await M.startSession(
      {},
      { input: { id: generateId(), appRef: otherApp.id, tool: 'zcode' } },
      ctx(contrib.id),
    );
    for (const args of [{}, { model: 'glm-5.3' }]) {
      await expect(
        M.recordTeamWork(
          {},
          { appRef: app.id, sessionRef: foreignSession.id, tool: 'github', kind: 'pr', ref: 'o/r#9', action: 'opened', ...args },
          ctx(contrib.id),
        ),
      ).rejects.toMatchObject({ extensions: { code: 'SESSION_NOT_IN_APP' } });
    }
  });

  // #3082: the two MCP-wrapper pins that lived here are gone with hadron_record_work / hadron_team_work_items over MCP.
  // Capability token `worklog-model` no longer advertised: pinned in src/mcp/server.mcpTeamCut3082.test.ts (the not-advertised
  // token list). Explicit model stored and read back: 'records an explicit model ...' above (row.properties.model and Q.teamWorkItems item.model).
});
