/**
 * #1325 — MemoryConfig / NodeRoleRule / MemoryConfigTemplate: the DATABASE
 * invariants, pinned below the API so no resolver can be the only thing
 * holding them.
 *
 * - A memory has at most one config (`memory_id` UNIQUE); an absent row is
 *   the empty config, so nothing here creates one at memory creation.
 * - A template has exactly one of four owners (`chk_memory_config_template_owner`)
 *   and a name unique per owner among LIVE rows.
 * - A rule's task reference is a node-id FK with ON DELETE SET NULL, and the
 *   `*_task_required` marker a delete cannot clear: a hard-deleted task leaves
 *   the rule failing CLOSED (#1325 H5, Holger 2026-09-25). The CHECK keeps the
 *   marker set whenever a reference is.
 * - #1322: role RULE KEYS follow the lower-case dotted grammar; Node.role
 *   itself remains open and has no matching CHECK.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbNode, createDbOrgAndGraph } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { resolveMemoryNodeRoleRule } from '../../lib/governedRole.js';

let org: { id: string };
let memoryId: string;
let taskId: string;
let user: { id: string };
let app: { id: string };
let server: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const made = await createDbOrgAndGraph(db, { orgName: 'mc-org', graphName: 'mc-mem' });
  org = made.org;
  memoryId = made.graph.id;
  taskId = (await createDbNode(db, { memoryId, loc: 'tasks:author', isRunnable: true })).id;
  user = await db.user.create({ data: { id: generateId(), handle: 'mc-user', githubUsername: 'mc-user' } });
  app = (await createDbAppWithKey(db, 'mc-app', org.id)).app;
  server = await db.hadronServer.create({ data: { id: generateId(), url: 'https://hc.example' } });
});

const rawInsertTemplate = (id: string, owners: Record<string, string>) => {
  const cols = ['id', 'name', ...Object.keys(owners)];
  const vals = [id, 'n', ...Object.values(owners)].map((v) => `'${v}'`);
  return db.$executeRawUnsafe(
    `INSERT INTO memory_config_templates (${cols.join(', ')}) VALUES (${vals.join(', ')})`,
  );
};

describe('#1325 — MemoryConfigTemplate: exactly one owner', () => {
  it('the constraint exists in the test schema', async () => {
    const rows = await db.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint WHERE conname IN
         ('chk_memory_config_template_owner', 'chk_node_role_rule_task_markers',
          'chk_memory_config_template_rule_task_markers',
          'chk_node_role_rule_role_format',
          'chk_memory_config_template_rule_role_format') ORDER BY conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual([
      'chk_memory_config_template_owner',
      'chk_memory_config_template_rule_role_format',
      'chk_memory_config_template_rule_task_markers',
      'chk_node_role_rule_role_format',
      'chk_node_role_rule_task_markers',
    ]);
  });

  it('refuses a template with no owner', async () => {
    await expect(rawInsertTemplate('t0', {})).rejects.toThrow(/chk_memory_config_template_owner/);
  });

  it('refuses a template with two owners', async () => {
    await expect(
      rawInsertTemplate('t2', { organization_id: org.id, owner_user_id: user.id }),
    ).rejects.toThrow(/chk_memory_config_template_owner/);
  });

  it('accepts each of the four owners alone (the User owner AiServiceConfig lacks included)', async () => {
    for (const owner of [
      { hadronServerId: server.id },
      { organizationId: org.id },
      { ownerUserId: user.id },
      { appId: app.id },
    ]) {
      await db.memoryConfigTemplate.create({ data: { name: 'specs', ...owner } });
    }
    expect(await db.memoryConfigTemplate.count()).toBe(4);
    // The optimistic-concurrency counter starts at 1 (cli#716 Q1).
    expect((await db.memoryConfigTemplate.findMany()).map((t) => t.revision)).toEqual([1, 1, 1, 1]);
  });

  it('a name is unique per owner among LIVE templates, and a soft-deleted one frees it', async () => {
    const first = await db.memoryConfigTemplate.create({ data: { name: 'specs', organizationId: org.id } });
    await expect(
      db.memoryConfigTemplate.create({ data: { name: 'specs', organizationId: org.id } }),
    ).rejects.toThrow(/memory_config_templates_org_name_uniq|Unique constraint/);
    // Another owner may use the same name.
    await db.memoryConfigTemplate.create({ data: { name: 'specs', ownerUserId: user.id } });
    await db.memoryConfigTemplate.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    await db.memoryConfigTemplate.create({ data: { name: 'specs', organizationId: org.id } });
    expect(
      await db.memoryConfigTemplate.count({ where: { organizationId: org.id, deletedAt: null } }),
    ).toBe(1);
  });

  it('a template goes with its owner', async () => {
    await db.memoryConfigTemplate.create({
      data: { name: 'mine', ownerUserId: user.id, rules: { create: [{ role: 'spec' }] } },
    });
    await db.user.delete({ where: { id: user.id } });
    expect(await db.memoryConfigTemplate.count()).toBe(0);
    expect(await db.memoryConfigTemplateRule.count()).toBe(0);
  });
});

describe('#1325 — MemoryConfig: at most one per memory', () => {
  it('refuses a second config for the same memory', async () => {
    await db.memoryConfig.create({ data: { memoryId } });
    await expect(db.memoryConfig.create({ data: { memoryId } })).rejects.toThrow(/Unique constraint/);
  });

  it('a memory with no config row has none — nothing is created with the memory', async () => {
    expect(await db.memoryConfig.findUnique({ where: { memoryId } })).toBeNull();
  });

  it('a hard-deleted memory takes its config and rules with it', async () => {
    await db.memoryConfig.create({ data: { memoryId, rules: { create: [{ role: 'spec' }] } } });
    await db.memory.delete({ where: { id: memoryId } });
    expect(await db.memoryConfig.count()).toBe(0);
    expect(await db.nodeRoleRule.count()).toBe(0);
  });
});

describe('#1325 — NodeRoleRule: one row per role, task references fail closed', () => {
  let configId: string;
  beforeEach(async () => {
    configId = (await db.memoryConfig.create({ data: { memoryId } })).id;
  });

  it('refuses a duplicate role in one config', async () => {
    await db.nodeRoleRule.create({ data: { configId, role: 'spec' } });
    await expect(db.nodeRoleRule.create({ data: { configId, role: 'spec' } })).rejects.toThrow(
      /Unique constraint/,
    );
  });

  it('a row may declare a role with no tasks at all (H1)', async () => {
    const rule = await db.nodeRoleRule.create({ data: { configId, role: 'spec.rule' } });
    expect(rule).toMatchObject({
      authorTaskId: null, authorTaskRequired: false, writers: 'ALL', enabled: true, revision: 1,
    });
  });

  it('accepts valid dotted rule keys and refuses invalid ones below the API', async () => {
    await expect(
      db.nodeRoleRule.create({ data: { configId, role: 'spec.rule-detail' } }),
    ).resolves.toMatchObject({ role: 'spec.rule-detail' });
    for (const role of ['Spec.rule', 'spec..rule', 'spec_rule', 'spec.', '']) {
      await expect(
        db.nodeRoleRule.create({ data: { configId, role } }),
      ).rejects.toThrow(/chk_node_role_rule_role_format/);
    }
  });

  it('resolves the most-specific enabled rule and walks past a disabled row (#1322)', async () => {
    await db.nodeRoleRule.createMany({
      data: [
        { id: generateId(), configId, role: 'spec', enabled: true },
        { id: generateId(), configId, role: 'spec.rule', enabled: false },
        { id: generateId(), configId, role: 'spec.rule.detail', enabled: true },
      ],
    });

    const resolved = async (role: string) => {
      const r = await resolveMemoryNodeRoleRule(db, memoryId, role);
      return r.kind === 'RULE' ? r.rule.role : r.kind;
    };
    expect(await resolved('spec.rule.detail')).toBe('spec.rule.detail');
    expect(await resolved('spec.rule.other')).toBe('spec');
    expect(await resolved('special')).toBe('NONE');
  });

  it('a strict parent refuses an undeclared sub-role from the stored config (#1345 review, H1)', async () => {
    await db.nodeRoleRule.createMany({
      data: [
        { id: generateId(), configId, role: 'review', enabled: true, strictSubRoles: true },
        { id: generateId(), configId, role: 'review.security', enabled: true },
      ],
    });
    expect((await resolveMemoryNodeRoleRule(db, memoryId, 'review.perf')).kind).toBe('UNDECLARED_UNDER_STRICT');
    expect(await resolved2(db, memoryId, 'review.security')).toBe('review.security');
  });

  it('refuses a task reference without its required marker', async () => {
    await expect(
      db.nodeRoleRule.create({ data: { configId, role: 'spec', authorTaskId: taskId } }),
    ).rejects.toThrow(/chk_node_role_rule_task_markers/);
    await expect(
      db.nodeRoleRule.create({ data: { configId, role: 'review', validationTaskId: taskId } }),
    ).rejects.toThrow(/chk_node_role_rule_task_markers/);
  });

  it('a HARD-deleted task nulls the reference and leaves the marker: the rule fails closed', async () => {
    const rule = await db.nodeRoleRule.create({
      data: {
        configId, role: 'spec',
        authorTaskId: taskId, authorTaskRequired: true,
        validationTaskId: taskId, validationTaskRequired: true,
      },
    });
    await db.node.delete({ where: { id: taskId } });
    expect(await db.nodeRoleRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({
      authorTaskId: null, authorTaskRequired: true,
      validationTaskId: null, validationTaskRequired: true,
    });
  });

  it('a SOFT-deleted task keeps the reference (the write-time check treats it as missing)', async () => {
    await db.nodeRoleRule.create({
      data: { configId, role: 'spec', authorTaskId: taskId, authorTaskRequired: true },
    });
    await db.node.update({ where: { id: taskId }, data: { deletedAt: new Date() } });
    expect((await db.nodeRoleRule.findFirstOrThrow({ where: { configId } })).authorTaskId).toBe(taskId);
  });

  it('a hard-deleted description node just nulls: documentation, not procedure', async () => {
    const doc = await createDbNode(db, { memoryId, loc: 'docs:spec' });
    await db.nodeRoleRule.create({ data: { configId, role: 'spec', descriptionNodeId: doc.id } });
    await db.node.delete({ where: { id: doc.id } });
    expect((await db.nodeRoleRule.findFirstOrThrow({ where: { configId } })).descriptionNodeId).toBeNull();
  });
});

describe('#1325 — MemoryConfigTemplateRule: the same reference semantics', () => {
  it('enforces the same dotted role-key grammar', async () => {
    const templateId = (await db.memoryConfigTemplate.create({ data: { name: 'grammar', organizationId: org.id } })).id;
    await expect(
      db.memoryConfigTemplateRule.create({ data: { templateId, role: 'spec.rule-detail' } }),
    ).resolves.toMatchObject({ role: 'spec.rule-detail' });
    await expect(
      db.memoryConfigTemplateRule.create({ data: { templateId, role: 'spec..rule' } }),
    ).rejects.toThrow(/chk_memory_config_template_rule_role_format/);
  });

  it('refuses either task without its marker, and both fail closed on a hard-deleted task', async () => {
    const templateId = (await db.memoryConfigTemplate.create({ data: { name: 't', organizationId: org.id } })).id;
    await expect(
      db.memoryConfigTemplateRule.create({ data: { templateId, role: 'spec', authorTaskId: taskId } }),
    ).rejects.toThrow(/chk_memory_config_template_rule_task_markers/);
    await expect(
      db.memoryConfigTemplateRule.create({ data: { templateId, role: 'review', validationTaskId: taskId } }),
    ).rejects.toThrow(/chk_memory_config_template_rule_task_markers/);
    const rule = await db.memoryConfigTemplateRule.create({
      data: {
        templateId, role: 'spec',
        authorTaskId: taskId, authorTaskRequired: true,
        validationTaskId: taskId, validationTaskRequired: true,
      },
    });
    await db.node.delete({ where: { id: taskId } });
    expect(await db.memoryConfigTemplateRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({
      authorTaskId: null, authorTaskRequired: true,
      validationTaskId: null, validationTaskRequired: true,
    });
  });
});

async function resolved2(db: Parameters<typeof resolveMemoryNodeRoleRule>[0], memoryId: string, role: string) {
  const r = await resolveMemoryNodeRoleRule(db, memoryId, role);
  return r.kind === 'RULE' ? r.rule.role : r.kind;
}
