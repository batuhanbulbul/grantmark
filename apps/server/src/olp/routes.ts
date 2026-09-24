/**
 * OLP endpoints (RSL 1.0 §5): POST /olp/token, /olp/introspect and /olp/key, all behind HTTP
 * Basic client authentication, plus the public JWKS for offline token verification.
 *
 * Paid offers use Grantmark's payment extension: /olp/token answers 402 with a payment request
 * and is retried with `payment_id` and `payment_evidence` (the transaction signature).
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { apiError } from '../http';
import { paymentBody } from '../payments/body';
import type { PaymentService, SettleOutcome } from '../payments/service';
import type { StoredPayment } from '../payments/store';
import { parseBasicAuth, type Client, type ClientStore } from './clients';
import type { KeyStore } from './keys';
import type { LicenseStore } from './licenses';
import type { LicenseService, TokenIssued } from './service';

export type ClientEnv = { Variables: { client: Client } };

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };
const MAX_REQUEST_BYTES = 1_048_576;

/** HTTP Basic client authentication (RSL §5.3), shared by the OLP and /v1 client endpoints. */
export function clientAuth(clients: ClientStore): MiddlewareHandler<ClientEnv> {
  return async (c, next) => {
    const credentials = parseBasicAuth(c.req.header('authorization'));
    const client = credentials && clients.verify(credentials.clientId, credentials.secret);
    if (client === undefined) {
      return apiError(c, 401, 'invalid_client', 'Client authentication failed.', {}, {
        'www-authenticate': 'Basic realm="grantmark-olp", charset="UTF-8"',
      });
    }
    c.set('client', client);
    await next();
  };
}

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

interface OlpServices {
  readonly clients: ClientStore;
  readonly keys: KeyStore;
  readonly licenses: LicenseStore;
  readonly licensing: LicenseService;
  readonly paymentService: PaymentService;
}

export function olpRoutes(services: OlpServices): Hono<ClientEnv> {
  const { clients, keys, licenses, licensing, paymentService } = services;
  const app = new Hono<ClientEnv>();

  const tokenResponse = (c: Context, outcome: TokenIssued) => {
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
  };
  const paymentRequired = (c: Context, payment: StoredPayment, description: string) =>
    apiError(c, 402, 'payment_required', description, { payment: paymentBody(payment, licenses.request(payment.licenseRequestId)!) }, NO_STORE);
  const settled = (c: Context, outcome: SettleOutcome) => {
    switch (outcome.kind) {
      case 'token':
        return tokenResponse(c, outcome);
      case 'pending':
        return paymentRequired(c, outcome.payment, outcome.payment.reason ?? 'The payment is not complete yet.');
      case 'error': {
        const extra = {
          ...(outcome.reasonCode === undefined ? {} : { reason_code: outcome.reasonCode }),
          ...(outcome.payment === undefined ? {} : { payment: { id: outcome.payment.id, status: outcome.payment.status } }),
        };
        return apiError(c, outcome.status, outcome.error, outcome.description, extra, NO_STORE);
      }
    }
  };

  app.use('/olp/*', bodyLimit({ maxSize: MAX_REQUEST_BYTES }), clientAuth(clients));

  app.post('/olp/token', async (c) => {
    const form = await readForm(c);
    if (typeof form === 'string') return apiError(c, 400, 'invalid_request', form, {}, NO_STORE);
    const client = c.get('client');
    if (form.payment_id !== undefined) return settled(c, await paymentService.settle(client, form));

    const outcome = await licensing.requestToken(client, form);
    if (outcome.kind === 'token') return tokenResponse(c, outcome);
    if (outcome.kind === 'error') return settled(c, outcome);

    const started = await paymentService.start(outcome.request, form.payer);
    if (started.kind === 'error') return settled(c, started);
    if (started.kind === 'payment') {
      return paymentRequired(c, started.payment, 'This license requires payment before a token can be issued.');
    }
    return apiError(
      c,
      402,
      'payment_required',
      'This license requires payment. Repeat the request with payer=<your Solana devnet wallet address> to get a transaction to sign.',
      {
        payment: {
          license_request: started.request.id,
          status: 'requires_payment',
          amount: started.request.amount,
          accepts: [],
        },
      },
      NO_STORE,
    );
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
