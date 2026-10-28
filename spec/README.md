# Consent authority record: likeness and digital replica profile

**Status: draft 0.2.0 (2026-10-27).** Experimental, not affiliated with or endorsed by the
Creator Assertions Working Group (CAWG), the Decentralized Identity Foundation (DIF) or C2PA.
Not legal advice.

A C2PA manifest can carry a CAWG consent assertion, `cawg.consent`. Each of its references
points to an authoritative source; one kind of source is a *consent authority*, "a service
that holds and resolves the current consent terms a reference points to"
([CAWG consent assertion 1.0 draft][cawg-consent] of 12 July 2026, content v0.21, defined
terms). The draft
lists what a consent authority ought to be able to express (§5, consent authority
recommendation). It does not define how a source stores or resolves consent (§6, out of
scope), so the format of the answer is open.

This profile defines that answer for one domain: consent to use a living adult's name,
image, likeness, voice and other identity attributes, for example to build and use a
digital replica. A verifier receives a record of this profile when it resolves the `uri` of
a reference with `reference_type: "consent_authority"`.

| File | Content |
|---|---|
| [`consent-authority-record.schema.json`](consent-authority-record.schema.json) | JSON Schema (2020-12) |
| [`examples/digital-double.example.json`](examples/digital-double.example.json) | A complete record for a fictional digital replica license, with two agreement versions and seven events |
| [`test-vectors/`](test-vectors/README.md) | Test vectors: records, each with the result a verifier must reach on it |

## How it fits together

```
asset ── C2PA manifest ── cawg.consent
                            └─ consent_references[]
                                 uri ─────────────────► record (this profile)
                                 reference_type: consent_authority    ├─ agreements[]   signed versions of the agreement
                                 consent_domain: identity | asset     │                 (participant, licensees, affected parties)
                                 bound_actor ──► cawg.identity        ├─ state          events, derived term states,
                                                                      │                 payment evidence, registered assets
                                                                      ├─ disclosures    salted values (full view only)
                                                                      └─ authority_attestation
```

One record covers one consent relationship with exactly one participant. A work that shows
several people carries one reference, and has one record, per person.

## Design decisions

All decisions are dated 2026-10-27. They build only on published specifications: C2PA 2.x,
CAWG consent assertion 1.0 draft (12 July 2026, content v0.21), the CAWG identity assertion,
CAWG training and data mining assertion 1.1, JSON Schema 2020-12, RFC 3161, RFC 3339,
RFC 4648, RFC 6454, RFC 6838, RFC 7493, RFC 7515, RFC 7517, RFC 7518, RFC 7638, RFC 7797,
RFC 8032, RFC 8037, RFC 8785, RFC 9864, RFC 9964, BCP 47, FIPS 186-5, FIPS 204, ISO 3166-1,
ISO 3166-2, ISO 4217 and ISO 17442-2.

