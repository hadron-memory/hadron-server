/**
 * #2972 — a nested `register:` loc is not an action-register entry.
 *
 * cor:urn:010:01 keys an action address on a SINGLE code atom
 * (`register:<code>`); a nested `register:a:b` loc is a legitimately writable
 * namespace loc (Xan's gate, reading (i), issue comment 6547618747) and must
 * read as "no entry" QUIETLY — no repair warn — on every surface that computes
 * an action URN. The single-atom drift case (a stored code the emitter refuses)
 * KEEPS its null-and-log signal: only a real entry can need repair.
 *
 * Red on main: the quiet-null pin (main warns "needs repair" for
 * `register:a:b`). The write-surface and parity pins are EVIDENCE, green on
 * main: they pin the seams that keep invalid atoms out and the validator
 * agreement the shared helper leans on, so the refactor cannot lose them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { validateLoc } from '../../../lib/validateLoc.js';
import { composeActionUrnV2 } from '../../../lib/urn.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let teamAgent: { id: string; urn: string };
let teamMemoryId: string;
let teamMemoryUrn: string;

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const field = () => (resolvers as any).Node?.actionUrn as
  (n: { loc: string; memoryId: string }, _: unknown, c: Context) => Promise<string | null>;

async function rawNode(memoryId: string, loc: string) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x' } });
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'au2972-org', urn: `au2972-${suffix}.example` } });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 2972001, githubUsername: 'au2972-admin', handle: 'au2972-admin', roles: ['READER'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const created = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  const teamRow = await db.agent.findUniqueOrThrow({ where: { id: created.id } });
  teamAgent = { id: teamRow.id, urn: teamRow.urn };
  teamMemoryId = teamRow.systemMemoryId as string;
  teamMemoryUrn = (await db.memory.findUniqueOrThrow({ where: { id: teamMemoryId } })).urn;
  await rawNode(teamMemoryId, 'roles'); // the Team Agent marker (locateTeamAgent)
});

describe('#2972 — a nested register: loc is not an entry (Node.actionUrn)', () => {
  it('is null QUIETLY for register:a:b — a writable namespace loc, not an entry needing repair', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = await rawNode(teamMemoryId, 'register:a:b');
    await expect(field()(row, {}, ctx(admin.id))).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('#2972 — drift defence (evidence, green on main)', () => {
  it('a single-atom unemittable stored code still null-AND-LOGS (only an entry can need repair)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Raw write: 'bad code!' is a single atom the emitter refuses (charset).
    const row = await rawNode(teamMemoryId, 'register:bad code!');
    await expect(field()(row, {}, ctx(admin.id))).resolves.toBeNull();
    // Scoped to THIS memory: earlier tests' async warns may land in the spy
    // (see the MCP 2972 file), and the node's own URN line warns separately
    // (safeUrnEmit) — only the action-URN repair signal is this pin's subject.
    const repair = warn.mock.calls.filter(
      (c) => String(c[0]).startsWith('[Node.actionUrn]') && String(c[0]).includes(teamMemoryId),
    );
    expect(repair).toHaveLength(1);
    expect(String(repair[0]?.[0])).toContain('needs repair');
    warn.mockRestore();
  });
});

describe('#2972 — write surfaces (evidence, green on main): nested register: locs stay writable, invalid atoms refuse', () => {
  it('createNode accepts register:a:b (the :440 seam — reading (i): nested locs are writable)', async () => {
    const made = await M.createNode(
      {},
      { input: { memoryId: teamMemoryId, loc: 'register:a:b', name: 'nested', content: '# x' } },
      ctx(admin.id),
    );
    expect(await db.node.findUnique({ where: { id: made.id } })).not.toBeNull();
  });

  it('createNode refuses a 65-char register: atom and a bad-charset register: atom with InvalidLocError', async () => {
    const tooLong = 'x'.repeat(65);
    await expect(
      M.createNode({}, { input: { memoryId: teamMemoryId, loc: `register:${tooLong}`, name: 'l', content: '# x' } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'InvalidLocError' } });
    await expect(
      M.createNode({}, { input: { memoryId: teamMemoryId, loc: 'register:a!b', name: 'c', content: '# x' } }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'InvalidLocError' } });
  });

  it('inline edge locs accept register:a:b and refuse register:a!b (the :704 seam)', async () => {
    const target = await rawNode(teamMemoryId, 'edge-target');
    const host = await M.createNode(
      {},
      {
        input: {
          memoryId: teamMemoryId,
          loc: 'edge-host',
          name: 'host',
          content: '# x',
          edges: [{ loc: 'register:a:b', targetId: target.id }],
        },
      },
      ctx(admin.id),
    );
    expect(host).not.toBeNull();
    await expect(
      M.createNode(
        {},
        {
          input: {
            memoryId: teamMemoryId,
            loc: 'edge-host-2',
            name: 'host2',
            content: '# x',
            edges: [{ loc: 'register:a!b', targetId: target.id }],
          },
        },
        ctx(admin.id),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'InvalidLocError' } });
  });

  it('moveNode renames into register:a:b and refuses register:a!b (the :1879 seam)', async () => {
    const moving = await rawNode(teamMemoryId, 'to-rename');
    await M.moveNode(
      {},
      { sourceRef: moving.id, targetUrn: `hrn:node:${teamMemoryUrn}:register:a:b` },
      ctx(admin.id),
    );
    await expect(db.node.findUniqueOrThrow({ where: { id: moving.id } })).resolves.toMatchObject({ loc: 'register:a:b' });
    await expect(
      M.moveNode({}, { sourceRef: moving.id, targetUrn: `hrn:node:${teamMemoryUrn}:register:a!b` }, ctx(admin.id)),
    ).rejects.toMatchObject({ extensions: { code: 'InvalidLocError' } });
  });
});

describe('#2972 — validator parity (evidence, green on main)', () => {
  it("validateLoc's atom rule accepts exactly the single-atom codes urn-lib composes as action codes", () => {
    // Single atoms only: a MULTI-atom loc (`register:a:b`) passes validateLoc
    // by design (it is a writable namespace loc) and is excluded from
    // entry-hood by the shared helper, not by either validator — pinned in
    // the quiet-null test above.
    const corpus = [
      'task.finish.open-children', // the amendment's canonical dotted code
      'a', // single char (both regexes' one-char arm)
      'A', // uppercase: both are case-lenient on the compose/parse path
      'a'.repeat(64), // the bound, inclusive
      'a'.repeat(65), // one past
      'a!b', 'a b', '-a', 'a-', 'a.', '.a', // charset edges
      '', // empty atom
    ];
    for (const code of corpus) {
      const validateLocThrows = (() => {
        try { validateLoc(`register:${code}`); return false; } catch { return true; }
      })();
      const composeThrows = (() => {
        try { composeActionUrnV2('parity-root', 'team-agent', code); return false; } catch { return true; }
      })();
      expect(
        { code, validateLocThrows, composeThrows },
        `parity drift on ${JSON.stringify(code)}: validateLocThrows=${validateLocThrows} composeThrows=${composeThrows}`,
      ).toEqual({ code, validateLocThrows: composeThrows, composeThrows });
    }
  });
});
