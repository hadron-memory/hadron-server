// The signal function is injected so cleanup validation can be tested safely.
export function stopCapturedChild(raw, signal) {
  signal(Number(raw), 'SIGTERM');
  return true;
}