| ID | Decision | Reason |
|---|---|---|
| D1 | The record is the target of an existing `cawg.consent` reference. No new C2PA assertion. | The draft defines the pointer; what is missing is the shape of what it points to. |
| D2 | Plain JSON described by JSON Schema, with `snake_case` names like `cawg.consent`. JSON-LD is not required. | Easy to implement and validate. A JSON-LD mapping can follow. |
| D3 | `agreements[]` holds every signed version. Version n + 1 restates the whole agreement, names version n by digest and replaces it. `record_uri` never changes. | The draft lets the participant or an authorized representative "grant, extend, narrow, or withdraw terms at that authority at any time; such changes take effect in the authority's record and are visible through existing references without modification to the asset" (§4.2, rule 5). |
| D4 | Each signed agreement names `profile`, `record_uri` and `authority_id`. | A signed agreement cannot be presented under another record, or by an authority the parties did not choose unless that authority hands the record over with a signed `authority_transferred` event (D22). |
| D5 | The participant signs every version personally, and so does every licensee of a grant. Any other party signs each version that changes something of its own: its party entry, a compensation item it pays or receives (or the grants that item pays for), a grant it holds, its asset terms or `asset_rights` entries, or the biometric declaration naming it as holder (R6). An authorized representative may co-sign and may submit narrowing, suspension and withdrawal for the participant, but never signs in the participant's place. | A version cannot change the entry of a party it keeps listed, or create, change or remove what a party declares, owes, is owed or holds as a licensee, without that party's signature. A party with nothing of its own left in the record may be dropped without signing. Dropping a term that is already withdrawn or ended changes nothing and needs no signature. Sublicensees hold their rights through a licensee and do not sign for the grant. Every licensee signs every version because a version replaces the whole agreement, including the prohibitions, end rules and other grants beside its license; licensees that should not depend on one another's signatures use separate records. For the participant this is stricter than the draft, which lets an authorized representative declare identity consent (§4.1) and grant or extend terms (§4.2, rule 5): the legal texts below ask for the individual's own signature or consent, and New York excludes digital replica use from a model's power of attorney. |
| D6 | Every signature is a compact JWS with a detached, unencoded payload (RFC 7515, RFC 7797) over the RFC 8785 form of a *signing statement* (below). The public key is embedded; `kid` is its RFC 7638 thumbprint; `key_binding` says how the key is tied to the signer and who holds it. Algorithms are fully specified (`ES256`, `ES384`, `Ed25519`, `PS256`, `ML-DSA-65`). | No new cryptography. The statement binds profile, record, signer and time to what is signed. RFC 9864 deprecates the polymorphic `EdDSA` name. A grant can stay in force for many years, while NIST IR 8547 (§4.1.1) deprecates ECDSA, EdDSA and RSA after 2030 and disallows them after 2035; `ML-DSA-65` (FIPS 204, RFC 9964) is a post-quantum algorithm a record can use today. |
| D7 | Every grant has an end, at most ten years after its start. A prohibition may have no end. | New York asks the consent to detail the duration of use. The ten-year cap is this profile's choice: it follows S. 4591 (not law), which limits a license to ten years while the individual is living. A prohibition only restricts, so an open end is safe. |
| D8 | Between versions, a grant changes only through narrowing operations. Narrowings are cumulative and outlive later versions. Widening needs a new version signed by every required signer, or a new term. | The draft: "A later signer cannot widen a participant's grant by asserting `supersedes_prior`" (§4.2, rule 4). Keeping narrowings across versions stops an amendment from silently restoring something the participant removed. |
| D9 | A narrowing, suspension or withdrawal from a party takes effect in the record when the authority receives it, or at a later instant that the party signs. The record has no notice period. `withdrawal_right` only records whether the agreement allows withdrawal without breach, and `end_of_use` says what happens to assets already published. | The draft lets the participant withdraw "at any time" (§4.2, rule 5). A notice period in the record would let an agreement postpone a withdrawal without limit, and a later effective time asserted only by the authority cannot be checked. The record shows that a withdrawal was received and when; what it means under the contract is for the parties. The Danish bill's remarks say that consent given when a contract is made can be withdrawn, but under the general rules of contract law, and that the withdrawal does not by itself make the contract invalid or end it. |
| D10 | History is an append-only list of events, each carrying the digest of the previous event. The authority signs every response. | A party that keeps an earlier signed response can prove a later one removed, reordered or changed events. |
| D11 | Values that need not be public (names, identifier values, amounts, payment references) can be salted commitments. Their cleartext lives in `disclosures`, which only the full view carries. | The same signatures verify on the public and the full view. After `retention.disclosures_until` the authority can delete the cleartext without breaking verification. |
| D12 | The record holds payment *evidence* only: amounts, references and digests of invoices or confirmations. The authority never moves money. Account and card numbers are never stored. | Keeps the authority out of payment processing and minimises personal data. |
| D13 | No biometric data. `held_by_authority` is always `false`. Identity and adulthood are recorded as verified, without a date of birth. The draft's default biometric restriction (§5) is recorded as a declaration. | Biometric data is special-category data, for example GDPR art. 9(1) ("biometric data for the purpose of uniquely identifying a natural person") and KVKK art. 6. |
| D14 | A Human Consent ID is an optional identifier, with no dependency on any registry. | Interoperates without relying on a service. |
| D15 | `freshness` says how long a response may be relied on: `max_age_seconds`, and `next_change_at` when a term will change on its own (a start, an end, a scheduled version or withdrawal). | Consent can change at any time. The [notes of the CAWG meeting of 2026-10-05][cawg-2026-10-05] record a suggestion, made in chat, that an external link carry "a freshness expectation as well as a location". |
| D16 | Vocabularies: identity attributes from the draft's definition of identity consent, asset uses from CAWG training and data mining 1.1, a few profile use codes, and absolute URIs for extensions. | Reuse before invention. |
| D17 | This version covers living adults only. Minors and post-mortem rights are out of scope. | Those cases need guardian, court or estate rules that differ by jurisdiction. |
| D18 | Assets are registered by the authority, one C2PA manifest at a time, under named grants (`asset_bindings`). A derived asset is covered only if it is registered itself. | Registration lets the participant see every asset made under the record and lets `max_assets` be enforced. |
| D19 | `state.term_states` is derived data. A verifier may recompute it from `agreements` and `events`; a mismatch invalidates the response. | Simple consumers can read the answer; careful ones need not trust it. |
| D20 | `withdrawn` and `ended` are final. When several apply to a term, the earliest wins; at the same instant `withdrawn` wins (possible only for a withdrawal recorded before the version that drops the grant; recorded after it, R13 rejects the withdrawal because the grant has ended), and among the reasons for `ended`, `dropped_by_version` comes before `valid_until_reached` and `ended_early`. | A withdrawn or ended grant cannot come back through an event or a version that takes effect later; a new grant needs a new term id. Which end rule applies (`on_withdrawal` or `on_expiry`) is settled once. |
| D21 | A rule about the state at an event's time judges the event against the events before it in `seq` order, that is, the record as it stood when the event was recorded. The derived state uses every event. | Appending an event never makes an earlier event invalid, so a valid record stays valid as it grows. The derived state still honours a withdrawal that was received earlier but recorded later. |
| D22 | A hand-over to another authority is signed by the transferring authority over the whole `authority_transferred` event, `prev_digest` included, and the event names the transferring authority's key set. | The signature fixes the history the successor received: every earlier event, and through their `ref_digest` every agreement version with its signatures, every payment and every binding. A successor cannot replay it on a shortened or altered history. It does not fix what the serving authority states afresh in each response and attests itself: `authority`, `example`, `as_of`, `freshness`, `term_states` (derived) and `disclosures` (checked against their commitments). |

## Signing statements

Every signature in a record covers a *signing statement*, an object that the verifier
rebuilds from the record:

```json
{
  "profile": "<the record's profile>",
  "record_uri": "<the record's record_uri>",
  "statement": "agreement | event_instruction | authority_transfer | record_attestation",
  "digest": "<base64url SHA-256, see below>",
  "signer": "<signature.signer>",
  "signed_at": "<signature.signed_at>"
}
```

| `statement` | Signature | `digest` covers |
|---|---|---|
| `agreement` | `agreements[].signatures[]` | the version's `agreement` (equal to `agreement_digest.value`) |
| `event_instruction` | `events[].actor_signature`, except on `authority_transferred` | the event's *instruction members* (below) |
| `authority_transfer` | `actor_signature` of an `authority_transferred` event | the event without `actor_signature` |
| `record_attestation` | `authority_attestation` | the record without `disclosures` and without `authority_attestation` |

Here a digest is `base64url(SHA-256(UTF-8(JCS(value))))`, without padding, and JCS is RFC
8785. Implementations use a complete RFC 8785 canonicalizer: the profile has no
floating-point numbers, but strings may hold any Unicode text that I-JSON allows. A record is
an I-JSON message (RFC 7493, R0): UTF-8, member names unique within an object, no surrogate or
noncharacter code points, and the schema keeps every integer at or below 2^53 − 1, so that
every implementation parses and canonicalizes the same value. The instruction members of an event are those of `type`, `actor`, `on_behalf_of`,
`effective_at`, `term_ids`, `narrowing`, `version`, `ref`, `ref_seq` and `ref_digest` that
are present. The authority assigns the other members (`seq`, `recorded_at`, `received_at`,
`channel`, `evidence`, `note`, `prev_digest`) after the actor signs. A hand-over differs: the
transferring authority assigns every member itself, so its signature covers all of them.

