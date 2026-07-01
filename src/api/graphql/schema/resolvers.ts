// GraphQL resolver map — thin assembler.
//
// The implementation was split out of this file (originally ~11k lines) into
// domain modules over three steps:
//   - resolvers.helpers.ts           shared auth/include/AI-config/chat/asset helpers (step 1)
//   - resolvers.types.ts             type-level field resolvers (step 3)
//   - resolvers.query.<domain>.ts    Query resolvers, by domain (step 3)
//   - resolvers.mutation.<domain>.ts Mutation resolvers, by domain (step 2)
//
// This file only imports those slices and spreads them into the resolver map.
// `Context` is re-exported so existing importers (mcp/server.ts + the resolver
// test suite, ~80 files) keep importing it from './resolvers.js' unchanged.
import { type Context } from './resolvers.helpers.js';
export type { Context };

import { typeResolvers } from './resolvers.types.js';

import { nodeQueries } from './resolvers.query.node.js';
import { assetQueries } from './resolvers.query.asset.js';
import { memoryQueries } from './resolvers.query.memory.js';
import { orgQueries } from './resolvers.query.org.js';
import { agentQueries } from './resolvers.query.agent.js';
import { appQueries } from './resolvers.query.app.js';
import { chatQueries } from './resolvers.query.chat.js';
import { sessionQueries } from './resolvers.query.session.js';

import { nodeMutations } from './resolvers.mutation.node.js';
import { assetMutations } from './resolvers.mutation.asset.js';
import { memoryMutations } from './resolvers.mutation.memory.js';
import { orgMutations } from './resolvers.mutation.org.js';
import { agentMutations } from './resolvers.mutation.agent.js';
import { appMutations } from './resolvers.mutation.app.js';
import { chatMutations } from './resolvers.mutation.chat.js';
import { sessionMutations } from './resolvers.mutation.session.js';

export const resolvers = {
  ...typeResolvers,
  Query: {
    ...nodeQueries,
    ...assetQueries,
    ...memoryQueries,
    ...orgQueries,
    ...agentQueries,
    ...appQueries,
    ...chatQueries,
    ...sessionQueries,
  },
  Mutation: {
    ...nodeMutations,
    ...assetMutations,
    ...memoryMutations,
    ...orgMutations,
    ...agentMutations,
    ...appMutations,
    ...chatMutations,
    ...sessionMutations,
  },
};
