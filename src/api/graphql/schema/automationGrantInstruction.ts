/** #3361: the #3311 protocol with each automation grant family's existing holder predicate. */
import type { Context } from './resolvers.helpers.js';
import { requireInstructedAct, sameActPrincipal, type ActAdmission, type ActInstruction } from '../../../lib/auth/instructedAct.js';
import { readActInstruction, lockInstructedActRows } from './resolvers.instruction.js';
import { lockWorkersForAssignment } from '../../../lib/agentTasks/workerLock.js';
import { lockAppManagerMemberships } from '../../../lib/auth/appManagement.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import type { Prisma } from '../../../generated/prisma/index.js';

type App = { id: string; organizationId: string | null; ownerUserId: string | null };
const denied = () => authorizationDenied();
export async function automationGrantAdmission(ctx: Context, app: App, instruction: ActInstruction | null | undefined,
  allows: (c: Context) => Promise<boolean>, expected?: ActAdmission): Promise<ActAdmission> {
  const fresh = await ctx.db.app.findFirst({ where: { id: app.id, deletedAt: null, uninstalledAt: null }, select: { organizationId: true, ownerUserId: true } });
  if (!fresh || fresh.organizationId !== app.organizationId || fresh.ownerUserId !== app.ownerUserId) throw denied();
  const actual = await requireInstructedAct(ctx, app.id, instruction, () => allows(ctx), readActInstruction, denied);
  if (expected && !sameActPrincipal(expected, actual)) throw denied();
  return actual;
}
export async function lockAutomationGrantActor(tx: Prisma.TransactionClient, admission: ActAdmission, app: App, targetOrgIds: string[] = []) {
  if (admission.kind === 'instructed-worker') await lockWorkersForAssignment(tx, [admission.workerId]);
  // Both the App and memory/Agent target-manager paths depend on live membership rows.
  await lockAppManagerMemberships(tx, admission.userId, app);
  const ids = [...new Set(targetOrgIds)].sort();
  if (ids.length) await tx.$queryRaw`SELECT user_id FROM org_members WHERE organization_id = ANY(${ids}::text[]) AND user_id = ${admission.userId} ORDER BY organization_id FOR SHARE`;
}
export async function finalAutomationGrantAdmission(ctx: Context, app: App, instruction: ActInstruction | null | undefined,
  allows: (c: Context) => Promise<boolean>, expected: ActAdmission) {
  if (expected.kind === 'instructed-worker') await lockInstructedActRows(ctx.db as Prisma.TransactionClient, [expected.workerId], ctx.sessionId);
  return automationGrantAdmission(ctx, app, instruction, allows, expected);
}
