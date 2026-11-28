/**
 * #2190 (cor:dmo:050:17) — appMemoryScope: the memories appNodes reads for a
 * caller, one row per memory with every reason it is in scope, paged, with an
 * advisory viewerCanWrite from the createNode gate.
 *
 * appNodes is the oracle: both fields share one admission-and-scope helper, and
 * the differential below holds them to the same inventory for every principal
 * shape (org reader, org reader who is also an App member, external App member,
 * org admin). The fixture carries every exclusion the fold applies — a worker's
 * working memory, another App's memory, an unlicensed foreign Agent — plus a
 * memory linked by two Agents, an empty memory, an inherited base, and a base
 * whose only node is a boot prompt (never inherited, so never listed).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServerOnCleanDb } from '../../../test/startServerFixture.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { compareScopeKeys } from './resolvers.appMemoryScope.js';

const Q = resolvers.Query as any;

type Row = { memoryId: string; memoryUrn: string; name: string; class: string; description: string | null; sources: Array<{ kind: string; agentId: string | null }>; viewerCanWrite: boolean };

let n: number;
let org: { id: string; urn: string };
let foreignOrg: { id: string; urn: string };
let appId: string;
const user: Record<string, string> = {};
const agent: Record<string, string> = {};
const mem: Record<string, string> = {};

const ctx = (who: string): Context => ({ db, userId: user[who], roles: ['READER'] });

async function memory(key: string, data: { orgId?: string; class?: string; appId?: string; sharedMemoryOfAgentId?: string; description?: string; isEncrypted?: boolean } = {}, withNode = true) {
  const o = data.orgId === foreignOrg?.id ? foreignOrg : org;
  mem[key] = (await db.memory.create({
    data: {
      class: (data.class ?? 'knowledge') as any,
      organizationId: o.id,
      name: key,
      urn: `${o.urn}:${key.toLowerCase()}`,
      appId: data.appId ?? null,
      sharedMemoryOfAgentId: data.sharedMemoryOfAgentId ?? null,
      // #4890: descriptions on the fixture rows, so the scope row's new field
      // has real text to carry (or withhold) per the record gate.
      description: data.description ?? null,
      isEncrypted: data.isEncrypted ?? false,
    },
  })).id;
  if (withNode) await db.node.create({ data: { memoryId: mem[key], loc: `notes:${key.toLowerCase()}`, name: key, content: key } });
  return mem[key]!;
}

async function makeAgent(key: string, opts: { orgId?: string; base?: string } = {}) {
  const o = opts.orgId === foreignOrg?.id ? foreignOrg : org;
  const sys = await db.memory.create({ data: { class: 'system', organizationId: o.id, name: `${key} system`, urn: `${o.urn}:${key}-system`, description: `d-sys${key}` } });
  mem[`sys${key}`] = sys.id;
  agent[key] = (await db.agent.create({
    data: { organizationId: o.id, name: key, urn: `${o.urn}:${key}`, visibility: 'ORGANIZATION', systemMemoryId: sys.id, extendsAgentId: opts.base ? agent[opts.base] : null },
  })).id;
  return agent[key]!;
}

const link = (agentKey: string, memKey: string, role: 'read' | 'read-write' = 'read') =>
  db.agentMemoryItem.create({ data: { agentId: agent[agentKey]!, memoryId: mem[memKey]!, role } });

async function scopeAll(who: string, pageSize = 2): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await Q.appMemoryScope({}, { appRef: appId, limit: pageSize, offset }, ctx(who));
    rows.push(...page.items);
    if (page.items.length === 0 || rows.length >= page.total) break;
  }
  return rows;
}

const appNodesMemoryIds = async (who: string) =>
  new Set<string>((await Q.appNodes({}, { appRef: appId }, ctx(who))).map((x: { memoryId: string }) => x.memoryId));

// Proxy passthrough that reads with the TARGET as receiver and binds methods to
// it, so a delegate method never sees the proxy as `this` (#4905 F6).
const passthroughBound = (target: object, prop: string | symbol) => {
  const value = Reflect.get(target, prop, target);
  return typeof value === 'function' ? value.bind(target) : value;
};

type MemoryFindManyArgs = { where?: { id?: { in?: string[] } }; select?: Record<string, boolean | undefined> };

/**
 * One spy for every test that watches or races `memory.findMany` (#4980 item 3): a context whose `db.memory.findMany` runs
 * `around(args, run)`, where `run()` performs the real read. Everything else passes through bound to the real client.
 */
