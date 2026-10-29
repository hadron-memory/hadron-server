import { isAbsolute, relative, resolve, sep } from 'node:path';

export class ProjectionPathError extends Error {}

/** Resolve a projection/checkout destination beneath its configured root, before any filesystem or git work. */
export function pathUnderGraphsRoot(root: string, ...segments: string[]): string {
  // Refuse special components even when normalization would return inside the root.
  if (segments.some(segment => segment.split(/[\\/]/).some(atom => atom === '.' || atom === '..'))) {
    throw new ProjectionPathError('Invalid projection path');
  }
  const base = resolve(root);
  const target = resolve(base, ...segments);
  const child = relative(base, target);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new ProjectionPathError('Invalid projection path');
  }
  return target;
}
