import { publishedTeamSpecSchemaText, type TeamSpecForm } from '../../../lib/teamSpec/schema.js';

/** Public format discovery only: no App or team state is returned. */
export const teamSpecQueries = {
  teamSpecSchema: async (_: unknown, { apiVersion, form }: { apiVersion: string; form?: TeamSpecForm | null }) =>
    publishedTeamSpecSchemaText(apiVersion, form ?? 'SERVER'),
};