const spyOnMemory = (
  who: string,
  around: (args: MemoryFindManyArgs, run: () => Promise<unknown>) => Promise<unknown>,
): Context => {
  const memory = new Proxy(db.memory, {
    get: (target, prop) => (prop === 'findMany'
      ? (args: MemoryFindManyArgs) => around(args, () => target.findMany(args as never))
      : passthroughBound(target, prop)),
  });
  return { ...ctx(who), db: new Proxy(db, { get: (t, p) => (p === 'memory' ? memory : passthroughBound(t, p)) }) as typeof db };
};

// The two reads `appMemoryScopePage` makes on `memory` by id: the order key (id, urn) and the page (description is its marker).
const isKeyRead = (a: MemoryFindManyArgs) => Array.isArray(a?.where?.id?.in) && a.select?.urn === true;
const isPageRead = (a: MemoryFindManyArgs) => Array.isArray(a?.where?.id?.in) && a.select?.description === true;

const keyOf = (id: string) => Object.entries(mem).find(([, v]) => v === id)?.[0] ?? id;
const keysOf = (rows: Row[]) => rows.map((r) => keyOf(r.memoryId)).sort();

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Scope', urn: `scope2190-${n}.example` }, select: { id: true, urn: true } });
  foreignOrg = await db.organization.create({ data: { name: 'Foreign', urn: `foreign2190-${n}.example` }, select: { id: true, urn: true } });
  for (const who of ['reader', 'member', 'external', 'admin', 'stranger']) {
    user[who] = (await db.user.create({ data: { handle: `s2190-${who}-${n}`, roles: ['READER'] } })).id;
  }
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.reader!, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.member!, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.admin!, role: 'ADMIN' } });

  appId = (await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } })).id;
  const otherAppId = (await db.app.create({ data: { name: 'Other', urn: `${org.urn}:other`, organizationId: org.id } })).id;
  await db.appMember.create({ data: { appId, userId: user.member!, role: 'member' } });
  await db.appMember.create({ data: { appId, userId: user.external!, role: 'member' } });

  // Agents: Alpha installed first; Beta (extends Core, which extends Root)
  // second; Gamma, a foreign Agent with no org grant, third.
  await makeAgent('Root');
  await makeAgent('Core', { base: 'Root' });
  await makeAgent('Alpha');
  await makeAgent('Beta', { base: 'Core' });
  await makeAgent('Gamma', { orgId: foreignOrg.id });
  const t0 = Date.now();
  for (const [i, key] of ['Alpha', 'Beta', 'Gamma'].entries()) {
    await db.appAgent.create({ data: { appId, agentId: agent[key]!, createdAt: new Date(t0 + i * 1000) } });
  }

  // System memories get a node each; Core's is inherited into Beta, Root's
  // only node is a boot prompt, which no child ever inherits.
  for (const key of ['Alpha', 'Beta', 'Core']) {
    await db.node.create({ data: { memoryId: mem[`sys${key}`]!, loc: `notes:${key.toLowerCase()}`, name: key, content: key } });
  }
  await db.node.create({ data: { memoryId: mem.sysRoot!, loc: 'prompts:boot', name: 'boot', content: 'boot', role: 'boot-prompt' } });

  await memory('KnowA', { description: 'd-KnowA' });
  await memory('KnowShared');
  await memory('KnowEmpty', {}, false);
  // #4890: an encrypted memory with a description — the record (name,
  // description) is never enciphered (cor:sec:040:03 is node-level), so its
  // scope row must carry the description with no key in play.
  await memory('KnowEnc', { description: 'd-KnowEnc', isEncrypted: true });
  await memory('KnowB');
  await memory('KnowC', { orgId: foreignOrg.id });
  // Linked by Alpha, but in an org Alpha's tenant cannot reach: the link is a
  // limit, never a grant (cor:dmo:050:09), so it caps to nothing.
  await memory('KnowF', { orgId: foreignOrg.id });
  await memory('TeamSpace', { class: 'app', appId, sharedMemoryOfAgentId: agent.Alpha, description: 'd-TeamSpace' });
  await memory('WorkerMem', { class: 'app', appId });
  await memory('OtherAppMem', { class: 'app', appId: otherAppId });
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.Alpha!, name: 'Iris', slug: 'iris', memoryId: mem.WorkerMem! } });

  await link('Alpha', 'KnowA', 'read-write');
  await link('Alpha', 'KnowEnc');
  await link('Alpha', 'KnowShared');
  await link('Alpha', 'KnowEmpty');
  await link('Alpha', 'WorkerMem');
  await link('Alpha', 'OtherAppMem');
  await link('Alpha', 'KnowF', 'read-write');
  await link('Beta', 'KnowShared', 'read-write');
  await link('Beta', 'KnowB');
  await link('Gamma', 'KnowC');
});

