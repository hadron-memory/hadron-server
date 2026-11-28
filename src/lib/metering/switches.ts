/**
 * The billing deployment switches, each parsed in exactly one place and read per call. This module imports nothing, so the
 * AI configuration walk (`src/lib/aiConfig.ts`) and the run wrapper (`src/lib/runner/runAiConfig.ts`) can read the same
 * predicate the credit gate reads without importing the gate itself (#5025, Billing A8): the gate (`./gate.ts`) stays callable
 * from the launch, the hop and the configuration test only (#5023 pin 13), and there is still one parse of each variable.
 * `./index.ts` re-exports {@link debitEnabled}, `./gate.ts` re-exports {@link creditGateEnabled} and {@link creditGateActive}.
 */

/** FR-006: automatic usage debits are OFF unless explicitly enabled (`true` or `1`, trimmed, any case). */
export function debitEnabled(): boolean {
  const raw = process.env.BILLING_DEBIT_ENABLED?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

/** The credit gate switch: ONLY the exact value `true`, read per call. `TRUE`, `1`, ` true` and every other value mean off. */
export function creditGateEnabled(): boolean {
  return process.env.BILLING_CREDIT_GATE_ENABLED === 'true';
}

/**
 * The gate runs only when debits are on as well: with no debit there is nothing to run out of. One parse, shared with the debit.
 * #5025 (Billing A8, cor:dmo:050:10): the same predicate opens the platform level of the AI configuration walk to a person.
 */
export function creditGateActive(): boolean {
  return debitEnabled() && creditGateEnabled();
}
