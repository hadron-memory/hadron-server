/** #2014/#2015 worker-only post admission; policy receipts live on those issues (citations pending). */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import { lockAppReportsTo } from './workerReportsTo.js';
import { appManagerUserIds } from './auth/appManagement.js';
import { generateId } from './id.js';
import type { AlarmChain } from './agentTasks/events.js';

/** Serialized across every session/Channel of the derived worker; take after the chat lock, before worker rows. */
export async function lockChatPostWorker(tx: Prisma.TransactionClient, workerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'chat-post-limit:' + workerId}))`;
}

/** One post-lock DB clock, persisted on accepted messages as well as used for every rolling cutoff. */
export async function chatPostAdmissionTime(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<{ at: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS at`;
  return row!.at;
}

/** Build the own-App reporting line under its graph lock; managers are fallback only, never appended to a line. */
async function rateAlarmChain(tx: Prisma.TransactionClient, workerId: string): Promise<{ appId: string; chain: AlarmChain; windowMinutes: number }> {
  const subject = await tx.worker.findUniqueOrThrow({ where: { id: workerId }, select: { appId: true } });
  await lockAppReportsTo(tx, subject.appId, 'shared');
  const chain: AlarmChain = [];
  const seen = new Set([workerId]);
  let next: string | null = workerId;
  while (next) {
    const row: { reportsToWorkerId: string | null } | null = await tx.worker.findFirst({ where: { id: next, appId: subject.appId, retiredAt: null }, select: { reportsToWorkerId: true } });
    const head: string | null = row?.reportsToWorkerId ?? null;
    if (!head || seen.has(head)) break;
    seen.add(head);
    const live = await tx.worker.findFirst({ where: { id: head, appId: subject.appId, retiredAt: null }, select: { id: true } });
    if (!live) break;
    chain.push({ workerId: head });
    next = head;
  }
  if (chain.length === 0) {
    const app = await tx.app.findUniqueOrThrow({ where: { id: subject.appId } });
    for (const userId of await appManagerUserIds(tx, app)) chain.push({ userId, via: 'manager' });
  }
  const windows = await tx.agentTaskStallSchedule.findUnique({ where: { appId: subject.appId } });
  return { appId: subject.appId, chain, windowMinutes: windows?.ownerReactionMinutes ?? 20 };
}

/** Record the episode, append-only alarm and escalation schedule atomically. An insert failure MUST escape/rollback. */
async function raiseRateAlarm(tx: Prisma.TransactionClient, workerId: string, at: Date, limit: 'minute' | 'hour'): Promise<void> {
  const episode = await tx.workerPostLimitEpisode.findFirst({ where: { workerId, episodeStart: { gt: new Date(at.getTime() - 3_600_000) } } });
  if (episode) return;
  const { appId, chain, windowMinutes } = await rateAlarmChain(tx, workerId);
  const eventId = generateId();
  await tx.agentTeamEvent.create({ data: {
    id: eventId, appId, taskId: null, subjectWorkerId: workerId,
    type: 'post-limit.exceeded', severity: 'alarm', episodeStart: at, createdAt: at,
    chain, payload: { limit, windowMinutes, max: limit === 'minute' ? 10 : 60, windowSeconds: limit === 'minute' ? 60 : 3600 },
  } });
  await tx.workerPostLimitEpisode.create({ data: { workerId, episodeStart: at, eventId } });
  await tx.agentTeamAlarmSchedule.createMany({ data: chain.map((_, i) => ({ eventId, chainIndex: i, dueAt: new Date(at.getTime() + i * windowMinutes * 60_000), wokenAt: i === 0 ? at : null })) });
}

/** Decide duplicate first, then rolling accepted-post limits while holding the worker limiter lock. */
export async function admitWorkerPost(tx: Prisma.TransactionClient, args: {
  workerId: string; channelId: string; body: string; replyTargetId: string | null; at: Date;
}): Promise<GraphQLError | null> {
  const { workerId, channelId, body, replyTargetId, at } = args;
  const duplicate = await tx.node.findFirst({ where: {
    nodeType: 'chat-message', createdByWorkerId: workerId, messageChannelId: channelId,
    deletedAt: null, createdAt: { gt: new Date(at.getTime() - 600_000) }, content: body,
    outgoingEdges: replyTargetId === null
      ? { none: { name: 'replies-to' } }
      : { some: { name: 'replies-to', targetId: replyTargetId } },
  }, orderBy: { seq: 'desc' }, select: { seq: true } });
  if (duplicate) return new GraphQLError(`This post is identical to your message #${duplicate.seq} in this Channel, which already landed. Do not retry it.`, { extensions: { code: 'TEAM_CHAT_DUPLICATE', earlierSeq: duplicate.seq, channelRef: channelId } });
  // Only the 60 newest matter: the 10th/60th newest determines when enough posts leave each window.
  const accepted = await tx.node.findMany({ where: { nodeType: 'chat-message', createdByWorkerId: workerId, createdAt: { gt: new Date(at.getTime() - 3_600_000) } }, orderBy: { createdAt: 'desc' }, take: 60, select: { createdAt: true } });
  const minute = accepted[9]?.createdAt;
  const hour = accepted[59]?.createdAt;
  const minuteReset = minute && minute.getTime() > at.getTime() - 60_000 ? minute.getTime() + 60_000 : 0;
  const hourReset = hour ? hour.getTime() + 3_600_000 : 0;
  const resetsAt = Math.max(minuteReset, hourReset);
  if (resetsAt === 0) return null;
  const limit = hourReset > minuteReset ? 'hour' : 'minute';
  const max = limit === 'minute' ? 10 : 60;
  const windowSeconds = limit === 'minute' ? 60 : 3600;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetsAt - at.getTime()) / 1000));
  await raiseRateAlarm(tx, workerId, at, limit);
  return new GraphQLError(`Worker post limit ${max} per ${windowSeconds} seconds reached (${limit}). Retry after ${retryAfterSeconds} seconds, at ${new Date(resetsAt).toISOString()}; do not retry before then.`, { extensions: { code: 'TEAM_CHAT_RATE_LIMITED', limit, max, windowSeconds, retryAfterSeconds, resetsAt: new Date(resetsAt).toISOString() } });
}