describe('#2190 — the inventory matches appNodes for every principal', () => {
  for (const who of ['reader', 'member', 'external', 'admin']) {
    it(`${who}: every appNodes memory is a row, and the only rows appNodes lacks are empty`, async () => {
      const rows = await scopeAll(who);
      const fromNodes = await appNodesMemoryIds(who);
      const scoped = new Set(rows.map((r) => r.memoryId));
      for (const id of fromNodes) expect(scoped.has(id), `appNodes memory ${keyOf(id)} missing from memoryScope`).toBe(true);
      const extra = [...scoped].filter((id) => !fromNodes.has(id)).map(keyOf);
      expect(extra.every((k) => k === 'KnowEmpty'), `rows with visible nodes absent from appNodes: ${extra}`).toBe(true);
    });
  }
});

describe('#2190 — what is in scope, and why', () => {
  it('an org reader who is also an App member: every licensed Agent, the team space, and the inherited base', async () => {
    expect(keysOf(await scopeAll('member'))).toEqual(
      ['KnowA', 'KnowB', 'KnowEmpty', 'KnowEnc', 'KnowShared', 'TeamSpace', 'sysAlpha', 'sysBeta', 'sysCore'],
    );
  });

  it('an org reader who is not an App member gets no team space', async () => {
    expect(keysOf(await scopeAll('reader'))).toEqual(
      ['KnowA', 'KnowB', 'KnowEmpty', 'KnowEnc', 'KnowShared', 'sysAlpha', 'sysBeta', 'sysCore'],
    );
  });

  it('#3305: an external App member keeps system/team reach but no item-only knowledge', async () => {
    expect(keysOf(await scopeAll('external'))).toEqual(['TeamSpace', 'sysAlpha']);
  });

  it('never lists a worker memory, another App\'s memory, an unlicensed Agent\'s memory, a link capped to nothing, or a base with nothing inherited', async () => {
    const keys = keysOf(await scopeAll('admin'));
    for (const k of ['WorkerMem', 'OtherAppMem', 'KnowC', 'KnowF', 'sysGamma', 'sysRoot']) expect(keys).not.toContain(k);
  });

  it('one row per memory, with every source in kind then install order', async () => {
    const rows = await scopeAll('member');
    const by = (k: string) => rows.find((r) => r.memoryId === mem[k])!;
    expect(rows.filter((r) => r.memoryId === mem.KnowShared)).toHaveLength(1);
    expect(by('KnowShared').sources).toEqual([
      { kind: 'AGENT_LINK', agentId: agent.Alpha },
      { kind: 'AGENT_LINK', agentId: agent.Beta },
    ]);
    expect(by('sysAlpha').sources).toEqual([{ kind: 'AGENT_SYSTEM', agentId: agent.Alpha }]);
    expect(by('sysCore').sources).toEqual([{ kind: 'INHERITED_BASE', agentId: agent.Core }]);
    expect(by('TeamSpace').sources).toEqual([{ kind: 'TEAM_SPACE', agentId: null }]);
    expect(by('KnowEmpty')).toMatchObject({ name: 'KnowEmpty', class: 'knowledge' });
  });

  it('an independently subscribed external member sees only the first Agent\'s link on a memory two Agents share', async () => {
    await db.orgMember.create({ data: { organizationId: foreignOrg.id, userId: user.external!, role: 'READER' } });
    await db.memorySubscription.create({ data: { memoryId: mem.KnowShared!, organizationId: foreignOrg.id, role: 'READER' } });
    const shared = (await scopeAll('external')).find((r) => r.memoryId === mem.KnowShared)!;
    expect(shared.sources).toEqual([{ kind: 'AGENT_LINK', agentId: agent.Alpha }]);
  });
});

