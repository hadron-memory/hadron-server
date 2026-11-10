/**
 * #2973 PR2 (cor:agt:040:09) — the organisation boot-prompt signing switch: `orgBootPromptSigning` (read),
 * `orgBootPromptSigningPreview` (what switching on would change) and `setOrgBootPromptSigning`. GraphQL only: the
 * agent-team tools are CLI and portal only (#2937), so there is no MCP twin.
 *
 * Every refusal of the audience is the one FORBIDDEN, and the organisation is never reported missing: a principal that
 * can never be the audience is refused before the organisation reference is looked at, and an unresolvable reference
 * answers the same denial. The logic lives in `src/lib/bootPrompt/signingSwitch.ts`.
 *
 * CONCURRENCY (the gate's clause: the org lock alone is not evidence that the writes which change the preview share it).
 * Approvals, signatures, pointer moves, installs and revisions do NOT take the organisation row, so the switch-on is NOT
 * fenced against them. It is instead judged on ONE stable snapshot: a REPEATABLE READ transaction whose first statement is
 * the organisation's exclusive authority anchor, then the row lock; the token's digest is recomputed from that
 * snapshot, and the switch commits against exactly that state. A preview-changing write that committed before the
 * snapshot is in the recompute (the token goes stale, PREVIEW_STALE); one that commits after is ordered after the
 * switch-on, the same order as if it had run after the commit, because the switch-on's decision was made wholly on the
 * snapshot. Two switch-ons serialize on the anchor; the later one's snapshot predates the first's commit, so its row
 * lock aborts it with a serialization failure and it re-runs on a fresh snapshot (`retryOnSerializationFailure`),
 * where it finds the switch on and succeeds without changing anything.
 */
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { AmbiguousLegacyUrnError, OrganizationNotFoundError } from '../../../lib/entityRef/errors.js';
import { retryOnSerializationFailure } from '../../../lib/serializableRetry.js';
import {
  computeSigningPreviewRows,
  dbNowMs,
  mintSigningPreviewToken,
  pageSigningPreview,
  requireFreshSigningPreview,
  requireSelfActingUser,
  requireSigningSwitchAudience,
  signingPreviewDigest,
  signingSwitchStatus,
} from '../../../lib/bootPrompt/signingSwitch.js';
import { liveTxContext, withAuthorizedTx } from './authorizedTx.js';
import type { Context } from './resolvers.helpers.js';

/**
 * The principal gate, then the organisation: an unknown, deleted or ambiguous reference is the same FORBIDDEN as a
 * non-member (never an existence oracle). A reference that is not a reference at all (malformed) is a plain input error
 * that does not depend on which organisations exist.
 */
async function audienceOrgId(ctx: Context, ref: string): Promise<{ userId: string; orgId: string }> {
  const userId = requireSelfActingUser(ctx);
  try {
    return { userId, orgId: (await resolveOrgRef(ctx.db, ref)).id };
  } catch (e) {
    if (e instanceof OrganizationNotFoundError || e instanceof AmbiguousLegacyUrnError) throw authorizationDenied();
    throw e;
  }
}

/** Read the organisation's audience-gated state on one REPEATABLE READ snapshot. */
async function inAudienceSnapshot<T>(
  ctx: Context,
  ref: string,
  fn: (tx: Prisma.TransactionClient, orgId: string, userId: string) => Promise<T>,
): Promise<T> {
  const { userId, orgId } = await audienceOrgId(ctx, ref);
  return ctx.db.$transaction(async (tx) => {
    const live = await liveTxContext(ctx, tx);
    requireSelfActingUser(live);
    await requireSigningSwitchAudience(tx, userId, orgId);
    return fn(tx, orgId, userId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 });
}

const statusOf = async (tx: Prisma.TransactionClient, orgId: string) =>
  signingSwitchStatus(await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { bootPromptSigningRequired: true } }));

export const orgBootPromptSigningQueries = {
  orgBootPromptSigning: (_: unknown, { org }: { org: string }, ctx: Context) =>
    inAudienceSnapshot(ctx, org, (tx, orgId) => statusOf(tx, orgId)),

  orgBootPromptSigningPreview: (
    _: unknown,
    { org, first, after }: { org: string; first?: number | null; after?: string | null },
    ctx: Context,
  ) => inAudienceSnapshot(ctx, org, async (tx, orgId, userId) => {
    // Validate the page arguments only for a caller already inside the audience.
    const status = await statusOf(tx, orgId);
    const rows = await computeSigningPreviewRows(tx, orgId);
    const page = pageSigningPreview(rows, first, after);
    return {
      enforced: status.enforced,
      deploymentSigns: status.deploymentSigns,
      total: rows.length,
      rows: page.rows,
      hasMore: page.hasMore,
      endCursor: page.endCursor,
      previewToken: mintSigningPreviewToken({ orgId, userId, digest: signingPreviewDigest(rows), iatMs: await dbNowMs(tx) }),
    };
  }),
};

export const orgBootPromptSigningMutations = {
  setOrgBootPromptSigning: async (
    _: unknown,
    { org, required, previewToken }: { org: string; required: boolean; previewToken?: string | null },
    ctx: Context,
  ) => {
    if (typeof required !== 'boolean') throw new GraphQLError('required must be true or false.', { extensions: { code: 'BAD_USER_INPUT' } });
    const { userId, orgId } = await audienceOrgId(ctx, org);
    return retryOnSerializationFailure(() => withAuthorizedTx(
      ctx,
      [{ kind: 'org', id: orgId }],
      async (txCtx) => {
        // The audience again, on the transaction: the request-time answer is not evidence once the anchor is held.
        requireSelfActingUser(txCtx);
        await requireSigningSwitchAudience(txCtx.db, userId, orgId);
      },
      async (tx) => {
        // Lock, then judge (the lock is the last one this act takes): the exclusive authority anchor serialized the
        // switchers, and this row lock makes a stale snapshot fail 40001 and re-run rather than decide on old state.
        const [row] = await tx.$queryRaw<Array<{ required: boolean }>>`
          SELECT boot_prompt_signing_required AS required FROM organizations WHERE id = ${orgId} FOR UPDATE`;
        if (!row) throw authorizationDenied();
        if (required) await requireFreshSigningPreview(tx, { token: previewToken, orgId, userId });
        if (row.required !== required) {
          await tx.organization.update({ where: { id: orgId }, data: { bootPromptSigningRequired: required } });
        }
        return statusOf(tx, orgId);
      },
      { lockMode: 'exclusive', isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    ));
  },
};
