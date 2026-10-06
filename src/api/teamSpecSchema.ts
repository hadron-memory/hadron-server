import type { Express } from 'express';
import { publishedTeamSpecSchema, TEAM_API_VERSION } from '../lib/teamSpec/schema.js';

/** Public format discovery: schema only, no tenant state. */
export function mountTeamSpecSchemaRoutes(app: Express): void {
  app.get('/schemas/team/:version.json', (req, res) => {
    if (req.params.version !== TEAM_API_VERSION.split('/').at(-1)) {
      res.status(404).json({ code: 'TEAM_SPEC_VERSION_UNSUPPORTED', accepted: [TEAM_API_VERSION] });
      return;
    }
    res.json(publishedTeamSpecSchema(TEAM_API_VERSION));
  });
}
