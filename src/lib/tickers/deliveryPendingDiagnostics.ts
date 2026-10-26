/** Footer telemetry is process-local and contains only finite classes, never raw errors or identities. */
export function footerFailureReason(_error: unknown): string {
  return 'failure';
}

export function createFooterOmissionReporter(
  write: (line: string) => void = line => console.warn(line),
  _now: () => number = Date.now,
): (reason: string) => void {
  return reason => {
    try { write(JSON.stringify({ event: 'delivery.pending.omitted', reason })); }
    catch { /* Diagnostics cannot change the successful operation. */ }
  };
}
