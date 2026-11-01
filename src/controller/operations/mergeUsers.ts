import { randomBytes } from 'crypto';
import { GraphQLError } from 'graphql';
import { AuthoritySnapshotStale, lockAuthorityAnchors } from '../../lib/auth/authorityAnchors.js';
import { consumeUserMergeConsent, mergeConsentAlreadyApplied } from '../../lib/userMergeConsent.js';
import { Prisma, type PrismaClient, type User } from '../../generated/prisma/index.js';
import { mergeOwnerNamespacedUrns } from '../../lib/mergeOwnerNamespacedUrns.js';
import { releasePrincipal } from '../../lib/principal/mintPrincipal.js';
import { waitForSerializationRetry } from '../../lib/serializableRetry.js';

// Non-conflicting ownership, attribution, credential, and history links. An optional third element names a
// lineage column: rows that carry one stay put (see the #1897 note in mergeUsers).
export const DIRECT_USER_REFERENCES: ReadonlyArray<readonly [string, string] | readonly [string, string, string]> = [
  ['memories', 'user_id'],
  ['sessions', 'user_id'],
  ['usage_events', 'user_id'],
  ['org_member_invitations', 'recipient_user_id'],
  ['user_invitation_activations', 'user_id'],
  ['exchange_connections', 'user_id'],
  ['connection_grants', 'granted_by_user_id'],
  ['principal_grants', 'principal_id'],
  ['user_api_keys', 'user_id', 'origin_sign_in_id'],
  ['auth_codes', 'user_id', 'sign_in_id'],
  ['auth_handoff_codes', 'user_id', 'sign_in_id'],
  ['app_runs', 'user_id'],
  ['agent_schedules', 'user_id'],
  ['agent_webhooks', 'user_id'],
  ['assets', 'uploaded_by'],
  ['agents', 'editor_lock_user_id'],
  // #1591: the approval of record on the live node (no FK, so nothing
  // else would carry it). The revision-row copy is rewritten above.
  ['nodes', 'approved_by'],
  ['nodes', 'minted_by'],
  // #1705: a task's owner and assignee are authorization identities
  // (cor:agt:050:08/:09), so they follow the merged person.
  // agent_team_events' actor / acknowledger ids are deliberately NOT
  // here: the stream is append-only (a trigger refuses the UPDATE), and
  // an event is a sealed record of who acted at the time — the
  // automation_versions precedent (#1696).
  ['agent_tasks', 'owner_user_id'],
  ['tickers', 'owner_user_id'],
  ['agent_tasks', 'assignee_user_id'],
  // #1706: who last set an availability record (mutable rows, not the
  // append-only stream). An alarm's `chain` is sealed JSON on the stream,
  // like the actor ids above, and is not rewritten.
  ['worker_availability', 'set_by_user_id'],
  ['model_family_availability', 'set_by_user_id'],
];

/**
 * Tables whose audit actor columns carry User.id values in normal writes.
 * All four audit actor column names are covered, including Organization's
 * creator: spec 048 retired auto-personal organizations, so that stamp is no
 * longer a personal-workspace discriminator.
 *
 * Values such as `app:<id>` / `github:<login>` are untouched because every
 * update below matches the source User.id exactly.
 */
