/**
 * The shape of a record that passed the JSON Schema (spec/consent-authority-record.schema.json).
 * The rules in src/checker.ts read records through these types; the schema has already
 * enforced every required member, enum and pattern, so the types state what it guarantees.
 */
import type { Alg } from './jws';

/** A withheld value: base64url(SHA-256(UTF-8(JCS([salt, value])))). */
export interface Commitment {
  readonly commitment: string;
}

export interface Money {
  readonly value: string;
  readonly currency: string;
}

export interface Digest {
  readonly alg: 'sha-256';
  readonly value: string;
}

export interface ConsentRecord {
  readonly profile: string;
  readonly example?: boolean;
  readonly record_uri: string;
  readonly authority: Authority;
  readonly agreements: readonly AgreementItem[];
  readonly state: State;
  /** Full view only: commitment digest → what it commits to. */
  readonly disclosures?: Readonly<Record<string, Disclosure>>;
  readonly authority_attestation: Signature;
}

export interface Disclosure {
  readonly salt: string;
  readonly value: unknown;
}

export interface Authority {
  readonly id: string;
  readonly name: string;
  readonly contact?: string;
  readonly keys_uri: string;
  readonly continuity: {
    readonly policy_uri: string;
    readonly successor_authority?: string;
    readonly escrow?: string;
  };
}

export interface AgreementItem {
  readonly agreement: Agreement;
  readonly agreement_digest: {
    readonly alg: 'sha-256';
    readonly canonicalization: 'jcs-rfc8785';
    readonly value: string;
  };
  readonly signatures: readonly Signature[];
}

export interface Agreement {
  readonly profile: string;
  readonly record_uri: string;
  readonly authority_id: string;
  readonly version: number;
  /** Absent in version 1, required after. */
  readonly previous_version_digest?: string;
  readonly created_at: string;
  readonly language: string;
  readonly jurisdictions?: readonly string[];
  /** Exactly one has the role `participant`. */
  readonly parties: readonly Party[];
  readonly consent_document: ConsentDocument;
  readonly terms: readonly Term[];
  readonly compensation: readonly Compensation[];
  /** Required when the version has a grant. */
  readonly end_of_use?: EndOfUse;
  readonly biometric_identifiers: BiometricIdentifiers;
  readonly asset_rights?: readonly AssetRights[];
  readonly retention: {
    readonly disclosures_until: string;
    readonly record_until: string | null;
  };
}

export type Role =
  | 'participant'
  | 'authorized_representative'
  | 'rights_holder'
  | 'licensee'
  | 'sublicensee'
  | 'payer'
  | 'payee';

export interface Party {
  readonly party_id: string;
  readonly roles: readonly Role[];
  readonly type: 'person' | 'organization';
  readonly display_name?: string | Commitment;
  readonly identifiers?: readonly Identifier[];
  /** The participant only. */
  readonly verification?: Verification;
  /** The participant only. */
  readonly identity_binding?: readonly IdentityBinding[];
  /** An authorized representative only: the participant's `party_id`. */
  readonly represents?: string;
  readonly authorization_basis?: 'representation_agreement' | 'power_of_attorney' | 'employment' | 'other';
  readonly authorization_evidence?: Digest;
}

export interface Identifier {
  /**
   * One of `human_consent_id`, `isni`, `lei`, `did`, `domain`, `x509_sha256`, or an absolute
   * URI.
   */
  readonly scheme: string;
  readonly value: string | Commitment;
}

export interface Verification {
  readonly identity_verified: true;
  readonly adult: true;
  readonly method: 'identity_document_check' | 'trusted_third_party' | 'in_person_check' | 'other';
  readonly verified_at: string;
  /** A `party_id` or an authority's `https` id. */
  readonly verified_by: string;
}

export interface IdentityBinding {
  readonly method: 'did' | 'x509_subject' | 'cawg_identity' | 'other';
  readonly value: string;
}

export interface ConsentDocument {
  readonly title: string | Commitment;
  readonly language: string;
  readonly media_type: string;
  readonly digest: Digest;
  readonly presented_at: string;
  readonly signed_at: string;
  readonly separate_document: boolean;
}

export interface Territories {
  /** `["WORLD"]`, or country codes. */
  readonly include: readonly string[];
  /** Only with `["WORLD"]`. */
  readonly exclude?: readonly string[];
}

export interface Sublicensing {
  readonly allowed: boolean;
  /** Only when allowed. Absent: any party. */
  readonly to?: readonly string[];
  readonly limited_to?: string;
}

/**
 * A grant's scope. The same shape serves the effective scope after narrowing, where lists
 * may be empty and `max_assets` may be 0.
 */
