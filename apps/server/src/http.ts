import type { Context } from 'hono';

export type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 413 | 415 | 429 | 500 | 503;

/** An OAuth-style error body, `{error, error_description}`, plus any extension fields. */
export function apiError(
  c: Context,
  status: ErrorStatus,
  error: string,
  description: string,
  extra: Readonly<Record<string, unknown>> = {},
  headers: Readonly<Record<string, string>> = {},
) {
  return c.json({ error, error_description: description, ...extra }, status, headers);
}
