/**
 * #2198 — copy the task warnings a request collected (`ctx.taskWarnings`, filed by the four task mutations after
 * their write committed) into the response's `extensions.warnings`. The data and error envelope are untouched; a
 * mutation that errored contributes none; per-operation and per-response caps are applied here (deterministically).
 * See src/api/graphql/schema/resolvers.taskWarnings.ts.
 */
import type { ApolloServerPlugin } from '@apollo/server';
import type { Context } from './schema/resolvers.helpers.js';
import { flushTaskWarningHistory, shapeResponseWarnings } from './schema/resolvers.taskWarnings.js';

export const taskWarningsPlugin: ApolloServerPlugin<Context> = {
  async requestDidStart() {
    return {
      async willSendResponse(requestContext) {
        const collected = requestContext.contextValue?.taskWarnings;
        const body = requestContext.response.body;
        if (body.kind !== 'single') return;
        const errored = new Set<string>();
        for (const e of body.singleResult.errors ?? []) {
          const head = e.path?.[0];
          if (typeof head === 'string') errored.add(head);
        }
        await flushTaskWarningHistory(requestContext.contextValue, errored);
        const warnings = shapeResponseWarnings(collected ?? [], errored);
        if (warnings.length === 0) return;
        body.singleResult.extensions = { ...body.singleResult.extensions, warnings };
      },
    };
  },
};