// #4890 (hrn:node:hadronmemory.com:specs:cor:dmo:050:17): the row's new
// `description` rides the RECORD gate (`canReadMemoryRecord`, the one
// `Query.memory` applies), never the row's own admission — a row the scope
// lists but the record gate refuses stays listed, with the description
// withheld. The memory record is never enciphered (cor:sec:040:03 enciphers
// node content only), so an encrypted memory's description is carried with no
// key in play, exactly as `Memory.description` serves it.
describe('#4890 — description rides the record gate, not the row\'s audience', () => {
  it('a row whose record the caller can read returns its description', async () => {
    const rows = await scopeAll('member');
    const by = (k: string) => rows.find((r) => r.memoryId === mem[k])!;
    expect(by('KnowA').description).toBe('d-KnowA');
    expect(by('KnowEnc').description).toBe('d-KnowEnc');
    expect(by('TeamSpace').description).toBe('d-TeamSpace');
  });

  it('a row the record gate refuses is still listed, with description null', async () => {
    // Preconditions, so the scenario cannot silently weaken: an org READER
    // cannot open the system records (their audience is the installed/
    // licensed Agent or a manager, never the record-only org-member shortcut,
    // #1807), while the App lens arm above still lists them — the two gates
    // genuinely differ for these rows.
    expect(await Q.memory({}, { ref: mem.sysAlpha! }, ctx('reader'))).toBeNull();
    expect(await Q.memory({}, { ref: mem.sysCore! }, ctx('reader'))).toBeNull();
    const rows = await scopeAll('reader');
    const sysAlpha = rows.find((r) => r.memoryId === mem.sysAlpha)!;
    const sysCore = rows.find((r) => r.memoryId === mem.sysCore)!;
    expect(sysAlpha.description).toBeNull();
    expect(sysCore.description).toBeNull();
  });

  it('an encrypted memory\'s row returns the same description Memory.description returns', async () => {
    for (const who of ['reader', 'member', 'admin']) {
      const row = (await scopeAll(who)).find((r) => r.memoryId === mem.KnowEnc)!;
      const record = await Q.memory({}, { ref: mem.KnowEnc! }, ctx(who));
      expect(record?.description, who).toBe('d-KnowEnc');
      expect(row.description, who).toBe(record!.description);
    }
  });

  it('agrees with Query.memory row by row, for every principal', async () => {
    for (const who of ['reader', 'member', 'external', 'admin']) {
      for (const row of await scopeAll(who)) {
        const record = await Q.memory({}, { ref: row.memoryId }, ctx(who));
        // The stored text is the independent oracle: the row carries it exactly
        // when Query.memory opens the record, and null exactly when it does not.
        const stored = (await db.memory.findUniqueOrThrow({ where: { id: row.memoryId }, select: { description: true } })).description;
        expect(row.description, `${who} on ${keyOf(row.memoryId)}`).toBe(record ? stored : null);
      }
    }
  });

  it('a readable row with no description, or an empty one, returns null and the empty string as stored', async () => {
    // The fixture seeds KnowShared and KnowB with NO description (null). This test changes one of them and leaves the other,
    // and says so: KnowShared stays null (asserted, not assumed), KnowB becomes ''. beforeEach runs cleanDb and reseeds, so
    // neither change reaches another test.
    expect((await db.memory.findUniqueOrThrow({ where: { id: mem.KnowShared! }, select: { description: true } })).description).toBeNull();
    await db.memory.update({ where: { id: mem.KnowB! }, data: { description: '' } });
    const rows = await scopeAll('admin');
    const by = (k: string) => rows.find((r) => r.memoryId === mem[k])!;
    // Both rows are openable by this caller; null here is "no description set", not "withheld".
    expect(await Q.memory({}, { ref: mem.KnowShared! }, ctx('admin'))).not.toBeNull();
    expect(by('KnowShared').description).toBeNull();
    expect(by('KnowB').description).toBe('');
  });

  it('reads descriptions and gate fields for the page\'s ids only, one read, not the whole scope', async () => {
    const keyReads: MemoryFindManyArgs[] = [];
    const pageReads: MemoryFindManyArgs[] = [];
    const page = await Q.appMemoryScope({}, { appRef: appId, limit: 2, offset: 0 }, spyOnMemory('admin', (args, run) => {
      if (isKeyRead(args)) keyReads.push(args);
      if (isPageRead(args)) pageReads.push(args);
      return run();
    }));
    expect(page.items).toHaveLength(2);
    expect(page.total).toBeGreaterThan(page.items.length);
    expect(pageReads).toHaveLength(1);
    expect(pageReads[0]!.where!.id!.in).toHaveLength(page.items.length);
    // #4980 item 3: the order-key read carries the id and the URN and nothing else, no description or gate field.
    expect(keyReads).toHaveLength(1);
    expect(keyReads[0]!.select).toEqual({ id: true, urn: true });
  });

  it('a row hard-deleted between the key read and the page read is dropped; total still counts it', async () => {
    const before = await Q.appMemoryScope({}, { appRef: appId }, ctx('admin'));
    let fired = false;
    const raced = await Q.appMemoryScope({}, { appRef: appId }, spyOnMemory('admin', async (args, run) => {
      if (!fired && isPageRead(args)) {
        fired = true;
        // The page read: remove one of the ids it is about to fetch.
        await db.memory.delete({ where: { id: args.where!.id!.in![0]! } });
      }
      return run();
    }));
    expect(fired).toBe(true);
    expect(raced.total).toBe(before.total);
    expect(raced.items).toHaveLength(before.items.length - 1);
  });

  it('an offset past the end returns no items and reads no page rows', async () => {
    let keyReads = 0;
    let pageReads = 0;
    const page = await Q.appMemoryScope({}, { appRef: appId, limit: 5, offset: 1000 }, spyOnMemory('admin', (args, run) => {
      if (isKeyRead(args)) keyReads += 1;
      if (isPageRead(args)) pageReads += 1;
      return run();
    }));
    expect(page.items).toEqual([]);
    expect(page.total).toBeGreaterThan(0);
    // #4980 item 1: the key read happened (total comes from it) and the page read did not.
    expect(keyReads).toBe(1);
    expect(pageReads).toBe(0);
  });

  it('a memory soft-deleted between the scope snapshot and the page read stays listed, with description null', async () => {
    // The snapshot and the page read are two queries; every scope arm drops
    // soft-deleted memories, so the ONLY way a deleted row reaches the page
    // is this window. `Query.memory` answers null for a soft-deleted record,
    // so the raced row must withhold the description while staying listed
    // (the snapshot admitted it). Proxy the snapshot's own findMany (select
    // id only, where OR appId, no class filter — distinct from every other
    // memory query in the walk) to soft-delete KnowA right after it admits
    // the row, before the page read fetches it.
    const raced = await Q.appMemoryScope({}, { appRef: appId }, spyOnMemory('member', async (args, run) => {
      const rows = await run();
      // The snapshot read: select id only, where OR appId, no class filter.
      const a = args as { select?: { id?: boolean; urn?: boolean }; where?: { OR?: unknown; class?: unknown } };
      if (a?.select?.id === true && !a?.select?.urn && a?.where?.OR && !a?.where?.class) {
        await db.memory.update({ where: { id: mem.KnowA! }, data: { deletedAt: new Date() } });
      }
      return rows;
    }));
    const row = (raced.items as Row[]).find((r) => r.memoryId === mem.KnowA);
    expect(row).toBeDefined();
    expect(row!.description).toBeNull();
    // Parity, stated: a fresh Query.memory for the same caller answers null.
    expect(await Q.memory({}, { ref: mem.KnowA! }, ctx('member'))).toBeNull();
  });
});

