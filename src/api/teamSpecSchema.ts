import type { Express } from 'express';
import { publishedTeamSpecSchemaText, TEAM_API_VERSION } from '../lib/teamSpec/schema.js';

/** Public format discovery: schema only, no tenant state. */
export function mountTeamSpecSchemaRoutes(app: Express): void {
  app.get('/schemas/team/:version.json', (req, res) => {
    if (req.params.version !== TEAM_API_VERSION.split('/').at(-1)) {
      res.status(404).json({ code: 'TEAM_SPEC_VERSION_UNSUPPORTED', accepted: ['v1alpha1.json'] });
      return;
    }
    res.type('application/schema+json').send(publishedTeamSpecSchemaText(TEAM_API_VERSION));
  });
}
