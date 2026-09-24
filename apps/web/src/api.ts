/** Typed calls to the Grantmark server (same origin). */

import type { Decision, VerdictStatus } from './format';

export interface Amount {
  readonly value: string;
  readonly currency: string;
}

export interface Offer {
  readonly license: number;
  readonly usage: string[];
  readonly prohibits: string[];
  readonly user: string[] | null;
  readonly amount: Amount | null;
  readonly xml: string;
}

export interface PersonaDeclaration {
  readonly hcrn: string;
  readonly version: number;
  readonly registry: string;
  readonly url: string;
  readonly status?: string;
  readonly subject_scope: string[] | null;
  readonly territory: string[] | null;
  readonly server: string | null;
  readonly offers: Offer[];
}

export interface Persona {
  readonly hcsi: string;
  readonly name: string;
  readonly description?: string;
  readonly fictional: boolean;
  readonly age_status: 'adult' | 'minor' | 'unknown';
  readonly record_url: string;
  readonly declarations: PersonaDeclaration[];
}

export interface Finding {
  readonly code: string;
  readonly rule: string;
  readonly at: string;
  readonly message: string;
}

export interface ScopeEvaluation {
  readonly scope: string;
  readonly decision: Decision;
  readonly governedBy: string[];
  readonly conflict: boolean;
  readonly explanation: string;
}

export interface Evaluation {
  readonly usage: string;
  readonly decision: Decision;
  readonly scopes: ScopeEvaluation[];
  readonly declarations: { hcrn?: string; operative: boolean; reasons: Finding[]; warnings: Finding[] }[];
  readonly offers: { hcrn: string; license: number }[];
  readonly serverAuthorizationRequired: boolean;
  readonly minorProtectionApplied: boolean;
  readonly ageStatus?: string;
}

export interface PaymentOption {
  readonly provider: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly pay_to: { role: string; wallet: string; token_account: string; amount: string }[];
  readonly memo: string;
  readonly transaction: string;
  readonly max_timeout_seconds: number;
}

export interface Payment {
  readonly id?: string;
  readonly license_request: string;
  readonly status: 'requires_payment' | 'processing' | 'succeeded' | 'failed' | 'expired';
  readonly amount: Amount;
  readonly expires_at?: string;
  readonly reason?: string;
  readonly accepts: PaymentOption[];
}

export type LicenseOutcome =
  | { kind: 'token'; token: string; licenseId: string; subjectScope: string; expiresIn: number; excludedScope: Record<string, string> }
  | { kind: 'payment_required'; description: string; payment: Payment }
  | { kind: 'error'; status: number; error: string; description: string; reasonCode?: string };

export interface LicenseRequestBody {
  readonly hcrn: string;
  readonly license: number;
  readonly scope?: string;
  readonly place?: string;
  readonly payer?: string;
  readonly payment_id?: string;
  readonly payment_evidence?: string;
}

export interface Verification {
  readonly verdict: { status: VerdictStatus; summary: string; warnings: string[] };
  readonly asset?: { sha256: string; mime: string; registered: boolean; licenses: string[] };
  readonly manifest?: {
    found: boolean;
    embedded?: boolean;
    validation_state: string | null;
    trusted: boolean;
    trust: string | null;
    failures: string[];
    signer: { issuer?: string; commonName?: string } | null;
    digital_source_type: string | null;
    title: string | null;
  };
  readonly consent_references?: { uri: string; reference_type: string; consent_domain: string }[];
  readonly license: LicenseRecord | null;
  readonly receipt: { present: boolean; valid: boolean; matches_license: boolean };
  readonly payment: { on_chain: string; transaction_signature?: string; explorer_url?: string; reason?: string };
  readonly checked_at: string;
}

export interface LicenseRecord {
  readonly license_id: string;
  readonly status: string;
  readonly current_permission: { permitted: boolean; reason?: string };
  readonly declaring_party: {
    registry?: string;
    hcrn: string;
    declaration_url: string;
    rights_subject: { hcsi: string; name?: string; record_url: string };
  };
  readonly grant: { usage: string[]; subject_scope: string[]; place?: string; license: string };
  readonly compensation: {
    amount: Amount | null;
    payment: { transaction_signature: string; explorer_url: string; paid_to: { role: string; wallet: string; amount: string }[] } | null;
  };
  readonly term: { valid_from: string; valid_until: string };
  readonly revocability: string;
  readonly binding: { subject: string; assets: { sha256: string; mime: string; mode: string; stamped_at: string }[] };
  readonly receipt_url: string;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error_description ?? body.error ?? `request failed (${response.status})`));
  return body as T;
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  personas: () => json<{ personas: Persona[] }>('/v1/demo/personas').then((r) => r.personas),

  evaluate: (body: { subject?: string; hcrn?: string; usage?: string; scopes?: string[]; place?: string }) =>
    json<Evaluation>('/v1/evaluate', postJson(body)),

  async requestLicense(body: LicenseRequestBody): Promise<LicenseOutcome> {
    const response = await fetch('/v1/demo/licenses', postJson(body));
    const data = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (response.status === 200) {
      return {
        kind: 'token',
        token: data.access_token,
        licenseId: data.license_id,
        subjectScope: data.subject_scope,
        expiresIn: data.expires_in,
        excludedScope: data.excluded_scope ?? {},
      };
    }
    if (response.status === 402) return { kind: 'payment_required', description: data.error_description, payment: data.payment };
    return {
      kind: 'error',
      status: response.status,
      error: data.error ?? 'error',
      description: data.error_description ?? `request failed (${response.status})`,
      ...(data.reason_code === undefined ? {} : { reasonCode: data.reason_code }),
    };
  },

  license: (id: string) => json<LicenseRecord>(`/v1/licenses/${encodeURIComponent(id)}`),

  async stamp(licenseId: string, token: string, image: Blob, fileName: string, mode: 'embedded' | 'sidecar'): Promise<{ blob: Blob; sha256: string }> {
    const form = new FormData();
    form.set('image', image, fileName);
    form.set('mode', mode);
    const response = await fetch(`/v1/licenses/${encodeURIComponent(licenseId)}/stamp`, {
      method: 'POST',
      headers: { authorization: `License ${token}` },
      body: form,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(String(body.error_description ?? `stamping failed (${response.status})`));
    }
    return { blob: await response.blob(), sha256: response.headers.get('x-grantmark-asset-sha256') ?? '' };
  },

  verifyImage(image: File, manifest?: File): Promise<Verification> {
    const form = new FormData();
    form.set('image', image);
    if (manifest !== undefined) form.set('manifest', manifest);
    return json<Verification>('/v1/verify', { method: 'POST', body: form });
  },

  verifyLicense: (id: string) => json<Verification>(`/v1/verify?license=${encodeURIComponent(id)}`),
};
