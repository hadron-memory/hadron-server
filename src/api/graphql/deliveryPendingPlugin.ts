import type { ApolloServerPlugin } from '@apollo/server';
import type { Context } from './schema/resolvers.helpers.js';
import { deliveryPending } from '../../lib/tickers/deliveryPending.js';

/** Successful completed operations only; preserve every existing data/error/extension field. */
export const deliveryPendingPlugin: ApolloServerPlugin<Context> = {
  async requestDidStart() {
    return { async willSendResponse({ contextValue, response }) {
      if (response.body.kind !== 'single' || response.body.singleResult.errors?.length) return;
      const pending = await deliveryPending(contextValue);
      if (!pending) return;
      const result = response.body.singleResult;
      const old = result.extensions?.hadron;
      result.extensions = { ...result.extensions, hadron: { ...(old && typeof old === 'object' ? old : {}), deliveryPending: pending } };
    } };
  },
};
