/**
 * #317 — required task-argument validation (spec cor:dmo:060:11, v1).
 *
 * `Mutation.runTask` is the one enforcement point (GraphQL, the CLI and MCP
 * `hadron_run_task` all reach it). A task node whose `data.args` is an object
 * declares arguments; every one with `required: true` and no `default` must be
 * present (key present, not null) in the caller's `args`, or the call is refused
 * `BAD_USER_INPUT` naming ALL the missing ones — before any rendering, run,
 * usage event or AppRun. Undeclared arguments pass through; `default` exempts;
 * no type checking; the refusal is judged AFTER read access, so an unreadable
 * task answers exactly what it answers today and discloses nothing of its schema.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { composeNodeUrn } from '../../../lib/urn.js';
import { resolvers, type Context } from './resolvers.js';
import { RUN_CLIENT_PREFIX } from '../../../lib/auth/runPrincipal.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgId: string;
let app: { id: string };
let adminId: string;
let memoryId: string;
let memoryUrn: string;

const ARGS = {
  file_path: { data_type: 'string', required: true, description: 'File path to process' },
  mode: { data_type: 'string', required: true },
  max_retries: { data_type: 'integer', required: true, default: 3 },
  note: { data_type: 'string', required: false },
};

async function mkTask(loc: string, data: unknown, content = 'Process {{file_path}} in {{mode}}'): Promise<string> {
  await db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc,
      isLink: false,
      name: loc,
      nodeType: 'task',
      isRunnable: true,
      content,
      tags: [],
      ...(data === undefined ? {} : { data: data as never }),
    },
  });
  return composeNodeUrn(memoryUrn, loc);
}

const adminCtx = (): Context => ({ db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` });

async function flushUsage(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'ta-org', urn: 'ta-org' } });
  orgId = org.id;
  app = await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'ta-app', urn: 'ta-org::ta-app' } });
  const admin = await db.user.create({ data: { githubId: 3171, githubUsername: 'ta-admin', roles: ['ADMIN'] } });
  adminId = admin.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  const mem = await db.memory.create({
    data: { id: generateId(), organizationId: orgId, name: 'ta-tasks', urn: 'ta-org::ta-tasks', class: 'knowledge' },
  });
  memoryId = mem.id;
  memoryUrn = mem.urn;
});

describe('#317 acceptance 1 — a missing required argument is refused before anything runs', () => {
  it('refuses BAD_USER_INPUT naming EVERY missing required argument, with no render, usage event or AppRun', async () => {
    const urn = await mkTask('tasks:needs-args', { args: ARGS });
    const err = (await resolvers.Mutation.runTask({}, { nodeRef: urn, args: {} }, adminCtx()).catch((e: unknown) => e)) as {
      extensions?: { code?: string };
      message?: string;
    };
    expect(err.extensions?.code).toBe('BAD_USER_INPUT');
    expect(err.message).toContain('file_path');
    expect(err.message).toContain('mode');
    // `max_retries` is required but carries a default, `note` is optional: neither is named.
    expect(err.message).not.toContain('max_retries');
    expect(err.message).not.toContain('note');
    await flushUsage();
    expect(await db.usageEvent.count({ where: { type: 'action-run' } })).toBe(0);
    expect(await db.appRun.count()).toBe(0);
  });

  it('refuses a call that passes no args at all', async () => {
    const urn = await mkTask('tasks:no-args-passed', { args: ARGS });
    await expect(resolvers.Mutation.runTask({}, { nodeRef: urn }, adminCtx())).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it.each([
    ['null', null],
    ['an array', ['file_path']],
    ['a string', 'file_path'],
    ['a number', 7],
  ])('args given as %s is not an argument object: refused BAD_USER_INPUT naming the missing arguments, never a TypeError (blind P2-1)', async (_label, bad) => {
    const urn = await mkTask(`tasks:bad-args-${_label.replace(/\W/g, '')}`, { args: ARGS });
    const err = (await resolvers.Mutation.runTask({}, { nodeRef: urn, args: bad }, adminCtx()).catch((e: unknown) => e)) as {
      extensions?: { code?: string };
      message?: string;
    };
    expect(err.extensions?.code).toBe('BAD_USER_INPUT');
    expect(err.message).toContain('file_path');
  });

  it('a required argument passed as null counts as missing', async () => {
    const urn = await mkTask('tasks:null-arg', { args: ARGS });
    await expect(
      resolvers.Mutation.runTask({}, { nodeRef: urn, args: { file_path: null, mode: 'x' } }, adminCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('the refusal comes before the execute path: with appRef, no AppRun is minted and the answer is the refusal', async () => {
    const urn = await mkTask('tasks:needs-args-exec', { args: ARGS });
    await expect(
      resolvers.Mutation.runTask({}, { nodeRef: urn, args: {}, appRef: app.id }, adminCtx()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.appRun.count()).toBe(0);
  });
});

describe('#317 acceptance 2-5 — what is NOT refused', () => {
  it('2: the same call with every required argument supplied runs as today', async () => {
    const urn = await mkTask('tasks:supplied', { args: ARGS });
    const out = await resolvers.Mutation.runTask({}, { nodeRef: urn, args: { file_path: 'a.txt', mode: 'fast' } }, adminCtx());
    expect(out).toContain('Process a.txt in fast');
  });

  it('3: a required argument with a default, omitted, is not refused', async () => {
    const urn = await mkTask('tasks:default-exempts', { args: { x: { required: true, default: 'd' } } }, 'x={{x}}');
    await expect(resolvers.Mutation.runTask({}, { nodeRef: urn, args: {} }, adminCtx())).resolves.toContain('x=');
  });

  it('4: undeclared arguments are accepted and reach the render', async () => {
    const urn = await mkTask('tasks:undeclared', { args: ARGS }, 'Process {{file_path}} {{extra}}');
    const out = await resolvers.Mutation.runTask(
      {},
      { nodeRef: urn, args: { file_path: 'a', mode: 'm', extra: 'kept' } },
      adminCtx(),
    );
    expect(out).toContain('Process a kept');
  });

  it('5: a task with no data.args behaves as today', async () => {
    const urn = await mkTask('tasks:no-schema', undefined, 'hello');
    await expect(resolvers.Mutation.runTask({}, { nodeRef: urn }, adminCtx())).resolves.toContain('hello');
  });

  it.each([
    ['a string', { args: 'file_path' }],
    ['an array', { args: ['file_path'] }],
    ['null', { args: null }],
  ])('5: data.args that is %s is not a schema and refuses nothing', async (_label, data) => {
    const urn = await mkTask(`tasks:bad-schema-${_label.replace(/\W/g, '')}`, data, 'hello');
    await expect(resolvers.Mutation.runTask({}, { nodeRef: urn }, adminCtx())).resolves.toContain('hello');
  });

  it('only required === true binds: "true", 1 and an absent flag do not', async () => {
    const urn = await mkTask(
      'tasks:strict-flag',
      { args: { a: { required: 'true' }, b: { required: 1 }, c: { data_type: 'string' }, d: 'junk' } },
      'hello',
    );
    await expect(resolvers.Mutation.runTask({}, { nodeRef: urn, args: {} }, adminCtx())).resolves.toContain('hello');
  });

  it('no type checking: a value of the wrong declared type passes', async () => {
    const urn = await mkTask('tasks:no-types', { args: { n: { data_type: 'integer', required: true } } }, 'n={{n}}');
    await expect(resolvers.Mutation.runTask({}, { nodeRef: urn, args: { n: 'not-a-number' } }, adminCtx())).resolves.toContain(
      'n=not-a-number',
    );
  });

  it('an empty string and false satisfy "present"', async () => {
    const urn = await mkTask('tasks:present', { args: { s: { required: true }, f: { required: true } } }, 'ok');
    await expect(resolvers.Mutation.runTask({}, { nodeRef: urn, args: { s: '', f: false } }, adminCtx())).resolves.toContain('ok');
  });
});

describe('#317 — a run-kernel hop is not the door (LOCAL F1)', () => {
  it('runTask called as a run principal (the kernel\'s assemble, merged view as args) is not refused for a missing required argument', async () => {
    const urn = await mkTask('tasks:kernel-hop', { args: ARGS }, 'hop {{file_path}}');
    const kernelCtx: Context = { db, roles: [], userId: adminId, clientId: `${RUN_CLIENT_PREFIX}run-317`, appId: app.id };
    await expect(resolvers.Mutation.runTask({}, { nodeRef: urn, args: undefined }, kernelCtx)).resolves.toContain('hop ');
    // The same task through the caller's own door is still refused.
    await expect(resolvers.Mutation.runTask({}, { nodeRef: urn, args: {} }, adminCtx())).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});

describe('#317 — an encrypted memory\'s data.args (SECURITY P3)', () => {
  async function mkEncryptedTask(): Promise<{ urn: string; memoryId: string; key: ReturnType<typeof generateDataKey> }> {
    const key = generateDataKey();
    const mem = await db.memory.create({
      data: { id: generateId(), organizationId: orgId, name: 'ta-enc', urn: 'ta-org::ta-enc', class: 'knowledge', isEncrypted: true },
    });
    const enc = encryptNodeFieldsWithKey({ abstract: null, content: 'Process {{file_path}}', data: { args: ARGS } }, key);
    await db.node.create({
      data: {
        id: generateId(), memoryId: mem.id, loc: 'tasks:enc', isLink: false, name: 'enc', nodeType: 'task', isRunnable: true,
        content: enc.content, abstract: enc.abstract, data: enc.data as never, tags: [],
      },
    });
    return { urn: composeNodeUrn(mem.urn, 'tasks:enc'), memoryId: mem.id, key };
  }

  it('with the session key cached the encrypted data.args is read and a missing required argument is refused', async () => {
    const { urn, memoryId, key } = await mkEncryptedTask();
    sessionKeyCache.set('s-317', memoryId, key);
    try {
      await expect(resolvers.Mutation.runTask({}, { nodeRef: urn, args: {} }, adminCtx())).rejects.toMatchObject({
        extensions: { code: 'BAD_USER_INPUT' },
      });
      await expect(
        resolvers.Mutation.runTask({}, { nodeRef: urn, args: { file_path: 'a', mode: 'm' } }, adminCtx()),
      ).resolves.toContain('Process a');
    } finally {
      sessionKeyCache.clear();
    }
  });

  it('without the key the ciphertext data is not an object: this guard refuses nothing (unchanged pre-#317 behaviour)', async () => {
    const { urn } = await mkEncryptedTask();
    sessionKeyCache.clear();
    const err = (await resolvers.Mutation.runTask({}, { nodeRef: urn, args: {} }, adminCtx()).then(
      () => null,
      (e: unknown) => e,
    )) as { extensions?: { code?: string } } | null;
    expect(err?.extensions?.code).not.toBe('BAD_USER_INPUT');
  });
});

describe('#317 acceptance 7 — the refusal is judged after read access and discloses nothing', () => {
  it('a caller who cannot read the task gets the existing answer, never the argument refusal (render and execute)', async () => {
    const urn = await mkTask('tasks:private-schema', { args: ARGS });
    const outsider = await db.user.create({ data: { githubId: 3172, githubUsername: 'ta-outsider', roles: [] } });
    const outsiderCtx: Context = { db, roles: [], userId: outsider.id, clientId: `user:${outsider.id}` };

    // The existing answer, with every argument supplied.
    const baseline = (await resolvers.Mutation.runTask(
      {},
      { nodeRef: urn, args: { file_path: 'a', mode: 'm' } },
      outsiderCtx,
    ).catch((e: unknown) => e)) as { extensions?: { code?: string }; message?: string };
    expect(baseline.extensions?.code).toBeDefined();
    expect(baseline.extensions?.code).not.toBe('BAD_USER_INPUT');

    // Missing the required arguments: byte-identical answer, nothing about the schema.
    const refused = (await resolvers.Mutation.runTask({}, { nodeRef: urn, args: {} }, outsiderCtx).catch((e: unknown) => e)) as {
      extensions?: { code?: string };
      message?: string;
    };
    expect(refused.extensions?.code).toBe(baseline.extensions?.code);
    expect(refused.message).toBe(baseline.message);
    expect(refused.message).not.toContain('file_path');

    // The execute path: same, and no run.
    const baselineExec = (await resolvers.Mutation.runTask(
      {},
      { nodeRef: urn, args: { file_path: 'a', mode: 'm' }, appRef: app.id },
      outsiderCtx,
    ).catch((e: unknown) => e)) as { extensions?: { code?: string }; message?: string };
    const refusedExec = (await resolvers.Mutation.runTask(
      {},
      { nodeRef: urn, args: {}, appRef: app.id },
      outsiderCtx,
    ).catch((e: unknown) => e)) as { extensions?: { code?: string }; message?: string };
    expect(refusedExec.extensions?.code).not.toBe('BAD_USER_INPUT');
    expect(refusedExec.extensions?.code).toBe(baselineExec.extensions?.code);
    expect(refusedExec.message).toBe(baselineExec.message);
    expect(await db.appRun.count()).toBe(0);
  });
});
