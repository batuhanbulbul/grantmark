/**
 * Public verification of an image (or a license id): the C2PA manifest checked against the test
 * trust anchors, the consent reference resolved to a Grantmark license record, the receipt
 * signature checked, and the payment behind it re-read from Solana devnet. The result ends in a
 * single verdict for people and a detailed report for machines.
 */

import { createHash } from 'node:crypto';
import { commitmentMemo, type SolanaUsdcDevnet } from '@grantmark/payments';
import { readStamp, type StampMimeType, type StampReading } from '@grantmark/stamp';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config';
import { apiError } from '../http';
import type { KeyStore } from '../olp/keys';
import type { License } from '../olp/licenses';
import { explorerUrl, licenseRecord, type LicenseRecord, type RecordServices } from './record';
import { MAX_IMAGE_BYTES, STAMP_TYPES } from './routes';

export type VerdictStatus =
  | 'licensed'
  | 'licensed_before_change'
  | 'expired'
  | 'revoked'
  | 'tampered'
  | 'no_credentials'
  | 'unknown_authority'
  | 'unknown_license';

interface VerifyServices extends RecordServices {
  readonly keys: KeyStore;
  readonly provider: SolanaUsdcDevnet;
  readonly signing: { readonly trustAnchors: string };
}

interface ReceiptCheck {
  readonly present: boolean;
  readonly valid: boolean;
  readonly matches_license: boolean;
  readonly claims?: Record<string, unknown> | undefined;
}

interface PaymentCheck {
  readonly on_chain: 'verified' | 'not_found' | 'failed' | 'unavailable' | 'none';
  readonly transaction_signature?: string | undefined;
  readonly explorer_url?: string | undefined;
  readonly reason?: string | undefined;
}

const GRACE_MS = 120_000;

