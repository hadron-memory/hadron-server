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

import { dateTimeScalar } from './dateTimeScalar.js';
import { typeResolvers } from './resolvers.types.js';

import { nodeQueries } from './resolvers.query.node.js';
import { skillQueries } from './resolvers.query.skill.js';
import { edgeQueries } from './resolvers.query.edge.js';
import { assetQueries } from './resolvers.query.asset.js';
import { memoryQueries } from './resolvers.query.memory.js';
import { orgQueries } from './resolvers.query.org.js';
import { agentQueries } from './resolvers.query.agent.js';
import { appQueries } from './resolvers.query.app.js';
import { chatQueries } from './resolvers.query.chat.js';
import { sessionQueries } from './resolvers.query.session.js';
import { slackQueries } from './resolvers.query.slack.js';
import { mcpQueries } from './resolvers.query.mcp.js';
import { homeAssistantQueries } from './resolvers.query.homeAssistant.js';
import { resendSenderQueries } from './resolvers.query.resendSender.js';
import { secretMutations, secretQueries } from './resolvers.secret.js';
import {
  impersonationMutations,
  impersonationQueries,
  impersonationTypeResolvers,
} from './resolvers.impersonation.js';
import { dashboardQueries, dashboardMutations } from './resolvers.dashboard.js';

import { nodeMutations } from './resolvers.mutation.node.js';
import { objectQueries, objectMutations } from './resolvers.object.js';
import { appRunMutations, appRunQueries } from './resolvers.appRun.js';
import { meteringMutations, meteringQueries } from './resolvers.metering.js';
import { connectionGrantMutations, connectionGrantQueries } from './resolvers.connectionGrant.js';
import { principalGrantMutations, principalGrantQueries } from './resolvers.principalGrant.js';
import { importNodeMutations } from './resolvers.mutation.importNode.js';
import { assetMutations } from './resolvers.mutation.asset.js';
import { memoryMutations } from './resolvers.mutation.memory.js';
import { memoryTransferMutations } from './resolvers.mutation.memoryTransfer.js';
import { appMemoryMutations } from './resolvers.mutation.appMemory.js';
import { orgMutations } from './resolvers.mutation.org.js';
import { agentMutations } from './resolvers.mutation.agent.js';
import { workerMutations, workerQueries, workerFieldResolvers } from './resolvers.worker.js';
import { teamRoleMutations, teamRoleQueries } from './resolvers.teamRole.js';
import { teamChatMutations, teamChatQueries } from './resolvers.teamChat.js';
import { teamAttentionMutations, teamAttentionQueries } from './resolvers.teamAttention.js';
import { teamWorkMutations, teamWorkQueries } from './resolvers.teamWork.js';
import { memoryConfigMutations, memoryConfigQueries, memoryConfigFieldResolvers } from './resolvers.memoryConfig.js';
import { memoryConfigApplyMutations } from './resolvers.memoryConfigApply.js';
import { nodeApprovalFieldResolvers, nodeApprovalMutations, nodeApprovalQueries } from './resolvers.nodeApproval.js';
import { nodeAttributionFieldResolvers } from './resolvers.nodeAttribution.js';
import {
  specCorpusMintMutations,
  specCorpusMutations,
  specCorpusQueries,
  specCorpusRenumberMutations,
} from './resolvers.specCorpus.js';
import {
  memoryConfigTemplateFieldResolvers,
  memoryConfigTemplateMutations,
  memoryConfigTemplateQueries,
} from './resolvers.memoryConfigTemplate.js';
import { scopeMutations, scopeQueries, scopeFieldResolvers } from './resolvers.scope.js';
import { channelMutations, channelQueries, channelFieldResolvers } from './resolvers.channel.js';
import { registerMutations, registerQueries, registerFieldResolvers, readStateQueries, readStateMutations } from './resolvers.register.js';
import { appMutations } from './resolvers.mutation.app.js';
import { chatMutations } from './resolvers.mutation.chat.js';
import { sessionMutations } from './resolvers.mutation.session.js';
import { slackMutations } from './resolvers.mutation.slack.js';
import { mcpMutations } from './resolvers.mutation.mcp.js';
import { homeAssistantMutations } from './resolvers.mutation.homeAssistant.js';
import { resendSenderMutations } from './resolvers.mutation.resendSender.js';

