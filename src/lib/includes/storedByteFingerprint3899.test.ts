/** #3899 (#2494): one shared stored-byte fingerprint fragment for capture and verification. R1 stays dormant. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateDataKey } from '../crypto.js';
import { encryptNodeFields } from '../nodeCrypto.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import { withIncludeHistoryTransaction, includeHistoryClient } from './includeHistoryFence.js';
import { replaceStructuralReferences } from './structuralReferences.js';
import { verifyIncludeCoverage } from './verifyIncludeCoverage.js';

let memory: { id: string };
let source: { id: string };
const fenced = <T>(work: (tx: Parameters<typeof replaceStructuralReferences>[0]) => Promise<T>) =>
  withIncludeHistoryTransaction(db, context => work(includeHistoryClient(context)));
const capture = (text: string | null) => fenced(tx => replaceStructuralReferences(tx, source.id, text));
const verify = () => fenced(verifyIncludeCoverage);
const setStored = (content: string | null) => db.node.update({ where: { id: source.id }, data: { content } });
const expected = (stored: string | null) =>
  createHash('sha256').update(stored === null ? 'null' : `text:${stored}`, 'utf8').digest('hex');
const coverage = () => db.includeSourceCoverage.findUniqueOrThrow({ where: { includerId: source.id } });

beforeEach(async () => {
  await cleanDb(db);
  await db.includeRetentionGeneration.deleteMany();
  const org = await db.organization.create({ data: { name: 'Fp3899', urn: 'fp3899.example' } });
  memory = await db.memory.create({ data: { organizationId: org.id, name: 'Sources', urn: `${org.urn}:sources`, class: 'knowledge' } });
  source = await db.node.create({ data: { memoryId: memory.id, loc: 'source', name: 'Source' } });
  await db.includeRetentionGeneration.create({ data: { id: 'singleton', state: 'ACTIVE', verifiedBindingGeneration: 0 } });
});

describe('stored-byte fingerprint (#3899)', () => {
  const sealedBytes = () => {
    sessionKeyCache.set('fp3899-sealed', memory.id, generateDataKey());
    const sealed = encryptNodeFields({ content: 'secret {{> nowhere}}' }, { id: memory.id, isEncrypted: true });
    sessionKeyCache.clear();
    return sealed.content as string;
  };

  it('capture and verification agree on NULL, empty, Unicode and opaque sealed stored bytes', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
    const sealed = sealedBytes();
    for (const stored of [null, '', 'héllo \u{1F600} 日本語', sealed]) {
      await setStored(stored);
      // The supplied plaintext deliberately differs from the stored bytes: only stored bytes are fingerprinted.
      await capture('plaintext differs from stored');
      expect((await coverage()).sourceContentFingerprint).toBe(expected(stored));
      expect(await verify()).toBe(true);
    }
  });

  it('NULL, empty and the literal text "null" fingerprint differently', async () => {
    const seen = new Set<string>();
    for (const stored of [null, '', 'null']) {
      await setStored(stored);
      await capture(null);
      seen.add((await coverage()).sourceContentFingerprint);
    }
    expect(seen.size).toBe(3);
  });

  it('a changed stored value invalidates verification', async () => {
    await setStored('one');
    await capture('one');
    expect(await verify()).toBe(true);
    for (const next of ['two', '', null]) {
      await setStored(next);
      expect(await verify()).toBe(false);
      await setStored('one');
      expect(await verify()).toBe(true);
    }
  });

  it('selects no stored content into the application, and never asks for a key', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
    await setStored(sealedBytes());
    const key = vi.spyOn(sessionKeyCache, 'getByMemoryId').mockImplementation(() => { throw new Error('no key permitted'); });
    try {
      await capture(null);
      expect(await verify()).toBe(true);
      expect(key).not.toHaveBeenCalled();
    } finally { key.mockRestore(); }
  });

  it('deduplication: both call sites use the one fragment and carry no private copy', async () => {
    for (const file of ['structuralReferences.ts', 'verifyIncludeCoverage.ts']) {
      const text = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(text).toContain('storedByteFingerprintSql(');
      expect(text).not.toMatch(/sha256\(|convert_to\(/);
    }
    const shared = await readFile(new URL('./storedByteFingerprint.ts', import.meta.url), 'utf8');
    expect(shared.match(/sha256\(/g)).toHaveLength(1);
  });
});
