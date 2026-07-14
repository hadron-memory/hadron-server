import { Prisma, type PrismaClient, type User } from '../../generated/prisma/index.js';

/**
 * Tables whose audit actor columns carry User.id values in normal writes.
 * Organization.createdBy is deliberately excluded: it is also the durable
 * personal-workspace discriminator, and rewriting it could make one target
 * user appear to have two personal workspaces after an account merge.
 *
 * Values such as `app:<id>` / `github:<login>` are untouched because every
 * update below matches the source User.id exactly.
 */
const AUDIT_USER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
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
};

export interface MergeUsersArgs {
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
  { sourceUserId, targetUserId, actorUserId, mergeGlobalRoles = false }: MergeUsersArgs,
): Promise<User> {
  // Defense-in-depth: the sole production caller (the mergeUsers resolver)
  // already rejects source === target with MERGE_SOURCE_EQUALS_TARGET, but this
  // operation is exported — guard here too so a direct or future caller can't
  // clear every unique field and then tombstone a single account by merging it
  // into itself.
  if (sourceUserId === targetUserId) {
    throw new Error('mergeUsers: source and target must be different users');
  }
  return db.$transaction(async (tx) => {
    // Serialize two merges involving either account. Ref resolution happens
    // in the GraphQL layer, but the rows are rechecked after the lock so a
    // concurrent soft-delete cannot be merged through. Parameterized template
    // (not $queryRawUnsafe) so the ids are bound, never interpolated.
    await tx.$queryRaw`SELECT id FROM users WHERE id IN (${sourceUserId}, ${targetUserId}) ORDER BY id FOR UPDATE`;
    const [source, target] = await Promise.all([
      tx.user.findUnique({ where: { id: sourceUserId } }),
      tx.user.findUnique({ where: { id: targetUserId } }),
    ]);
    if (!source || source.deletedAt) throw new Error('Source user not found');
    if (!target || target.deletedAt) throw new Error('Target user not found');

    const adoptGithubIdentity = target.githubId == null && target.githubUsername == null;
    const adoptExternalIdentity = target.externalAppId == null && target.externalId == null;
    const actor = actorUserId === sourceUserId ? targetUserId : (actorUserId ?? null);

    // Release source-held unique values before assigning any of them to the
    // target. The source remains present as a tombstone after the transaction.
    await tx.user.update({
      where: { id: sourceUserId },
      data: {
        handle: null,
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
    // (`directReferences` / `AUDIT_USER_COLUMNS`) — never user input — while the
    // two user ids are still passed as bound parameters ($1 = target, $2 =
    // source), not interpolated. See #665.
    const runWithIds = (sql: string) => tx.$executeRawUnsafe(sql, targetUserId, sourceUserId);

    // Non-conflicting ownership, attribution, credential, and history links.
    const directReferences: ReadonlyArray<readonly [string, string]> = [
      ['memories', 'user_id'],
      ['sessions', 'user_id'],
      ['usage_events', 'user_id'],
      ['org_member_invitations', 'recipient_user_id'],
      ['user_invitation_activations', 'user_id'],
      ['exchange_connections', 'user_id'],
      ['connection_grants', 'granted_by_user_id'],
      ['principal_grants', 'principal_id'],
      ['user_api_keys', 'user_id'],
      ['auth_codes', 'user_id'],
      ['auth_handoff_codes', 'user_id'],
      ['app_runs', 'user_id'],
      ['agent_schedules', 'user_id'],
      ['agent_webhooks', 'user_id'],
      ['assets', 'uploaded_by'],
      ['agents', 'editor_lock_user_id'],
    ];
    for (const [table, column] of directReferences) {
      await runWithIds(`UPDATE "${table}" SET "${column}" = $1 WHERE "${column}" = $2`);
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

    return tx.user.findUniqueOrThrow({ where: { id: targetUserId } });
  }, {
    timeout: 60_000,
    maxWait: 15_000,
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
}
