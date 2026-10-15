import type { buildOpenApiDocument } from '@aervox/contracts';

export interface RouteCoverageException {
  method: string;
  path: string;
  module: string;
  reason: string;
}

/** Parameter spelling does not change endpoint identity; implicit HEAD/OPTIONS are excluded. */
export function routeCoverageKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/:[A-Za-z0-9_]+|\{[^}]+\}/g, '{param}')}`;
}

export function compareRouteCoverage(
  routes: readonly { method: string; path: string }[],
  document: Pick<ReturnType<typeof buildOpenApiDocument>, 'paths'>,
  exceptions: readonly RouteCoverageException[],
): { missing: string[]; stale: string[]; invalid: string[] } {
  const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  const actual = new Set(routes.filter(route => route.path.startsWith('/v1/') && methods.has(route.method.toUpperCase()))
    .map(route => routeCoverageKey(route.method, route.path)));
  const declared = new Set(Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item ?? {}).filter(method => methods.has(method.toUpperCase())).map(method => routeCoverageKey(method, path))));
  const known = new Set(exceptions.map(entry => routeCoverageKey(entry.method, entry.path)));
  const invalid = exceptions.filter(entry => !entry.module.trim() || !entry.reason.trim()).map(entry => routeCoverageKey(entry.method, entry.path));
  if (known.size !== exceptions.length) invalid.push('duplicate_exception');
  return {
    missing: [...actual].filter(key => !declared.has(key) && !known.has(key)).sort(),
    stale: [...known].filter(key => !actual.has(key) || declared.has(key)).sort(),
    invalid,
  };
}
