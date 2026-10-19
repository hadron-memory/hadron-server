export type TeamWorker = { id: string; name: string; reportsToWorkerId: string | null; retiredAt: Date | null };
export type TeamTagSnapshot = { headId: string; label: string };
export type TeamSnapshot = { teamTagsVersion: 1; teamTags: TeamTagSnapshot[]; teamHeadIds: string[]; teamBroadcastWorkerIds: string[] };
export function teamTagsEnabled(value = process.env.TEAM_TAGS_ENABLED): boolean { return false; }
export function reservedTeamPrefix(name: string, enabled = teamTagsEnabled()): boolean { return false; }
export function buildTeamSnapshot(workers: readonly TeamWorker[], authorWorkerId: string | null, mentions: readonly string[]): TeamSnapshot {
  return { teamTagsVersion: 1, teamTags: [], teamHeadIds: [], teamBroadcastWorkerIds: [] };
}
