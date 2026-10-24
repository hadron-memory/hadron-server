import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

vi.mock('child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  (args.at(-1) as Function)(null, { stdout: '', stderr: '' });
}) }));
vi.mock('./githubApp.js', () => ({ getInstallationToken: vi.fn(async () => 'fixture'), toHttpsUrl: vi.fn((s: string) => s) }));
let graphsPath: string;
let cleanup: () => void;
let graph: MemoryWithOrg;
vi.mock('../../config.js', async original => ({ ...await original<typeof import('../../config.js')>(), get GRAPHS_PATH() { return graphsPath; } }));
const file = (loc: string, content: string) => {
  const root = join(graphsPath, 'report-org', 'report-memory');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${loc}.md`), `---\nname: ${loc}\n---\n${content}\n`);
};
const storedReport = async () => (await db.memory.findUniqueOrThrow({ where: { id: graph.id } }) as unknown as { lastSyncReport?: string | null }).lastSyncReport;

beforeEach(async () => {
  ({ dir: graphsPath, cleanup } = makeTmpDir());
  await cleanDb(db);
  const { org, graph: created } = await createDbOrgAndGraph(db, { orgName: 'report-org', graphName: 'report-memory' });
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 12345 } });
  graph = await db.memory.update({ where: { id: created.id }, data: { urn: 'report-org:report-memory', source: 'git@github.com:fixture/repo.git', readBranch: 'main' }, include: { organization: true } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('#1507 persisted sync outcome', () => {
  it('reports an invalid include as partial alongside committed graph writes', async () => {
    file('good', 'committed'); file('bad', '{{> good bogus}}');
    const result = await syncGraphFromGithub(graph);
    expect(result.error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'good' } })).toBe(1);
    const text = await storedReport();
    expect(typeof text).toBe('string');
    expect(JSON.parse(text!)).toMatchObject({ version: 1, outcome: 'partial', entries: [{ kind: 'invalid_include', loc: 'bad', code: expect.any(String) }] });
  });

  it('uses null only after a clean committed sync', async () => {
    file('good', 'committed');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await storedReport()).toBeNull();
  });

  it.each(['partial', 'failed', 'unknown'])('clears a previous %s report only after a clean commit', async outcome => {
    await db.memory.update({ where: { id: graph.id }, data: { lastSyncReport: JSON.stringify({ version: 1, outcome, recordedAt: '2026-10-23T00:00:00.000Z', entries: [] }) } });
    file('good', 'committed');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    const stored = await db.memory.findUniqueOrThrow({ where: { id: graph.id } });
    expect(stored.lastSyncReport).toBeNull();
    expect(stored.syncStatus).toBe('OK');
    expect(stored.syncError).toBeNull();
    expect(stored.lastSyncedAt).toBeInstanceOf(Date);
  });

  it('rolls back graph writes when the in-transaction report write fails', async () => {
    file('good', 'must roll back');
    const transaction = db.$transaction.bind(db);
    const spy = vi.spyOn(db, '$transaction');
    spy.mockImplementation(((callback: (tx: unknown) => Promise<unknown>, options?: unknown) => transaction(async tx => {
      const wrapped = new Proxy(tx, { get(target, property) {
        if (property !== 'memory') return Reflect.get(target, property);
        return new Proxy(tx.memory, { get(model, method) {
          if (method !== 'update') return Reflect.get(model, method);
          return async (args: { data: Record<string, unknown> }) => {
            if ('lastSyncReport' in args.data) throw new Error('fixture private metadata failure');
            return tx.memory.update(args as Parameters<typeof tx.memory.update>[0]);
          };
        } });
      } });
      return callback(wrapped);
    }, options as never)) as typeof db.$transaction);
    const result = await syncGraphFromGithub(graph);
    spy.mockRestore();
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'good' } })).toBe(0);
    expect(result.error).toContain('fixture private metadata failure');
    const report = await storedReport();
    expect(JSON.parse(report!)).toMatchObject({ outcome: 'failed', entries: [], code: 'SYNC_FAILED' });
    expect(report).not.toContain('private metadata failure');
  });

  it.each(['GraphQL', 'MCP', 'startup', 'webhook'])('persists the shared partial outcome through the actual %s entry handler', async door => {
    file('good', 'committed'); file('bad', '{{> good bogus}}');
    const owner = await db.user.create({ data: { handle: 'sync-report-owner', roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: graph.organizationId!, userId: owner.id, role: 'OWNER' } });
    if (door === 'GraphQL') {
      const { resolvers } = await import('../../api/graphql/schema/resolvers.js');
      await resolvers.Mutation.syncMemory({}, { id: graph.id }, { db, userId: owner.id, roles: ['READER'] });
    } else if (door === 'MCP') {
      const { createTestableMcpServer } = await import('../../mcp/server.js');
      const server = createTestableMcpServer({ userId: owner.id, roles: ['READER'], clientId: `user:${owner.id}` });
      const text = await server.callToolText('hadron_sync_graph', { memoryUrn: `hrn:mem:${graph.urn}` });
      expect(text).not.toContain('Sync failed');
    } else if (door === 'startup') {
      vi.stubEnv('DISABLE_STARTUP_SYNC', 'false');
      const { startup } = await import('../../controller/startup.js');
      try { expect(await startup()).toBe('ran'); } finally { vi.unstubAllEnvs(); }
    } else {
      const { createServer } = await import('../../server.js');
      const { createServer: httpServer } = await import('node:http');
      const { createHmac } = await import('node:crypto');
      vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'report-fixture-secret');
      const server = httpServer(await createServer());
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address() as { port: number };
        const body = JSON.stringify({ ref: 'refs/heads/main', repository: { default_branch: 'main', full_name: 'fixture/repo' } });
        const signature = `sha256=${createHmac('sha256', 'report-fixture-secret').update(body).digest('hex')}`;
        const response = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': signature }, body });
        expect(response.status).toBe(200);
        await vi.waitFor(async () => expect(await storedReport()).toBeTypeOf('string'), { timeout: 5000 });
      } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        vi.unstubAllEnvs();
      }
    }
    expect(JSON.parse((await storedReport())!)).toMatchObject({ outcome: 'partial', entries: [{ kind: 'invalid_include', loc: 'bad' }] });
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'good' } })).toBe(1);
  });

  it('persists fixed failed metadata when preflight fails without claiming committed files', async () => {
    const result = await syncGraphFromGithub({ ...graph, source: 'https://not-a-github-host.test/repo' });
    expect(result.error).toBeDefined();
    const text = await storedReport();
    expect(typeof text).toBe('string');
    expect(JSON.parse(text!)).toMatchObject({ version: 1, outcome: 'failed', code: 'SYNC_FAILED', entries: [] });
    expect(text).not.toContain('not-a-github-host');
  });
});
