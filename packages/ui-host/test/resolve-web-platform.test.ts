import { describe, expect, it } from 'vitest';
import { resolveWebPlatform } from '../src/resolve-web-platform';

describe('resolveWebPlatform', () => {
  it('keeps the Capacitor mobile build on the mobile surface without relying on browser signals', () => {
    expect(resolveWebPlatform({ configuredPlatform: 'mobile' })).toBe('mobile');
  });

  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148', 5],
    ['iPad', 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604.1', 5],
    ['iPad desktop browser', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605.1.15', 5],
    ['Android phone', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36', 5],
    ['Android tablet', 'Mozilla/5.0 (Linux; Android 15; SM-X700) Chrome/140.0 Safari/537.36', 5],
    ['Kindle tablet', 'Mozilla/5.0 (Linux) Silk/123.3 Safari/537.36', 5],
  ])('detects %s as mobile regardless of viewport size', (_device, userAgent, maxTouchPoints) => {
    expect(resolveWebPlatform({ userAgent, maxTouchPoints })).toBe('mobile');
  });

  it.each([
    ['Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36', 0],
    ['Windows touch laptop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36', 10],
    ['Linux', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36', 0],
  ])('keeps %s on desktop Web, including narrow windows', (_device, userAgent, maxTouchPoints) => {
    expect(resolveWebPlatform({ userAgent, maxTouchPoints })).toBe('web');
  });

  it('uses Web when browser signals are missing', () => {
    expect(resolveWebPlatform({})).toBe('web');
  });
  it('detects a phone in the shared Web build', () => {
    expect(resolveWebPlatform({ configuredPlatform: 'web', userAgent: 'iPhone Mobile' })).toBe('mobile');
  });
});
