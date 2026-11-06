/** #1148 / ruling0235: extra licence and text audience for a personal App's non-PUBLIC org Agent. */
import { isLifecycleActive } from '@hadron-memory/access-control';
import type { PrismaClient, Prisma } from '../../generated/prisma/index.js';
type Db = PrismaClient | Prisma.TransactionClient;
export async function currentAgentOrgMember(db: Db, userId: string | null | undefined, organizationId: string): Promise<boolean> {
  if (!userId) return false;
  return (await db.orgMember.findFirst({where:{userId,organizationId,deletedAt:null,organization:{deletedAt:null}},select:{id:true}})) !== null;
}
/** True outside this rule; existing PUBLIC, own-Agent and org-App licence gates remain the caller's responsibility. */
export async function personalOrgAgentLicenseHolds(db: Db, app: {organizationId:string|null;ownerUserId:string|null}, agentId:string):Promise<boolean> {
  if (app.organizationId !== null || !app.ownerUserId) return true;
  const agent=await db.agent.findUnique({where:{id:agentId},select:{organizationId:true,visibility:true,deletedAt:true}});
  if (!agent || !agent.organizationId || agent.visibility==='PUBLIC') return true;
  if (agent.deletedAt) return false;
  if (agent.visibility!=='ORGANIZATION' || !(await currentAgentOrgMember(db,app.ownerUserId,agent.organizationId))) return false;
  const subscription=await db.agentSubscription.findUnique({where:{userId_agentId:{userId:app.ownerUserId,agentId}}});
  return subscription !== null && isLifecycleActive(subscription);
}
/** An independently admitted participant must ALSO be a current member before reading this install's org text. */
export async function personalOrgAgentTextAllowed(db:Db,app:{organizationId:string|null;ownerUserId:string|null},agentId:string,userId:string|null|undefined):Promise<boolean> {
  if(app.organizationId!==null||!app.ownerUserId)return true;
  const agent=await db.agent.findUnique({where:{id:agentId},select:{organizationId:true,visibility:true}});
  if(!agent?.organizationId||agent.visibility==='PUBLIC')return true;
  return await personalOrgAgentLicenseHolds(db,app,agentId) && await currentAgentOrgMember(db,userId,agent.organizationId);
}