export interface Scope {
  readonly media_types: readonly string[];
  readonly channels: readonly string[];
  readonly territories: Territories;
  readonly exclusivity?: 'exclusive' | 'non_exclusive';
  readonly sublicensing?: Sublicensing;
  readonly max_assets?: number;
  readonly named_works?: readonly string[];
  readonly prohibited_contexts?: readonly string[];
}

interface TermBase {
  readonly term_id: string;
  readonly consent_domain: 'identity' | 'asset';
  /** Asset terms only: the declaring rights holder. */
  readonly declared_by?: string;
  /** Identity terms only. */
  readonly identity_attributes?: readonly string[];
  readonly uses: readonly string[];
  readonly valid_from: string;
  readonly valid_until?: string;
  readonly notes?: string;
}

export interface Grant extends TermBase {
  readonly kind: 'grant';
  readonly purpose: { readonly description: string; readonly categories?: readonly string[] };
  readonly scope: Scope;
  readonly licensees: readonly string[];
  readonly valid_until: string;
  readonly withdrawal_right: boolean;
  readonly compensation: readonly string[];
  readonly end_of_use?: EndOfUse;
}

export interface Prohibition extends TermBase {
  readonly kind: 'prohibition';
}

export type Term = Grant | Prohibition;

export interface AssetRights {
  readonly rights_holder: string;
  readonly posture: 'all_rights_reserved' | 'licensed' | 'available_for_licensing';
  readonly license_uri?: string;
  readonly contact?: string;
}

export interface Compensation {
  readonly compensation_id: string;
  readonly model: 'flat_fee' | 'per_asset' | 'per_period' | 'royalty' | 'unpaid' | 'other';
  readonly amount?: Money | Commitment;
  readonly royalty_percent?: string | Commitment;
  readonly basis?: string;
  readonly cap?: Money | Commitment;
  /** Absent only on an `unpaid` item. */
  readonly payer?: string;
  /** Absent only on an `unpaid` item. */
  readonly payee?: string;
  readonly due_by?: string;
  readonly description: string;
}

export interface EndRule {
  readonly existing_assets: { readonly action: 'may_remain' | 'remove'; readonly within_days?: number };
  readonly replica: Disposal;
  readonly source_captures: Disposal;
}

export interface Disposal {
  readonly action: 'delete' | 'hand_over_to_participant' | 'retain_without_use' | 'not_applicable';
  readonly within_days?: number;
  readonly retain_until?: string;
}

export interface EndOfUse {
  readonly on_expiry: EndRule;
  readonly on_withdrawal: EndRule;
  readonly withdrawal_channels: readonly string[];
}

export interface BiometricIdentifiers {
  readonly held_by_authority: false;
  readonly restriction: 'no_use_unrelated_to_engagement';
  readonly collected_in_engagement: boolean;
  /** With `collected_in_engagement` only, like `holder` and `delete_by`. */
  readonly kinds?: readonly string[];
  readonly holder?: string;
  readonly delete_by?: string;
  readonly statement: string;
}

export interface KeyBinding {
  readonly method: 'did' | 'x509' | 'authority_verified';
  /** `did` only. */
  readonly did_url?: string;
  /** `x509` only: standard base64 DER, leaf first. */
  readonly x5c?: readonly string[];
  readonly custody: 'signer_held' | 'authority_managed';
  readonly authentication?: string;
  readonly verified_by?: string;
  readonly verified_at: string;
}

export interface Signature {
  /** A `party_id`, or an authority's `https` id. */
  readonly signer: string;
  readonly signed_at: string;
  readonly alg: Alg;
  readonly jwk: Readonly<Record<string, unknown>> & { readonly kty: string };
  readonly kid: string;
  /** Present exactly when `signer` is a `party_id`. */
  readonly key_binding?: KeyBinding;
  readonly value: string;
  readonly timestamp_token?: string;
}

export type Status = 'in_force' | 'not_yet_valid' | 'suspended' | 'withdrawn' | 'ended';
export type EndReason = 'valid_until_reached' | 'ended_early' | 'dropped_by_version';

export interface State {
  readonly as_of: string;
  readonly freshness: { readonly max_age_seconds: number; readonly next_change_at?: string };
  readonly term_states: readonly TermState[];
  readonly events: readonly RecordEvent[];
  readonly payments?: readonly Payment[];
  readonly asset_bindings?: readonly AssetBinding[];
}

/** A grant after every narrowing. */
export interface Effective {
  readonly uses: readonly string[];
  readonly identity_attributes?: readonly string[];
  readonly scope: Scope;
  readonly licensees: readonly string[];
  readonly valid_from: string;
  readonly valid_until: string;
}

export interface TermState {
  readonly term_id: string;
  readonly status: Status;
  readonly since: string;
  readonly end_reason?: EndReason;
  readonly version: number;
  readonly narrowed: boolean;
  /** The schema does not constrain the items of `uses` here, so they are not typed. */
  readonly effective?: Omit<Effective, 'uses'> & { readonly uses: readonly unknown[] };
}

