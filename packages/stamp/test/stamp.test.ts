import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { consentAssertion, loadTestPki, readStamp, Stamper, TRAINED_ALGORITHMIC_MEDIA } from '../src/index';
import { placeholderPng } from '../src/placeholder';

const pki = loadTestPki();
const stamper = new Stamper(pki);
const PNG = placeholderPng(64, 48, 1);
const LICENSE_URL = 'https://grantmark.test/v1/licenses/lic_TEST';
const DECLARATION_URI = 'https://id.humanconsent.org/HCRN-0000-0068-F';

const stampInput = { image: PNG, mimeType: 'image/png' as const, licenseUrl: LICENSE_URL, declarationUri: DECLARATION_URI, receipt: 'header.payload.signature', title: 'placeholder.png' };

/** Changes one pixel byte inside the first IDAT chunk and fixes the chunk CRC, so the PNG stays well-formed. */
function tamper(png: Uint8Array): Uint8Array {
  const copy = new Uint8Array(png);
  const view = new DataView(copy.buffer);
  for (let offset = 8; offset < copy.length; ) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(copy.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') {
      const target = offset + 8 + length - 5;
      copy[target] = copy[target]! ^ 0xff;
      view.setUint32(offset + 8 + length, crc32(copy.subarray(offset + 4, offset + 8 + length)));
      return copy;
    }
    offset += 12 + length;
  }
  throw new Error('no IDAT chunk');
}

describe('placeholderPng', () => {
  it('writes a PNG of the requested size, different for each seed', () => {
    expect([...PNG.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(PNG.buffer, PNG.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([64, 48]);
    expect(placeholderPng(64, 48, 2)).not.toEqual(PNG);
  });
});

describe('consentAssertion (CAWG consent 1.0 draft, v0.21)', () => {
  it('references the license record as the consent authority, and the declaration when known', () => {
    expect(consentAssertion(LICENSE_URL, DECLARATION_URI)).toEqual({
      consent_references: [
        { uri: LICENSE_URL, reference_type: 'consent_authority', consent_domain: 'identity', supersedes_prior: false },
        { uri: DECLARATION_URI, reference_type: 'consent_authority', consent_domain: 'identity', supersedes_prior: false },
      ],
    });
    expect(consentAssertion(LICENSE_URL).consent_references).toHaveLength(1);
  });
});

describe('Stamper: embedded manifest', () => {
  it('signs the image and reads back as Trusted with the test roots', async () => {
    const result = await stamper.stamp(stampInput);
    expect(result.mode).toBe('embedded');
    expect(result.image).not.toEqual(PNG);
    expect(result.manifest.length).toBeGreaterThan(1000);
    expect(result.manifest.length).toBeLessThan(40_000); // no thumbnail

    const reading = await readStamp({ image: result.image, mimeType: 'image/png', trustAnchors: pki.trustAnchors });
    expect(reading).toMatchObject({
      found: true,
      embedded: true,
      validationState: 'Trusted',
      trusted: true,
      failures: [],
      receipt: 'header.payload.signature',
      digitalSourceType: TRAINED_ALGORITHMIC_MEDIA,
      title: 'placeholder.png',
    });
    expect(reading.consent).toEqual(consentAssertion(LICENSE_URL, DECLARATION_URI).consent_references);
    expect(reading.signer?.commonName).toBe('C2PA Signer');
  });

  it('is Valid but not trusted without the test roots, as third-party verifiers will see it', async () => {
    const result = await stamper.stamp(stampInput);
    const reading = await readStamp({ image: result.image, mimeType: 'image/png' });
    expect(reading.validationState).toBe('Valid');
    expect(reading.trusted).toBe(false);
    expect(reading.failures).toContain('signingCredential.untrusted');
  });

  it('detects changes to the image', async () => {
    const result = await stamper.stamp(stampInput);
    const reading = await readStamp({ image: tamper(result.image), mimeType: 'image/png', trustAnchors: pki.trustAnchors });
    expect(reading.validationState).toBe('Invalid');
    expect(reading.trusted).toBe(false);
    expect(reading.failures.some((code) => code.includes('mismatch'))).toBe(true);
  });
});

describe('Stamper: sidecar manifest', () => {
  it('leaves the image untouched and validates with the separate manifest', async () => {
    const result = await stamper.stamp({ ...stampInput, mode: 'sidecar' });
    expect(result.mode).toBe('sidecar');
    expect(result.image).toEqual(PNG);
    const reading = await readStamp({ image: PNG, mimeType: 'image/png', manifest: result.manifest, trustAnchors: pki.trustAnchors });
    expect(reading).toMatchObject({ found: true, embedded: false, validationState: 'Trusted', receipt: 'header.payload.signature' });
  });
});

describe('readStamp on an image without a manifest', () => {
  it('reports that nothing was found', async () => {
    expect(await readStamp({ image: PNG, mimeType: 'image/png', trustAnchors: pki.trustAnchors })).toMatchObject({ found: false, trusted: false });
  });

  it('reports unreadable input as not found instead of throwing', async () => {
    expect(await readStamp({ image: new Uint8Array([1, 2, 3]), mimeType: 'image/png' })).toMatchObject({ found: false });
  });
});