export const AUDIT_USER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  org_members: ['created_by', 'updated_by', 'deleted_by'],
  memories: ['created_by', 'updated_by', 'deleted_by'],
  nodes: ['created_by', 'updated_by', 'deleted_by'],
  edges: ['created_by', 'updated_by', 'deleted_by'],
  pending_edges: ['created_by', 'updated_by', 'deleted_by'],
  sessions: ['created_by', 'updated_by', 'deleted_by'],
  usage_events: ['created_by', 'updated_by', 'deleted_by'],
  agents: ['created_by', 'updated_by', 'deleted_by'],
  agent_memory_items: ['created_by', 'updated_by', 'deleted_by'],
  memory_licenses: ['created_by', 'updated_by', 'deleted_by'],
  memory_subscriptions: ['created_by', 'updated_by', 'deleted_by'],
  hadron_server: ['created_by', 'updated_by', 'deleted_by'],
  ai_service_configs: ['created_by', 'updated_by'],
  model_groups: ['created_by', 'updated_by'],
  server_log: ['created_by', 'updated_by'],
  memory_log: ['created_by', 'updated_by'],
  org_member_invitations: ['created_by', 'updated_by', 'deleted_by'],
  user_invitations: ['created_by', 'updated_by', 'deleted_by'],
  user_invitation_activations: ['created_by', 'updated_by', 'deleted_by'],
  node_revisions: ['created_by'],
  pending_setups: ['created_by'],
  exchange_connections: ['created_by', 'updated_by', 'deleted_by'],
  connection_grants: ['created_by', 'updated_by', 'deleted_by'],
  principal_grants: ['created_by', 'updated_by', 'deleted_by'],
  slack_connections: ['created_by', 'deleted_by'],
  mcp_servers: ['created_by', 'updated_by'],
  home_assistant_instances: ['created_by', 'updated_by'],
  apps: ['created_by', 'updated_by', 'deleted_by'],
  app_keys: ['created_by'],
  app_members: ['created_by', 'updated_by'],
  agent_org_grants: ['created_by', 'updated_by', 'revoked_by'],
  agent_imports: ['created_by'],
  agent_subscriptions: ['created_by', 'updated_by', 'revoked_by'],
  app_log: ['created_by', 'updated_by'],
  app_agents: ['created_by', 'updated_by'],
  memory_shares: ['created_by', 'updated_by'],
  memory_members: ['created_by', 'updated_by'],
  user_api_keys: ['created_by'],
  oauth_clients: ['created_by', 'updated_by', 'deleted_by'],
  auth_codes: ['created_by'],
  app_runs: ['created_by'],
  agent_schedules: ['created_by', 'updated_by', 'deleted_by'],
  ai_model_prices: ['created_by', 'updated_by', 'deleted_by'],
  credit_ledger_entries: ['created_by', 'updated_by', 'deleted_by'],
  agent_webhooks: ['created_by', 'updated_by', 'deleted_by'],
  // #1325 — the memory config tables.
  memory_configs: ['created_by', 'updated_by'],
  node_role_rules: ['created_by', 'updated_by'],
  memory_config_templates: ['created_by', 'updated_by', 'deleted_by'],
  channels: ['created_by', 'updated_by', 'deleted_by'],
  dashboard_widgets: ['created_by', 'updated_by'],
  organizations: ['created_by', 'updated_by', 'deleted_by'],
  register_entries: ['created_by', 'updated_by', 'deleted_by'],
  resend_senders: ['created_by', 'updated_by'],
  scopes: ['created_by', 'updated_by', 'deleted_by'],
  secrets: ['created_by', 'updated_by'],
  urn_aliases: ['created_by'],
  users: ['created_by', 'updated_by', 'deleted_by'],
  // #1416 (R204): `retired_by` is the retirer's exact User.id; it follows the survivor like every actor stamp.
  workers: ['created_by', 'updated_by', 'retired_by'],
  // #1705 — agent tasks. `assigned_by` is the assignment's audit actor.
  agent_tasks: ['created_by', 'updated_by', 'assigned_by'],
  // #1747 — tickers: who made, changed and deleted one; who subscribed a worker; who
  // changed wake settings; who gave and who revoked a grant, and the person behind each grant use.
  tickers: ['created_by', 'updated_by', 'deleted_by'],
  // #2024 — who declared, changed and removed an Agent ticker template.
  agent_ticker_templates: ['created_by', 'updated_by', 'deleted_by'],
  ticker_subscriptions: ['created_by', 'ended_by', 'via_grant_person_id', 'ended_via_grant_person_id'],
  worker_wake_settings: ['updated_by'],
  app_grants: ['granted_by', 'revoked_by'],
  app_key_scopes: ['granted_by_user_id', 'revoked_by_user_id'],
  // #1706 — who last changed an App's stall windows.
  agent_task_stall_schedule: ['updated_by'],
};

/**
 * A merge that lost a race with a concurrent write and must be re-run from a
 * fresh snapshot. The one raised here: a USER template renamed after the merge
 * planned its collision renames, so a planned name is now taken (#1369 review,
 * Codex P2). Template update/delete do not take the owner-row lock the merge
 * holds, so the plan can go stale; re-planning is the fix, not a stronger lock.
 */
class MergeRaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MergeRaceError';
  }
}

/**
 * How many times the SERIALIZABLE merge is re-run (three retries, four total attempts) after a serialization abort
 * (P2034) or a {@link MergeRaceError}. The body touches only the database, so
 * a bounded re-run is safe (conventions:count-then-act-serializable-txn, as in
 * deleteUserAccount).
 */
const MERGE_RETRIES = 3;

/** A unique violation from a raw statement (Prisma wraps it as P2010 / SQLSTATE 23505). */
function isUniqueViolation(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code === 'P2002') return true;
  return e.code === 'P2010' && ((e.meta as { code?: string } | undefined)?.code === '23505' || /23505/.test(e.message));
}

/**
 * A serialization abort: P2034 for the transaction, or P2010 / SQLSTATE 40001
 * when a raw statement (the account FOR UPDATE) hits it. The second form is
 * how a concurrent execution of the same proof loses (#1770).
 */
function isSerializationAbort(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return e.code === 'P2034' || (e.code === 'P2010' && (e.meta as { code?: string } | undefined)?.code === '40001');
}

/** The template-name grammar's length cap (`validateAiConfigName`). */
const TEMPLATE_NAME_MAX = 64;