export interface Narrowing {
  readonly remove_uses?: readonly string[];
  readonly remove_identity_attributes?: readonly string[];
  readonly remove_media_types?: readonly string[];
  readonly remove_channels?: readonly string[];
  readonly remove_territories?: readonly string[];
  readonly add_prohibited_contexts?: readonly string[];
  readonly remove_licensees?: readonly string[];
  readonly remove_sublicensees?: readonly string[];
  readonly forbid_sublicensing?: true;
  readonly restrict_named_works?: readonly string[];
  readonly lower_max_assets?: number;
  readonly end_earlier?: string;
}

interface EventBase {
  readonly seq: number;
  readonly recorded_at: string;
  readonly received_at?: string;
  readonly effective_at: string;
  /** A `party_id`, or an authority's `https` id. */
  readonly actor: string;
  readonly on_behalf_of?: string;
  readonly channel: string;
  readonly evidence?: readonly Digest[];
  readonly note?: string;
  readonly actor_signature?: Signature;
  /** null for the first event only. */
  readonly prev_digest: string | null;
}

export interface VersionEvent extends EventBase {
  readonly type: 'issued' | 'version_added';
  readonly version: number;
  /** Digest of the whole `agreements` item. */
  readonly ref_digest: string;
}

export interface NarrowedEvent extends EventBase {
  readonly type: 'narrowed';
  readonly term_ids: readonly string[];
  readonly narrowing: Narrowing;
}

export interface SuspendedEvent extends EventBase {
  readonly type: 'suspended';
  readonly term_ids: readonly string[];
}

export interface ResumedEvent extends EventBase {
  readonly type: 'resumed';
  readonly term_ids: readonly string[];
  /** The `suspended` event lifted. */
  readonly ref_seq: number;
}

export interface WithdrawnEvent extends EventBase {
  readonly type: 'withdrawn';
  readonly term_ids: readonly string[];
}

export type InstructionEvent = NarrowedEvent | SuspendedEvent | ResumedEvent | WithdrawnEvent;

export interface PaymentEvent extends EventBase {
  readonly type: 'payment_recorded' | 'payment_confirmed' | 'payment_disputed' | 'payment_refunded';
  /** The `payment_id`. */
  readonly ref: string;
  /** `payment_recorded` only: digest of the payment. */
  readonly ref_digest?: string;
}

export interface BindingEvent extends EventBase {
  readonly type: 'asset_bound' | 'asset_unbound';
  /** The `binding_id`. */
  readonly ref: string;
  /** `asset_bound` only: digest of the binding. */
  readonly ref_digest?: string;
}

export interface TransferEvent extends EventBase {
  readonly type: 'authority_transferred';
  readonly to_authority: string;
  readonly keys_uri: string;
  readonly actor_signature: Signature;
}

export interface CorrectionEvent extends EventBase {
  readonly type: 'correction';
  /** The event corrected. */
  readonly ref_seq: number;
  readonly note: string;
}

export type RecordEvent =
  | VersionEvent
  | InstructionEvent
  | PaymentEvent
  | BindingEvent
  | TransferEvent
  | CorrectionEvent;

export interface Payment {
  readonly payment_id: string;
  readonly compensation_id: string;
  readonly paid_at: string;
  readonly amount: Money | Commitment;
  readonly method: string;
  readonly reference?: string | Commitment;
  readonly evidence: readonly { readonly kind: string; readonly digest: Digest }[];
}

export interface AssetBinding {
  readonly binding_id: string;
  readonly registered_by: string;
  readonly term_ids: readonly string[];
  readonly media_type: string;
  readonly mime_type?: string;
  readonly c2pa: {
    readonly manifest_label: string;
    readonly claim_signer: {
      readonly serial_number: string;
      readonly subject_common_name?: string;
      readonly subject_organization?: string;
      readonly certificate_sha256?: string;
    };
    readonly hard_binding?: { readonly url: string; readonly alg: string; readonly hash: string };
  };
  readonly asset_digest?: Digest;
}

export function isVersionEvent(e: RecordEvent): e is VersionEvent {
  return e.type === 'issued' || e.type === 'version_added';
}

/** `narrowed`, `suspended`, `resumed` and `withdrawn`: the instructions about grants. */
export function isInstruction(e: RecordEvent): e is InstructionEvent {
  return e.type === 'narrowed' || e.type === 'suspended' || e.type === 'resumed' || e.type === 'withdrawn';
}

export function isPaymentEvent(e: RecordEvent): e is PaymentEvent {
  return e.type.startsWith('payment_');
}

/** An actor that is an authority (its `https` id) rather than a party. */
export function isAuthority(actor: string): boolean {
  return actor.startsWith('https://');
}
