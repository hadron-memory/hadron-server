/**
 * #2047 (S10, cor:agt:040:03) — the served-prompt record's database facts: one owner of the right kind, owner-consistent
 * App/Agent/worker, one record per bind and run, and immutability with an owner-absence delete gate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../id.js';

describe('served-prompt-invariants.sql (#2047)', () => {
  it('the migration carries a byte-identical copy of the invariants file', () => {
    const source = readFileSync(new URL('../../../prisma/served-prompt-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../prisma/migrations/20261020010000_served_prompts/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(source)).toBe(true);
  });

  it('post-push.sql and the test template setup both include the invariants file', () => {
    const post = readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8');
    expect(post).toContain('\\ir served-prompt-invariants.sql');
    const setup = readFileSync(new URL('../../test/globalSetup.ts', import.meta.url), 'utf8');
    expect(setup).toContain('served-prompt-invariants.sql');
  });

  describe('the table', () => {
    let appId: string;
    let otherAppId: string;
    let agentId: string;
    let workerId: string;
    let sessionId: string;
    let runId: string;
    let chatNodeId: string;

    beforeEach(async () => {
      await cleanDb(db);
      const { org, graph } = await createDbOrgAndGraph(db, { orgName: `sp-${generateId().slice(0, 8)}` });
      const agent = await db.agent.create({ data: { id: generateId(), name: 'A', organizationId: org.id, urn: `${org.urn}:a` } as never });
      agentId = agent.id;
      appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'T', urn: `${org.urn}:t` } })).id;
      otherAppId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'U', urn: `${org.urn}:u` } })).id;
      workerId = (await db.worker.create({ data: { id: generateId(), appId, agentId, name: 'W', slug: 'w', signature: '', trailer: '' } })).id;
      sessionId = (await db.session.create({ data: { id: generateId(), appId, agentId, workerId, type: 'DEVELOPER' } as never })).id;
      runId = (
        await db.appRun.create({
          data: { id: generateId(), organizationId: org.id, appId, agentId, triggerKind: 'MANUAL', entryNodeUrn: 'x:y:z' } as never,
        })
      ).id;
      chatNodeId = (await db.node.create({ data: { id: generateId(), memoryId: graph.id, loc: 'chats:one', name: 'chat', ownerRepo: 'r' } as never })).id;
    });

    const base = () => ({
      appId,
      agentId,
      pointerLevel: 'AGENT' as const,
      compiledNodeId: generateId(),
      servedRevSeq: 3,
      provenanceRevSeq: 2,
      compiledContentHash: 'h',
    });
    const bind = (extra: Record<string, unknown> = {}) =>
      db.servedPrompt.create({ data: { ...base(), kind: 'BIND', sessionId, workerId, ...extra } as never });
    const run = (extra: Record<string, unknown> = {}) =>
      db.servedPrompt.create({ data: { ...base(), kind: 'RUN', runId, ...extra } as never });
    const chat = (extra: Record<string, unknown> = {}) =>
      db.servedPrompt.create({ data: { ...base(), kind: 'CHAT', chatId: chatNodeId, ...extra } as never });
    const bad = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);

    it('accepts one well-formed record per owner kind', async () => {
      await expect(bind()).resolves.toBeTruthy();
      await expect(run()).resolves.toBeTruthy();
      await expect(chat()).resolves.toBeTruthy();
    });

    it('has exactly one owner, of the kind it says, and only a bind names a worker', async () => {
      await bad(bind({ runId }), /chk_served_prompts_shape/);
      await bad(bind({ sessionId: null }), /chk_served_prompts_shape/);
      await bad(bind({ workerId: null }), /chk_served_prompts_shape/);
      await bad(run({ workerId }), /chk_served_prompts_shape/);
      await bad(chat({ kind: 'RUN' }), /chk_served_prompts_shape/);
    });

    it('bounds ordinal, revision numbers and the json shapes; a worker pointer can only have chosen a bind', async () => {
      await bad(run({ ordinal: 2 }), /chk_served_prompts_shape/);
      await bad(chat({ ordinal: 0 }), /chk_served_prompts_shape/);
      await bad(bind({ servedRevSeq: 0 }), /chk_served_prompts_shape/);
      await bad(bind({ provenanceRevSeq: 4 }), /chk_served_prompts_shape/);
      await bad(bind({ provenance: {} }), /chk_served_prompts_shape/);
      await bad(bind({ variables: [] }), /chk_served_prompts_shape/);
      await bad(run({ pointerLevel: 'WORKER' }), /chk_served_prompts_shape/);
      await expect(bind({ pointerLevel: 'WORKER' })).resolves.toBeTruthy();
    });

    it('keeps one record per bind and per run, and one per chat ordinal', async () => {
      await bind();
      await bad(bind(), /Unique constraint|served_prompts_session_uniq/);
      await run();
      await bad(run(), /Unique constraint|served_prompts_run_uniq/);
      await chat();
      await bad(chat(), /Unique constraint|served_prompts_chat_ordinal_uniq/);
      await expect(chat({ ordinal: 2 })).resolves.toBeTruthy();
    });

    it("refuses a record filed under another owner's App, Agent or worker", async () => {
      await bad(bind({ appId: otherAppId }), /served_prompts_session_owner_fkey/);
      await bad(run({ appId: otherAppId }), /served_prompts_run_owner_fkey/);
      const otherAgent = await db.agent.create({ data: { id: generateId(), name: 'B', organizationId: (await db.app.findUniqueOrThrow({ where: { id: appId } })).organizationId, urn: `x:${generateId()}` } as never });
      await bad(bind({ agentId: otherAgent.id }), /served_prompts_session_owner_fkey/);
      await bad(run({ agentId: otherAgent.id }), /served_prompts_run_owner_fkey/);
      const otherWorker = await db.worker.create({ data: { id: generateId(), appId, agentId, name: 'W2', slug: 'w2', signature: '', trailer: '' } });
      await bad(bind({ workerId: otherWorker.id }), /served_prompts_session_owner_fkey/);
    });

    it('refuses a chat record naming a node that does not exist', async () => {
      await bad(chat({ chatId: generateId() }), /served_prompts_chat_fkey/);
    });

    it('is immutable: no update, and no truncate', async () => {
      const rec = await bind();
      await bad(db.servedPrompt.update({ where: { id: rec.id }, data: { servedRevSeq: 4 } }), /immutable/);
      await bad(db.$executeRawUnsafe('TRUNCATE TABLE served_prompts'), /cannot be truncated/);
    });

    it('refuses a direct delete while the owner exists, per kind', async () => {
      const b = await bind();
      const r = await run();
      const c = await chat();
      for (const rec of [b, r, c]) {
        await bad(db.servedPrompt.delete({ where: { id: rec.id } }), /only with their owner/);
      }
      expect(await db.servedPrompt.count()).toBe(3);
    });

    it('refuses a delete issued by an unrelated nested trigger while the owner still exists', async () => {
      const rec = await bind();
      await db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION sp_test_nested_delete() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN DELETE FROM served_prompts WHERE id = '${rec.id}'; RETURN NEW; END $f$`);
      await db.$executeRawUnsafe(
        'CREATE TRIGGER sp_test_nested BEFORE UPDATE ON workers FOR EACH ROW EXECUTE FUNCTION sp_test_nested_delete()',
      );
      try {
        await bad(db.worker.update({ where: { id: workerId }, data: { name: 'W-renamed' } }), /only with their owner/);
        expect(await db.servedPrompt.count()).toBe(1);
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS sp_test_nested ON workers');
        await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS sp_test_nested_delete()');
      }
    });

    it('goes with its owner: deleting the session, the run or the chat node removes its records', async () => {
      await bind();
      await run();
      await chat();
      await db.session.delete({ where: { id: sessionId } });
      expect(await db.servedPrompt.count({ where: { kind: 'BIND' } })).toBe(0);
      await db.appRun.delete({ where: { id: runId } });
      expect(await db.servedPrompt.count({ where: { kind: 'RUN' } })).toBe(0);
      await db.node.delete({ where: { id: chatNodeId } });
      expect(await db.servedPrompt.count()).toBe(0);
    });

    it('keeps a chat record when its node is only soft-deleted', async () => {
      await chat();
      await db.node.update({ where: { id: chatNodeId }, data: { deletedAt: new Date() } as never });
      expect(await db.servedPrompt.count()).toBe(1);
    });
  });
});
