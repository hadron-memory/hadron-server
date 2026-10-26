import { GraphQLError } from 'graphql';

export type WorkerTeamChoice = { kind: 'UNSET' } | { kind: 'NO_TEAM' } | { kind: 'REPORTS_TO'; ref: string };
export type CastTeamArgs = { reportsTo?: string | null; noTeam?: boolean | null };

/** Presence is part of the wire contract: only undefined means omitted. */
export function castTeamChoice(args: CastTeamArgs): WorkerTeamChoice {
  const reports = args.reportsTo !== undefined;
  const noTeam = args.noTeam !== undefined;
  const refuse = (suffix: string, message: string): never => {
    throw new GraphQLError(message, { extensions: { code: `WORKER_TEAM_CHOICE_${suffix}` } });
  };
  if (reports && noTeam) return refuse('CONFLICT', 'Supply reportsTo or noTeam, never both.');
  if (!reports && !noTeam) {
    if (process.env.CAST_REPORTING_CHOICE_REQUIRED === 'true') {
      return refuse('REQUIRED', 'Choose reportsTo or noTeam: true when casting a worker.');
    }
    return { kind: 'UNSET' };
  }
  if (noTeam && args.noTeam === true) return { kind: 'NO_TEAM' };
  if (reports && typeof args.reportsTo === 'string' && args.reportsTo.trim()) return { kind: 'REPORTS_TO', ref: args.reportsTo.trim() };
  return refuse('INVALID', 'reportsTo must be a non-empty worker reference, or noTeam must be true.');
}

export function teamPlacement(worker: { reportsToWorkerId?: string | null; explicitNoTeam?: boolean }): 'UNSET' | 'NO_TEAM' | 'REPORTS_TO' {
  return worker.reportsToWorkerId ? 'REPORTS_TO' : worker.explicitNoTeam ? 'NO_TEAM' : 'UNSET';
}
