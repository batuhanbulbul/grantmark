/**
 * The OLP-HCS prototype: RSL 1.0 §5 license acquisition and introspection, applied to HCS
 * declarations. OLP-HCS itself is not published yet, so everything beyond RSL §5 here is a
 * Grantmark proposal: `resource` names the declaration's HCRN (HCS §3.1.10), the optional
 * `scope` and `place` parameters narrow the use, and paid offers answer with a payment request.
 *
 * Every request re-evaluates the current official declaration. The minors rule is checked when
 * a token is requested (before any payment request exists) and again when a license is issued.
 */

import {
  CANONICAL_ID_BASE,
  SUBJECT_SCOPES,
  ageStatus,
  canonicalElement,
  canonicalLicense,
  checkDocument,
  collapse,
  evaluate,
  isCountryCode,
  isValidHcsId,
  parseHcsDocument,
  splitList,
  type Declaration,
  type Evaluation,
  type HcsRight,
  type LicenseTerms,
  type ScopeEvaluation,
  type UsageToken,
} from '@grantmark/hcs';
import { USDC_DECIMALS, toBaseUnits } from '@grantmark/payments';
import type { Config } from '../config';
import { registryView, subjectDocuments } from '../registry/view';
import type { RegistryStore, StoredDeclaration } from '../registry/store';
import type { Client } from './clients';
import type { KeyStore } from './keys';
import { createHash } from 'node:crypto';
import type { License, LicenseRequest, LicenseStore } from './licenses';

/** Default term of a license; never beyond the declaration's valid-until. */
export const LICENSE_TERM_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type OlpErrorCode =
  | 'invalid_request'
  | 'invalid_license'
  | 'invalid_resource'
  | 'unsupported_grant_type';

/** Why a license is refused: a Grantmark extension field next to the OLP error code. */
export type ReasonCode = 'minor_protection' | 'not_operative' | 'not_permitted' | 'unsupported_terms' | 'payment_unavailable';

export interface Refusal {
  readonly kind: 'error';
  readonly status: 400 | 403;
  readonly error: OlpErrorCode;
  readonly description: string;
  readonly reasonCode?: ReasonCode | undefined;
}

export interface TokenIssued {
  readonly kind: 'token';
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly license: License;
  /** Requested scopes left out of the license, with the reason for each. */
  readonly excludedScope: Readonly<Record<string, string>>;
}

export interface PaymentRequired {
  readonly kind: 'payment_required';
  readonly request: LicenseRequest;
}

export type TokenOutcome = TokenIssued | PaymentRequired | Refusal;

export type TokenForm = Readonly<Record<string, string | undefined>>;

/** The payment a receipt binds a license to. */
export interface ReceiptPayment {
  readonly provider: string;
  readonly network: string;
  readonly asset: string;
  readonly transactionSignature: string;
  readonly amount: { readonly value: string; readonly currency: string };
  readonly memo: string;
  readonly commitment: Readonly<Record<string, unknown>>;
  readonly paidAt: string;
}

export type Introspection =
  | { readonly active: false }
  | ({ readonly active: true; readonly permitted: boolean; readonly reason?: string } & Record<string, unknown>);

interface Loaded {
  readonly hcrn: string;
  readonly stored: StoredDeclaration;
  readonly right: HcsRight;
  readonly declaration: Declaration;
}

interface Decided {
  readonly usage: readonly UsageToken[];
  readonly scopes: readonly string[];
  readonly excluded: Readonly<Record<string, string>>;
}

const refuse = (status: 400 | 403, error: OlpErrorCode, description: string, reasonCode?: ReasonCode): Refusal => ({
  kind: 'error',
  status,
  error,
  description,
  reasonCode,
});
const isRefusal = (value: object): value is Refusal => 'kind' in value && value.kind === 'error';
const permits = (scope: ScopeEvaluation | undefined) =>
  scope !== undefined && (scope.decision === 'permitted' || scope.decision === 'permitted_with_terms');

/** The 0-based index of the offer with these canonical terms in the current declaration, or -1. */
const offerIndex = (loaded: Loaded, canonical: string) =>
  loaded.right.licenses.findIndex((license) => canonicalElement(license.element) === canonical);
