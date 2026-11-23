/**
 * #4921 slice A: the App's role lists, one per purpose. The App says which of its roles holds a purpose; code never
 * compares a team role's name (rulings 0270, 0271). The stored form is the saturation wake list's (cor:agt:060:16,
 * `normalizeWakeRoles`), so the App has ONE role-list format. Slice A stores and serves the lists; slice B makes the
 * three doors read them.
 */
import { normalizeWakeRoles } from './saturation.js';

/** The three purposes, with the `agent_task_stall_schedule` column each list lives in and its SDL field name. */
export const APP_ROLE_PURPOSES = {
  DEFECT_LINK: { column: 'defectLinkRoles', field: 'defectLink' },
  REGISTER_PICK: { column: 'registerPickRoles', field: 'registerPick' },
  REVIEW_WITHDRAW: { column: 'reviewWithdrawRoles', field: 'reviewWithdraw' },
} as const;
export type AppRolePurpose = keyof typeof APP_ROLE_PURPOSES;
export type AppRoleColumn = (typeof APP_ROLE_PURPOSES)[AppRolePurpose]['column'];

export function isAppRolePurpose(v: unknown): v is AppRolePurpose {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(APP_ROLE_PURPOSES, v);
}

/** The stored form of a list (trimmed, lower-cased, de-duplicated, sorted), or null when malformed. */
export const normalizeRoleList = normalizeWakeRoles;

/** An App's three lists, empty where it has no row or the list was never set. */
export type AppRoleListsView = { appId: string; defectLink: string[]; registerPick: string[]; reviewWithdraw: string[] };
