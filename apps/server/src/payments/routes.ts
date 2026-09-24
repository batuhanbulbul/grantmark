/** Payment status and transaction refresh for the client that owns a payment. */

import { Hono } from 'hono';
import { apiError } from '../http';
import type { ClientStore } from '../olp/clients';
import type { LicenseStore } from '../olp/licenses';
import { clientAuth, type ClientEnv } from '../olp/routes';
import { paymentBody } from './body';
import type { PaymentService } from './service';

export function paymentRoutes(services: { clients: ClientStore; licenses: LicenseStore; paymentService: PaymentService }): Hono<ClientEnv> {
  const { clients, licenses, paymentService } = services;
  const app = new Hono<ClientEnv>();
  const noStore = { 'cache-control': 'no-store' };

  app.use('/v1/payments/*', clientAuth(clients));

  app.get('/v1/payments/:id', (c) => {
    const payment = paymentService.owned(c.get('client'), c.req.param('id'));
    if (payment === undefined) return apiError(c, 404, 'not_found', 'no such payment for this client');
    return c.json(paymentBody(payment, licenses.request(payment.licenseRequestId)!), 200, noStore);
  });

  app.post('/v1/payments/:id/transaction', async (c) => {
    const payment = await paymentService.refresh(c.get('client'), c.req.param('id'));
    if (payment === undefined) return apiError(c, 404, 'not_found', 'no open payment with this id for this client');
    return c.json(paymentBody(payment, licenses.request(payment.licenseRequestId)!), 200, noStore);
  });

  return app;
}
