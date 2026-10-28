/**
 * Stamps licensed images with a C2PA manifest (via @contentauth/c2pa-node, pinned to 0.9.10) that
 * carries a CAWG consent assertion pointing at the Grantmark license record, plus the license
 * receipt. Signing uses test PKI only; outside Grantmark's verifier the signer shows as unknown.
 */

import { readFileSync } from 'node:fs';
import { Builder, Context, LocalSigner, Reader } from '@contentauth/c2pa-node';

export { placeholderPng } from './placeholder';

/** CAWG consent assertion label (consent 1.0 draft, content v0.21). */
export const CONSENT_LABEL = 'cawg.consent';
/** Grantmark's assertion that carries the license receipt (a provisional label). */
export const RECEIPT_LABEL = 'grantmark.receipt';
export const TRAINED_ALGORITHMIC_MEDIA = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';

export type StampMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ConsentReference {
  readonly uri: string;
  readonly reference_type: 'consent_authority' | 'contract' | 'permission_record';
  readonly consent_domain: 'identity' | 'asset';
  readonly supersedes_prior?: boolean;
}

/**
 * The `cawg.consent` payload: the license record as consent authority and, when known, the HCS
 * declaration's canonical URI. The draft makes `bound_actor` mandatory for the identity domain,
 * but it needs a `cawg.identity` assertion, which Grantmark does not produce yet, so it is left
 * out knowingly.
 */
export function consentAssertion(licenseUrl: string, declarationUri?: string): { consent_references: ConsentReference[] } {
  const reference = (uri: string): ConsentReference => ({
    uri,
    reference_type: 'consent_authority',
    consent_domain: 'identity',
    supersedes_prior: false,
  });
  return { consent_references: [reference(licenseUrl), ...(declarationUri === undefined ? [] : [reference(declarationUri)])] };
}

export interface SigningMaterial {
  /** PEM certificate chain, leaf first, without the root. */
  readonly certificateChain: Uint8Array;
  /** PEM (PKCS#8) private key. */
  readonly privateKey: Uint8Array;
  /** PEM root certificates to trust when verifying. */
  readonly trustAnchors: string;
}

/** The public c2pa-rs test certificates in `fixtures/test-pki` (see its NOTICE). */
export function loadTestPki(folder: URL = new URL('../../../fixtures/test-pki/', import.meta.url)): SigningMaterial {
  return {
    certificateChain: readFileSync(new URL('es256-certs.pem', folder)),
    privateKey: readFileSync(new URL('es256-private-key.pem', folder)),
    trustAnchors: readFileSync(new URL('test-root-bundle.pem', folder), 'utf8'),
  };
}

export interface StampInput {
  readonly image: Uint8Array;
  readonly mimeType: StampMimeType;
  /** Public license record: the consent authority the assertion points to. */
  readonly licenseUrl: string;
  /** Canonical URI of the HCS declaration, if any. */
  readonly declarationUri?: string | undefined;
  /** The license receipt (a public JWS, not a bearer token). */
  readonly receipt?: string | undefined;
  readonly title?: string | undefined;
  /** `sidecar` leaves the image unchanged and returns a separate `.c2pa` manifest. */
  readonly mode?: 'embedded' | 'sidecar' | undefined;
}

export interface StampResult {
  readonly mode: 'embedded' | 'sidecar';
  /** The signed image, or the unchanged input in sidecar mode. */
  readonly image: Uint8Array;
  /** The C2PA manifest store bytes (`application/c2pa`). */
  readonly manifest: Uint8Array;
}

export class Stamper {
  private readonly signing: SigningMaterial;

  constructor(signing: SigningMaterial) {
    this.signing = signing;
  }

