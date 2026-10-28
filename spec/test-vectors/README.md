# Test vectors

Test vectors for the [consent authority record profile](../README.md), draft 0.2.0. Each
vector is one record and the result a verifier must reach on it.

| File | Content |
|---|---|
| `index.json` | `{profile, count, cases: [{id, file, description, expect}]}` |
| `cases/NNN-*.json` | One record per file, byte for byte as a verifier receives it |
| `key-sets.json` | The example authorities' public keys, keyed by `keys_uri`, for the key set check (step 4 under "Signing statements") |

## Expectations

- `"valid"`: the record verifies without any problem, both as given (the full view) and
  without `disclosures` (the public view).
- A rule id (`schema` or `R0` to `R20`): verifying the record as given reports at least one
  problem under that rule. A verifier may report other problems as well. Each case changes
  one thing, but one change can break several rules; editing a signed value, for example,
  breaks the signature and every digest that covers it.

The `R0` cases are deliberately not I-JSON: a duplicate member name, an escaped unpaired
surrogate, noncharacters, a number beyond the range of an IEEE 754 double, and bytes that
are not UTF-8. A few other cases also depend on their exact bytes, such as a number written
`1.0`. Read every file as bytes and keep tools from rewriting them. The other files are
minified JSON.

The expectations do not cover checks that need data from outside the record: DID
resolution, X.509 certificate chains, revocation and identifiers, and RFC 3161 time-stamp
tokens. The DIDs (`did:example:`) do not resolve, and the `x5c` values are placeholders,
not certificates.

## How they were made

Every case starts from the [example record](../examples/digital-double.example.json) and
changes one thing. Most cases change the source and recompute every digest and signature,
so that the named rule is tested on its own; a few tamper with the finished record. Every
record is marked `example: true` and conveys no consent.

Ed25519 and ECDSA keys come from public seeds, and the RSA keys were generated once without
protection. Anyone can sign with these keys, so the signatures prove nothing. PS256 and
ML-DSA-65 signatures are randomized, so regenerating the vectors changes those files.

Case ids may change between versions of the profile.

## License

Same as the [`spec/` folder](../README.md#license).
