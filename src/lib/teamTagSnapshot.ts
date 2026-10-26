// S3: the caller holds the App reportsTo graph shared through commit. Only
// destination-App workers are supplied. All returned values are post-time facts.
import { GraphQLError } from 'graphql';
import { mentionTokenOf } from './mentionToken.js';
export type TeamWorker = { id: string; name: string; reportsToWorkerId: string | null; retiredAt: Date | null };
export type TeamTagSnapshot = { headId: string; label: string };
export type TeamSnapshot = { teamTagsVersion: 1; teamTags: TeamTagSnapshot[]; teamHeadIds: string[]; teamBroadcastWorkerIds: string[] };
/** One deployment mode gates reservation, routing/stamping and alias retirement. */
export function teamTagsEnabled(value = process.env.TEAM_TAGS_ENABLED): boolean { return value === 'true'; }
export function reservedTeamPrefix(name: string, enabled = teamTagsEnabled()): boolean {
  return enabled && (mentionTokenOf(name)?.startsWith('team.') ?? false);
}
export function teamHeadInvalid(): GraphQLError {
  return new GraphQLError('Team broadcast target is unavailable in this Channel.', { extensions: { code: 'TEAM_CHAT_TEAM_HEAD_INVALID' } });
}
export function buildTeamSnapshot(workers: readonly TeamWorker[], authorWorkerId: string | null, mentions: readonly string[]): TeamSnapshot {
  const live = workers.filter(w => !w.retiredAt);
  const byId = new Map(live.map(w => [w.id, w]));
  const heads = new Set(live.filter(w => w.reportsToWorkerId && byId.has(w.reportsToWorkerId)).map(w => w.reportsToWorkerId!));
  const nearest = (id: string | null): string | null => {
    const w = id ? byId.get(id) : null;
    if (!w) return null;
    if (heads.has(w.id)) return w.id;
    return w.reportsToWorkerId && byId.has(w.reportsToWorkerId) ? w.reportsToWorkerId : null;
  };
  const tagged = new Set<string>();
  const recipients = new Set<string>();
  const addTag = (id: string | null) => { if (id && mentionTokenOf(byId.get(id)!.name)) tagged.add(id); };
  addTag(nearest(authorWorkerId));
  for (const mention of mentions) {
    if (mention === 'team.all' || (mention.startsWith('team.') && mention.endsWith('.all'))) {
      let head: string | null;
      if (mention === 'team.all') head = nearest(authorWorkerId);
      else {
        const token = mention.slice(5, -4);
        const matches = live.filter(w => heads.has(w.id) && mentionTokenOf(w.name) === token);
        head = matches.length === 1 ? matches[0]!.id : null;
      }
      if (!head) throw teamHeadInvalid();
      addTag(head);
      const pending = [head];
      while (pending.length) {
        const id = pending.pop()!;
        if (recipients.has(id)) continue;
        recipients.add(id);
        pending.push(...live.filter(w => w.reportsToWorkerId === id).map(w => w.id));
      }
    } else {
      // Lossy ordinary mention tokens may address several workers; union their teams.
      for (const w of live) if (mentionTokenOf(w.name) === mention) addTag(nearest(w.id));
    }
  }
  const teamHeadIds = [...tagged].sort();
  return { teamTagsVersion: 1, teamHeadIds,
    teamTags: teamHeadIds.map(headId => ({ headId, label: `@team.${mentionTokenOf(byId.get(headId)!.name)!}` })),
    teamBroadcastWorkerIds: [...recipients].sort() };
}
