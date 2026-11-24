/**
 * The `user.roles.changed` audit line (#5012, Billing A5).
 *
 * One key=value line per change of a user's platform roles, written by every writer of `User.roles` that changes
 * them: `updateUserRoles`, a role-unioning `mergeUsers` (gate ruling 10.5) and the service-user mode of
 * `admin:mint-token`. Ids and role names only (no handle, email or name). Roles are sorted so the line is stable,
 * and an empty side is written empty (`before=`). Callers write it AFTER their transaction commits, so a
 * rolled-back change logs nothing.
 *
 * `actor` is the acting user's id, or `host-script` for the admin script, which has no authenticated user
 * (gate ruling 10.4).
 */
export function logUserRolesChanged(entry: {
  actor: string;
  target: string;
  before: readonly string[];
  after: readonly string[];
}): void {
  const list = (roles: readonly string[]) => [...new Set(roles)].sort().join(',');
  const before = list(entry.before);
  const after = list(entry.after);
  if (before === after) return;
  console.info(`user.roles.changed actor=${entry.actor} target=${entry.target} before=${before} after=${after}`);
}
