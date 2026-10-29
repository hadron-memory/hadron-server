/**
 * #2198 — copy the task warnings a request collected (`ctx.taskWarnings`, filed by the four task mutations after
 * their write committed) into the response's `extensions.warnings`. The data and error envelope are untouched; a
 * mutation that errored contributes none; per-operation and per-response caps are applied here (deterministically).
 * #2063 plain-pin advice joins the same response-level carrier after committed node writes.
 * See src/api/graphql/schema/resolvers.taskWarnings.ts and lib/includes/plainPinWarnings.ts.
 */
import { beginIncludeWarningPath, responseIncludePinWarnings, resetIncludePinWarnings } from '../../lib/includes/plainPinWarnings.js';
import type { ApolloServerPlugin } from '@apollo/server';
import type { Context } from './schema/resolvers.helpers.js';
import { flushTaskWarningHistory, shapeResponseWarnings } from './schema/resolvers.taskWarnings.js';

export const taskWarningsPlugin: ApolloServerPlugin<Context> = {
  async requestDidStart(requestContext) {
    if (requestContext.contextValue) resetIncludePinWarnings(requestContext.contextValue);
    return {
      async executionDidStart() {
        return {
          willResolveField({ contextValue, info }) {
            if (!contextValue || info.parentType.name !== 'Mutation') return;
            return beginIncludeWarningPath(contextValue, String(info.path.key));
          },
        };
      },
      async willSendResponse(requestContext) {
        const ctx = requestContext.contextValue;
        if (!ctx) return;
        const collected = ctx.taskWarnings;
        const body = requestContext.response.body;
        if (body.kind !== 'single') return;
        const errored = new Set<string>();
        for (const e of body.singleResult.errors ?? []) {
          const head = e.path?.[0];
          if (typeof head === 'string') errored.add(head);
        }
        await flushTaskWarningHistory(ctx, errored);
        const warnings = [...shapeResponseWarnings(collected ?? [], errored), ...await responseIncludePinWarnings(ctx, errored)].slice(0, 20);
        if (warnings.length === 0) return;
        body.singleResult.extensions = { ...body.singleResult.extensions, warnings };
      },
    };
  },
};
