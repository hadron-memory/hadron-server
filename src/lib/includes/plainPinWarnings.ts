import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
export async function plainPinWarnings(_ctx: Context, _source: { memoryId: string }, _content: string | null | undefined): Promise<{ code: string; text: string }[]> {
  return [];
}
