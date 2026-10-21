/** Resolve once at startup so resizing a browser never replaces the active surface. */
export function resolveWebPlatform(options: {
  configuredPlatform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
}): 'web' | 'mobile' {
  if (options.configuredPlatform === 'mobile') return 'mobile';
  const userAgent = options.userAgent ?? '';
  if (/Android|iPhone|iPad|iPod|Mobile|Tablet|Silk\//i.test(userAgent)) return 'mobile';
  // iPadOS requests desktop sites with a Macintosh user agent. Desktop Macs
  // have no multi-touch screen; Windows touch laptops retain the desktop UI.
  if (/Macintosh/i.test(userAgent) && (options.maxTouchPoints ?? 0) > 1) return 'mobile';
  return 'web';
}
