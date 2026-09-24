/** Security headers for every response, and a per-address rate limit for public endpoints. */

import type { Context, MiddlewareHandler } from 'hono';
import { apiError } from './http';

/** The web app loads only its own scripts and styles; wallet icons are data: URLs. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('content-security-policy', CONTENT_SECURITY_POLICY);
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  c.header('x-frame-options', 'DENY');
};

/** The client address: X-Forwarded-For only when a trusted proxy sets it, else the socket. */
function clientAddress(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

/** A fixed one-minute window per client address. */
export function rateLimit(options: { perMinute: number; trustProxy: boolean; now: () => Date }): MiddlewareHandler {
  const windows = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    const now = options.now().getTime();
    const key = clientAddress(c, options.trustProxy);
    let window = windows.get(key);
    if (window === undefined || now - window.start >= 60_000) {
      window = { start: now, count: 0 };
      windows.set(key, window);
      // Forget old windows so the map cannot grow without bound.
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (now - w.start >= 60_000) windows.delete(k);
      }
    }
    window.count++;
    if (window.count > options.perMinute) {
      const retryAfter = Math.max(1, Math.ceil((window.start + 60_000 - now) / 1000));
      return apiError(c, 429, 'rate_limited', 'too many requests; try again later', {}, { 'retry-after': String(retryAfter) });
    }
    await next();
  };
}
