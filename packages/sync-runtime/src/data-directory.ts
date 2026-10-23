import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This module has the same depth in src/ and dist/; never resolve from a nested module.
export const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

export function defaultDataDirectory(root = repositoryRoot): string {
  return path.join(root, 'data');
}