/**
 * A deterministic, grammar-valid template name not in `taken`: `<name>-merged`,
 * then `<name>-merged-2`, `-3`, … The base is trimmed so the result stays
 * within the name grammar's 64 characters; a trimmed base keeps only grammar
 * characters, so the result is always a valid name (#1325 part c, Holger's
 * collision ruling 2026-09-26).
 */
export function collisionFreeTemplateName(name: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '-merged' : `-merged-${n}`;
    const candidate = name.slice(0, TEMPLATE_NAME_MAX - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Move the source's USER-owned config templates to the target (#1325 part c).
 * Audit-stamp reassignment alone would leave them owned by a tombstone.
 *
 * Holger's collision ruling (2026-09-26): preserve both. The target's template
 * keeps its name; an incoming LIVE template whose name the target already uses
 * is renamed deterministically (`collisionFreeTemplateName`). Ids, rules and
 * copied-config provenance are untouched. Uniqueness covers live rows only, so
 * soft-deleted templates move as they are. Org/App/Server-owned templates are
 * never re-owned here — only `owner_user_id` rows move.
 *
 * Race-free under the merge transaction: both user rows are held FOR UPDATE,
 * and a template create takes its owner's row FOR SHARE first
 * (`lockLiveOwner`), so neither account can gain a template mid-merge.
 */
async function mergeUserOwnedTemplates(
  tx: Prisma.TransactionClient,
  sourceUserId: string,
  targetUserId: string,
): Promise<void> {
  const [incoming, existing] = await Promise.all([
    tx.memoryConfigTemplate.findMany({
      where: { ownerUserId: sourceUserId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
    tx.memoryConfigTemplate.findMany({ where: { ownerUserId: targetUserId, deletedAt: null }, select: { name: true } }),
  ]);
  const targetNames = new Set(existing.map((t) => t.name));
  // Every live name on EITHER side is taken, so a rename can never land on a
  // source template's own name that moves later in this loop.
  const taken = new Set([...targetNames, ...incoming.map((t) => t.name)]);
  for (const t of incoming) {
    const name = targetNames.has(t.name) ? collisionFreeTemplateName(t.name, taken) : t.name;
    taken.add(name);
    try {
      await tx.$executeRaw`UPDATE memory_config_templates
        SET owner_user_id = ${targetUserId}, name = ${name}, revision = revision + 1, updated_at = now()
        WHERE id = ${t.id}`;
    } catch (e) {
      // The plan was built from this transaction's snapshot; a unique hit
      // means a concurrent write took a planned name. Re-plan, don't fail.
      if (isUniqueViolation(e)) throw new MergeRaceError(`template name '${name}' was taken concurrently`, { cause: e });
      throw e;
    }
  }
  await tx.$executeRaw`UPDATE memory_config_templates
    SET owner_user_id = ${targetUserId}, revision = revision + 1, updated_at = now()
    WHERE owner_user_id = ${sourceUserId} AND deleted_at IS NOT NULL`;
}

export interface MergeUsersArgs {
  consentProof?: string;
  sourceUserId: string;
  targetUserId: string;
  actorUserId?: string | null;
  /**
   * Whether the target may inherit the source's global `User.roles` (platform
   * ADMIN/OWNER etc). ONLY a platform admin may union roles — otherwise an org
   * admin authorized to merge two of their members could smuggle a source
   * account's platform privileges onto the target (privilege escalation). When
   * false, the target keeps its own roles and the source's are dropped with the
   * tombstone.
   */
  mergeGlobalRoles?: boolean;
}

/**
 * Fold one User into another, with the target surviving.
 *
 * Collision rule: target wins non-combinable values. Source-only scalar
 * identities fill empty target fields; roles and ordered access grants keep
 * the strongest live entitlement so merging cannot leave an organization or
 * group memory ownerless. Source-only relationships move. The source is
 * soft-deleted after all references have moved; login-identity fields are
 * cleared so their unique values can belong to the target.
 */
export async function mergeUsers(
  db: PrismaClient,
  { sourceUserId, targetUserId, actorUserId, mergeGlobalRoles = false, consentProof }: MergeUsersArgs,
): Promise<User> {
  // Defense-in-depth: the sole production caller (the mergeUsers resolver)
  // already rejects source === target with MERGE_SOURCE_EQUALS_TARGET, but this
  // operation is exported — guard here too so a direct or future caller can't
  // clear every unique field and then tombstone a single account by merging it
  // into itself.
  if (sourceUserId === targetUserId) {
    throw new Error('mergeUsers: source and target must be different users');
  }
  let aborted = false;
  for (let attempt = 1; ; attempt++) {
    try {
      return await runMergeTxn(db, { sourceUserId, targetUserId, actorUserId, mergeGlobalRoles, consentProof });
    } catch (e) {
      const serialization = isSerializationAbort(e);
      aborted ||= serialization;
      if ((e instanceof MergeRaceError || e instanceof AuthoritySnapshotStale || serialization) && attempt <= MERGE_RETRIES) {
        await waitForSerializationRetry(attempt);
        continue;
      }
      // #1770 (cor:api:010:02): after losing a race, if the winner was a merge
      // of this very proof, say so with a typed refusal; never surface the raw
      // 40001 or the tombstoned source the re-run meets.
      if (aborted && consentProof && await mergeConsentAlreadyApplied(db, consentProof, sourceUserId, targetUserId, actorUserId))
        throw new GraphQLError('This merge was already applied by a concurrent request.',
          { extensions: { code: 'MERGE_ALREADY_APPLIED' } });
      throw e;
    }
  }
}

/**
 * #1706 (Diego's P2 on #1720): refuse a merge while either account is named in
 * the owner chain of an UNACKNOWLEDGED agent-task alarm.
 *
 * An alarm's `chain` is sealed when it is raised. The event is append-only
 * (prisma/agent-task-invariants.sql), so a merge cannot rewrite it. Yet the
 * chain is authorization state: `acknowledgeAlarm` admits only a party named
 * in it. Merging S into T would leave T unable to acknowledge an alarm only S
 * could, and S could no longer sign in, so nobody could stop its escalation.
 * Merge-aware identity (#1715, `user_merges`) so far covers decisions only, so
 * such a merge is still refused; `acknowledgeAlarm` could follow the chain the
 * same way (src/lib/userMerges.ts `identitiesOf`). An ACKNOWLEDGED alarm strands
 * nothing, because the acknowledgement is its one remaining act, so it does
 * not block.
 *
 * The refusal carries a COUNT only. The merging admin may not be able to read
 * the Apps those alarms belong to, so no task, App or event id is disclosed.
 *
 * RACE. The stall evaluator raises an alarm in a SERIALIZABLE transaction
 * (src/lib/agentTasks/stall.ts `raiseStallAlarm`) that reads the owner rows of
 * the chain. This guard reads `agent_team_events`, and the merge later writes
 * those owner rows. An alarm raised concurrently with a merge therefore forms
 * a read-write cycle that Postgres aborts on one side. A raise that loses
 * retries on the evaluator's next pass, and sees the merged owner. A merge
 * that loses retries (P2034) and meets the new alarm here.
 */
async function refuseUsersInOpenAlarmChains(
  tx: Prisma.TransactionClient,
  sourceUserId: string,
  targetUserId: string,
): Promise<void> {
  const [{ count }] = await tx.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM agent_team_events
    WHERE severity = 'alarm' AND acknowledged_at IS NULL
      AND (chain @> ${JSON.stringify([{ userId: sourceUserId }])}::jsonb
        OR chain @> ${JSON.stringify([{ userId: targetUserId }])}::jsonb)`;
  if (count > 0) {
    throw new GraphQLError(
      `mergeUsers is refused: these accounts own ${count} unacknowledged agent-task alarm${count === 1 ? '' : 's'}, ` +
        'whose owner chains cannot follow a merge yet. Acknowledge them first, then merge.',
      { extensions: { code: 'MERGE_USER_IN_OPEN_ALARMS', alarmCount: count } },
    );
  }
}

/**
 * #1416: a SERIALIZABLE merge keeps the snapshot it took before it waited on
 * the source's authority anchor (findings:serializable-advisory-wait-keeps-old-snapshot).
 * A start, stop or retirement that committed during that wait left impersonation
 * or worker rows the merge's UPDATEs cannot see. Compare the source's actor-row
 * set on the transaction and on a second connection (READ COMMITTED, sees the
 * commit); any difference re-runs the whole merge from a fresh snapshot, inside
 * {@link MERGE_RETRIES}. The source's anchor is held, so no participating writer
 * can commit between this read and the rewrites below.
 */
async function assertSourceActorRowsFresh(
  tx: Prisma.TransactionClient,
  db: PrismaClient,
  sourceUserId: string,
): Promise<void> {
  const rows = Prisma.sql`
    SELECT row_key FROM (
      SELECT 'imp:' || id || ':' || coalesce(ended_at::text, '') || ':' || coalesce(ended_by, '') AS row_key
        FROM impersonation_sessions
        WHERE admin_user_id = ${sourceUserId} OR target_user_id = ${sourceUserId} OR ended_by = ${sourceUserId}
      UNION ALL
      SELECT 'worker:' || id || ':' || coalesce(retired_at::text, '') FROM workers WHERE retired_by = ${sourceUserId}
    ) AS source_actor_rows ORDER BY row_key`;
  const snapshot = await tx.$queryRaw<Array<{ row_key: string }>>(rows);
  const fresh = await db.$queryRaw<Array<{ row_key: string }>>(rows);
  if (snapshot.length !== fresh.length || snapshot.some((row, i) => row.row_key !== fresh[i].row_key)) {
    throw new AuthoritySnapshotStale();
  }
}

/** The single SERIALIZABLE merge transaction {@link mergeUsers} retries. */
async function runMergeTxn(
  db: PrismaClient,
  { sourceUserId, targetUserId, actorUserId, mergeGlobalRoles = false, consentProof }: MergeUsersArgs,
): Promise<User> {
  return db.$transaction(async (tx) => {
    // Serialize two merges involving either account. Ref resolution happens
    // in the GraphQL layer, but the rows are rechecked after the lock so a
    // concurrent soft-delete cannot be merged through. Parameterized template
    // (not $queryRawUnsafe) so the ids are bound, never interpolated.
    // #1631 PR3: the source's authority anchor (anchors before row locks, as deleteUserAccount takes them), so a
    // passkey registration can't race the live-passkey refusal below.
    await lockAuthorityAnchors(tx, [{ kind: 'user', id: sourceUserId }], 'exclusive');
    await tx.$queryRaw`SELECT id FROM users WHERE id IN (${sourceUserId}, ${targetUserId}, ${actorUserId ?? ''}) ORDER BY id FOR UPDATE`;
    const [source, target] = await Promise.all([
      tx.user.findUnique({ where: { id: sourceUserId } }),
      tx.user.findUnique({ where: { id: targetUserId } }),
    ]);
    if (!source || source.deletedAt) throw new Error('Source user not found');
    if (!target || target.deletedAt) throw new Error('Target user not found');
    // Execution authority is independent of whether global roles transfer.
    const actorRow = actorUserId ? await tx.user.findUnique({ where: { id: actorUserId } }) : null;
    if (!actorRow || actorRow.deletedAt || !actorRow.roles.some(r => r === 'ADMIN' || r === 'OWNER'))
      throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
    // A passkey's owner never changes (cor:aut:040:05), so a merge can't carry one. While the source holds a live
    // (unrevoked) passkey the merge is refused; the user revokes them first (Holger, 2026-10-21, team chat #29507).
    const livePasskeys = await tx.passkeyCredential.count({ where: { ownerId: sourceUserId, revokedAt: null } });
    if (livePasskeys > 0) {
      throw new GraphQLError('The source account still holds a passkey. Revoke its passkeys before merging.',
        { extensions: { code: 'MERGE_SOURCE_HAS_PASSKEYS', passkeyCount: livePasskeys } });
    }
    await assertSourceActorRowsFresh(tx, db, sourceUserId);
    const consent = await consumeUserMergeConsent(tx, consentProof, sourceUserId, targetUserId, actorUserId);
    await refuseUsersInOpenAlarmChains(tx, sourceUserId, targetUserId);

    const adoptGithubIdentity = target.githubId == null && target.githubUsername == null;
    const adoptExternalIdentity = target.externalAppId == null && target.externalId == null;
    const actor = actorUserId === sourceUserId ? targetUserId : (actorUserId ?? null);

    // Release source-held unique values before assigning any of them to the
    // target. The source remains present as a tombstone after the transaction.
    // handle is NOT NULL (spec 047), so instead of nulling it we give the
    // tombstone a fresh random handle — that RELEASES the original value (so the
    // target can adopt it below) while satisfying the constraint.
    await tx.user.update({
      where: { id: sourceUserId },
      data: {
        handle: `merged-${randomBytes(8).toString('hex')}`,
        githubId: null,
        githubUsername: null,
        googleId: null,
        appleId: null,
        email: null,
        externalAppId: null,
        externalId: null,
        linkedAt: null,
      },
    });

    // #708: the source's handle was just replaced by a random placeholder, so its original name is dead.
    // Tombstone the #692 pool principal (name reserved forever; the user→principal link stays).
    if (source.principalId) await releasePrincipal(tx, source.principalId);

    await tx.user.update({
      where: { id: targetUserId },
      data: {
        handle: target.handle ?? source.handle,
        ...(adoptGithubIdentity
          ? { githubId: source.githubId, githubUsername: source.githubUsername }
          : {}),
        googleId: target.googleId ?? source.googleId,
        appleId: target.appleId ?? source.appleId,
        identityProvider: target.identityProvider ?? source.identityProvider,
        ...(adoptExternalIdentity
          ? {
              externalAppId: source.externalAppId,
              externalId: source.externalId,
              linkedAt: target.linkedAt ?? source.linkedAt,
            }
          : {}),
        name: target.name ?? source.name,
        email: target.email ?? source.email,
        avatarUrl: target.avatarUrl ?? source.avatarUrl,
        // Global platform roles union ONLY on a platform-admin-authorized merge
        // — an org-admin-authorized merge must not let a source account's
        // ADMIN/OWNER leak onto the target (privilege escalation).
        ...(mergeGlobalRoles
          ? { roles: [...new Set([...target.roles, ...source.roles])] }
          : {}),
        updatedBy: actor,
      },
    });

    // Re-own the source's spec-047 owner-namespaced App / Agent / Memory rows
    // onto the target: move `owner_user_id`, re-root each `@source:slug` URN to
    // `@target:slug`, and re-mint (author-derived) any slug that would collide
    // with a live target resource (#695). Runs here — after the target's handle
    // is final and the source's is released — so the re-root lands on the
    // surviving handle. `source.handle` is the ORIGINAL (author root for the
    // re-mint disambiguator); `target.handle` is NOT NULL (spec 047).
    await mergeOwnerNamespacedUrns(tx, {
      sourceUserId,
      targetUserId,
      targetHandle: target.handle ?? source.handle,
      sourceHandle: source.handle,
    });

    await mergeUserOwnedTemplates(tx, sourceUserId, targetUserId);

    // #1416 (R204, cor:api:010:02). Impersonation by or of the source ends here, then the exact source id in
    // the participant and ender columns follows the survivor. Order matters: a live row is ended BEFORE its
    // participant is rewritten, so no credential minted for the source ever matches a row naming the survivor.
    // The decision time is read now, after every wait above, because CURRENT_TIMESTAMP is the transaction's
    // start: a session that expired while the merge waited is expired-unstamped history, not live. A system
    // end leaves ended_by NULL (the encoding of markImpersonationRevoked); an ended row keeps its ended_at.
    // Naive UTC text, like the columns it is compared with: a Date or timestamptz would be read in the session zone.
    const [{ decided_at: decidedAt }] = await tx.$queryRaw<Array<{ decided_at: string }>>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::text AS decided_at`;
    await tx.$executeRaw`UPDATE impersonation_sessions SET ended_at = ${decidedAt}::timestamp
      WHERE ended_at IS NULL AND expires_at > ${decidedAt}::timestamp
        AND (admin_user_id = ${sourceUserId} OR target_user_id = ${sourceUserId})`;
    await tx.$executeRaw`UPDATE impersonation_sessions SET
        admin_user_id = CASE WHEN admin_user_id = ${sourceUserId} THEN ${targetUserId} ELSE admin_user_id END,
        target_user_id = CASE WHEN target_user_id = ${sourceUserId} THEN ${targetUserId} ELSE target_user_id END,
        ended_by = CASE WHEN ended_by = ${sourceUserId} THEN ${targetUserId} ELSE ended_by END
      WHERE admin_user_id = ${sourceUserId} OR target_user_id = ${sourceUserId} OR ended_by = ${sourceUserId}`;

    // Fixed-identifier statements use parameterized tagged `$executeRaw`
    // (review:raw-sql-mutations): the two user ids interpolate as BOUND params,
    // and every table/column name is a literal in the template — never
    // interpolated. The two identifier-driven loops at the end can't use this
    // form (Postgres binds values, not identifiers) and stay `$executeRawUnsafe`
    // with a documented safety argument (#665).

    // Composite-key / unique relationships: combine ordered entitlements,
    // remove the source collision, then retarget source-only rows. A revoked
    // OrgMember contributes no role/canInvite authority. LEAST is strongest
    // for Role (OWNER is declared first in the Postgres enum).
    await tx.$executeRaw`UPDATE org_members t SET
        role = CASE
          WHEN s.deleted_at IS NOT NULL THEN t.role
          WHEN t.deleted_at IS NOT NULL THEN s.role
          ELSE LEAST(t.role, s.role)
        END,
        can_invite = CASE
          WHEN s.deleted_at IS NOT NULL THEN t.can_invite
          WHEN t.deleted_at IS NOT NULL THEN s.can_invite
          ELSE t.can_invite OR s.can_invite
        END,
        deleted_at = CASE
          WHEN t.deleted_at IS NULL OR s.deleted_at IS NULL THEN NULL
          ELSE t.deleted_at
        END,
        deleted_by = CASE
          WHEN t.deleted_at IS NULL OR s.deleted_at IS NULL THEN NULL
          ELSE t.deleted_by
        END,
        updated_at = now()
      FROM org_members s
      WHERE t.user_id = ${targetUserId} AND s.user_id = ${sourceUserId}
        AND t.organization_id = s.organization_id`;
    await tx.$executeRaw`DELETE FROM org_members s USING org_members t
      WHERE s.user_id = ${sourceUserId} AND t.user_id = ${targetUserId}
        AND s.organization_id = t.organization_id`;
    await tx.$executeRaw`UPDATE org_members SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`;

    await tx.$executeRaw`DELETE FROM app_members s USING app_members t
      WHERE s.user_id = ${sourceUserId} AND t.user_id = ${targetUserId} AND s.app_id = t.app_id`;
    await tx.$executeRaw`UPDATE app_members SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`;

    // Preserve the union's strongest live subscription. When both are active,
    // keep the earlier activation and broader expiry (NULL = perpetual).
    await tx.$executeRaw`UPDATE agent_subscriptions t SET
        activated_at = CASE
          WHEN t.activated_at IS NOT NULL AND t.revoked_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > now())
            AND s.activated_at IS NOT NULL AND s.revoked_at IS NULL
            AND (s.expires_at IS NULL OR s.expires_at > now())
            THEN LEAST(t.activated_at, s.activated_at)
          WHEN s.activated_at IS NOT NULL AND s.revoked_at IS NULL
            AND (s.expires_at IS NULL OR s.expires_at > now())
            THEN s.activated_at
          ELSE t.activated_at
        END,
        expires_at = CASE
          WHEN t.activated_at IS NOT NULL AND t.revoked_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > now())
            AND s.activated_at IS NOT NULL AND s.revoked_at IS NULL
            AND (s.expires_at IS NULL OR s.expires_at > now())
            THEN CASE
              WHEN t.expires_at IS NULL OR s.expires_at IS NULL THEN NULL
              ELSE GREATEST(t.expires_at, s.expires_at)
            END
          WHEN s.activated_at IS NOT NULL AND s.revoked_at IS NULL
            AND (s.expires_at IS NULL OR s.expires_at > now())
            THEN s.expires_at
          ELSE t.expires_at
        END,
        revoked_at = CASE
          WHEN (t.activated_at IS NOT NULL AND t.revoked_at IS NULL
              AND (t.expires_at IS NULL OR t.expires_at > now()))
            OR (s.activated_at IS NOT NULL AND s.revoked_at IS NULL
              AND (s.expires_at IS NULL OR s.expires_at > now()))
            THEN NULL
          ELSE t.revoked_at
        END,
        revoked_by = CASE
          WHEN (t.activated_at IS NOT NULL AND t.revoked_at IS NULL
              AND (t.expires_at IS NULL OR t.expires_at > now()))
            OR (s.activated_at IS NOT NULL AND s.revoked_at IS NULL
              AND (s.expires_at IS NULL OR s.expires_at > now()))
            THEN NULL
          ELSE t.revoked_by
        END,
        updated_at = now()
      FROM agent_subscriptions s
      WHERE t.user_id = ${targetUserId} AND s.user_id = ${sourceUserId} AND t.agent_id = s.agent_id`;
    await tx.$executeRaw`DELETE FROM agent_subscriptions s USING agent_subscriptions t
      WHERE s.user_id = ${sourceUserId} AND t.user_id = ${targetUserId} AND s.agent_id = t.agent_id`;
    await tx.$executeRaw`UPDATE agent_subscriptions SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`;

    // MemoryMemberRole is declared reader < writer < owner, so GREATEST
    // preserves owner and therefore the last-owner invariant.
    await tx.$executeRaw`UPDATE memory_members t SET
        role = GREATEST(t.role, s.role), updated_at = now()
      FROM memory_members s
      WHERE t.user_id = ${targetUserId} AND s.user_id = ${sourceUserId} AND t.memory_id = s.memory_id`;
    await tx.$executeRaw`DELETE FROM memory_members s USING memory_members t
      WHERE s.user_id = ${sourceUserId} AND t.user_id = ${targetUserId} AND s.memory_id = t.memory_id`;
    await tx.$executeRaw`UPDATE memory_members SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`;

    await tx.$executeRaw`UPDATE memory_shares t SET
        role = GREATEST(t.role, s.role), updated_at = now()
      FROM memory_shares s
      WHERE t.grantee_id = ${targetUserId} AND s.grantee_id = ${sourceUserId} AND t.memory_id = s.memory_id`;
    await tx.$executeRaw`DELETE FROM memory_shares s USING memory_shares t
      WHERE s.grantee_id = ${sourceUserId} AND t.grantee_id = ${targetUserId} AND s.memory_id = t.memory_id`;
    await tx.$executeRaw`UPDATE memory_shares SET grantee_id = ${targetUserId} WHERE grantee_id = ${sourceUserId}`;
    await tx.$executeRaw`UPDATE memory_shares SET grantor_id = ${targetUserId} WHERE grantor_id = ${sourceUserId}`;
    // A share can become self-directed when either its owner or grantee moves.
    await tx.$executeRaw`DELETE FROM memory_shares WHERE grantee_id = ${targetUserId} AND grantor_id = ${targetUserId}`;

    // #1050 — worker HOLDS move to the surviving account. Unlike most rows
    // here there is no uniqueness to collide on (one user may hold many names),
    // so this is a plain retarget with no pre-delete pass.
    //
    // It has to be explicit for the same reason the deletion path does: the
    // source User is SOFT-deleted, so `held_by_user_id`'s ON DELETE SET NULL
    // never fires. Left out, the surviving account would be refused
    // WORKER_HELD on names held by what is, by construction, the same person
    // (PR #1052 review, Codex P1).
    await tx.$executeRaw`UPDATE workers SET held_by_user_id = ${targetUserId} WHERE held_by_user_id = ${sourceUserId}`;

    await tx.$executeRaw`DELETE FROM pending_setups s USING pending_setups t
      WHERE s.user_id = ${sourceUserId} AND t.user_id = ${targetUserId}`;
    await tx.$executeRaw`UPDATE pending_setups SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`;

    await tx.$executeRaw`UPDATE user_invitations SET
      sender_user_id = CASE WHEN sender_user_id = ${sourceUserId} THEN ${targetUserId} ELSE sender_user_id END,
      new_user_id = CASE WHEN new_user_id = ${sourceUserId} THEN ${targetUserId} ELSE new_user_id END
      WHERE sender_user_id = ${sourceUserId} OR new_user_id = ${sourceUserId}`;
    await tx.$executeRaw`UPDATE node_revisions SET
      edited_by = CASE WHEN edited_by = ${sourceUserId} THEN ${targetUserId} ELSE edited_by END,
      approved_by = CASE WHEN approved_by = ${sourceUserId} THEN ${targetUserId} ELSE approved_by END
      WHERE edited_by = ${sourceUserId} OR approved_by = ${sourceUserId}`;

    // The remaining two rewrites interpolate table/column IDENTIFIERS, which a
    // tagged template cannot bind (Postgres parameters are values, not
    // identifiers). They stay `$executeRawUnsafe`, and it is safe: every
    // identifier comes from a compile-time-constant allowlist in THIS file
    // (`DIRECT_USER_REFERENCES` / `AUDIT_USER_COLUMNS`) — never user input — while the
    // two user ids are still passed as bound parameters ($1 = target, $2 =
    // source), not interpolated. See #665.
    const runWithIds = (sql: string) => tx.$executeRawUnsafe(sql, targetUserId, sourceUserId);

    // #1897 (Bindi P2-1, #2116): what descends from a sign-in is bound to the
    // sign-in's own user by composite FKs, and a sign-in's owner never changes,
    // so a lineage key or code cannot follow the merge. They stay on the
    // soft-deleted source, dead: the source's sign-ins end, its lineage keys
    // are revoked and its unspent lineage codes are dropped. Rows with no
    // lineage (legacy, direct issuance) are retargeted below as before.
    await tx.$executeRaw`UPDATE sign_ins SET ended_at = CURRENT_TIMESTAMP, end_reason = 'user-merged'
      WHERE user_id = ${sourceUserId} AND ended_at IS NULL`;
    await tx.$executeRaw`UPDATE user_api_keys SET revoked_at = CURRENT_TIMESTAMP
      WHERE user_id = ${sourceUserId} AND origin_sign_in_id IS NOT NULL AND revoked_at IS NULL`;
    await tx.$executeRaw`DELETE FROM auth_codes WHERE user_id = ${sourceUserId} AND sign_in_id IS NOT NULL`;
    await tx.$executeRaw`DELETE FROM auth_handoff_codes WHERE user_id = ${sourceUserId} AND sign_in_id IS NOT NULL`;

    // Non-conflicting ownership, attribution, credential, and history links.
    // An optional third element names a lineage column: rows that carry one stay
    // put (see the #1897 note above).
    for (const [table, column, lineage] of DIRECT_USER_REFERENCES) {
      const unlineaged = lineage ? ` AND "${lineage}" IS NULL` : '';
      await runWithIds(`UPDATE "${table}" SET "${column}" = $1 WHERE "${column}" = $2${unlineaged}`);
    }

    // Audit actor ids are identity references in several authorization and
    // creator-only paths (not merely display history), so the merged identity
    // must follow them as well.
    for (const [table, columns] of Object.entries(AUDIT_USER_COLUMNS)) {
      const assignments = columns
        .map((column) => `"${column}" = CASE WHEN "${column}" = $2 THEN $1 ELSE "${column}" END`)
        .join(', ');
      const predicate = columns.map((column) => `"${column}" = $2`).join(' OR ');
      await runWithIds(`UPDATE "${table}" SET ${assignments} WHERE ${predicate}`);
    }

    await tx.user.update({
      where: { id: sourceUserId },
      data: { deletedAt: new Date(), deletedBy: actor, updatedBy: actor },
    });
    // #1715: the merge itself, for the records a merge may not rewrite. A
    // decision's asker and deciders and a log's deciders sit inside its
    // authenticated payload, so they keep the source's id, and readers follow
    // it here to the target (src/lib/userMerges.ts). Keyed on the source, so a
    // second merge of the same account can't record a second target.
    await tx.userMerge.create({ data: { sourceUserId, targetUserId, mergedBy: actor, ...consent } });

    return tx.user.findUniqueOrThrow({ where: { id: targetUserId } });
  }, {
    timeout: 60_000,
    maxWait: 15_000,
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
}
