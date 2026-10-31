import { createHash, createHmac } from 'node:crypto';
import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient, RateLimitPolicy, RateLimitManifest } from '../../generated/prisma/index.js';
import { DEFAULTS, RATE_CLASSES, RateConfigurationError, readRateKeys, keyFingerprint, seedLimits, type FieldClass } from './config.js';
import type { RateIdentity } from './identity.js';
import { generateId } from '../id.js';

export { RateConfigurationError } from './config.js';
export type { FieldClass } from './config.js';
export type RateTx = Prisma.TransactionClient;
// PostgreSQL two-int lock space is disjoint from the one-bigint subject lock space.
const RETENTION_MS = 86400_000;
const MAX_COUNT = 9223372036854775807n;
/** Only availability failures are policy-outage decisions; schema/programming faults are never exhaustion. */
function storeUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e=error as {code?:unknown;errorCode?:unknown;meta?:{code?:unknown}};
  const code=String(e.code ?? e.errorCode ?? '');
  if (['P1001','P1002','P1008','P1017','P2024'].includes(code)) return true;
  const sqlState=String(e.meta?.code ?? '');
  return code==='P2010' && (sqlState.startsWith('08') || ['53300','57P01','57P02','57P03'].includes(sqlState));
}
function unknownMode(fieldClass: FieldClass): RateDecision {
  observe(fieldClass,'store','UNKNOWN');
  if (fieldClass === 'CREDENTIALS' || fieldClass === 'OUTBOUND') {
    // Holger #1793: unreadable policy refuses fail-closed classes even during LOG_ONLY; never use a cached mode.
    throw new RateLimited(fieldClass, DEFAULTS[fieldClass].windowSeconds);
  }
  return { admitted: true, retryAfterSeconds: 0, fieldClass };
}
export async function configFence(tx: RateTx, exclusive = false) {
  if (exclusive) await tx.$executeRaw`SELECT pg_advisory_xact_lock(1793, 0)`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(1793, 0)`;
}
/** One actual-key numeric order, including aliases/absent buckets; never includes a window. */
function lockKey(key: string): bigint { return createHash('sha256').update('rate-limit:subject:'+key).digest().readBigInt64BE(); }
async function subjectLocks(tx: RateTx, keys: string[]) {
  const ordered = [...new Set(keys.map(k => lockKey(k)))].sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
  for (const key of ordered) await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;
}
function validateManifest(manifest: RateLimitManifest | null) {
  const ring = readRateKeys();
  if (!manifest || manifest.keyIds.length < 1 || manifest.keyIds.length > 2 || new Set(manifest.keyIds).size !== manifest.keyIds.length) throw new RateConfigurationError();
  const fingerprints = manifest.fingerprints as Record<string, string>;
  for (const id of manifest.keyIds) {
    const key = ring.keys.get(id);
    if (!key || fingerprints[id] !== keyFingerprint(key)) throw new RateConfigurationError();
  }
  return { manifest, keys: ring.keys };
}
export function validatePolicy(p: RateLimitPolicy): RateLimitPolicy {
  if (!RATE_CLASSES.includes(p.fieldClass as FieldClass) || !['LOG_ONLY','ENFORCING'].includes(p.enforcementMode) ||
    p.windowSeconds !== DEFAULTS[p.fieldClass as FieldClass].windowSeconds || p.retentionSeconds !== 86400 ||
    [p.principalLimit,p.keyLimit,p.ipLimit,p.version].some(n => !Number.isSafeInteger(n) || n < 1 || n > 2147483647)) throw new RateConfigurationError();
  return p;
}
/** Boot/first admin use only. Env seeds missing rows, never overwrites DB state; invalid configured keys refuse readiness. */
export async function seedRateConfig(tx: RateTx) {
  await configFence(tx, true);
  const ring = readRateKeys();
  const manifest = await tx.rateLimitManifest.findUnique({ where: { id: 'global' } });
  if (!manifest && (await tx.rateLimitPolicy.count() || await tx.rateLimitBucket.count() || await tx.rateLimitPolicyAudit.count())) throw new RateConfigurationError();
  if (!manifest) await tx.rateLimitManifest.create({ data: { id: 'global', keyIds: [ring.current], fingerprints: { [ring.current]: keyFingerprint(ring.keys.get(ring.current)!) } } });
  for (const fieldClass of RATE_CLASSES) {
    const exists = await tx.rateLimitPolicy.findUnique({ where: { fieldClass } });
    if (!exists && manifest) throw new RateConfigurationError();
    if (!exists) await tx.rateLimitPolicy.create({ data: { fieldClass, ...seedLimits(fieldClass) } });
    else validatePolicy(exists);
  }
  if (await tx.rateLimitPolicy.count() !== RATE_CLASSES.length) throw new RateConfigurationError();
  validateManifest(await tx.rateLimitManifest.findUnique({ where: { id: 'global' } }));
}
export async function assertRateReadiness(db: PrismaClient) {
  readRateKeys();
  await db.$transaction(seedRateConfig);
}
/** Read-only health/readiness validation, including a manifest changed by a live overlap transition. */
export async function checkRateConfiguration(db: PrismaClient): Promise<void> {
  readRateKeys();
  try {
    await db.$transaction(async tx => {
      await configFence(tx);
      validateManifest(await tx.rateLimitManifest.findUnique({ where: { id: 'global' } }));
      const policies=await tx.rateLimitPolicy.findMany();
      if (policies.length !== RATE_CLASSES.length) throw new RateConfigurationError();
      for (const p of policies) validatePolicy(p);
    });
  } catch(error) {
    // A transient policy-store read error does not take fail-open callers out of service (R209).
    // The health route independently checks the ordinary application DB pool.
    if (!storeUnavailable(error)) throw error;
  }
}
export class RateLimited extends GraphQLError {
  constructor(fieldClass: FieldClass, retryAfterSeconds: number) {
    super('Too many requests.', { extensions: { code: 'RATE_LIMITED', fieldClass, retryAfterSeconds } });
  }
}
/** Privacy-bounded metrics only. No subject, token, proof, IP or request text can enter here. */
function observe(fieldClass: FieldClass, dimension: 'principal'|'key'|'ip'|'store', mode: string) {
  console.info('rate-limit-observation', { fieldClass, dimension, mode });
}
/** Policy read failures are separate from malformed configuration; rollback restores a usable caller transaction. */
async function policySnapshot(tx: RateTx, fieldClass: FieldClass) {
  await tx.$executeRawUnsafe('SAVEPOINT rate_limit_policy');
  try {
    if (!await tx.rateLimitManifest.findUnique({ where: { id: 'global' } })) await seedRateConfig(tx);
    await configFence(tx);
    const p=await tx.rateLimitPolicy.findUnique({ where: { fieldClass } });
    if (!p) throw new RateConfigurationError();
    validatePolicy(p);
    const {manifest,keys}=validateManifest(await tx.rateLimitManifest.findUnique({ where: { id: 'global' } }));
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT rate_limit_policy');
    return {p,manifest,keys};
  } catch(error) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rate_limit_policy');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT rate_limit_policy');
    if (storeUnavailable(error)) return null;
    throw error;
  }
}
function validateIdentity(identity: RateIdentity) {
  if (!identity.principal && !identity.ip) throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
  if (identity.internal && (!identity.principal?.startsWith('APP:') || identity.key || identity.ip)) throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
}
export interface RateDecision { admitted: boolean; retryAfterSeconds: number; fieldClass: FieldClass }
/** Caller supplies the transaction: consent proof and counters share commit/rollback. */
export async function admitRateInTx(tx: RateTx, fieldClass: FieldClass, identity: RateIdentity): Promise<RateDecision> {
  readRateKeys(); // Configuration/readiness failures are never a store-outage fail-open path.
  validateIdentity(identity);
  const snapshot=await policySnapshot(tx,fieldClass);
  if (!snapshot) return unknownMode(fieldClass);
  const {p,manifest,keys}=snapshot;
  const closed = fieldClass === 'CREDENTIALS' || fieldClass === 'OUTBOUND';
  if (!identity.ip && !identity.internal) {
    observe(fieldClass, 'ip', p.enforcementMode);
    if (closed && p.enforcementMode === 'ENFORCING') throw new RateLimited(fieldClass, p.windowSeconds);
  }
  const dimensions: Array<{ dim: 'principal'|'key'|'ip'; subject: string; limit: number }> = [];
  if (identity.principal) dimensions.push({ dim: 'principal', subject: identity.principal, limit: p.principalLimit });
  if (identity.key) dimensions.push({ dim: 'key', subject: identity.key, limit: p.keyLimit });
  if (identity.ip) dimensions.push({ dim: 'ip', subject: identity.ip, limit: p.ipLimit });
  const aliases = dimensions.map(d => ({ ...d, aliases: manifest.keyIds.map(id => `${id}:${createHmac('sha256', keys.get(id)!).update(JSON.stringify(['v1',fieldClass,d.dim,d.subject])).digest('hex')}`) }));
  // A savepoint contains an aborted SQL statement before a fail-open decision; no partial counter writes survive.
  await tx.$executeRawUnsafe('SAVEPOINT rate_limit_admission');
  try {
    await subjectLocks(tx, aliases.flatMap(d => d.aliases.map(s => `${fieldClass}:${d.dim}:${s}`)));
    const [{ now }] = await tx.$queryRaw<Array<{now: Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    const windowStart = new Date(Math.floor(now.getTime() / (p.windowSeconds * 1000)) * p.windowSeconds * 1000);
    const retry = Math.max(1, Math.ceil((windowStart.getTime() + p.windowSeconds*1000 - now.getTime()) / 1000));
    const counts: Array<{ dim: typeof aliases[number]; used: bigint }> = [];
    let over = false;
    for (const d of aliases) {
      const rows = await tx.rateLimitBucket.findMany({ where: { fieldClass, dimension: d.dim, subject: { in: d.aliases }, windowStart }, select: { used: true } });
      const used = rows.reduce((m,r) => r.used > m ? r.used : m, 0n);
      counts.push({ dim: d, used });
      if (used >= BigInt(d.limit)) { over = true; observe(fieldClass, d.dim, p.enforcementMode); }
    }
    if (over && p.enforcementMode === 'ENFORCING') throw new RateLimited(fieldClass, retry);
    for (const { dim: d, used } of counts) for (const subject of d.aliases) {
      if (used >= MAX_COUNT) throw new RateConfigurationError();
      await tx.rateLimitBucket.upsert({ where: { fieldClass_dimension_subject_windowStart: { fieldClass, dimension: d.dim, subject, windowStart } },
        create: { id: generateId(), fieldClass, dimension: d.dim, subject, windowStart, used: used+1n, expiresAt: new Date(windowStart.getTime()+p.windowSeconds*1000+RETENTION_MS) }, update: { used: used+1n } });
    }
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT rate_limit_admission');
    return { admitted: true, retryAfterSeconds: over ? retry : 0, fieldClass };
  } catch (error) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rate_limit_admission');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT rate_limit_admission');
    if (error instanceof RateLimited || error instanceof RateConfigurationError || !storeUnavailable(error)) throw error;
    observe(fieldClass, 'store', p.enforcementMode);
    if (p.enforcementMode === 'ENFORCING' && closed) throw new RateLimited(fieldClass, p.windowSeconds);
    return { admitted: true, retryAfterSeconds: 0, fieldClass };
  }
}
export async function admitRate(db: PrismaClient, fieldClass: FieldClass, identity: RateIdentity) {
  readRateKeys();
  validateIdentity(identity);
  if (!RATE_CLASSES.includes(fieldClass)) throw new RateConfigurationError();
  try { return await db.$transaction(tx => admitRateInTx(tx, fieldClass, identity)); }
  catch (error) {
    if (!storeUnavailable(error)) throw error;
    return unknownMode(fieldClass);
  }
}
/** Cleanup uses the same config→subject order and checks expiry after waits; never refreshes a refusal. */
export async function cleanupRateBuckets(db: PrismaClient, take = 200) {
  return db.$transaction(async tx => {
    await configFence(tx);
    const candidates = await tx.rateLimitBucket.findMany({ where: { expiresAt: { lt: new Date() } }, take: Math.min(200,Math.max(1,take)), orderBy: { expiresAt: 'asc' } });
    await subjectLocks(tx,candidates.map(r => `${r.fieldClass}:${r.dimension}:${r.subject}`));
    const [{now}] = await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    return tx.rateLimitBucket.deleteMany({ where: { id: { in: candidates.map(r => r.id) }, expiresAt: { lt: now } } });
  });
}
