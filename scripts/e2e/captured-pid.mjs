// The signal function is injected so cleanup validation can be tested safely.
export function stopCapturedChild(raw, signal) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return false;
  const pid = Number(raw.trim());
  // Node accepts zero/negative PIDs as process groups; PID 1 is never our child.
  // Keep the value in the signed pid_t range so conversion cannot wrap it.
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff) return false;
  signal(pid, 'SIGTERM');
  return true;
}
