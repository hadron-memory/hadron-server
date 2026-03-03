import { findGraph } from './operations/findGraph.js';
import { updateNode } from './operations/updateNode.js';
import { createNode } from './operations/createNode.js';
import { createUsageEvent } from './operations/createUsageEvent';

export const controller = {
  operations: {
    findGraph,
    createNode,
    updateNode,
    createUsageEvent,
  },
}
