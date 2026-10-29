/**
 * #2047 (S10) — the one activation gate for boot-prompt serving.
 *
 * Default OFF. OFF keeps every surface exactly as before: no refusals, no records, retired prompt text still read.
 * ON is Holger's act, after the R28 content cutover; this helper is the only place the flag is read, so no path can
 * activate serving on its own. Read per call, so toggling it is a restart, not a redeploy.
 */
export function bootPromptServingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BOOT_PROMPT_SERVE_ENABLED === 'true';
}
