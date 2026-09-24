/**
 * Public license records (GET /v1/licenses/:id), receipts, and stamping. The record is the
 * consent authority that stamped images point to; see record.ts.
 */

import { createHash } from 'node:crypto';
import { CANONICAL_ID_BASE } from '@grantmark/hcs';
import type { StampMimeType, Stamper } from '@grantmark/stamp';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config';
import { apiError } from '../http';
import type { KeyStore } from '../olp/keys';
import type { License } from '../olp/licenses';
import { licenseRecord, licenseStatus, type RecordServices } from './record';

export const STAMP_TYPES: readonly StampMimeType[] = ['image/png', 'image/jpeg', 'image/webp'];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface LicenseServices extends RecordServices {
  readonly keys: KeyStore;
  readonly stamper: Stamper;
}

export function licenseRoutes(services: LicenseServices, config: Config, now: () => Date): Hono {
  const { licenses, licensing, keys, stamper } = services;
  const base = config.publicBaseUrl;
  const app = new Hono();

  const status = (license: License) => licenseStatus(license, now());

  app.get('/v1/licenses/:id', (c) => {
    const license = licenses.license(c.req.param('id'));
    if (license === undefined) return apiError(c, 404, 'not_found', 'no such license');
    return c.json(licenseRecord(services, config, now(), license), 200, { 'cache-control': 'no-cache' });
  });

  app.get('/v1/licenses/:id/receipt', (c) => {
    const license = licenses.license(c.req.param('id'));
    if (license?.receiptJws === undefined) return apiError(c, 404, 'not_found', 'no receipt for this license');
    return c.json({ receipt: license.receiptJws, jwks_url: `${base}/.well-known/jwks.json` });
  });

  app.post(
    '/v1/licenses/:id/stamp',
    bodyLimit({
      maxSize: MAX_IMAGE_BYTES,
      onError: (c) => apiError(c, 413, 'invalid_request', 'images up to 10 MB can be stamped'),
    }),
    async (c) => {
      const unauthorized = (description: string) =>
        c.json({ error: 'invalid_token', error_description: description }, 401, {
          'www-authenticate': `License error="invalid_token", error_description="${description}"`,
        });
      // The License authentication scheme of RSL 1.0 §6.2.
      const match = /^License (\S+)$/i.exec(c.req.header('authorization') ?? '');
      if (match === null) return unauthorized('a License token is required');
      const claims = await keys.verify(match[1]!, now());
      if (claims === undefined) return unauthorized('the License token is invalid or expired');

      const id = c.req.param('id');
      if (claims.jti !== id) return apiError(c, 403, 'insufficient_scope', 'the License token is for another license');
      const license = licenses.license(id);
      if (license === undefined) return apiError(c, 404, 'not_found', 'no such license');
      if (status(license) !== 'active') return unauthorized(`the license is ${status(license)}`);
      const refusal = licensing.checkCurrent(license);
      if (refusal !== undefined) {
        return apiError(c, 403, 'invalid_license', refusal.description, refusal.reasonCode === undefined ? {} : { reason_code: refusal.reasonCode });
      }

      const body = await c.req.parseBody();
      const file = body.image;
      if (!(file instanceof File)) return apiError(c, 400, 'invalid_request', 'send the image as multipart field "image"');
      const mimeType = file.type as StampMimeType;
      if (!STAMP_TYPES.includes(mimeType)) {
        return apiError(c, 415, 'invalid_request', 'only PNG, JPEG and WebP images can be stamped');
      }
      const mode = body.mode === 'sidecar' ? 'sidecar' : 'embedded';
      const image = new Uint8Array(await file.arrayBuffer());
      const result = await stamper.stamp({
        image,
        mimeType,
        licenseUrl: `${base}/v1/licenses/${license.id}`,
        declarationUri: CANONICAL_ID_BASE + license.hcrn,
        receipt: license.receiptJws,
        title: file.name || 'image',
        mode,
      });

      const sha256 = createHash('sha256').update(result.image).digest('hex');
      licenses.addAsset(license.id, { sha256, mime: mimeType, mode });
      const headers = { 'x-grantmark-asset-sha256': sha256, 'cache-control': 'no-store' };
      return mode === 'sidecar'
        ? c.body(new Uint8Array(result.manifest), 200, { ...headers, 'content-type': 'application/c2pa' })
        : c.body(new Uint8Array(result.image), 200, { ...headers, 'content-type': mimeType });
    },
  );

  return app;
}