  async stamp(input: StampInput): Promise<StampResult> {
    const mode = input.mode ?? 'embedded';
    const assertions: { label: string; data: unknown; kind: 'Json'; created: true }[] = [
      { label: CONSENT_LABEL, data: consentAssertion(input.licenseUrl, input.declarationUri), kind: 'Json', created: true },
    ];
    if (input.receipt !== undefined) {
      assertions.push({ label: RECEIPT_LABEL, data: { receipt: input.receipt }, kind: 'Json', created: true });
    }

    // Thumbnails are off: they make the manifest about four times larger.
    const context = new Context({ builder: { generateC2paArchive: true, thumbnail: { enabled: false } } });
    const builder = await Builder.withJsonAsync(
      {
        claim_generator_info: [{ name: 'Grantmark', version: '0.1.0' }],
        title: input.title ?? 'image',
        assertions,
      } as Parameters<typeof Builder.withJsonAsync>[0],
      context,
    );
    builder.setIntent({ create: TRAINED_ALGORITHMIC_MEDIA } as Parameters<Builder['setIntent']>[0]);
    if (mode === 'sidecar') builder.setNoEmbed(true);

    const signer = LocalSigner.newSigner(Buffer.from(this.signing.certificateChain), Buffer.from(this.signing.privateKey), 'es256');
    const output: { buffer: Buffer | null } = { buffer: null };
    const manifest = builder.sign(signer, { buffer: Buffer.from(input.image), mimeType: input.mimeType }, output);
    const image = mode === 'sidecar' || output.buffer === null ? input.image : new Uint8Array(output.buffer);
    return { mode, image, manifest: new Uint8Array(manifest) };
  }
}

export interface StampReading {
  readonly found: boolean;
  readonly embedded?: boolean | undefined;
  /** `Invalid`, `Valid` (signature fine, signer not trusted) or `Trusted`. */
  readonly validationState?: string | undefined;
  readonly trusted: boolean;
  /** Validation failure codes of the active manifest. */
  readonly failures: readonly string[];
  readonly consent: readonly ConsentReference[];
  readonly receipt?: string | undefined;
  readonly digitalSourceType?: string | undefined;
  readonly title?: string | undefined;
  readonly signer?: { readonly issuer?: string | undefined; readonly commonName?: string | undefined; readonly time?: string | undefined } | undefined;
}

interface ManifestJson {
  title?: string;
  assertions?: { label: string; data?: any }[];
  signature_info?: { issuer?: string; common_name?: string; time?: string };
}

/** Reads and validates a C2PA manifest, embedded or from sidecar bytes. */
export async function readStamp(input: {
  image: Uint8Array;
  mimeType: StampMimeType;
  manifest?: Uint8Array | undefined;
  trustAnchors?: string | undefined;
}): Promise<StampReading> {
  const notFound: StampReading = { found: false, trusted: false, failures: [], consent: [] };
  const context =
    input.trustAnchors === undefined
      ? undefined
      : new Context({ verify: { verifyTrust: true }, trust: { trustAnchors: input.trustAnchors } });
  const asset = { buffer: Buffer.from(input.image), mimeType: input.mimeType };

  let reader: Reader | null;
  try {
    reader =
      input.manifest === undefined
        ? await Reader.fromAsset(asset, context)
        : await Reader.fromManifestDataAndAsset(Buffer.from(input.manifest), asset, context);
  } catch {
    return notFound;
  }
  if (reader === null) return notFound;

  const store = reader.json() as unknown as {
    active_manifest?: string;
    manifests?: Record<string, ManifestJson>;
    validation_state?: string;
    validation_results?: { activeManifest?: { failure?: { code: string }[] } };
  };
  const manifest = store.active_manifest === undefined ? undefined : store.manifests?.[store.active_manifest];
  if (manifest === undefined) return notFound;

  const assertion = (label: string) => manifest.assertions?.find((a) => a.label === label)?.data;
  const actions = (assertion('c2pa.actions.v2') ?? assertion('c2pa.actions')) as { actions?: { digitalSourceType?: string }[] } | undefined;
  const signature = manifest.signature_info;
  return {
    found: true,
    embedded: reader.isEmbedded(),
    validationState: store.validation_state,
    trusted: store.validation_state === 'Trusted',
    failures: store.validation_results?.activeManifest?.failure?.map((f) => f.code) ?? [],
    consent: (assertion(CONSENT_LABEL) as { consent_references?: ConsentReference[] } | undefined)?.consent_references ?? [],
    receipt: (assertion(RECEIPT_LABEL) as { receipt?: string } | undefined)?.receipt,
    digitalSourceType: actions?.actions?.find((a) => a.digitalSourceType !== undefined)?.digitalSourceType,
    title: manifest.title,
    signer: signature && { issuer: signature.issuer, commonName: signature.common_name, time: signature.time },
  };
}
