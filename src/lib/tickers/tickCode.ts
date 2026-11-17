/** #2733, cor:agt:110:01: the runtime copy stores its code once; templates describe future copies. */
import { tickerSlugBase } from './tickerSlug.js';
export const TICK_CODE_PREFIX = 'tick.';
export const tickCodeOfSlug = (slug: string): string => TICK_CODE_PREFIX + slug;
export const templateTickCode = (name: string): string => tickCodeOfSlug(tickerSlugBase(name));