describe('#2190 — viewerCanWrite is the viewer\'s createNode gate, not the Agent\'s link', () => {
  it('a read-write link does not make a memory writable for an org reader', async () => {
    const row = (await scopeAll('reader')).find((r) => r.memoryId === mem.KnowA)!;
    expect(row.viewerCanWrite).toBe(false);
  });

  it('a read link does not stop an org admin who may write the memory', async () => {
    const row = (await scopeAll('admin')).find((r) => r.memoryId === mem.KnowB)!;
    expect(row.viewerCanWrite).toBe(true);
  });

  it('reports each row\'s own answer: a page mixing writable and read-only rows keeps them aligned', async () => {
    const rows = await scopeAll('member', 100);
    const answers = new Set(rows.map((r) => r.viewerCanWrite));
    expect(answers.size, 'the principal must see both writable and read-only rows').toBe(2);
    for (const r of rows) {
      const solo = (await Q.appMemoryScope({}, { appRef: appId, limit: 1, offset: rows.indexOf(r) }, ctx('member'))).items[0] as Row;
      expect(solo.memoryId).toBe(r.memoryId);
      expect(solo.viewerCanWrite, keyOf(r.memoryId)).toBe(r.viewerCanWrite);
    }
  });

  it('agrees with createNode, row by row', async () => {
    for (const who of ['reader', 'member', 'admin']) {
      for (const row of await scopeAll(who)) {
        let gateAdmitted = true;
        try {
          await (resolvers.Mutation as any).createNode({}, { input: { memoryRef: row.memoryId, loc: `probe:${n}-${who}`, name: 'probe' } }, ctx(who));
        } catch (err) {
          // #4890 fixture: an encrypted memory's node creation needs a session
          // key this bare resolver context cannot hold, so createNode refuses
          // with SESSION_EXPIRED AFTER the write gate admitted. That refusal
          // is not the gate disagreeing — viewerCanWrite reports the gate
          // alone — so only FORBIDDEN counts as "cannot write".
          const e = err as { extensions?: { code?: string }; code?: string };
          const code = e.extensions?.code ?? e.code;
          // The named answers only: FORBIDDEN, or MEMORY_NOT_FOUND where createNode
          // conceals a denial on a memory the caller cannot read. Anything else is a
          // different failure, not an answer.
          if (code !== 'SESSION_EXPIRED' && code !== 'FORBIDDEN' && code !== 'MEMORY_NOT_FOUND') throw err;
          gateAdmitted = code === 'SESSION_EXPIRED';
        }
        expect(row.viewerCanWrite, `${who} on ${keyOf(row.memoryId)}`).toBe(gateAdmitted);
      }
    }
  });
});

