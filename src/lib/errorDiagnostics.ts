/** Keep public error fields while removing server diagnostic extensions from any transport. */
export function publicErrorExtensions(extensions: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { stacktrace: _stacktrace, exception: _exception, ...publicFields } = extensions;
  return publicFields;
}
