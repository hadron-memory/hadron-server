/** Red checkpoint: a diagnostic must reject a fixture/global-client bypass during its span. */
export function guardFixtureClient3638<T extends object>(client: T, _active: () => boolean): T {
  return client;
}
