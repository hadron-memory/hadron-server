/**
 * #4677 (item 3, refs #419): the ONE source of the session cookie's name. Every writer
 * (`res.cookie(AUTH_COOKIE_NAME, …)`) and every reader (the OAuth consent handlers and the #419
 * admission adapter in `authRate.ts`) imports it, so a rename cannot leave admission reading a
 * cookie no handler sets.
 */
export const AUTH_COOKIE_NAME = 'hadron_token';
