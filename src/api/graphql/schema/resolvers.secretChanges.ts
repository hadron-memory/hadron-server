/** #3999; cor:sec:070:02. Request polling and withdrawal disclose only to the requester acting as themselves. */
import type { Context } from './resolvers.helpers.js';
import { GraphQLError } from 'graphql';
import { requirePersonOnlyAct } from '../../../lib/auth/personAsThemselves.js';
import { visibleChange, type ChangeRequest } from '../../../lib/secrets/changeRequests.js';
import { signingSurfacePolicy } from '../../../lib/signing/surface.js';
const absent = () => new GraphQLError('Secret change request not found.', { extensions: { code: 'NOT_FOUND' } });
async function person(ctx: Context) {
 if (!signingSurfacePolicy().signing || ctx.appKeyId) throw absent();
 return requirePersonOnlyAct(ctx, 'secret.change', absent);
}
export const secretChangeQueries = {
 secretChangeRequest: async (_: unknown, { id }: { id: string }, ctx: Context) => {
  let userId: string;
  try { userId = await person(ctx); } catch (e) { if (e instanceof GraphQLError && e.extensions.code === 'NOT_FOUND') return null; throw e; }
  const [r] = await ctx.db.$queryRaw<ChangeRequest[]>`SELECT id,state,operation,created_at,expires_at FROM secret_change_requests WHERE id=${id} AND requester_id=${userId}`;
  if (!r) return null;
  const [{ now }] = await ctx.db.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  return visibleChange(r, now);
 },
};
export const secretChangeMutations = {
 withdrawSecretChangeRequest: async (_: unknown, { id }: { id: string }, ctx: Context) => {
  const userId = await person(ctx);
  return ctx.db.$transaction(async(tx) => {
   const [r] = await tx.$queryRaw<ChangeRequest[]>`SELECT id,state,expires_at FROM secret_change_requests WHERE id=${id} AND requester_id=${userId} FOR UPDATE`;
   if(!r)throw absent();
   if(r.state!=='open')return false;
   await tx.$executeRaw`UPDATE secret_change_requests SET state=CASE WHEN expires_at <= (clock_timestamp() AT TIME ZONE 'UTC') THEN 'expired' ELSE 'withdrawn' END,
    ended_at=(clock_timestamp() AT TIME ZONE 'UTC') WHERE id=${id}`;
   return true;
  });
 },
};
