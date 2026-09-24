/**
 * Public license records, receipts, and stamping.
 *
 * GET /v1/licenses/:id is the consent authority that stamped images point to (their
 * `cawg.consent` reference). It answers the minimum set CAWG recommends for a consent authority:
 * who declared, what is granted, scope, compensation, term, current status and revocability, and
 * the binding to the assets and the subject. It is public and grants nothing.
 */

import { createHash } from 'node:crypto';
import { CANONICAL_ID_BASE } from '@grantmark/hcs';
import type { StampMimeType, Stamper } from '@grantmark/stamp';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config';
import { apiError } from '../http';
import type { KeyStore } from '../olp/keys';
import type { License, LicenseStore } from '../olp/licenses';
import type { LicenseService } from '../olp/service';
import type { PaymentStore } from '../payments/store';
import type { RegistryStore } from '../registry/store';
import { declarationUrl, subjectRecordUrl } from '../registry/view';

const STAMP_TYPES: readonly StampMimeType[] = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const REVOCABILITY =
  'The rights holder can withdraw or change the declaration at any time. From then on new uses are no longer ' +
  'permitted (HCS 1.0 Draft §1.3); uses made before stay licensed as of their time.';

interface LicenseServices {
  readonly registry: RegistryStore;
  readonly licenses: LicenseStore;
  readonly licensing: LicenseService;
  readonly payments: PaymentStore;
  readonly keys: KeyStore;
  readonly stamper: Stamper;
}

export function licenseRoutes(services: LicenseServices, config: Config, now: () => Date): Hono {
  const { registry, licenses, licensing, payments, keys, stamper } = services;
  const base = config.publicBaseUrl;
  const app = new Hono();

  const status = (license: License) =>
    license.status === 'revoked' ? 'revoked' : now() >= license.validUntil ? 'expired' : 'active';

  function record(license: License) {
    const request = licenses.request(license.requestId);
    const payment = payments.succeededForRequest(license.requestId);
    const declaration = registry.declaration(license.hcrn);
    const subject = registry.subject(license.hcsi)?.record as { name?: unknown } | undefined;
    const refusal = status(license) === 'active' ? licensing.checkCurrent(license) : undefined;
    return {
      license_id: license.id,
      status: status(license),
      current_permission:
        status(license) !== 'active'
          ? { permitted: false, reason: `the license is ${status(license)}` }
          : refusal === undefined
            ? { permitted: true }
            : { permitted: false, reason: refusal.description },
      declaring_party: {
        registry: declaration?.registry,
        hcrn: license.hcrn,
        declaration_url: declarationUrl(base, license.hcrn),
        declaration_uri: CANONICAL_ID_BASE + license.hcrn,
        declaration_sha256: license.declarationSha256,
        rights_subject: {
          hcsi: license.hcsi,
          name: typeof subject?.name === 'string' ? subject.name : undefined,
          record_url: subjectRecordUrl(base, license.hcsi),
        },
      },
      licensee: { client_id: license.clientId },
      grant: {
        usage: license.usage,
        subject_scope: license.subjectScope,
        ...(license.place === undefined ? {} : { place: license.place }),
        license: license.licenseXml,
      },
      compensation: {
        amount: request?.amount ?? null,
        payment:
          payment === undefined
            ? null
            : {
                provider: payment.provider,
                network: payment.request.network,
                asset: payment.request.asset,
                transaction_signature: payment.externalRef,
                explorer_url: `https://explorer.solana.com/tx/${payment.externalRef}?cluster=devnet`,
                memo: payment.request.memo,
                paid_to: payment.request.splits.map((s) => ({ role: s.role, wallet: s.wallet, amount: s.amount })),
              },
      },
      term: { valid_from: license.validFrom.toISOString(), valid_until: license.validUntil.toISOString() },
      revocability: REVOCABILITY,
      binding: {
        subject: license.hcsi,
        assets: licenses.assets(license.id).map((a) => ({ sha256: a.sha256, mime: a.mime, mode: a.mode, stamped_at: a.createdAt.toISOString() })),
      },
      receipt_url: `${base}/v1/licenses/${license.id}/receipt`,
      notice: 'Grantmark prototype on the HCS 1.0 Draft. Devnet and test mode only; all people are fictional.',
    };
  }

  app.get('/v1/licenses/:id', (c) => {
    const license = licenses.license(c.req.param('id'));
    if (license === undefined) return apiError(c, 404, 'not_found', 'no such license');
    return c.json(record(license), 200, { 'cache-control': 'no-cache' });
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
