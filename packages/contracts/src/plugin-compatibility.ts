/** Version policy for the declarative bundle host; independent of UI surface versions. */
export const PLUGIN_HOST_API_VERSION = "1.1.0";
export const STABLE_PLUGIN_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const PLUGIN_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface PluginHostRequirement { min: string; maxExclusive?: string }
export interface PluginCompatibilitySubject { requires?: { hostApiVersion: PluginHostRequirement } }

/** Null means an existing legacy version cannot be ordered; never guess its age. */
export function comparePluginVersions(left: string, right: string): -1 | 0 | 1 | null {
  const a = PLUGIN_VERSION_PATTERN.exec(left);
  const b = PLUGIN_VERSION_PATTERN.exec(right);
  if (!a || !b) return null;
  const compare = (x: string, y: string): -1 | 0 | 1 => {
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric && x.length !== y.length) return x.length < y.length ? -1 : 1;
    return x === y ? 0 : x < y ? -1 : 1;
  };
  for (let i = 1; i <= 3; i++) {
    const result = compare(a[i]!, b[i]!);
    if (result) return result;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const ap = a[4].split(".");
  const bp = b[4].split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i]; const y = bp[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (/^\d+$/.test(x) !== /^\d+$/.test(y)) return /^\d+$/.test(x) ? -1 : 1;
    const result = compare(x, y);
    if (result) return result;
  }
  return 0;
}

export function checkPluginHostCompatibility(
  manifest: PluginCompatibilitySubject,
  hostVersion = PLUGIN_HOST_API_VERSION,
): { compatible: boolean; reason?: string } {
  const range = manifest.requires?.hostApiVersion ?? { min: "1.0.0", maxExclusive: "2.0.0" };
  if (!STABLE_PLUGIN_VERSION_PATTERN.test(hostVersion) || !STABLE_PLUGIN_VERSION_PATTERN.test(range.min)
    || (range.maxExclusive !== undefined && (!STABLE_PLUGIN_VERSION_PATTERN.test(range.maxExclusive)
      || comparePluginVersions(range.min, range.maxExclusive) !== -1))) {
    return { compatible: false, reason: "Invalid host API version or compatibility interval" };
  }
  if (comparePluginVersions(hostVersion, range.min) === -1
    || (range.maxExclusive !== undefined && comparePluginVersions(hostVersion, range.maxExclusive) !== -1)) {
    return { compatible: false, reason: `Host API ${hostVersion} does not satisfy >=${range.min}${range.maxExclusive ? ` <${range.maxExclusive}` : ""}` };
  }
  return { compatible: true };
}
