/** #3056: read at each tick so an operator can narrow later runs without disabling their bound. */
const DEFAULT_MAX_ROWS = 200;
let warned = false;

export function gitMirrorSweepRowBudget(): number {
  const value = Number(process.env.GIT_MIRROR_SWEEP_MAX_ROWS);
  // Match automation/runBudgets: positive safe integers within a signed PostgreSQL integer.
  if (Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647) return value;
  if (!warned) {
    console.warn('[git-mirror-sweep] GIT_MIRROR_SWEEP_MAX_ROWS unset or invalid; using 200 rows per run');
    warned = true;
  }
  return DEFAULT_MAX_ROWS;
}
