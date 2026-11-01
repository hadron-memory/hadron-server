/**
 * #3101: importNode's pre-fetch write check admits whoever manages the App on its live
 * install memory (cor:api:130:00 provision 1, cor:acl:010:01 install row, cor:agt:040:06),
 * keeps refusing a reader before any fetch, and leaves the decision to the write's own
 * fenced transaction (a manager demoted after the pre-flight is refused there).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/webFetch.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchWebPage: vi.fn(async (url: string) => ({ html: `<html><body><p>fetched ${url}</p></body></html>`, finalUrl: url })),
}));
vi.mock('../../../lib/pdfClient.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  convertHtmlToMarkdown: vi.fn(async (html: string) => ({ markdown: `md:${html}`, title: 'Converted' })),
}));
vi.mock('../../../lib/articleExtract.js', () => ({
  extractArticle: vi.fn(() => ({ contentHtml: '<article>extracted</article>', title: 'Extracted' })),
}));

import { fetchWebPage } from '../../../lib/webFetch.js';

beforeEach(async () => { await cleanDb(db); vi.mocked(fetchWebPage).mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); });

const context = (userId: string, database: Context['db'] = db): Context =>
  ({ db: database, userId, roles: [], clientId: `user:${userId}` }) as Context;

async function fixture() {
  const org = await db.organization.create({ data: { name: 'Import 3101', urn: `import3101-${generateId().toLowerCase()}.test` } });
  const manager = await db.user.create({ data: { id: generateId(), name: 'manager' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Importer', urn: `${org.urn}:app`, organizationId: org.id } });
  const agent = await db.agent.create({ data: { name: 'Importer', urn: `${org.urn}:agent`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, 'Import safely.');
  const system = await db.agent.findUniqueOrThrow({ where: { id: agent.id }, select: { systemMemoryId: true } });
  const install = await db.memory.create({ data: {
    name: 'Install', urn: `${org.urn}:install`, class: 'system', organizationId: org.id,
    appId: app.id, isInstallMemory: true, installOfAgentId: agent.id,
  } });
  const task = await db.node.create({ data: {
    memoryId: system.systemMemoryId!, loc: 'tasks:import', name: 'Import', nodeType: 'task', isRunnable: true,
    content: 'Process {{importedNodeUrn}}',
  } });
  // Readers of the install memory who do not manage the App (040:06 S6).
  const member = await db.user.create({ data: { id: generateId(), name: 'participant' } });
  await createDbAppMember(db, app.id, member.id, 'member');
  const contributor = await db.user.create({ data: { id: generateId(), name: 'contributor' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
  const outsider = await db.user.create({ data: { id: generateId(), name: 'outsider' } });
  const inline = { memoryId: install.id, loc: 'clips:authority', content: '# Imported', contentType: 'text/markdown' };
  const composed = { ...inline, taskRef: task.id, appRef: app.id };
  return { org, app, agent, install, manager, member, contributor, outsider, inline, composed };
}

const stored = (memoryId: string, loc: string) => db.node.findUnique({ where: { loc_memoryId: { memoryId, loc } } });

describe('#3101 importNode into a live install memory', () => {
  it('admits the App manager: composed import stores the node and mints one run (FETCH_PENDING)', async () => {
    const f = await fixture();
    const result = await resolvers.Mutation.importNode({}, { input: f.composed as never }, context(f.manager.id));
    expect(result.status).toBe('FETCH_PENDING');
    expect(await db.appRun.count()).toBe(1);
    expect((await stored(f.install.id, f.inline.loc))?.content).toBe('# Imported');
  });

  it('admits the App manager on the plain inline import (STORED)', async () => {
    const f = await fixture();
    const result = await resolvers.Mutation.importNode({}, { input: f.inline as never }, context(f.manager.id));
    expect(result.status).toBe('STORED');
    expect((await stored(f.install.id, f.inline.loc))?.content).toBe('# Imported');
  });

  it('admits the App manager on the url import, fetching once', async () => {
    const f = await fixture();
    const result = await resolvers.Mutation.importNode({}, { input: { memoryId: f.install.id, loc: 'clips:web', url: 'https://example.com/a' } as never }, context(f.manager.id));
    expect(result.status).toBe('STORED');
    expect(fetchWebPage).toHaveBeenCalledTimes(1);
  });

  it.each(['member', 'contributor', 'outsider'] as const)('refuses %s before any fetch, writing nothing', async who => {
    const f = await fixture();
    const user = f[who];
    const error: any = await resolvers.Mutation.importNode({}, { input: { memoryId: f.install.id, loc: 'clips:denied', url: 'https://example.com/x' } as never }, context(user.id)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.extensions?.code).toBe('FORBIDDEN');
    expect(fetchWebPage).not.toHaveBeenCalled();
    expect(await stored(f.install.id, 'clips:denied')).toBeNull();
    expect(await db.appRun.count()).toBe(0);
  });

  it.each(['composed', 'inline'] as const)('refuses a manager demoted after the pre-flight, inside the write transaction (%s)', async shape => {
    const f = await fixture();
    let crossed = false;
    // Demote at the first transaction the import opens: after the pre-fetch check passed,
    // before the fenced write decides. The in-transaction recheck must refuse.
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === '$transaction') return async (work: any, options: any) => {
        if (!crossed) {
          crossed = true;
          await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.manager.id } }, data: { role: 'READER' } });
        }
        return target.$transaction(work, options);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(resolvers.Mutation.importNode({}, { input: f[shape] as never }, context(f.manager.id, wrapped as never))).rejects.toThrow();
    expect(crossed).toBe(true);
    expect(await stored(f.install.id, f.inline.loc)).toBeNull();
    expect(await db.appRun.count()).toBe(0);
  });
});
