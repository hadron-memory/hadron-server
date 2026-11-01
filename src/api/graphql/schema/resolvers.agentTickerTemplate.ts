// Agent ticker templates — #2024 (S8). The read and write surface of the tickers an Agent declares; the cast and
// retirement halves live in src/lib/tickers/agentTickerTemplates.ts and resolvers.worker.ts.
//
// WHO: reading a template is reading the Agent (`resolveReadableAgentRef`, an unreadable Agent answers as absent).
// Writing one is editing the Agent, the `requireAgentAccess(..., 'ADMIN')` door `updateAgent` uses, re-decided inside
// the deciding transaction under the Agent's authority anchors. An App manager is not thereby an Agent editor.
//
// WHAT A WRITE DOES: it changes the Agent's declaration and nothing else. Workers already cast and tickers already
// generated are untouched (snapshot at cast, R96 A); there is no fan-out and no reactivation.

import { GraphQLError } from 'graphql';
import { templateTickCode } from '../../../lib/tickers/tickCode.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { type Context, requireAgentAccess, resolveReadableAgentRef } from './resolvers.helpers.js';
import { taskError } from './resolvers.agentTask.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { cleanName, checkQuietHours, checkReasons, checkRelevance, reasonEnum } from './resolvers.ticker.js';
import { TICKER_MAX_CADENCE_SECONDS } from '../../../lib/tickers/bounds.js';
import { lockAgentTemplates, liveTemplates, type TemplateRow } from '../../../lib/tickers/agentTickerTemplates.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { isId } from '../../../lib/entityRef/shape.js';
import {
  type AgentManagementOp, assertNoWorkerSessionAgentManagement, underWorkerSession,
} from '../../../lib/auth/agentManagementWorkerSession.js';

/** Most live templates one Agent declares. An Agent that wants more is describing something other than a heartbeat. */
export const TICKER_TEMPLATES_MAX = 20;

const badInput = (message: string): GraphQLError => taskError('BAD_USER_INPUT', message);
const notFound = (id: string): GraphQLError => taskError('TICKER_TEMPLATE_NOT_FOUND', 'Ticker template not found.', { id });

type AgentGate = { id: string; organizationId: string | null; ownerUserId: string | null };

function checkCadence(cadence: unknown): number {
  if (typeof cadence !== 'number' || !Number.isInteger(cadence) || cadence < 1 || cadence > TICKER_MAX_CADENCE_SECONDS) {
    throw taskError(
      'TICKER_CADENCE_OUT_OF_RANGE',
      `A template's cadence is a whole number of seconds from 1 to ${TICKER_MAX_CADENCE_SECONDS}. The cast raises it to the App's own floor.`,
      { min: 1, max: TICKER_MAX_CADENCE_SECONDS },
    );
  }
  return cadence;
}

type TemplateInput = { name: string; cadenceSeconds: number; quietHours?: unknown; relevance?: string | null; reasons?: string[] | null };
type TemplatePatch = {
  name?: string | null; cadenceSeconds?: number | null; quietHours?: unknown; clearQuietHours?: boolean | null;
  relevance?: string | null; reasons?: string[] | null;
};

/** Shape that needs no row. A field that is present must be valid: `null` on a non-nullable field is refused, not skipped. */
function patchFromInput(input: TemplatePatch): Prisma.AgentTickerTemplateUpdateInput {
  const data: Prisma.AgentTickerTemplateUpdateInput = {};
  if (input.name !== undefined) data.name = cleanName(input.name);
  if (input.cadenceSeconds !== undefined) data.cadenceSeconds = checkCadence(input.cadenceSeconds);
  if (input.relevance !== undefined) data.relevance = checkRelevance(input.relevance);
  if (input.reasons !== undefined) data.reasons = checkReasons(input.reasons);
  if (input.clearQuietHours && input.quietHours !== undefined && input.quietHours !== null) {
    throw badInput('Pass quietHours or clearQuietHours, not both.');
  }
  if (input.clearQuietHours) data.quietHours = Prisma.DbNull;
  else if (input.quietHours !== undefined) {
    if (input.quietHours === null) throw badInput('quietHours is null: use clearQuietHours to remove the quiet hours.');
    data.quietHours = checkQuietHours(input.quietHours);
  }
  return data;
}

/**
 * Run a template write as the Agent's editor, decided again inside the transaction under the Agent's anchors. A bound
 * worker session is refused there, after the person gate and before the write callback's existence, revision and name
 * checks (#3030, cor:agt:080:35).
 */
