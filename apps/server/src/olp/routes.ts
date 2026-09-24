/**
 * OLP endpoints (RSL 1.0 §5): POST /olp/token, /olp/introspect and /olp/key, all behind HTTP
 * Basic client authentication, plus the public JWKS for offline token verification.
 */

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { apiError } from '../http';
import { parseBasicAuth, type Client, type ClientStore } from './clients';
import type { KeyStore } from './keys';
import type { LicenseService } from './service';

type Env = { Variables: { client: Client } };

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };
const MAX_REQUEST_BYTES = 1_048_576;

/** Reads a form-encoded body (RSL §5.4.2); a string is the reason it was rejected. */
async function readForm(c: Context): Promise<Record<string, string> | string> {
  if (!/^application\/x-www-form-urlencoded\b/i.test(c.req.header('content-type') ?? '')) {
    return 'the request body must be application/x-www-form-urlencoded (RSL §5.4.2)';
  }
  const params = new URLSearchParams(await c.req.text());
  const form: Record<string, string> = {};
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    if (values.length > 1) return `parameter ${name} must not appear more than once`;
    form[name] = values[0]!;
  }
  return form;
}

export function olpRoutes(services: { clients: ClientStore; keys: KeyStore; licensing: LicenseService }): Hono<Env> {
  const { clients, keys, licensing } = services;
  const app = new Hono<Env>();

  app.use('/olp/*', bodyLimit({ maxSize: MAX_REQUEST_BYTES }), async (c, next) => {
    const credentials = parseBasicAuth(c.req.header('authorization'));
    const client = credentials && clients.verify(credentials.clientId, credentials.secret);
    if (client === undefined) {
      return apiError(c, 401, 'invalid_client', 'Client authentication failed.', {}, {
        'www-authenticate': 'Basic realm="grantmark-olp", charset="UTF-8"',
      });
    }
    c.set('client', client);
    await next();
  });

  app.post('/olp/token', async (c) => {
    const form = await readForm(c);
    if (typeof form === 'string') return apiError(c, 400, 'invalid_request', form, {}, NO_STORE);

    const outcome = await licensing.requestToken(c.get('client'), form);
    switch (outcome.kind) {
      case 'token': {
        const excluded = Object.keys(outcome.excludedScope).length > 0 ? { excluded_scope: outcome.excludedScope } : {};
        return c.json(
          {
            access_token: outcome.accessToken,
            token_type: 'License',
            expires_in: outcome.expiresIn,
            license_id: outcome.license.id,
            subject_scope: outcome.license.subjectScope.join(' '),
            ...excluded,
          },
          200,
          NO_STORE,
        );
      }
      case 'payment_required':
        // Grantmark extension: OLP defines no payment signal (see the OLP-HCS notes).
        return apiError(
          c,
          402,
          'payment_required',
          'This license requires payment before a token can be issued.',
          {
            payment: {
              license_request: outcome.request.id,
              status: 'requires_payment',
              amount: outcome.request.amount,
              accepts: [],
            },
          },
          NO_STORE,
        );
      case 'error':
        return apiError(
          c,
          outcome.status,
          outcome.error,
          outcome.description,
          outcome.reasonCode === undefined ? {} : { reason_code: outcome.reasonCode },
          NO_STORE,
        );
    }
  });

  app.post('/olp/introspect', async (c) => {
    const form = await readForm(c);
    if (typeof form === 'string') return apiError(c, 400, 'invalid_request', form, {}, NO_STORE);
    if (!form.token || !form.resource) return apiError(c, 400, 'invalid_request', 'token and resource are required', {}, NO_STORE);
    return c.json(await licensing.introspect(form.token, form.resource), 200, NO_STORE);
  });

  app.post('/olp/key', (c) =>
    apiError(
      c,
      400,
      'invalid_request',
      'This license server does not hold Encrypted Media Standard keys (RSL §5.6); Grantmark licenses are not tied to encrypted assets.',
    ),
  );

  app.get('/.well-known/jwks.json', async (c) => c.json(await keys.jwks(), 200, { 'cache-control': 'public, max-age=300' }));

  return app;
}