The JWS protected header is UTF-8 JSON text without a byte order mark or duplicate member
names, and it decodes to exactly `{"alg": <alg>, "b64": false, "crit": ["b64"], "kid":
<kid>}`. The signing input is `BASE64URL(header) || "." || JCS(statement)`. `value` is
`BASE64URL(header) || ".." || BASE64URL(signature)`. A verifier:

1. rebuilds the statement and checks the JWS with `jwk`;
2. checks that the header is exactly as above and that `kid` is the RFC 7638 thumbprint of `jwk`;
3. checks `key_binding`: for `did`, that `did_url` resolves to a verification method with this
   key, and that its DID (the part before any `/`, `?` or `#`) is listed in clear for the
   signer (R6); for `x509`, that the first certificate of `x5c` holds this key, chains to an
   anchor the verifier trusts, was valid and not revoked at `signed_at`, and is tied to the
   signer by an identifier listed in clear (R6): a `dNSName` subjectAltName equal to a
   `domain` identifier, an LEI (ISO 17442-2) equal to an `lei` identifier, or the
   certificate's SHA-256 equal to an `x509_sha256` identifier; for `authority_verified`, it
   relies on `verified_by`, the authority in charge at `verified_at` (R6);
4. for an authority's signature, checks that `kid` is listed in that authority's key set:
   `authority.keys_uri` for the serving authority, and the `keys_uri` of its last
   `authority_transferred` event for an authority that handed the record over. An authority
   has one key set per record, so it keeps listed there every key it signed the record with,
   including keys from an earlier time in charge. A key set entry counts only if it is a
   public key whose `kid`, if present, is the signature's `kid` and whose `use` and
   `key_ops` allow verifying, as for `jwk` under R7. A verifier
   that cannot fetch a key set cannot check that signature; how a key set outlives its
   authority is open question 11.

A verifier may resolve no more key sets and DID URLs for one record than a number it
documents; it resolves the serving authority's key set first. It then cannot check the
signatures that need the others, as when it cannot fetch a key set, and does not report the
record as fully verified.

`custody: "authority_managed"` means the authority held the key and signed after the
signer authenticated by `authentication`. Such signatures, and `authority_verified` key
bindings, prove only what the authority attests. Verifiers weigh them accordingly.

`signed_at` is the signer's own statement. The record bounds it from above, since a
signature is recorded no earlier than it was made (R9, R14); a `timestamp_token` attests it
independently.

## Commitments and the two views

A withheld value is replaced by `{"commitment": base64url(SHA-256(UTF-8(JCS([salt,
value]))))}`, where `salt` is at least 16 random bytes in base64url. The full view adds
`disclosures`, which maps each commitment to `{salt, value}`. The public view is the same
record without `disclosures`. Agreement digests, every signature and the authority
attestation are computed over the committed form, so both views verify.

Commitments can replace `display_name`, identifier values, the consent document `title`,
`amount`, `cap`, `royalty_percent`, and payment `amount` and `reference`. Statuses, terms,
purposes, validity and history are never withheld: a consumer needs them to decide. A DID
that backs a `did` key binding stays in clear, so that the public view verifies too.

A later version may reuse a commitment for an unchanged value, so that the unchanged item
compares equal for R6. Reuse shows that the value did not change; a fresh salt hides that,
and the item then counts as changed, so its parties sign again.

## Deriving the state

A verifier computes the state of every term at an instant `t` from `agreements` and the
events whose `effective_at` is at or before `t`.

1. **Version in force.** The latest `issued` or `version_added` event in effect at `t` names
   it. Before version 1 takes effect, no term exists. A term exists from the first version in
   force that contains it.
2. **Text.** The term's text is that of the version in force, or of the last version that
   contained it. A later version may move a grant's validity: a live grant whose new
   `valid_from` lies ahead is `not_yet_valid` again. A narrowing applies to the text of every
   later version too, even one recorded before the narrowing (D21), so an `end_earlier` can
   fall before a later version's `valid_from`; the grant then ends early (`ended_early`)
   without becoming valid again.
3. **Effective grant.** Start from the grant's text and apply every `narrowed` event for the
   term in effect at `t`, in `seq` order:

   | Operation | Effect |
   |---|---|
   | `remove_uses`, `remove_identity_attributes`, `remove_media_types`, `remove_channels`, `remove_licensees` | remove the listed values |
   | `remove_territories` | with `include: ["WORLD"]`, add the countries to `exclude`; otherwise remove them from `include` |
   | `add_prohibited_contexts` | add the contexts |
   | `forbid_sublicensing` | sublicensing becomes `{"allowed": false}` |
   | `remove_sublicensees` | remove them from `sublicensing.to`; if none is left, sublicensing becomes `{"allowed": false}`. On the text of a later version whose sublicensing is allowed without a `to` list, sublicensing becomes `{"allowed": false}` (R13 lets a narrowing name only parties of a `to` list). |
   | `restrict_named_works` | keep only the listed works; if the grant names none, the list becomes the restriction |
   | `lower_max_assets` | the lower of the two values; without a `max_assets`, the narrowing's value |
   | `end_earlier` | the earlier of the two ends |

   A term without `sublicensing` allows none, and both sublicensing operations leave such a
   text without it. Arrays are compared as sets, and `valid_from` and `valid_until` as
   instants; every other string compares as written, even one that looks like a date.
4. **Status at `t`**, in this order of precedence:
   - `withdrawn`: a `withdrawn` event for the term is in effect;
   - `ended`: the version in force no longer contains the term (`end_reason:
     dropped_by_version`), or `t` is at or after its effective `valid_until`
     (`valid_until_reached`, or `ended_early` when a narrowing moved the end);
   - `not_yet_valid`: `t` is before `valid_from`;
   - `suspended`: a `suspended` event for the term is in effect and no `resumed` event that
     names the term and that suspension in `ref_seq` is. A grant may be suspended more than
     once; it stays suspended until each of its suspensions is lifted;
   - `in_force` otherwise.