export function verifyRoutes(services: VerifyServices, config: Config, now: () => Date): Hono {
  const { licenses, keys, provider, signing } = services;
  const licensePrefix = `${config.publicBaseUrl}/v1/licenses/`;
  const app = new Hono();

  async function checkReceipt(receipt: string | undefined, license: License | undefined): Promise<ReceiptCheck> {
    if (receipt === undefined) return { present: false, valid: false, matches_license: false };
    const claims = await keys.verifyReceipt(receipt);
    if (claims === undefined) return { present: true, valid: false, matches_license: false };
    return { present: true, valid: true, matches_license: license !== undefined && claims.jti === license.id, claims };
  }

  /** Re-reads the payment a receipt describes from devnet, using only the receipt's facts. */
  async function checkPayment(claims: Record<string, unknown> | undefined): Promise<PaymentCheck> {
    const payment = claims?.payment as
      | { transaction_signature?: string; memo?: string; commitment?: { payees?: { token_account: string; amount: string }[]; expires_at?: string } }
      | undefined;
    if (payment?.transaction_signature === undefined) return { on_chain: 'none' };
    const signature = payment.transaction_signature;
    const base = { transaction_signature: signature, explorer_url: explorerUrl(signature) };
    const commitment = payment.commitment;
    if (commitment === undefined || payment.memo !== commitmentMemo(commitment)) {
      return { ...base, on_chain: 'failed', reason: 'the receipt commitment does not match its memo' };
    }
    try {
      const check = await provider.recheck(signature, {
        memo: payment.memo,
        transfers: (commitment.payees ?? []).map((p) => ({ tokenAccount: p.token_account, amount: BigInt(p.amount) })),
        notBefore: new Date(0),
        notAfter: new Date(Date.parse(commitment.expires_at ?? '') + GRACE_MS),
      });
      if (check.ok) return { ...base, on_chain: 'verified' };
      return { ...base, on_chain: check.pending === true ? 'not_found' : 'failed', reason: check.reason };
    } catch (error) {
      return { ...base, on_chain: 'unavailable', reason: error instanceof Error ? error.message : 'the devnet RPC is unavailable' };
    }
  }

  function verdictFor(record: LicenseRecord): { status: VerdictStatus; summary: string } {
    if (record.status === 'expired') return { status: 'expired', summary: `License ${record.license_id} has expired.` };
    if (record.status === 'revoked') return { status: 'revoked', summary: `License ${record.license_id} was revoked.` };
    if (!record.current_permission.permitted) {
      return {
        status: 'licensed_before_change',
        summary: `Licensed under ${record.license_id} when it was issued, but new uses are no longer permitted: ${record.current_permission.reason}`,
      };
    }
    return { status: 'licensed', summary: `Licensed under ${record.license_id} for ${record.grant.usage.join(', ')} (${record.grant.subject_scope.join(', ')}).` };
  }

  function warnings(manifest: StampReading | undefined, receipt: ReceiptCheck, payment: PaymentCheck): string[] {
    const list: string[] = [];
    if (manifest?.found === true && !manifest.trusted) list.push('The manifest signer is not in the trusted test PKI.');
    if (receipt.present && !receipt.valid) list.push('The embedded receipt does not verify with this server’s keys.');
    if (receipt.valid && !receipt.matches_license) list.push('The receipt is for a different license.');
    if (payment.on_chain === 'not_found') list.push('The payment transaction could not be found on devnet.');
    if (payment.on_chain === 'failed') list.push(`The payment could not be confirmed: ${payment.reason}`);
    if (payment.on_chain === 'unavailable') list.push('The payment could not be re-checked because devnet was unavailable.');
    return list;
  }

  app.post('/v1/verify', bodyLimit({ maxSize: MAX_IMAGE_BYTES + 1024 * 1024, onError: (c) => apiError(c, 413, 'invalid_request', 'images up to 10 MB can be verified') }), async (c) => {
    const body = await c.req.parseBody();
    const file = body.image;
    if (!(file instanceof File)) return apiError(c, 400, 'invalid_request', 'send the image as multipart field "image"');
    const mimeType = file.type as StampMimeType;
    if (!STAMP_TYPES.includes(mimeType)) return apiError(c, 415, 'invalid_request', 'only PNG, JPEG and WebP images can be verified');
    const image = new Uint8Array(await file.arrayBuffer());
    const manifestFile = body.manifest instanceof File ? new Uint8Array(await body.manifest.arrayBuffer()) : undefined;

    const sha256 = createHash('sha256').update(image).digest('hex');
    const registeredUnder = licenses.licensesForAsset(sha256);
    const manifest = await readStamp({ image, mimeType, manifest: manifestFile, trustAnchors: signing.trustAnchors });
    const reference = manifest.consent.find((r) => r.uri.startsWith(licensePrefix));
    const license = reference === undefined ? undefined : licenses.license(reference.uri.slice(licensePrefix.length));
    const record = license === undefined ? null : licenseRecord(services, config, now(), license);
    const receipt = await checkReceipt(manifest.receipt, license);
    const payment = await checkPayment(receipt.valid ? receipt.claims : undefined);

    let verdict: { status: VerdictStatus; summary: string };
    if (!manifest.found) verdict = { status: 'no_credentials', summary: 'No Content Credentials were found in this image.' };
    else if (manifest.validationState === 'Invalid') verdict = { status: 'tampered', summary: 'The image or its manifest changed after it was stamped.' };
    else if (reference === undefined) {
      verdict = { status: 'unknown_authority', summary: 'The Content Credentials point to a consent authority other than this Grantmark server, so it cannot vouch for them.' };
    } else if (record === null) verdict = { status: 'unknown_license', summary: 'The referenced license does not exist on this server.' };
    else verdict = verdictFor(record);

    return c.json({
      verdict: { ...verdict, warnings: warnings(manifest, receipt, payment) },
      asset: { sha256, mime: mimeType, registered: registeredUnder.length > 0, licenses: registeredUnder },
      manifest: {
        found: manifest.found,
        embedded: manifest.embedded,
        validation_state: manifest.validationState ?? null,
        trusted: manifest.trusted,
        trust: !manifest.found ? null : manifest.trusted ? 'Trusted (test PKI)' : manifest.validationState === 'Valid' ? 'Valid (unknown signer)' : 'Invalid',
        failures: manifest.failures,
        signer: manifest.signer ?? null,
        digital_source_type: manifest.digitalSourceType ?? null,
        title: manifest.title ?? null,
      },
      consent_references: manifest.consent,
      license: record,
      receipt: { present: receipt.present, valid: receipt.valid, matches_license: receipt.matches_license },
      payment,
      checked_at: now().toISOString(),
    });
  });

  app.get('/v1/verify', async (c) => {
    const id = c.req.query('license');
    if (id === undefined) return apiError(c, 400, 'invalid_request', 'send an image with POST, or ?license=<license id>');
    const license = licenses.license(id);
    if (license === undefined) return apiError(c, 404, 'not_found', 'no such license');
    const record = licenseRecord(services, config, now(), license);
    const receipt = await checkReceipt(license.receiptJws, license);
    const payment = await checkPayment(receipt.valid ? receipt.claims : undefined);
    return c.json({
      verdict: { ...verdictFor(record), warnings: warnings(undefined, receipt, payment) },
      license: record,
      receipt: { present: receipt.present, valid: receipt.valid, matches_license: receipt.matches_license },
      payment,
      checked_at: now().toISOString(),
    });
  });

  return app;
}