const noLongerOffered = () =>
  refuse(403, 'invalid_license', 'these license terms are no longer offered by the current declaration', 'not_operative');

/** The HCRN named by an OLP `resource`: the HCRN itself or its canonical URI. */
export function resourceHcrn(resource: string): string | undefined {
  const value = collapse(resource);
  const id = value.startsWith(CANONICAL_ID_BASE) ? value.slice(CANONICAL_ID_BASE.length) : value;
  return isValidHcsId(id, 'HCRN') ? id : undefined;
}

/**
 * The price to collect, if any. Offers without money (no `<payment>`, `free`, `attribution`, or
 * a zero amount) need none. Any other amount must be positive USD that devnet USDC can pay
 * exactly. Offers that rely on an outside clearance process are not supported.
 */
function priceOf(offer: LicenseTerms): { value: string; currency: string } | undefined | Refusal {
  const payment = offer.payment;
  if (payment === undefined || payment.type === 'free') return undefined;
  const amount = payment.amount;
  if (amount !== undefined && !/^\+?0*(?:\.0*)?$/.test(amount.value)) {
    if (amount.currency !== 'USD') {
      return refuse(403, 'invalid_license', 'this license server only settles prices in USD', 'unsupported_terms');
    }
    try {
      toBaseUnits(amount.value, USDC_DECIMALS);
    } catch {
      return refuse(
        403,
        'invalid_license',
        `the price ${amount.value} ${amount.currency} is not a positive amount with at most ${USDC_DECIMALS} decimal places`,
        'unsupported_terms',
      );
    }
    return amount;
  }
  if (payment.custom !== undefined || payment.standard !== undefined || payment.accepts !== undefined) {
    return refuse(403, 'invalid_license', 'this offer needs a clearance process outside this license server', 'unsupported_terms');
  }
  if (payment.type !== undefined && payment.type !== 'attribution' && payment.amount === undefined) {
    return refuse(403, 'invalid_license', `payment type "${payment.type}" has no amount to collect`, 'unsupported_terms');
  }
  return undefined;
}

export class LicenseService {
  private readonly registry: RegistryStore;
  private readonly licenses: LicenseStore;
  private readonly keys: KeyStore;
  private readonly config: Config;
  private readonly now: () => Date;

  constructor(deps: { registry: RegistryStore; licenses: LicenseStore; keys: KeyStore; config: Config; now: () => Date }) {
    this.registry = deps.registry;
    this.licenses = deps.licenses;
    this.keys = deps.keys;
    this.config = deps.config;
    this.now = deps.now;
  }

  async requestToken(client: Client, form: TokenForm): Promise<TokenOutcome> {
    if (form.grant_type === undefined) return refuse(400, 'invalid_request', 'grant_type is required');
    if (form.grant_type !== 'client_credentials') {
      return refuse(400, 'unsupported_grant_type', 'only the client_credentials grant is supported');
    }
    if (!form.license || !form.resource) return refuse(400, 'invalid_request', 'license and resource are required');
    if (form.license_type !== undefined && form.license_type !== 'application/rsl+xml') {
      return refuse(400, 'invalid_license', 'only application/rsl+xml licenses are supported');
    }
    const hcrn = resourceHcrn(form.resource);
    if (hcrn === undefined) {
      return refuse(400, 'invalid_resource', 'resource must be a declaration HCRN or its canonical URI (HCS §3.1.10)');
    }

    const loaded = this.load(hcrn);
    if (isRefusal(loaded)) return loaded;
    const { declaration } = loaded;
    if (declaration.server !== undefined && declaration.server !== this.config.licenseServerUrl) {
      return refuse(400, 'invalid_resource', `${hcrn} names another license server: ${declaration.server}`);
    }
    if (declaration.subjectId === undefined) {
      return refuse(400, 'invalid_resource', 'Default Declarations cover a class of subjects and are not licensed here');
    }

    const submitted = canonicalLicense(form.license);
    if (submitted === undefined) return refuse(400, 'invalid_license', 'license must be one well-formed RSL <license> element');
    const index = offerIndex(loaded, submitted);
    if (index === -1) {
      return refuse(400, 'invalid_license', `license does not match any offer in the current declaration for ${hcrn}`);
    }
    if (form.place !== undefined && !isCountryCode(form.place)) {
      return refuse(400, 'invalid_request', 'place must be an officially assigned ISO 3166-1 alpha-2 code');
    }
    const scopes = this.scopesFor(loaded, form.scope);
    if (isRefusal(scopes)) return scopes;

    const decided = this.decide(loaded, index, scopes, form.place);
    if (isRefusal(decided)) return decided;
    const offer = declaration.licenses[index]!;
    const price = priceOf(offer);
    if (price !== undefined && isRefusal(price)) return price;

    const request = this.licenses.createRequest({
      clientId: client.clientId,
      hcrn,
      hcsi: declaration.subjectId,
      declarationSha256: loaded.stored.sha256,
      licenseXml: offer.source,
      licenseCanonical: submitted,
      licenseIndex: index + 1,
      usage: decided.usage,
      subjectScope: decided.scopes,
      place: form.place,
      amount: price,
    });
    if (price !== undefined) return { kind: 'payment_required', request };
    const issued = await this.issue(request.id);
    return issued.kind === 'token' ? { ...issued, excludedScope: { ...decided.excluded, ...issued.excludedScope } } : issued;
  }