export const resolvers = {
  // Issue #205: every date field is declared `DateTime`, so serialization is a
  // property of the schema rather than something each type has to remember.
  DateTime: dateTimeScalar,
  ...typeResolvers,
  ...impersonationTypeResolvers,
  ...workerFieldResolvers,
  ...scopeFieldResolvers,
  ...channelFieldResolvers,
  ...registerFieldResolvers,
  // `Agent` already has a block in typeResolvers; the register's field joins
  // it rather than replacing it (a bare spread would clobber the AI-config
  // and relation fields).
  Agent: { ...typeResolvers.Agent, ...registerFieldResolvers.Agent },
  // Same for Memory: the config field joins the existing type block (#1325).
  Memory: { ...typeResolvers.Memory, ...memoryConfigFieldResolvers.Memory },
  // #1591: approval status joins the existing Node block; #1610 the
  // Worker / Agent attribution with it.
  Node: { ...typeResolvers.Node, ...nodeApprovalFieldResolvers.Node, ...nodeAttributionFieldResolvers.Node },
  NodeRevision: { ...typeResolvers.NodeRevision, ...nodeAttributionFieldResolvers.NodeRevision },
  NodeApproval: nodeApprovalFieldResolvers.NodeApproval,
  NodeMintStatus: nodeApprovalFieldResolvers.NodeMintStatus,
  MemoryConfig: memoryConfigFieldResolvers.MemoryConfig,
  NodeRoleRule: memoryConfigFieldResolvers.NodeRoleRule,
  MemoryConfigTemplate: memoryConfigTemplateFieldResolvers.MemoryConfigTemplate,
  MemoryConfigTemplateRule: memoryConfigTemplateFieldResolvers.MemoryConfigTemplateRule,
  Query: {
    ...nodeQueries,
    ...specCorpusQueries,
    ...nodeApprovalQueries,
    ...skillQueries,
    ...objectQueries,
    ...edgeQueries,
    ...assetQueries,
    ...memoryQueries,
    ...orgQueries,
    ...agentQueries,
    ...appQueries,
    ...chatQueries,
    ...teamChatQueries,
    ...teamAttentionQueries,
    ...teamWorkQueries,
    ...memoryConfigQueries,
    ...memoryConfigTemplateQueries,
    ...scopeQueries,
    ...channelQueries,
    ...registerQueries,
    ...readStateQueries,
    ...workerQueries,
    ...teamRoleQueries,
    ...sessionQueries,
    ...slackQueries,
    ...mcpQueries,
    ...homeAssistantQueries,
    ...resendSenderQueries,
    ...secretQueries,
    ...dashboardQueries,
    ...appRunQueries,
    ...connectionGrantQueries,
    ...principalGrantQueries,
    ...meteringQueries,
    ...impersonationQueries,
  },
  Mutation: {
    ...nodeMutations,
    ...objectMutations,
    ...dashboardMutations,
    ...appRunMutations,
    ...meteringMutations,
    ...connectionGrantMutations,
    ...principalGrantMutations,
    ...importNodeMutations,
    ...assetMutations,
    ...memoryMutations,
    ...memoryTransferMutations,
    ...appMemoryMutations,
    ...orgMutations,
    ...agentMutations,
    ...workerMutations,
    ...teamRoleMutations,
    ...teamChatMutations,
    ...teamAttentionMutations,
    ...teamWorkMutations,
    ...memoryConfigMutations,
    ...memoryConfigTemplateMutations,
    ...memoryConfigApplyMutations,
    ...specCorpusMutations,
    ...specCorpusRenumberMutations,
    ...specCorpusMintMutations,
    ...nodeApprovalMutations,
    ...scopeMutations,
    ...channelMutations,
    ...registerMutations,
    ...readStateMutations,
    ...appMutations,
    ...chatMutations,
    ...sessionMutations,
    ...slackMutations,
    ...mcpMutations,
    ...homeAssistantMutations,
    ...resendSenderMutations,
    ...secretMutations,
    ...impersonationMutations,
  },
};
