/** #1655 version-store primitives. Public compile/publish wiring and run
 * execution follow separately; callers supply the trusted live-registry and
 * environment resolver, never a client-supplied environment assertion.
 */
import { GraphQLError } from 'graphql';
import type { App, AutomationVersion } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { hasAppRelationship } from '../auth/appRelationship.js';
import { isStrictOwner } from '../auth/strictOwner.js';
import { isRunPrincipal } from '../auth/runPrincipal.js';
import { withAuthorizedTx } from '../../api/graphql/schema/authorizedTx.js';
import { requireOwnerOrOrgRole, type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { automationVersionHash, canonicalizeAutomationJson, validateCompiledAutomation, type CompiledAutomation } from './format.js';

export interface AutomationValidationContext {
  environment: CompiledAutomation['environment'];
  resolvesTool: (name: string) => boolean;
  resolvesCredential: (ref: string) => boolean;
}
export type AutomationValidationResolver = (ctx: Context, app: App, input: unknown) => Promise<AutomationValidationContext>;
const refuse = (code: string, message: string): never => { throw new GraphQLError(message, { extensions: { code } }); };
function requireHuman(ctx: Context): string {
  if (!ctx.userId || ctx.impersonation || isRunPrincipal(ctx)) return refuse('FORBIDDEN', 'An authenticated non-impersonated user is required.');
  return ctx.userId;
}
async function loadApp(ctx: Context, appId: string): Promise<App> {
  const app = await ctx.db.app.findFirst({ where: { id: appId, deletedAt: null, uninstalledAt: null } });
  if (!app) return refuse('NOT_FOUND', 'App not found.');
  return app;
}
function requireSameOwnership(current: App, observed: App): void {
  if (current.organizationId !== observed.organizationId || current.ownerUserId !== observed.ownerUserId) {
    refuse('FORBIDDEN', 'App ownership changed; reload and retry.');
  }
}
function anchorsFor(app: App) {
  return [
    { kind: 'app' as const, id: app.id },
    ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
    ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
  ];
}
async function validateCurrent(ctx: Context, app: App, input: unknown, resolve: AutomationValidationResolver) {
  // Bound and validate structure before consulting live catalogs. The second
  // pass below is mandatory: a declared name is not proof it resolves.
  const canonical = canonicalizeAutomationJson(input);
  const bounded = validateCompiledAutomation(input, { appId: app.id, resolvesTool: () => true, resolvesCredential: () => true });
  const live = await resolve(ctx, app, bounded);
  const object = validateCompiledAutomation(bounded, { appId: app.id, resolvesTool: live.resolvesTool, resolvesCredential: live.resolvesCredential });
  if (canonicalizeAutomationJson(object) !== canonical) refuse('AUTOMATION_HASH_MISMATCH', 'Validation must preserve the compiled object.');
  if (canonicalizeAutomationJson(object.environment) !== canonicalizeAutomationJson(live.environment)) {
    return refuse('AUTOMATION_ENVIRONMENT_DRIFT', 'The automation environment differs from the live environment.');
  }
  return object;
}
function decodeStored(version: AutomationVersion): unknown {
  let object: unknown;
  try { object = JSON.parse(version.compiledJson); } catch { return refuse('AUTOMATION_INVALID', 'Stored automation JSON is invalid.'); }
  if (canonicalizeAutomationJson(object) !== version.compiledJson || automationVersionHash(object) !== version.versionHash) {
    return refuse('AUTOMATION_HASH_MISMATCH', 'Stored automation hash does not match.');
  }
  return object;
}

/** Store immutable canonical code pending evidence. The live environment and
 * registry validation happens inside the authorization transaction.
 */
export async function publishAutomationVersion(ctx: Context, input: {
  appId: string; json: unknown; tier: 'PERSON' | 'APP'; runAsUserId?: string | null;
}, resolve: AutomationValidationResolver): Promise<AutomationVersion> {
  const publisher = requireHuman(ctx);
  const observed = await loadApp(ctx, input.appId);
  const runAsUserId = input.tier === 'PERSON' ? (input.runAsUserId ?? publisher) : null;
  if (!['APP', 'PERSON'].includes(input.tier) || (input.tier === 'APP' && input.runAsUserId != null) || !runAsUserId && input.tier === 'PERSON') {
    return refuse('AUTOMATION_TIER_MISMATCH', 'Automation tier and run-as identity do not match.');
  }
  await requireOwnerOrOrgRole(ctx, observed, 'ADMIN', 'app');
  let app = observed;
  return withAuthorizedTx(ctx, [
    ...anchorsFor(observed), ...(runAsUserId ? [{ kind: 'user' as const, id: runAsUserId }] : []),
  ], async txCtx => {
    app = await loadApp(txCtx, observed.id);
    requireSameOwnership(app, observed);
    await requireOwnerOrOrgRole(txCtx, app, 'ADMIN', 'app');
    if (runAsUserId && !(await hasAppRelationship(txCtx.db, app.id, runAsUserId))) {
      refuse('RELATIONSHIP_MISSING', 'The run-as user has no live App relationship.');
    }
  }, async (tx, txCtx) => {
    const object = await validateCurrent(txCtx, app, input.json, resolve);
    const entrySourceNodeId = object.nodes[object.entry].source.nodeId;
    // A dedicated allocator lock avoids upgrading the App SHARE row lock
    // held by withAuthorizedTx (two simultaneous upgrades would deadlock).
    const allocationKey = `automation-version:${app.id}:${entrySourceNodeId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${allocationKey}, 0))`;
    const previous = await tx.automationVersion.aggregate({ where: { appId: app.id, entrySourceNodeId }, _max: { number: true } });
    return tx.automationVersion.create({ data: {
      id: generateId(), appId: app.id, number: (previous._max.number ?? 0) + 1,
      entrySourceNodeId, compiledJson: canonicalizeAutomationJson(object), versionHash: automationVersionHash(object),
      sourceManifest: Object.keys(object.nodes).sort().map(key => object.nodes[key].source),
      tier: input.tier, runAsUserId, publishedBy: publisher,
    } });
  }, { timeout: 20000 });
}

async function observedVersion(ctx: Context, id: string) {
  requireHuman(ctx);
  const version = await ctx.db.automationVersion.findUnique({ where: { id } });
  if (!version) return refuse('NOT_FOUND', 'Automation version not found.');
  return { version, app: await loadApp(ctx, version.appId) };
}

/** DZ-3 bridge: person-tier evidence is only its run-as user's confirmation;
 * App-tier evidence is App management approval. Evidence binds the hash the
 * approver actually saw and is append-once. Reapproval requires a new version.
 */
export async function approveAutomationVersion(ctx: Context, id: string, expectedHash: string,
  resolve: AutomationValidationResolver): Promise<AutomationVersion> {
  const actor = requireHuman(ctx);
  const observed = await observedVersion(ctx, id);
  let current = observed.version; let app = observed.app;
  return withAuthorizedTx(ctx, anchorsFor(observed.app), async txCtx => {
    current = (await txCtx.db.automationVersion.findUnique({ where: { id } }))!;
    if (!current) refuse('NOT_FOUND', 'Automation version not found.');
    app = await loadApp(txCtx, current.appId);
    requireSameOwnership(app, observed.app);
    if (current.tier === 'PERSON') {
      if (!isStrictOwner(txCtx, current.runAsUserId)) refuse('FORBIDDEN', 'Only the run-as user may approve this version.');
      if (!(await hasAppRelationship(txCtx.db, current.appId, actor))) refuse('RELATIONSHIP_MISSING', 'The run-as user has no live App relationship.');
    } else { await requireOwnerOrOrgRole(txCtx, app, 'ADMIN', 'app'); }
    if (current.revokedAt) refuse('AUTOMATION_VERSION_REVOKED', 'Automation version is revoked.');
    if (expectedHash !== current.versionHash) refuse('AUTOMATION_HASH_MISMATCH', 'The approval hash does not match the version.');
  }, async (tx, txCtx) => {
    await validateCurrent(txCtx, app, decodeStored(current), resolve);
    if (current.approvedAt) return current;
    return tx.automationVersion.update({ where: { id }, data: { approvalHash: current.versionHash, approvedBy: actor, approvedAt: new Date() } });
  }, { afterLock: async tx => { await tx.$queryRaw`SELECT id FROM automation_versions WHERE id = ${id} FOR UPDATE`; } });
}

/** DAH: revocation only lowers authority. Return a receipt without exposing
 * another person's compiled code to an App administrator.
 */
export async function revokeAutomationVersion(ctx: Context, id: string): Promise<{ id: string; revokedAt: Date; revokedBy: string }> {
  const actor = requireHuman(ctx);
  const observed = await observedVersion(ctx, id);
  let current = observed.version;
  return withAuthorizedTx(ctx, anchorsFor(observed.app), async txCtx => {
    current = (await txCtx.db.automationVersion.findUnique({ where: { id } }))!;
    if (!current) refuse('NOT_FOUND', 'Automation version not found.');
    const app = await loadApp(txCtx, current.appId);
    requireSameOwnership(app, observed.app);
    if (!isStrictOwner(txCtx, current.runAsUserId)) await requireOwnerOrOrgRole(txCtx, app, 'ADMIN', 'app');
  }, async tx => {
    if (!current.revokedAt) current = await tx.automationVersion.update({ where: { id }, data: { revokedAt: new Date(), revokedBy: actor } });
    return { id: current.id, revokedAt: current.revokedAt!, revokedBy: current.revokedBy! };
  }, { afterLock: async tx => { await tx.$queryRaw`SELECT id FROM automation_versions WHERE id = ${id} FOR UPDATE`; } });
}