  /**
   * Issues the license for a request whose conditions are met (for paid offers, once payment
   * is verified). Re-checks the current declaration, including the minors rule, first.
   */
  async issue(requestId: string, payment?: ReceiptPayment): Promise<TokenIssued | Refusal> {
    const request = this.licenses.request(requestId);
    if (request === undefined) return refuse(400, 'invalid_request', `unknown license request ${requestId}`);
    const existing = this.licenses.licenseForRequest(requestId);
    if (existing !== undefined) {
      // A retry after the license exists: the receipt is kept either way, but a new token is
      // handed out only while the license still permits new uses.
      const license = await this.withReceipt(existing, payment);
      if (license.status === 'revoked') return refuse(403, 'invalid_license', 'this license has been revoked', 'not_operative');
      return this.checkCurrent(license) ?? this.tokenFor(license, {});
    }

    const loaded = this.load(request.hcrn);
    if (isRefusal(loaded)) return loaded;
    const index = offerIndex(loaded, request.licenseCanonical);
    if (index === -1) return noLongerOffered();
    const decided = this.decide(loaded, index, request.subjectScope, request.place);
    if (isRefusal(decided)) return decided;

    const now = this.now();
    const validUntil = new Date(
      Math.min(now.getTime() + LICENSE_TERM_DAYS * DAY_MS, loaded.declaration.validUntil?.time ?? Number.POSITIVE_INFINITY),
    );
    if (validUntil.getTime() - now.getTime() < 1000) {
      return refuse(403, 'invalid_license', 'the declaration is no longer in force', 'not_operative');
    }
    const license = this.licenses.issue(requestId, {
      validFrom: now,
      validUntil,
      usage: decided.usage,
      subjectScope: decided.scopes,
      declarationSha256: loaded.stored.sha256,
    });
    return this.tokenFor(await this.withReceipt(license, payment), decided.excluded);
  }

  /** Why a stored request could no longer be licensed now, e.g. before a payment is refreshed. */
  recheck(requestId: string): Refusal | undefined {
    const request = this.licenses.request(requestId);
    if (request === undefined) return refuse(400, 'invalid_request', `unknown license request ${requestId}`);
    const loaded = this.load(request.hcrn);
    if (isRefusal(loaded)) return loaded;
    const index = offerIndex(loaded, request.licenseCanonical);
    if (index === -1) return noLongerOffered();
    const decided = this.decide(loaded, index, request.subjectScope, request.place);
    return isRefusal(decided) ? decided : undefined;
  }