describe('#2190 — a write-gate failure is a failure, never a read-only answer', () => {
  it('fails the field when the gate errors with anything but its FORBIDDEN denial', async () => {
    const boom = new Error('simulated memory lookup failure');
    const memory = new Proxy(db.memory, {
      get: (target, prop) => (prop === 'findUniqueOrThrow' ? () => Promise.reject(boom) : passthroughBound(target, prop)),
    });
    const failing = new Proxy(db, { get: (target, prop) => (prop === 'memory' ? memory : passthroughBound(target, prop)) });
    await expect(Q.appMemoryScope({}, { appRef: appId }, { ...ctx('member'), db: failing as typeof db })).rejects.toBe(boom);
  });
});

describe('#2190 — paging (cor:api:120:04)', () => {
  it('pages in memoryUrn order without dropping or repeating a row', async () => {
    const full = (await Q.appMemoryScope({}, { appRef: appId }, ctx('member'))).items as Row[];
    const paged = await scopeAll('member', 3);
    expect(paged.map((r) => r.memoryId)).toEqual(full.map((r) => r.memoryId));
    const urns = full.map((r) => r.memoryUrn);
    expect(urns).toEqual([...urns].sort());
    expect(new Set(urns).size).toBe(urns.length);
  });

  it('reports the whole scope in total, and an offset past the end returns no items', async () => {
    const page = await Q.appMemoryScope({}, { appRef: appId, limit: 2, offset: 100 }, ctx('member'));
    expect(page.items).toEqual([]);
    expect(page.total).toBe(9);
  });

  it('compareScopeKeys: equal canonical URNs fall back to the id, in both directions', () => {
    const a = { memoryUrn: 'hrn:mem:o:kb', id: 'a1' };
    const b = { memoryUrn: 'hrn:mem:o:kb', id: 'b2' };
    expect(compareScopeKeys(a, b)).toBeLessThan(0);
    expect(compareScopeKeys(b, a)).toBeGreaterThan(0);
    expect(compareScopeKeys(a, { ...a })).toBe(0);
    // the URN still decides first, whatever the ids say
    expect(compareScopeKeys({ memoryUrn: 'hrn:mem:o:a', id: 'z9' }, { memoryUrn: 'hrn:mem:o:b', id: 'a1' })).toBeLessThan(0);
    const shuffled = [b, { memoryUrn: 'hrn:mem:o:a', id: 'z9' }, a].sort(compareScopeKeys);
    expect(shuffled.map((k) => k.id)).toEqual(['z9', 'a1', 'b2']);
  });

  it('#4980: two memories whose stored URNs differ but emit the same canonical URN page in id order, one at a time', async () => {
    // `org:tie` and `org::tie` are distinct unique stored values and both emit `hrn:mem:org:tie`.
    const ids: string[] = [];
    for (const raw of [`${org.urn}:tie`, `${org.urn}::tie`]) {
      const m = await db.memory.create({ data: { class: 'knowledge', organizationId: org.id, name: 'Tie', urn: raw } });
      await db.node.create({ data: { memoryId: m.id, loc: 'notes:tie', name: 'Tie', content: 'tie' } });
      await db.agentMemoryItem.create({ data: { agentId: agent.Alpha!, memoryId: m.id, role: 'read' } });
      ids.push(m.id);
    }
    const full = (await Q.appMemoryScope({}, { appRef: appId, limit: 100 }, ctx('admin'))).items as Row[];
    const tied = full.filter((r) => ids.includes(r.memoryId));
    expect(tied).toHaveLength(2);
    expect(tied[0]!.memoryUrn).toBe(tied[1]!.memoryUrn);
    expect(tied.map((r) => r.memoryId)).toEqual([...ids].sort());
    const oneByOne = await scopeAll('admin', 1);
    expect(oneByOne.map((r) => r.memoryId)).toEqual(full.map((r) => r.memoryId));
  });

  it('a limit over the cap returns a page of the cap, never a refusal', async () => {
    const page = await Q.appMemoryScope({}, { appRef: appId, limit: 10_000 }, ctx('member'));
    expect(page.items).toHaveLength(9);
  });
});