5. **Final states.** `withdrawn` and `ended` are final (D20). If step 4 gives `withdrawn` or
   `ended` at some instant at or before `t`, let `u` be the earliest such instant. The state
   at `t` is then the state at `u`: its `status`, `end_reason`, `version`, `narrowed` and
   `effective` are those at `u`, and `since` is `u`. Steps 1 to 4 change only at an event's
   `effective_at`, at a `valid_from` or `valid_until` of the term, or at an `end_earlier`, so
   `u` is one of those instants.
6. **Other members.** `narrowed` is true when the effective grant differs from the text.
   `since` is the instant at which the current status began. `version` is the version whose
   text applies. `effective` is present for grants only. A grant narrowed to no uses or no
   licensees stays `in_force` but permits nothing.
7. **Next change.** `freshness.next_change_at` is the first instant after `as_of` at which
   the derived `term_states` would differ, or absent if there is none.
8. **End rule.** A grant that is withdrawn, or ended early by a narrowing (`ended_early`),
   follows `on_withdrawal`. A grant that reached its `valid_until` or that a version dropped
   follows `on_expiry`. An early end is a party's own decision like a withdrawal, so it cannot
   be used to choose the other rule; the ends that every signer agreed follow `on_expiry`. The
   rule comes from the grant's `end_of_use`, or else the agreement's, in the version given by
   `version`.

## Events