  /** Signs and stores the license's public receipt if it has none yet. */
  private async withReceipt(license: License, payment: ReceiptPayment | undefined): Promise<License> {
    if (license.receiptJws !== undefined) return license;
    const claims = {
      jti: license.id,
      sub: license.clientId,
      license: {
        id: license.id,
        hcrn: license.hcrn,
        hcsi: license.hcsi,
        usage: license.usage,
        subject_scope: license.subjectScope,
        ...(license.place === undefined ? {} : { place: license.place }),
        valid_from: license.validFrom.toISOString(),
        valid_until: license.validUntil.toISOString(),
        declaration_sha256: license.declarationSha256,
        license_sha256: createHash('sha256').update(license.licenseXml).digest('hex'),
      },
      ...(payment === undefined
        ? {}
        : {
            payment: {
              provider: payment.provider,
              network: payment.network,
              asset: payment.asset,
              transaction_signature: payment.transactionSignature,
              amount: payment.amount,
              memo: payment.memo,
              commitment: payment.commitment,
              paid_at: payment.paidAt,
            },
          }),
    };
    this.licenses.setReceipt(license.id, await this.keys.signReceipt(claims, license.createdAt));
    return this.licenses.license(license.id)!;
  }

  /** RSL §5.5 introspection, re-checking the current declaration for new uses (HCS §1.3). */
  async introspect(token: string, resource: string): Promise<Introspection> {
    const now = this.now();
    const claims = await this.keys.verify(token, now);
    const license = typeof claims?.jti === 'string' ? this.licenses.license(claims.jti) : undefined;
    if (license === undefined || license.status !== 'active' || now >= license.validUntil) return { active: false };

    const description = {
      active: true as const,
      token_type: 'License',
      license: license.licenseXml,
      resource,
      license_id: license.id,
      hcrn: license.hcrn,
      hcsi: license.hcsi,
      client_id: license.clientId,
      usage: license.usage.join(' '),
      subject_scope: license.subjectScope.join(' '),
      exp: Math.floor(license.validUntil.getTime() / 1000),
      status: license.status,
    };
    if (resourceHcrn(resource) !== license.hcrn) {
      return { ...description, permitted: false, reason: 'License does not cover this resource.' };
    }
    const refusal = this.checkCurrent(license);
    return refusal === undefined ? { ...description, permitted: true } : { ...description, permitted: false, reason: refusal.description };
  }

  private async tokenFor(license: License, excluded: Readonly<Record<string, string>>): Promise<TokenIssued | Refusal> {
    const now = this.now();
    const expiresIn = Math.floor((license.validUntil.getTime() - now.getTime()) / 1000);
    // OLP reads expires_in 0 as "never expires", so a license about to end is not handed out.
    if (expiresIn < 1) return refuse(403, 'invalid_license', 'the license has expired', 'not_operative');
    const accessToken = await this.keys.sign(
      {
        sub: license.clientId,
        jti: license.id,
        hcrn: license.hcrn,
        hcsi: license.hcsi,
        usage: license.usage,
        subject_scope: license.subjectScope,
        ...(license.place === undefined ? {} : { place: license.place }),
        declaration_sha256: license.declarationSha256,
        license_request: license.requestId,
      },
      now,
      license.validUntil,
    );
    return { kind: 'token', accessToken, expiresIn, license, excludedScope: excluded };
  }

  private load(hcrn: string): Loaded | Refusal {
    const stored = this.registry.declaration(hcrn);
    if (stored === undefined) return refuse(400, 'invalid_resource', `${hcrn} is not managed by this license server`);
    const parsed = parseHcsDocument(stored.content);
    const declaration = parsed.ok ? checkDocument(parsed.document)[0]?.declaration : undefined;
    if (!parsed.ok || declaration === undefined) {
      return refuse(403, 'invalid_license', `the declaration for ${hcrn} does not conform to HCS`, 'not_operative');
    }
    return { hcrn, stored, right: parsed.document.rights[0]!, declaration };
  }

  private scopesFor(loaded: Loaded, requested: string | undefined): string[] | Refusal {
    const { declaration } = loaded;
    const available =
      declaration.subject === 'mark' ? ['*'] : [...(declaration.subjectScope ?? SUBJECT_SCOPES[declaration.subject])];
    if (requested === undefined) return available;
    const scopes = [...new Set(splitList(requested))];
    if (declaration.subject === 'mark' || scopes.length === 0 || scopes.some((s) => !available.includes(s))) {
      return refuse(400, 'invalid_request', `scope must list Rights Scopes covered by ${loaded.hcrn}: ${available.join(' ')}`);
    }
    return scopes;
  }