describe('#2190 — admission is appNodes\' own', () => {
  it('a caller appNodes refuses gets the same refusal', async () => {
    const refusal = await Q.appNodes({}, { appRef: appId }, ctx('stranger')).catch((e: Error) => e);
    expect(refusal).toBeInstanceOf(Error);
    await expect(Q.appMemoryScope({}, { appRef: appId }, ctx('stranger'))).rejects.toThrow(refusal.message);
  });

  it('an App in a soft-deleted organization has an empty scope, as appNodes does', async () => {
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    expect(await Q.appNodes({}, { appRef: appId }, ctx('member'))).toEqual([]);
    expect(await Q.appMemoryScope({}, { appRef: appId }, ctx('member'))).toEqual({ items: [], total: 0 });
  });
});

// #2196 QA (Clark): the composition only the real HTTP boundary has. The
// outer Query.app gate, and the read-only plugin that refuses an impersonated
// mutation before any resolver runs, are invisible to direct-resolver calls.
describe('#2190 — over the real GraphQL HTTP boundary', () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = createHttpServer(await createServerOnCleanDb());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  const keyFor = async (who: string) =>
    (await mintUserApiKey(db, { userId: user[who]!, label: null, createdBy: user[who]!, issuedVia: 'test' })).rawKey;
  // `status` is 200 unless named: the read-only plugin refuses at
  // didResolveOperation, which Apollo answers with a 500 carrying the code.
  const post = async (bearer: string, query: string, variables: Record<string, unknown> = {}, status = 200) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    expect(response.status).toBe(status);
    return response.json() as Promise<{ data?: any; errors?: Array<{ message: string; extensions?: { code?: string } }> }>;
  };
  const SCOPE = 'query($a: ID!) { appMemoryScope(appRef: $a, limit: 200) { total items { memoryId description viewerCanWrite } } }';
  const NODES = 'query($a: ID!) { appNodes(appRef: $a) { memoryId } }';

  it('answers an external App participant whom Query.app refuses, with appNodes\' scope', async () => {
    const key = await keyFor('external');
    const app = await post(key, 'query($a: ID!) { app(ref: $a) { id } }', { a: appId });
    expect(app.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    const scope = await post(key, SCOPE, { a: appId });
    expect(scope.errors).toBeUndefined();
    const ids = new Set<string>(scope.data.appMemoryScope.items.map((r: Row) => r.memoryId));
    expect([...ids].map(keyOf).sort()).toEqual(keysOf(await scopeAll('external')));
    expect(ids.has(mem.TeamSpace!)).toBe(true);
    const nodes = await post(key, NODES, { a: appId });
    for (const { memoryId } of nodes.data.appNodes) expect(ids.has(memoryId)).toBe(true);
  });

  it('gives total 0 for an App in a soft-deleted organization, as appNodes gives []', async () => {
    const key = await keyFor('member');
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    expect((await post(key, NODES, { a: appId })).data.appNodes).toEqual([]);
    const scope = await post(key, SCOPE, { a: appId });
    expect(scope.errors).toBeUndefined();
    expect(scope.data.appMemoryScope).toEqual({ total: 0, items: [] });
  });

  it('reads no row as writable in a read-only impersonation session, where createNode is refused', async () => {
    user.owner = (await db.user.create({ data: { handle: `s2190-owner-${n}`, roles: ['READER'] } })).id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: user.owner, role: 'OWNER' } });
    const started = await post(await keyFor('owner'),
      'mutation($o: String!, $u: String!) { startImpersonation(orgRef: $o, userRef: $u) { token } }', { o: org.id, u: user.admin });
    expect(started.errors).toBeUndefined();
    const token: string = started.data.startImpersonation.token;

    // Control: the same admin, signed in as themselves, may write some rows.
    const own = (await post(await keyFor('admin'), SCOPE, { a: appId })).data.appMemoryScope.items as Row[];
    const writable = own.filter((r) => r.viewerCanWrite);
    expect(writable.length).toBeGreaterThan(0);

    const impersonated = await post(token, SCOPE, { a: appId });
    expect(impersonated.errors).toBeUndefined();
    const rows = impersonated.data.appMemoryScope.items as Row[];
    expect(rows.map((r) => r.memoryId)).toEqual(own.map((r) => r.memoryId));
    expect(rows.filter((r) => r.viewerCanWrite)).toEqual([]);

    // #4890: under impersonation, each row's description is exactly what
    // Memory.description returns under the SAME impersonation token — the row
    // reuses the record gate rather than deciding impersonation itself.
    for (const row of rows) {
      const record = await post(token, 'query($r: ID!) { memory(ref: $r) { description } }', { r: row.memoryId });
      expect(record.errors, keyOf(row.memoryId)).toBeUndefined();
      expect(row.description, keyOf(row.memoryId)).toBe(record.data.memory?.description ?? null);
    }

    const created = await post(token, 'mutation($i: CreateNodeInput!) { createNode(input: $i) { id } }',
      { i: { memoryId: writable[0]!.memoryId, loc: `probe:imp-${n}`, name: 'probe' } }, 403);
    expect(created.errors?.[0]?.extensions?.code).toBe('IMPERSONATION_READ_ONLY');
    expect(await db.node.count({ where: { memoryId: writable[0]!.memoryId, loc: `probe:imp-${n}` } })).toBe(0);
  });
});