async function writeAsAgentEditor<T>(
  ctx: Context,
  agent: AgentGate,
  op: AgentManagementOp,
  write: (tx: Prisma.TransactionClient, txCtx: Context) => Promise<T>,
): Promise<T> {
  return withAuthorizedTx(
    ctx,
    [
      { kind: 'agent', id: agent.id },
      ...(agent.organizationId ? [{ kind: 'org' as const, id: agent.organizationId }] : []),
      ...(agent.ownerUserId ? [{ kind: 'user' as const, id: agent.ownerUserId }] : []),
    ],
    async (txCtx) => {
      const current = await txCtx.db.agent.findUnique({ where: { id: agent.id }, select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true } });
      if (!current || current.deletedAt) throw new AgentNotFoundError(agent.id);
      if (current.organizationId !== agent.organizationId || current.ownerUserId !== agent.ownerUserId) {
        throw new Error('Agent ownership changed; retry the template change');
      }
      await requireAgentAccess(txCtx, current, 'ADMIN');
      assertNoWorkerSessionAgentManagement(op);
    },
    async (tx, txCtx) => {
      await lockAgentTemplates(tx, agent.id, 'exclusive');
      return write(tx, txCtx);
    },
  );
}

/** A unique-violation on THIS model only: a P2002 with no model, or another model's, is not a name clash. */
export const isNameClash = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' &&
  (e.meta as { modelName?: unknown } | undefined)?.modelName === 'AgentTickerTemplate';

const nameTaken = (name: string): GraphQLError =>
  taskError('TICKER_TEMPLATE_NAME_TAKEN', `This Agent already has a ticker template named "${name}" (names ignore case).`, { name });

const revisionMismatch = (id: string, expected: number, current: number): GraphQLError =>
  taskError(
    'TICKER_TEMPLATE_REVISION_MISMATCH',
    `This template is at revision ${current}, not ${expected}. Read it again and apply the change to what is there; nothing was written.`,
    { id, expectedRevision: expected, currentRevision: current },
  );

/** The live template and its Agent, the Agent readable by the caller; anything else answers as absent. */
async function loadTemplate(ctx: Context, id: string): Promise<{ template: TemplateRow; agent: AgentGate }> {
  if (!isId(id)) throw notFound(id);
  const template = await ctx.db.agentTickerTemplate.findUnique({ where: { id } });
  if (!template || template.deletedAt) throw notFound(id);
  let agent;
  try {
    agent = await resolveReadableAgentRef(ctx, template.agentId);
  } catch (e) {
    if (e instanceof AgentNotFoundError) throw notFound(id);
    throw e;
  }
  return { template, agent };
}

export const agentTickerTemplateQueries = {
  agentTickerTemplates: async (_: unknown, { agentRef }: { agentRef: string }, ctx: Context) => {
    const agent = await resolveReadableAgentRef(ctx, agentRef);
    return liveTemplates(ctx.db, agent.id);
  },
};

