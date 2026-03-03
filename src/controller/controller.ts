import { findGraph } from './operations/findGraph.js';
import { updateNode } from './operations/updateNode.js';
import { createNode } from './operations/createNode.js';
import { createUsageEvent } from './operations/createUsageEvent.js';
import { startup } from './startup.js';
import { syncGraphFromGithub } from '../integrations/github/syncGraphFromGithub.js';

export const controller = {
  startup,
  syncGraphFromGithub,
  operations: {
    findGraph,
    createNode,
    updateNode,
    createUsageEvent,
  },
};
