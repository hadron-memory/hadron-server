import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1026 — every MCP surface that prints a worker URN prints the link with it.
 *
 * The bug this pins shut: #1008 asks each worker to sign what it publishes with
 * a HYPERLINKED URN, and #881 gave node reads a ready-made `URL:` line so no
 * agent ever has to build one. Worker reads printed the URN alone, so the only
 * way to satisfy #1008 was to assemble `<origin>/app/u/<urn>` by hand — the one
 * thing every role-agent prompt on the team forbids. The prompts papered over
 * it with an explicit carve-out; this makes the carve-out unnecessary.
 *
 * The rule these surfaces now share is flat, which is what makes it testable as
 * one thing: WHEREVER A WORKER URN IS PRINTED, THE LINK IS PRINTED WITH IT.
 * Five surfaces — the cast receipt, the bind receipt, the roster, the single
 * read, and `hadron_whoami`.
 *
 * Also pinned: no configured portal origin ⇒ NO `URL:` line on any of them,
 * because a link to the wrong host is worse than no link; and the link is
 * always built from the URN the SAME output prints, so the two cannot disagree.
 *
 * Test harness: createTestableMcpServer drives the registered tool callbacks
 * without an HTTP transport, so this exercises the production closure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const PORTAL = 'https://hadronmemory.com';

let org: { id: string; urn: string };
let user: { id: string };
let app: { id: string; urn: string };
let agent: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  process.env.FRONTEND_URL = PORTAL;
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'wpu-org', urn: `wpumcp-${suffix}.com` },
  });
  user = await db.user.create({
    data: { id: generateId(), githubId: 97710, githubUsername: `wpu-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' },
  });
  agent = await db.agent.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:server`,
      name: 'Server Engineer', visibility: 'ORGANIZATION',
      personaRole: 'server-engineer',
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
});

afterEach(() => {
  process.env.FRONTEND_URL = '';
});

function auth(): AuthContext {
  return { userId: user.id, appId: app.id, roles: ['READER'], clientId: `user:${user.id}` };
}

const castWorker = (name: string, slug: string) =>
  db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug, role: 'server-engineer' },
  });

/** Every `URL:` value in a tool's output, in order. */
function urlLines(text: string): string[] {
  return [...text.matchAll(/^\s*URL: (.+)$/gm)].map((m) => m[1].trim());
}

/**
 * Every worker URN printed as an IDENTIFIER, in order — deliberately excluding
 * the `URL:` lines, whose value ends in a URN too. Counting those would make
 * `expectLinkForEveryUrn` compare the links against themselves and pass for any
 * output at all, which is the fixture-cannot-express-the-defect trap.
 */
function workerUrns(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !/^\s*URL:/.test(line))
    .flatMap((line) => [...line.matchAll(/hrn:worker:[^\s)]+/g)].map((m) => m[0]));
}

/**
 * The property under test, asserted the same way on every surface: the output
 * printed at least one worker URN, and each one is accompanied by its own link.
 * Comparing DERIVED-from-the-printed-URN rather than to a literal is the point
 * — it is what makes "the link and the identifier cannot disagree" the thing
 * being checked, rather than "the link looks about right".
 */
function expectLinkForEveryUrn(out: string): void {
  const urns = workerUrns(out);
  expect(urns.length).toBeGreaterThan(0);
  expect(urlLines(out)).toEqual(urns.map((u) => `${PORTAL}/app/u/${u}`));
}

describe('#1026 — a worker URN never appears without its link', () => {
  it('hadron_get_worker', async () => {
    await castWorker('Dara', 'dara');
    const out = await createTestableMcpServer(auth()).callToolText('hadron_get_worker', {
      workerRef: 'Dara',
    });
    expect(out).toContain(`hrn:worker:${org.urn}:team:dara`);
    expectLinkForEveryUrn(out);
  });

  it('hadron_list_workers — one link per roster row', async () => {
    await castWorker('Dara', 'dara');
    await castWorker('Gil', 'gil');
    const out = await createTestableMcpServer(auth()).callToolText('hadron_list_workers', {});
    expect(workerUrns(out)).toHaveLength(2);
    expectLinkForEveryUrn(out);
  });

  it('hadron_cast_worker — the one-time mint whose receipt a human keeps', async () => {
    const out = await createTestableMcpServer(auth()).callToolText('hadron_cast_worker', {
      role: 'server-engineer',
      name: 'Dara',
    });
    expect(out).toContain(`hrn:worker:${org.urn}:team:dara`);
    expectLinkForEveryUrn(out);
  });

  it('hadron_start_session — the bind, where a worker FIRST needs its identity', async () => {
    await castWorker('Dara', 'dara');
    const out = await createTestableMcpServer(auth()).callToolText('hadron_start_session', {
      workerRef: 'Dara',
      description: 'a stint',
    });
    // Before #1026 the bind receipt printed NEITHER, so the briefing's own
    // instruction ("your exact URN is the urn line from hadron_get_worker")
    // forced a second call at the exact moment the need arises.
    expect(out).toContain(`hrn:worker:${org.urn}:team:dara`);
    expectLinkForEveryUrn(out);
  });

  it('hadron_whoami — the post-compaction recovery read', async () => {
    const worker = await castWorker('Dara', 'dara');
    await db.session.create({
      data: { id: generateId(), workerId: worker.id, appId: app.id, userId: user.id },
    });
    const out = await createTestableMcpServer(auth()).callToolText('hadron_whoami', {});
    expect(out).toContain(`hrn:worker:${org.urn}:team:dara`);
    expectLinkForEveryUrn(out);
  });
});

describe('#1026 — no portal origin means no link, never a guess', () => {
  beforeEach(() => {
    process.env.FRONTEND_URL = '';
  });

  it('omits the URL line on every surface while keeping the URN', async () => {
    const worker = await castWorker('Dara', 'dara');
    await db.session.create({
      data: { id: generateId(), workerId: worker.id, appId: app.id, userId: user.id },
    });
    const srv = createTestableMcpServer(auth());
    for (const [tool, args] of [
      ['hadron_get_worker', { workerRef: 'Dara' }],
      ['hadron_list_workers', {}],
      ['hadron_whoami', {}],
    ] as const) {
      const out = await srv.callToolText(tool, args as never);
      expect(urlLines(out), `${tool} emitted a link with no portal configured`).toEqual([]);
      // The identifier survives — losing the link must not cost the caller the
      // URN, which is the part that is still usable as a workerRef.
      expect(out, `${tool} dropped the URN`).toContain(`hrn:worker:${org.urn}:team:dara`);
    }
  });

  it('omits it on a malformed FRONTEND_URL too (parse, do not pattern-match)', async () => {
    process.env.FRONTEND_URL = 'https://host:abc';
    await castWorker('Dara', 'dara');
    const out = await createTestableMcpServer(auth()).callToolText('hadron_get_worker', {
      workerRef: 'Dara',
    });
    expect(urlLines(out)).toEqual([]);
    expect(out).toContain(`hrn:worker:${org.urn}:team:dara`);
  });
});