export const agentTickerTemplateMutations = {
  createAgentTickerTemplate: async (_: unknown, { agentRef, input }: { agentRef: string; input: TemplateInput }, ctx: Context) => {
    assertNoWorkerSessionAgentManagement('createAgentTickerTemplate'); // first, so the answer never depends on the target (#3030)
    const agent = await resolveReadableAgentRef(ctx, agentRef);
    await requireAgentAccess(ctx, agent, 'ADMIN');
    const name = cleanName(input.name);
    const cadenceSeconds = checkCadence(input.cadenceSeconds);
    const quietHours = input.quietHours == null ? Prisma.DbNull : checkQuietHours(input.quietHours);
    const relevance = input.relevance == null ? 'ALL' : checkRelevance(input.relevance);
    const reasons = input.reasons == null ? ['read-team-channel'] : checkReasons(input.reasons);
    try {
      return await writeAsAgentEditor(ctx, agent, 'createAgentTickerTemplate', async (tx, txCtx) => {
        const live = await tx.agentTickerTemplate.count({ where: { agentId: agent.id, deletedAt: null } });
        if (live >= TICKER_TEMPLATES_MAX) {
          throw taskError(
            'TICKER_TEMPLATE_LIMIT_REACHED',
            `This Agent already declares ${live} ticker templates, the most it may. Remove one first.`,
            { limit: TICKER_TEMPLATES_MAX },
          );
        }
        const clash = await tx.agentTickerTemplate.findFirst({
          where: { agentId: agent.id, deletedAt: null, name: { equals: name, mode: 'insensitive' } }, select: { id: true },
        });
        if (clash) throw nameTaken(name);
        return tx.agentTickerTemplate.create({
          data: { agentId: agent.id, name, cadenceSeconds, quietHours, relevance, reasons, createdBy: txCtx.userId ?? null, updatedBy: txCtx.userId ?? null },
        });
      });
    } catch (e) {
      if (isNameClash(e)) throw nameTaken(name);
      throw e;
    }
  },

  updateAgentTickerTemplate: async (
    _: unknown, { id, expectedRevision, input }: { id: string; expectedRevision: number; input: TemplatePatch }, ctx: Context,
  ) => {
    assertNoWorkerSessionAgentManagement('updateAgentTickerTemplate'); // first, so the answer never depends on the target (#3030)
    const { template: seen, agent } = await loadTemplate(ctx, id);
    await requireAgentAccess(ctx, agent, 'ADMIN');
    const data = patchFromInput(input);
    if (Object.keys(data).length === 0) throw badInput('Nothing to change: name at least one field.');
    try {
      return await writeAsAgentEditor(ctx, agent, 'updateAgentTickerTemplate', async (tx, txCtx) => {
        await tx.$queryRaw`SELECT id FROM agent_ticker_templates WHERE id = ${seen.id} FOR UPDATE`;
        const current = await tx.agentTickerTemplate.findUnique({ where: { id: seen.id } });
        if (!current || current.deletedAt || current.agentId !== agent.id) throw notFound(id);
        if (current.revision !== expectedRevision) throw revisionMismatch(id, expectedRevision, current.revision);
        if (typeof data.name === 'string') {
          const clash = await tx.agentTickerTemplate.findFirst({
            where: { agentId: agent.id, deletedAt: null, id: { not: current.id }, name: { equals: data.name, mode: 'insensitive' } }, select: { id: true },
          });
          if (clash) throw nameTaken(data.name);
        }
        return tx.agentTickerTemplate.update({
          where: { id: current.id },
          data: { ...data, revision: { increment: 1 }, updatedBy: txCtx.userId ?? null },
        });
      });
    } catch (e) {
      if (isNameClash(e) && typeof data.name === 'string') throw nameTaken(data.name);
      throw e;
    }
  },

  deleteAgentTickerTemplate: async (_: unknown, { id, expectedRevision }: { id: string; expectedRevision: number }, ctx: Context) => {
    assertNoWorkerSessionAgentManagement('deleteAgentTickerTemplate'); // first, so the answer never depends on the target (#3030)
    const { template: seen, agent } = await loadTemplate(ctx, id);
    await requireAgentAccess(ctx, agent, 'ADMIN');
    await writeAsAgentEditor(ctx, agent, 'deleteAgentTickerTemplate', async (tx, txCtx) => {
      await tx.$queryRaw`SELECT id FROM agent_ticker_templates WHERE id = ${seen.id} FOR UPDATE`;
      const current = await tx.agentTickerTemplate.findUnique({ where: { id: seen.id } });
      if (!current || current.deletedAt || current.agentId !== agent.id) throw notFound(id);
      if (current.revision !== expectedRevision) throw revisionMismatch(id, expectedRevision, current.revision);
      // Soft delete: generated tickers keep the provenance of the template they were made from.
      await tx.agentTickerTemplate.update({
        where: { id: current.id },
        data: { deletedAt: new Date(), deletedBy: txCtx.userId ?? null, revision: { increment: 1 }, updatedBy: txCtx.userId ?? null },
      });
    });
    return true;
  },
};

export const agentTickerTemplateFieldResolvers = {
  Agent: {
    /** Read through the Agent's own read gate, so a foreign private Agent reached through a public parent shows none. */
    tickerTemplates: async (agent: { id: string }, _: unknown, ctx: Context) => {
      try {
        await resolveReadableAgentRef(ctx, agent.id);
      } catch (e) {
        if (e instanceof AgentNotFoundError) return [];
        throw e;
      }
      return liveTemplates(ctx.db, agent.id);
    },
    /** False under a worker session, whose writes refuse whatever its holder may do (#3030), so no surface offers them. */
    viewerMayEditTickerTemplates: async (agent: AgentGate, _: unknown, ctx: Context) => {
      if (underWorkerSession()) return false;
      try {
        await requireAgentAccess(ctx, agent, 'ADMIN');
        return true;
      } catch (e) {
        if (e instanceof GraphQLError && e.extensions?.code === 'FORBIDDEN') return false;
        return null;
      }
    },
  },
  AgentTickerTemplate: {
    tickCode: (t: TemplateRow) => templateTickCode(t.name),
    agent: (t: TemplateRow, _: unknown, ctx: Context) => ctx.db.agent.findUnique({ where: { id: t.agentId } }),
    quietHours: (t: TemplateRow) => t.quietHours ?? null,
    reasons: (t: TemplateRow) => t.reasons.map(reasonEnum),
  },
};
