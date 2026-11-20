/** STUB (#4348 pins): the inline comparison the seven jobs carry today. Replaced in the implementation commit. */
export function isProcessEntry(importMetaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  return importMetaUrl === `file://${argv1}`;
}