| Type | Actor | Notes |
|---|---|---|
| `issued`, `version_added` | the authority in charge | `version`, and `ref_digest`: the digest of the whole `agreements` item, signatures included. Recorded, and in effect, no earlier than every signature of the version. |
| `narrowed`, `withdrawn` | identity grant: the participant, or an authorized representative with `on_behalf_of`; asset grant: the declaring rights holder | Grants only. `received_at` required. Takes effect at `received_at`, or later when `actor_signature` covers the later `effective_at`. Each narrowing operation, and each value it lists, must change the grant (R13). A withdrawal must take effect before the grant ends. |
| `suspended` | as for `narrowed`, or the authority in charge | Grants only. From a party, timed like `narrowed`. |
| `resumed` | the actor of the suspension it lifts (`ref_seq`); for a suspension made `on_behalf_of` the participant, the participant, or the same representative while still appointed, with `on_behalf_of`; for an authority's suspension, the authority in charge | Lifts that suspension for the listed terms. |
| `payment_recorded` | the payer of the compensation item, or the authority | `ref` and `ref_digest` of the payment. `effective_at` is the payment's `paid_at`. The item's payer and payee, as it stands at `paid_at` (R15), are the payer and payee for every event about the payment. |
| `payment_confirmed` | the payee, or a representative with `on_behalf_of` when the participant is the payee | |
| `payment_disputed`, `payment_refunded` | the payer or the payee, or a representative with `on_behalf_of` when the participant is one of them | These and `payment_confirmed` take effect no earlier than the payment's `paid_at` and no later than they are recorded. A payment's status is the type of its last payment event in `seq` order. |
| `asset_bound` | the authority in charge | `ref` and `ref_digest` of the binding. |
| `asset_unbound` | the authority, or the party that registered the asset while it is a party (R12) | Takes effect when recorded. |
| `authority_transferred` | the authority in charge | `to_authority`, `keys_uri` (the transferring authority's key set) and `actor_signature` over the whole event (`authority_transfer`). Takes effect when recorded. |
| `correction` | the authority in charge | Explains an earlier event (`ref_seq`). It changes no state. |

Payment events record when something happened and may take effect before they are
recorded. A narrowing, suspension or withdrawal from a party takes effect when it was
received. Every other event takes effect no earlier than it is recorded, so nothing that
widens a grant or registers an asset can be backdated.

An authority cannot honour a signed `effective_at` earlier than the instruction's
`received_at`. It records the instruction to take effect at `received_at`, without that
`actor_signature` (which covers another `effective_at`), and may keep a digest of the signed
instruction in `evidence`. A client SHOULD sign an `effective_at` no earlier than the
instruction can arrive.

An event is judged on the record as it stands when it is recorded (D21). An instruction
that names something only a pending version adds is therefore valid only if recorded after
that version's event. Signatures, time-stamp tokens included, are final once their version
or event is recorded: the record's digests cover them.

The derived state still applies an instruction from the time it was received, even when it
is recorded after later events. A binding that takes effect after its grant was withdrawn,
which can happen when the withdrawal is recorded after the binding, therefore covers
nothing, and no end rule applies to its asset. Licensees carry this gap between receipt and
recording; an authority SHOULD record an instruction as soon as it receives it.

`withdrawn` and `ended` are final. A recorded withdrawal cannot be cancelled, whoever
submitted it and even before it takes effect, and a later version that restates the grant
does not undo it; to continue, the parties agree a new grant with a new term id. A
representative's narrowing, suspension or withdrawal binds the participant as the
participant's own would. This holds even when the representative also holds a license under
the record, which `roles` shows. Withdrawal needs no particular form:
e-mail, letter and the portal are equal channels, and `evidence` can hold a digest of what
was received.

## Validation rules beyond JSON Schema

An implementation that accepts or verifies a record also checks the following. Where a rule
refers to the state or the version in force at an event's time, it means the state derived
from the events before that event in `seq` order (D21). Instants are compared as instants,
not as strings. Schema validation asserts the `format` keywords (`date-time`, `uri`), which
JSON Schema 2020-12 treats as annotations unless the validator is set to assert them. A
`uri` is an absolute URI written with the characters RFC 3986 §2 allows: a scheme, then
unreserved, reserved and percent-encoded characters only.

- **R0** The record is I-JSON (RFC 7493 §2): UTF-8 text; no duplicate member names in any
  object, names compared after resolving escapes; and no surrogate or noncharacter code
  point in any string or member name. A `\u` escape may name a surrogate only as half of a
  pair that stands for one supplementary character: `\ud83d\ude00` is allowed, a lone
  `\ud800` is not. The noncharacters are U+FDD0 to U+FDEF and the last two code points of
  every plane (U+FFFE, U+FFFF, U+1FFFE, U+1FFFF, …, U+10FFFF), 66 in all. No number is
  beyond the range of an IEEE 754 double, such as `1E400` (RFC 7493 §2.2). R0 is checked on
  the text, before the schema, because a parser may silently keep one of two duplicate
  names.
- **R1** Every version has the record's `profile` and `record_uri`. `agreements[k - 1]` has
  `version: k`, and its `previous_version_digest` equals the `agreement_digest.value` of
  version k - 1.
- **R2** `agreement_digest.value` is the digest of `agreement`.
- **R3** Within a version, `party_id`, `term_id` and `compensation_id` values are unique and
  every reference resolves to a party with the right role: licensees (`licensee`),
  `sublicensing.to` (`sublicensee`), `payer` and `payee` (which an `unpaid` item omits), `declared_by` and
  `asset_rights.rights_holder` (`rights_holder`). An authorized representative represents
  the participant. `verification.verified_by` is an `https` URI or a party, and
  `biometric_identifiers.holder`, when present, is a party.
- **R4** A grant's `valid_until` is after its `valid_from` and at most ten years later: no
  later than the same date and time in UTC ten years on, or 28 February at that time for a
  start on 29 February. A prohibition's `valid_until`, if present, is after its
  `valid_from`. The consent document is
  signed no earlier than it was presented. `record_until`, if set, is not before
  `disclosures_until`.
- **R5** The participant's `party_id` is the same in every version. A term id keeps its
  `kind`, `consent_domain` and `declared_by`. A term id or `party_id` that a version drops
  never returns; a party that comes back gets a new id and signs with a key it did not use
  under the old one (R6). A version names no term that is
  withdrawn or ended when its version event takes effect. A version signed while a term was live but recorded only after that term ended
  cannot be recorded; its signers sign a version without that term.
- **R6** In every version each party signs at most once, and these parties sign:
  - the participant, and every licensee of a grant;
  - every party listed in both versions whose entry differs (a party with nothing of its own
    left may be dropped without signing);
  - the payer and the payee of every compensation item that the version adds, changes or
    drops, counting a change to a grant that names the item (compared as below);
  - for every grant the version changes or drops, its effective licensees when the version
    takes effect;
  - every rights holder whose asset terms or `asset_rights` entries the version adds,
    changes or drops;
  - the `holder` of `biometric_identifiers`, before and after, when that declaration changes.

  The version is compared with the previous one as RFC 8785 values in committed form:
  parties by `party_id`; terms by `term_id`, a grant together with the `end_of_use` that
  governs it (its own, or else the agreement's; the whole `end_of_use`, `withdrawal_channels`
  included); compensation items by `compensation_id`,
  each together with the set of grants that name it, each grant taken as for terms, since
  what a grant covers, and what may stay in use after it ends, sets what is owed; and each
  rights holder's `asset_rights` entries as a set. Inside each compared value, arrays
  compare in order, so restating an entry with its arrays reordered counts as a change.
  Grants withdrawn or ended when the version takes effect are left out of these
  comparisons. In version 1 every item and declaration is new. Dropping a term that is
  withdrawn or ended when the version takes effect needs no signature. Every party that
  must sign is a party of the version, even one whose last item it drops. No signature
  predates `created_at`. The participant signs no earlier than the consent document was
  presented and no earlier than the participant's verification. The DID of a `did` key binding is
  listed in clear for the signer: in its `identity_binding`, or as a `did` identifier whose
  value is not a commitment. A signer with an `x509` key binding lists in clear the `domain`,
  `lei` or `x509_sha256` identifier that ties its certificate to it. A key binding's
  `verified_at` is no later than the `recorded_at` of the version event or event that records
  its signature, and its `verified_by`, when present, names the authority in charge at `verified_at`, by the
  hand-overs recorded before that event (a hand-over is in effect from its `recorded_at`).
  With `custody: "authority_managed"`, that authority, which holds the key, is also in
  charge at `signed_at`. One key (`kid`) signs for one signer only in a record.
- **R7** Every signature verifies as described above, and `alg` matches the key type, as
  RFC 7518, RFC 9864 and RFC 9964 define the algorithms: `ES256` a P-256 key and `ES384` a P-384
  key (`kty` `EC`), each signature the 64- or 96-byte concatenation of R and S; `Ed25519`
  an `OKP` key with `crv` `Ed25519` (RFC 8037) and a 64-byte signature (RFC 8032), where
  `x` encodes its point canonically (y < p, RFC 8032 §5.1.3) and neither that point nor the
  signature's R is of small order (1, 2, 4 or 8), since a key of small order verifies
  forged signatures; `PS256` an RSA key of 2048 to 4096 bits whose public exponent `e` is
  odd and 2^16 < e < 2^31 (within the range FIPS 186-5 allows), with MGF1 over SHA-256 and
  a 32-byte salt;
  `ML-DSA-65` an `AKP` key whose `alg` member is `ML-DSA-65` and whose `pub` holds the
  1952-byte public key, and a 3309-byte signature made by ML-DSA as FIPS 204 Algorithm 2
  defines it, with an empty context string.
  Because `kid` is the thumbprint of the required members of `jwk` (for `AKP`: `alg`,
  `kty` and `pub`, RFC 9964 §6), with their values as written, `jwk` is encoded as RFC 7518
  §2 and §6, RFC 8037 §2 and RFC 8032 §5.1.5 require: `x` and `y` of 32 (P-256) or 48
  (P-384) bytes, `x` of 32 bytes for Ed25519, and `n` and `e` without leading zero octets.
  A `jwk` whose `use` is not `sig`, or whose `key_ops` lacks `verify`, verifies no signature
  (RFC 7517 §4.2, §4.3). Every `x5c` item is standard base64 (RFC 4648 §4) with the padding
  its length needs and pad bits of zero (§3.5).
- **R8** Events are numbered 1, 2, … in order, each `prev_digest` is the digest of the
  previous event, `recorded_at` never decreases, and no event is recorded after `as_of`.
- **R9** Every version has exactly one version event, in version order. Its `ref_digest` is
  the digest of the whole `agreements` item. It is recorded, and takes effect, no earlier
  than every signature of the version and the signing of its consent document. Version
  effect times increase, and version 1 takes effect no later than `as_of`. Every term of a
  version that has a `valid_until` ends after that version takes effect; for a grant, the
  end counts every `end_earlier` recorded before the version event, and also lies after the
  grant's `valid_from`. A narrowing recorded after the version event cannot invalidate it
  (D21); step 2 of the derivation says how it applies.
- **R10** The authority in charge is version 1's `authority_id` until an
  `authority_transferred` event hands the record to its `to_authority`. Every event whose
  actor is an authority names the authority in charge, and so does each version's
  `authority_id` when its version event is recorded. A hand-over takes effect when it is
  recorded, goes to another authority, and has a `keys_uri` on the transferring authority's
  origin. The record is served by the authority in charge at the end, and its `keys_uri` is
  on the same origin as its `id`. Origins are compared as RFC 6454 §4 computes them: scheme
  and host without regard to ASCII case, and the port, 443 when an `https` URI names none.
  An `https` URI of the schema has no userinfo and no percent-encoding in its authority, so
  that every URI parser, the URL parser of a fetch included, finds the same host.
- **R11** `received_at`, when present, is not after `recorded_at`. An instruction from a party
  (`narrowed`, `suspended`, `resumed`, `withdrawn`) has `received_at`. A `narrowed`,
  `suspended` or `withdrawn` event from a party takes effect at `received_at`, or later only
  when it carries an `actor_signature`, which covers `effective_at`. Every other event except
  payment events takes effect no earlier than it is recorded, and an `asset_unbound` when it
  is recorded, so that a binding is live exactly until the event that unbinds it (R16).
- **R12** Each event's actor is allowed for its type (table above). An actor other than an
  authority is a party of the version in force when the event takes effect (version 1
  before that) or, for a grant or compensation item that the version in force does not
  hold, of the version that R13 or R15 takes it from. Its key binding is checked against its
  entry in the version in force, or else in the earliest such version. An authorized
  representative acts for the participant only while its appointment is in force: it holds
  that role in the version in force when the event takes effect. `on_behalf_of` appears only
  when such a representative acts for the participant, never on an instruction about an asset
  grant, whose rights holder acts in its own name. Payments are recorded once,
  before any other event about them; bindings are bound once and unbound at most once.
- **R13** An instruction names grants of the version in force when it takes effect, or of a
  version recorded before it that takes effect later. Each grant is in force, not yet valid
  or suspended at the instruction's `effective_at`, or, for a grant of a later version, when
  that version takes effect; the checks below use that instant. `resumed` lifts a suspension
  of the grant that took effect no later than it and that no earlier `resumed` lifted. Every
  narrowing operation changes the grant, and so does every value it lists: a value it
  removes is granted (for `remove_sublicensees`, listed in `sublicensing.to`), a context it
  adds is not yet prohibited, and a work `restrict_named_works` keeps is one the grant names,
  when it names any. `end_earlier` is not before that instant, is after the effective
  `valid_from`, and is before the current end.
- **R14** An `actor_signature` is made by the actor, no later than `received_at` (or
  `recorded_at`), over the statement given above: `authority_transfer` for a hand-over,
  `event_instruction` otherwise. No two events carry signatures over the same statement, so
  a signed instruction cannot be recorded twice.
- **R15** Payment ids are unique. Every payment has a `payment_recorded` event that takes
  effect at its `paid_at` and is recorded no earlier. Its compensation item is the one that
  stands at `paid_at`: in the latest version that contains it among the version in force
  then and the versions before it; otherwise, for a payment ahead of a version that takes
  effect later, in the first such version recorded before that event. A payment for an item
  that a later version dropped is therefore still accepted. An `unpaid` item takes no
  payment. Later events about the payment take effect no earlier than `paid_at` and no later
  than they are recorded.
- **R16** Binding ids are unique and every binding has an `asset_bound` event. No two live
  bindings name the same `manifest_label`; to change a registration, unbind and bind
  again. At registration (that event's `effective_at`), each named term is a grant in force,
  `registered_by` is one of its effective licensees, `media_type` is one of its effective
  media types, and the live bindings naming it, this one included, do not exceed its
  effective `max_assets`. When `mime_type` has the top-level type `image`, `video`, `audio` or
  `model`, `media_type` is `image`, `video`, `audio` or `3d`; for `text` it is `text` or
  `interactive`.
- **R17** `term_states` holds one entry for every term id of the versions that have taken
  effect by `as_of`, equal to its derived state at `as_of`.
- **R18** `freshness.next_change_at` equals the derived next change.
- **R19** Every disclosure matches a commitment in the record and has the type of the field it
  replaces. A commitment may appear more than once, but only in place of fields of the same
  name. Members of a `jwk` are key material, never commitments. A compensation item's `cap`
  has the currency of its `amount`.
- **R20** `authority_attestation` is made by the serving authority, at `as_of`, and verifies.

A record with `example: true` conveys no consent.

A verifier may refuse a record that is beyond limits it documents: on its size, on how deep
its arrays and objects nest, or on the work its checks take. It then reports the record as
not verified, never as valid.

## Evaluating a use

This profile does not decide how consent combines with other signals (the draft leaves that
out of scope, §6). A consumer that wants to know whether a record permits a use of an asset
can apply these steps; any failure means no permission from this record.

1. Validate the asset's C2PA manifest and its claim signer under the consumer's trust list.
2. Resolve the reference's `uri` and verify the record (R0–R20). Check that `record_uri`
   equals the `uri`, that `example` is not `true`, and that the response is fresh: `as_of` is
   not later than now, allowing for clock skew, and now is before both
   `as_of + max_age_seconds` and `next_change_at`.
3. Decide whether to trust the authority, by its `id` and key set. Verification shows that
   the record is consistent and its signatures valid. It cannot show that the authority
   recorded every instruction it received, or recorded `received_at` truthfully, and
   `authority_verified` key bindings and `authority_managed` keys rest on the authority's
   word. An authority is known by its origin: the same-origin rule for `keys_uri` cannot tell
   apart authorities that share one.
4. For an identity reference, check that the identity named by the `cawg.identity` assertion
   that `bound_actor` refers to matches a value in the participant's `identity_binding` (open
   question 2). Without `identity_binding` this check cannot be made, and only the binding of
   step 5 ties the asset to the record.
5. Find the live binding whose `manifest_label` is the manifest's label (R16 allows one) and whose `claim_signer`
   fields match the claim's signing certificate, and that has no `asset_unbound` event. When
   the consumer can read the claim's hard-binding reference or hash the file, it also compares
   `hard_binding` and `asset_digest`.
6. Consider only terms whose `consent_domain` equals the reference's. A prohibition in force
   that lists the use applies, whatever any grant says; for identity consent, only when it
   also lists one of the identity attributes the use involves.
7. Find a grant named by the binding, in force, whose effective grant covers the use: use,
   identity attributes, media type, channel, territory (included and not excluded), context
   (not prohibited), named work and party (a licensee, or a sublicensee the grant allows).
   A grant that is suspended or not yet valid, including again after a later version moved
   its start, permits no use while it stays so, not even of assets already published under
   it.
8. If the grant is withdrawn or ended, no new use is permitted. Its end rule (step 8 of the
   derivation) says whether an asset published before then may stay (`may_remain`) or must be
   removed within `within_days`. That covers only an asset whose binding took effect while
   the grant was in force in the derived state. The record shows when an asset was
   registered, not when it was published. `end_of_use` applies only to a grant that is
   withdrawn or ended.

As the draft puts it, "A consumer ought not infer permission from silence" (§5, note).

The label and signer fields identify a manifest only together with C2PA trust validation:
SDKs report the signing certificate's serial number and subject names, which are not unique
on their own. `certificate_sha256` and `hard_binding` bind the manifest cryptographically for
consumers that can read them. (As of 2026-10-27, the JSON report of `@contentauth/c2pa-node`
0.9.7 exposes the manifest label and `signature_info` with `common_name`, `issuer` (holding
the subject's organization), and `cert_serial_number`, but not the hard-binding assertion.)

## Resolution

- A record is served with HTTP GET on `record_uri` as `application/json`.
- `Cache-Control: max-age` is no longer than `freshness.max_age_seconds` and does not reach
  past `next_change_at`.
- Anyone may receive the public view. The full view requires authentication; the method is
  an open question.
- An error, `404` or `410` means no permission.
- `record_uri` SHOULD be a persistent identifier that a successor authority can redirect.

## Privacy

A record is personal data about the participant even without biometric data. This profile
keeps it small:

- no birth date, no identity document numbers, no account or card numbers;
- commitments for names, identifiers and amounts;
- `retention` states when cleartext and the record are deleted; like every field of the
  agreement, it is that of the version in force. A record that registered
  assets refer to may need to outlive the engagement as evidence; this profile records the
  parties' choice and takes no position on how erasure rights apply. For example, GDPR art.
  17(3)(e) limits erasure where processing is necessary for legal claims.

Free-text fields (`purpose.description`, `notes`, `statement`, `basis`, `description`) are
public in both views. They name "the participant", not the person.

Keys and DIDs are public in both views too: `jwk`, `kid`, `did_url` and `identity_binding`
let anyone link the records that share them. Signers SHOULD use a separate key for each
record, and a pairwise DID where they can. A participant's `identity_binding` is linkable in
any case through the assets whose `bound_actor` names that identity.

A commitment reused across versions, or for a payment and the item it pays, shows that the
values are equal. Use a fresh salt where that matters.

The public view also shows the parties' roles, purposes, the dates and methods of payments,
and the biometric declaration: which kinds of biometric identifiers of the participant a
named party holds, and until when. The declaration is not biometric data, but it is personal
data about special-category processing (open question 12).

## Mapping to the CAWG minimum recommendation (§5)

| CAWG consent v0.21 §5: a consent authority ought to be able to express | Where |
|---|---|
| the declaring party, the party on whose behalf, and the basis for that authorization | `parties[]` (`roles`, `represents`, `authorization_basis`, `authorization_evidence`), `declared_by`, `signatures[]`, event `actor` and `on_behalf_of` |
| asset consent terms: AI training and data mining, licensing posture, derivative works, named contextual prohibitions, compensation | asset terms (`cawg.*` uses, `asset.derive`), `asset_rights[].posture`, `scope.prohibited_contexts`, `compensation[]` |
| the grant: granted and prohibited uses, scope, consideration, term, parties | `terms[]` (`kind`, `uses`, `scope`, `compensation`, `valid_from`/`valid_until`, `licensees`) and `parties[]` |
| identity consent terms covering likeness, voice, movement, mannerisms, persona | identity terms, `identity_attributes` (also `name` and `image`, from the draft's definition of identity consent) |
| biometric-identifier restrictions | `biometric_identifiers` |
| the current state and revocability of each term | `state.term_states[]`, `withdrawn` events, `withdrawal_right`, `end_of_use` |
| the temporal validity of each term | `valid_from`, `valid_until`, `term_states[].effective.valid_until` |
| the continuity of records, durability and succession | `authority.continuity`, `authority_transferred` events signed over the history, persistent `record_uri` |
| the binding of the record to the asset and, for identity consent, to the participant's identity | `asset_bindings[]`; the participant's `identity_binding` for `bound_actor` |
| at least one term | `terms` has `minItems: 1` |

Scope note: this profile covers identity consent for living adults and the asset terms that
come with such an engagement. It is not a general asset licensing format. A record may hold
only prohibitions, for example a participant's refusal of AI training.

## Mapping to legal texts (informational)

This table shows which fields hold the facts these texts ask for. It is **not legal advice**
and says nothing about whether any record satisfies any law.

| Text | Requirement | Fields |
|---|---|---|
| New York Fashion Workers Act, Labor Law art. 36. Enacted by L. 2024 ch. 676 ([S9832][ny-s9832], signed 2024-12-21) and amended by L. 2025 ch. 66 ([A2249][ny-a2249], signed 2025-02-14). In force since 2025-06-19. | §1034(11), as amended: "obtain clear written consent from the model for any creation or use of a model's digital replica, detailing the scope, purpose, rate of pay, and duration of such use. This consent must be obtained separately from the representation agreement." §1037(7) asks clients for "clear and conspicuous prior written consent" with the same details. §1036(1)(d): a power of attorney extends to modeling matters "with the exclusion of the use of the model's digital replica". | scope → `scope`; purpose → `purpose`; rate of pay → `compensation[]`; duration → `valid_from`/`valid_until`; separate → `consent_document.separate_document`; prior → R9; power of attorney → D5 |
| US NO FAKES Act of 2026, [S. 4591][no-fakes], 119th Congress, reported in the Senate. Not law. | Sec. 2(b)(2)(B)(i): while the individual is living, a license is valid only for a duration of at most 10 years, and only if the agreement "is in writing and signed by" the applicable individual and "includes a reasonably specific description of the intended uses". Clause (ii) covers minors; clause (iii) exempts licenses governed by a collective bargaining agreement. | participant `signatures[]` (D5); `purpose`, `uses`, `scope`, `named_works`; R4 |
| Denmark, bill [L 49][dk-l49] (2026-27) amending the Copyright Act, introduced 2026-10-08. Not passed; intended to apply from 2027-01-01. | Unofficial translations. Proposed §73 a(1): realistic digitally generated imitations of a natural person's personal, physical characteristics may not be made available to the public without that person's consent. The explanatory remarks: consent can be withdrawn at any time, with no particular formal requirements; withdrawal does not affect the lawfulness of making the imitation available before it; consent given when a contract is made can be withdrawn, but under the general rules of contract law, and withdrawal does not by itself make the contract invalid or end it; whoever makes the imitation available must prove consent. | the record with its signatures and `consent_document` digest; `withdrawal_channels`; withdrawal takes effect when received and needs no form (D9); `end_of_use.existing_assets`; `withdrawal_right` |

## About the example

The example record is fictional and marked `example: true`. Every name, domain
(`*.example`), DID (`did:example:`) and identifier is invented. It shows two agreement
versions: version 2 adds a printed lookbook and a fee. After that the participant removes
Germany from the campaign and withdraws the voice grant by e-mail.

- Agreement digests, commitments, `ref_digest` and `prev_digest` values are real.
- Every signature is a real Ed25519 signature that verifies. The keys come from public seeds
  (SHA-256 of `grantmark example key: <signer>`), so anyone can forge them. They are test
  vectors, not evidence.
- Salts are derived from public labels, not random, so the example is reproducible. Real
  salts MUST be random.
- Document, invoice, e-mail and asset digests, and the C2PA hash, are SHA-256 of placeholder
  strings. The DID does not resolve.

## Open questions

1. CAWG has not decided whether `cawg.consent` stays its own label or moves into
   `cawg.metadata` (the draft's Appendix A, editorial flags). The agenda of the
   [CAWG meeting of 2026-10-05][cawg-2026-10-05] lists a unified CAWG 2.0 draft circulating
   on 30 October 2026. The pointer (`uri`) is expected to survive either way.
2. The syntax of `bound_actor` is not fixed in the draft, so how `identity_binding` matches it
   is provisional.
3. The draft asks each reference to identify its asset by its C2PA hard binding (§4.3) but
   does not name a field. `asset_bindings` should align once it does.
4. A persistent identifier for `profile` and `$id`; the `.example` host is a placeholder.
5. How verifiers authenticate to receive the full view.
6. Privacy-preserving status checks. W3C Bitstring Status List gives one bit per entry, which
   cannot express a partly narrowed or partly withdrawn record.
7. Paging of `events` and `asset_bindings` for records with many assets, and whether to log
   event digests in a public transparency log.
8. A mapping to ISO/IEC TS 27560:2023 consent record fields and the W3C Data Privacy
   Vocabulary.
9. Minors, guardians and post-mortem rights, for a later version.
10. Authority succession. A hand-over needs the transferring authority's signature, so a
    record cannot move once that authority has disappeared, and the parties cannot limit whom
    it hands the record to. An authority could also hand the same record to two successors;
    each copy verifies on its own, and only comparing them shows the fork. Whether agreements
    should name permitted successors, and how the parties could move a record themselves, is
    open.
11. Rotation and revocation of authority keys, including the keys of an authority that has
    handed its records over. After a hand-over, the transferring authority's signature can
    be checked only while its key set is reachable at its `keys_uri`; if that authority
    disappears, nobody can check it again. A successor could republish the key set it
    received, but a verifier can trust that copy only as far as it trusts the successor.
12. Whether `biometric_identifiers.kinds` and `holder` should be withheld behind
    commitments. They are public now so that any consumer can see the restriction and who
    must honour it.

## License

The contents of this `spec/` folder are offered under the [Apache License 2.0][apache-2]
or the [Creative Commons Attribution 4.0 International License][cc-by-4], at your option
(SPDX: `Apache-2.0 OR CC-BY-4.0`).

[cawg-consent]: https://cawg.io/consent/1.0-draft+initial-version/
[cc-by-4]: https://creativecommons.org/licenses/by/4.0/
[apache-2]: https://www.apache.org/licenses/LICENSE-2.0
[cawg-2026-10-05]: https://cawg.io/meeting-notes/2026-10-05/
[ny-s9832]: https://legislation.nysenate.gov/pdf/bills/2023/S9832
[ny-a2249]: https://nyassembly.gov/leg/?default_fld=&leg_video=&bn=A02249&term=2025&Summary=Y&Actions=Y&Text=Y
[no-fakes]: https://www.congress.gov/bill/119th-congress/senate-bill/4591
[dk-l49]: https://www.folketingstidende.dk/samling/20261/lovforslag/L49/20261_L49_som_fremsat.pdf
