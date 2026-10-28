# Grantmark

**Grantmark: the open clearance layer for AI likeness rights.**

*Grant* — a person grants permission and a studio obtains a license.
*Mark* — that permission is stamped onto the generated image as a verifiable mark.

> **Prototype notice.** Grantmark is an experimental prototype built on the
> **Human Consent Standard (HCS) 1.0 Draft**, which is not finalized. Grantmark is
> not affiliated with, endorsed by, or certified by the Human Consent Foundation,
> the RSL Collective, or CAWG/C2PA. Everything here is a proposal for how an
> HCS-compatible license server *could* work. Devnet and test mode only; all people
> in the demo data are fictional.

## What works today

1. **Declare.** A mock HCS registry serves the declarations of fictional rights holders
   (`/.well-known/hcs.xml`, `/registry/…`). `@grantmark/hcs` parses them, checks
   conformance and evaluates a use by the draft's rules, including conflicts between
   registries and territory. Minors never get a permission path.
2. **License and pay.** A license server speaks the Open License Protocol from RSL 1.0
   (`/olp/token`, `/olp/introspect`) and issues ES256 License tokens (`/.well-known/jwks.json`).
   A paid offer answers `402` with a payment request: the studio pays USDC on Solana devnet
   straight to the rights holder's wallet, with a memo holding a hash of the exact terms.
   The server holds no Solana private key. Stripe test mode exists as an interface only.
   Solana is the first payment rail: payments sit behind the `PaymentProvider` interface
   (`packages/payments`), and other chains such as Ethereum and Sui are planned.
3. **Stamp.** `@grantmark/stamp` signs an image with a C2PA manifest whose `cawg.consent`
   assertion points to the public license record (`/v1/licenses/{id}`), and adds a signed
   receipt. Signing uses test PKI only, so outside Grantmark the signer shows as unknown.
4. **Verify.** `/v1/verify` reads an image and checks its C2PA manifest, the consent
   reference, the license, the receipt and the on-chain payment.

A web app (People, Studio, Verify) runs the whole flow in the browser with a Solana wallet.
The API is described at `/openapi.json`.

The repository also proposes a format for what a consent authority returns:
[`spec/`](spec/README.md) with its verifier, see
[Consent authority record profile](#consent-authority-record-profile).

## Repository

| Path | Content |
|---|---|
| `apps/server` | HTTP server (Hono, SQLite): registry, license server, payments, licenses, stamping, verification |
| `apps/web` | Demo web app (React, Vite) |
| `packages/hcs` | HCS 1.0 Draft parser, conformance checks, evaluator and identifiers |
| `packages/payments` | Solana USDC devnet transactions, payment memo and verifier; Stripe test mode stub |
| `packages/stamp` | C2PA stamping and reading with `cawg.consent` |
| `packages/consent-record` | Verifier for the consent authority record profile |
| `spec` | Consent authority record profile: schema, example, test vectors |
| `scripts/devnet-e2e.ts` | A paid license end to end on Solana devnet |
| `fixtures` | HCS persona fixtures and the public c2pa-rs test PKI (see its `NOTICE`) |

## Run locally

Requires Node.js 24 (`.nvmrc`).

```sh
npm ci
cp .env.example .env    # optional: every value has a local default
npm run seed            # fictional rights holders and the demo OLP client
npm run dev             # API on http://localhost:8787
```

`npm run seed` prints the demo client's secret unless `DEMO_CLIENT_SECRET` is set. For the
web app, run `npm run dev --workspace=apps/web` beside the API; Vite forwards the API paths to
port 8787. Alternatively `npm run build && npm start` serves the built web app and the API on
one port.

With Docker, one container runs everything and seeds on start:

```sh
docker build -t grantmark .
docker run -p 8787:8787 -v grantmark-data:/data grantmark
```

A real devnet payment needs `DEMO_RIGHTS_HOLDER_WALLET` set before seeding, and a devnet
wallet funded with devnet SOL and devnet USDC. The steps are at the top of
`scripts/devnet-e2e.ts`.

## Tests

```sh
npm test             # Vitest, all packages and apps
npm run typecheck
```

Tests that call the public devnet RPC are skipped unless `GRANTMARK_LIVE_DEVNET=1`. CI runs
the type check, the tests, the web build and the Docker build.

## Consent authority record profile

A C2PA manifest can carry a CAWG consent assertion, `cawg.consent`, whose references point
to a *consent authority*: a service that holds and resolves the current consent terms. The
CAWG draft leaves the format of the authority's answer open. [`spec/`](spec/README.md)
proposes one for consent to use a living adult's name, image, likeness and voice, for
example for a digital replica: a JSON Schema, a complete example record, the validation
rules and 310 test vectors. It is draft 0.2.0 and not endorsed by CAWG, DIF or C2PA.

`@grantmark/consent-record` verifies a record against the schema and every rule:

```sh
npm run verify-record -- spec/examples/digital-double.example.json --public \
  --key-sets spec/test-vectors/key-sets.json
```

Checks that need outside data (DID resolution, X.509 chains, time-stamp tokens) are listed
as not checked unless a resolver supplies the data.

The license record that the server publishes today (`/v1/licenses/{id}`) predates this
profile: it carries the minimum set of the CAWG draft, not a record of the profile.

## License

[Apache License 2.0](LICENSE). The contents of `spec/` are also offered under CC BY 4.0, at
your option (`Apache-2.0 OR CC-BY-4.0`).