  private evaluations(loaded: Loaded, usages: readonly string[], scopes: readonly string[], place: string | undefined): Evaluation[] {
    const base = this.config.publicBaseUrl;
    const subject = loaded.declaration.subjectId!;
    return usages.map((usage) =>
      evaluate({
        subject,
        documents: subjectDocuments(this.registry, base, subject),
        registry: registryView(this.registry, base),
        use: { usage: usage as UsageToken, at: this.now(), scopes, place },
      }),
    );
  }

  /** A refusal when nobody may rely on the declaration now: minor protection or not operative. */
  private blocked(loaded: Loaded, evaluations: readonly Evaluation[]): Refusal | undefined {
    // The evaluator applies the minors rule; this is a second, independent check on the licensed
    // declaration itself, so no evaluation detail can open a path for a minor's identity.
    const age =
      loaded.declaration.subject === 'identity'
        ? ageStatus(this.registry.subject(loaded.declaration.subjectId!)?.record, this.now())
        : undefined;
    const minor = evaluations.find((e) => e.minorProtectionApplied);
    if (minor !== undefined || (age !== undefined && age !== 'adult')) {
      const description =
        (minor?.ageStatus ?? age) === 'minor'
          ? "Minor protection (HCS §1.1): no permission, payment or license path is operative for a minor's identity."
          : 'Grantmark requires evidence of adulthood before any license for an identity, and the Rights Subject Record shows none.';
      return refuse(403, 'invalid_license', description, 'minor_protection');
    }
    const own = evaluations[0]?.declarations.find((d) => d.hcrn === loaded.hcrn);
    if (own === undefined || !own.operative) {
      const reasons = own?.reasons.map((r) => r.message).join('; ') ?? 'not found';
      return refuse(403, 'invalid_license', `${loaded.hcrn} is not operative: ${reasons}`, 'not_operative');
    }
    return undefined;
  }

  /** Which requested scopes the offer (0-based index) licenses for all of its usage tokens. */
  private decide(loaded: Loaded, index: number, scopes: readonly string[], place: string | undefined): Decided | Refusal {
    const usage = loaded.declaration.licenses[index]?.permits.usage ?? [];
    if (usage.length === 0) return refuse(403, 'invalid_license', 'this license offer permits no HCS usage token', 'not_permitted');
    const evaluations = this.evaluations(loaded, usage, scopes, place);
    const blocked = this.blocked(loaded, evaluations);
    if (blocked !== undefined) return blocked;

    const coveredByOffer = (s: ScopeEvaluation | undefined) =>
      permits(s) && s!.offers.some((o) => o.hcrn === loaded.hcrn && o.license === index + 1);
    const licensed: string[] = [];
    const excluded: Record<string, string> = {};
    for (const scope of scopes) {
      const results = evaluations.map((e) => e.scopes.find((s) => s.scope === scope));
      const failing = results.findIndex((s) => !coveredByOffer(s));
      if (failing === -1) licensed.push(scope);
      else excluded[scope] = results[failing]?.explanation ?? `${scope} is not licensed by this offer`;
    }
    if (licensed.length === 0) {
      return refuse(403, 'invalid_license', Object.values(excluded).join(' '), 'not_permitted');
    }
    return { usage, scopes: licensed, excluded };
  }

  /**
   * Why an issued license no longer permits new uses (withdrawal, minor protection, a new
   * conflict or prohibition), or undefined if it still does. Uses before a change stay licensed
   * as of their time (HCS §1.3).
   */
  checkCurrent(license: License): Refusal | undefined {
    const loaded = this.load(license.hcrn);
    if (isRefusal(loaded)) return loaded;
    const evaluations = this.evaluations(loaded, license.usage, license.subjectScope, license.place);
    const blocked = this.blocked(loaded, evaluations);
    if (blocked !== undefined) return blocked;
    // New uses need the licensed terms to still be on offer: a changed price or a removed offer
    // is a change like any other (HCS §1.3).
    if (offerIndex(loaded, license.licenseCanonical) === -1) return noLongerOffered();
    for (const scope of license.subjectScope) {
      for (const evaluation of evaluations) {
        const result = evaluation.scopes.find((s) => s.scope === scope);
        if (!permits(result)) {
          return refuse(403, 'invalid_license', result?.explanation ?? `${scope} is no longer permitted`, 'not_permitted');
        }
      }
    }
    return undefined;
  }
}
