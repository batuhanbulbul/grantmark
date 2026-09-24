/**
 * OpenAPI 3.1 description of the Grantmark server, served at /openapi.json. A test checks that it
 * lists exactly the routes the server has.
 */

import type { Config } from './config';

const json = (description: string, schema: object = { type: 'object' }) => ({
  description,
  content: { 'application/json': { schema } },
});
const error = (description: string) => json(description, { $ref: '#/components/schemas/Error' });
const form = (properties: Record<string, object>, required: string[]) => ({
  required: true,
  content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties, required } } },
});
const text = { type: 'string' };
const id = (name: string, description: string) => ({ name, in: 'path', required: true, description, schema: text });

export function openApiDocument(config: Config) {
  const paths: Record<string, Record<string, object>> = {
    '/.well-known/hcs.xml': {
      get: { tags: ['Mock HCS registry'], summary: 'HCS discovery document (HCS §5.2.1)', responses: { 200: { description: 'application/xml' } } },
    },
    '/registry/sitemap.xml': {
      get: { tags: ['Mock HCS registry'], summary: 'HCS sitemap of current declarations (HCS §5.1)', responses: { 200: { description: 'application/xml' } } },
    },
    '/registry/declarations/{hcrn}': {
      get: {
        tags: ['Mock HCS registry'],
        summary: 'Current official declaration, exact bytes, with ETag and Last-Modified',
        parameters: [id('hcrn', 'Registration identifier, e.g. HCRN-0000-0068-F')],
        responses: { 200: { description: 'application/rsl+xml' }, 304: { description: 'Not modified' }, 400: error('Malformed HCRN'), 404: error('Unknown HCRN') },
      },
    },
    '/registry/lookup/{id}': {
      get: {
        tags: ['Mock HCS registry'],
        summary: 'HCRN lookup record (HCS §4.3.2) or HCSI lookup record (HCS §4.4.3)',
        parameters: [id('id', 'An HCRN or an HCSI')],
        responses: { 200: json('Lookup record, labelled mock'), 400: error('Malformed identifier'), 404: error('Unknown identifier') },
      },
    },
    '/registry/subjects/{hcsi}': {
      get: {
        tags: ['Mock HCS registry'],
        summary: 'Rights Subject Record (HCS §4.4.2)',
        parameters: [id('hcsi', 'Rights subject identifier')],
        responses: { 200: { description: 'application/ld+json' }, 404: error('Unknown HCSI') },
      },
    },
    '/registry/authorization': {
      get: { tags: ['Mock HCS registry'], summary: 'Mock Governance Board authorization of registries (HCS §6.1)', responses: { 200: json('Registries') } },
    },
    '/olp/token': {
      post: {
        tags: ['OLP-HCS license server'],
        summary: 'Acquire a License token (RSL 1.0 §5.4); paid offers answer 402 with a payment request (Grantmark extension)',
        security: [{ basicAuth: [] }],
        requestBody: form(
          {
            grant_type: { const: 'client_credentials' },
            license: { type: 'string', description: 'The chosen <license> element from the declaration' },
            resource: { type: 'string', description: 'The declaration HCRN or its canonical URI' },
            license_type: { const: 'application/rsl+xml' },
            scope: { type: 'string', description: 'Grantmark: space-separated Rights Scopes the use needs' },
            place: { type: 'string', description: 'Grantmark: ISO 3166-1 alpha-2 place of use' },
            payer: { type: 'string', description: 'Grantmark: payer Solana devnet wallet' },
            payment_id: { type: 'string', description: 'Grantmark: retry after paying' },
            payment_evidence: { type: 'string', description: 'Grantmark: transaction signature' },
          },
          ['grant_type', 'license', 'resource'],
        ),
        responses: {
          200: json('License token', { $ref: '#/components/schemas/Token' }),
          400: error('invalid_request, invalid_license, invalid_resource or unsupported_grant_type'),
          401: error('invalid_client'),
          402: error('payment_required, with a payment object'),
          403: error('invalid_license with reason_code (minor_protection, not_operative, not_permitted, …)'),
        },
      },
    },
    '/olp/introspect': {
      post: {
        tags: ['OLP-HCS license server'],
        summary: 'Validate a License token for a resource (RSL 1.0 §5.5), re-checking the declaration for new uses',
        security: [{ basicAuth: [] }],
        requestBody: form({ token: text, resource: text }, ['token', 'resource']),
        responses: { 200: json('Introspection response'), 400: error('invalid_request'), 401: error('invalid_client') },
      },
    },
    '/olp/key': {
      post: {
        tags: ['OLP-HCS license server'],
        summary: 'Not supported: Grantmark holds no Encrypted Media Standard keys (RSL 1.0 §5.6)',
        security: [{ basicAuth: [] }],
        responses: { 400: error('invalid_request'), 401: error('invalid_client') },
      },
    },
    '/.well-known/jwks.json': {
      get: { tags: ['OLP-HCS license server'], summary: 'Public keys for License tokens and receipts (ES256)', responses: { 200: json('JWK set') } },
    },
    '/v1/payments/{id}': {
      get: {
        tags: ['Payments'],
        summary: 'Payment status for its client',
        security: [{ basicAuth: [] }],
        parameters: [id('id', 'Payment id (pay_…)')],
        responses: { 200: json('Payment'), 401: error('invalid_client'), 404: error('Unknown payment') },
      },
    },
    '/v1/payments/{id}/transaction': {
      post: {
        tags: ['Payments'],
        summary: 'Rebuild the unsigned devnet transaction with a fresh blockhash (same memo)',
        security: [{ basicAuth: [] }],
        parameters: [id('id', 'Payment id (pay_…)')],
        responses: { 200: json('Payment'), 401: error('invalid_client'), 404: error('No open payment') },
      },
    },
    '/v1/licenses/{id}': {
      get: {
        tags: ['Licenses'],
        summary: 'Public license record: the consent authority stamped images point to (CAWG minimum set)',
        parameters: [id('id', 'License id (lic_…)')],
        responses: { 200: json('License record'), 404: error('Unknown license') },
      },
    },
    '/v1/licenses/{id}/receipt': {
      get: {
        tags: ['Licenses'],
        summary: 'Signed public receipt (JWS, typ grantmark-receipt+jwt)',
        parameters: [id('id', 'License id (lic_…)')],
        responses: { 200: json('Receipt'), 404: error('No receipt') },
      },
    },
    '/v1/licenses/{id}/stamp': {
      post: {
        tags: ['Licenses'],
        summary: 'Stamp an image with C2PA and cawg.consent (embedded or sidecar)',
        security: [{ licenseToken: [] }],
        parameters: [id('id', 'License id (lic_…)')],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { image: { type: 'string', format: 'binary' }, mode: { enum: ['embedded', 'sidecar'] } },
                required: ['image'],
              },
            },
          },
        },
        responses: {
          200: { description: 'The stamped image, or application/c2pa in sidecar mode; X-Grantmark-Asset-Sha256 header' },
          401: error('invalid_token'),
          403: error('Another license, or the declaration no longer permits new uses'),
          413: error('Image larger than 10 MB'),
          415: error('Not PNG, JPEG or WebP'),
        },
      },
    },
    '/v1/verify': {
      post: {
        tags: ['Verification'],
        summary: 'Verify an image: C2PA manifest, consent reference, license, receipt, on-chain payment',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { image: { type: 'string', format: 'binary' }, manifest: { type: 'string', format: 'binary' } },
                required: ['image'],
              },
            },
          },
        },
        responses: { 200: json('Verification report with a verdict'), 400: error('No image'), 415: error('Unsupported image type') },
      },
      get: {
        tags: ['Verification'],
        summary: 'Verify a license by id',
        parameters: [{ name: 'license', in: 'query', required: true, schema: text }],
        responses: { 200: json('Verification report with a verdict'), 404: error('Unknown license') },
      },
    },
    '/v1/evaluate': {
      post: {
        tags: ['Demo'],
        summary: 'Evaluate a subject or declaration for a use, or check pasted XML for conformance',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  subject: text,
                  hcrn: text,
                  xml: text,
                  usage: { enum: ['hcs:ai-generate', 'hcs:ai-train'] },
                  scopes: { type: 'array', items: text },
                  place: text,
                },
              },
            },
          },
        },
        responses: { 200: json('Evaluation'), 400: error('invalid_request'), 404: error('Unknown declaration') },
      },
    },
    '/v1/demo/personas': {
      get: { tags: ['Demo'], summary: 'The fictional personas and their declarations', responses: { 200: json('Personas') } },
    },
    '/v1/demo/licenses': {
      post: {
        tags: ['Demo'],
        summary: 'License requests of the demo studio, run server side (same flow as /olp/token)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['hcrn', 'license'] } } } },
        responses: { 200: json('License token'), 402: error('payment_required'), 403: error('Refused'), 503: error('Demo client not set up') },
      },
    },
    '/health': {
      get: { tags: ['Operations'], summary: 'Liveness check', responses: { 200: json('Up') } },
    },
  };

  if (config.adminToken !== undefined) {
    paths['/registry/admin/declarations'] = {
      post: {
        tags: ['Mock HCS registry'],
        summary: 'Demo only: publish a new declaration version',
        security: [{ adminBearer: [] }],
        requestBody: { required: true, content: { 'application/rsl+xml': { schema: text } } },
        responses: { 200: json('Unchanged'), 201: json('Published'), 400: error('Invalid declaration'), 401: error('Wrong token') },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Grantmark',
      version: '0.1.0',
      summary: 'The open clearance layer for AI likeness rights (prototype on the HCS 1.0 Draft).',
      description:
        'Mock HCS registry, an OLP-HCS license server prototype (RSL 1.0 §5 plus a Solana devnet payment step), receipts, C2PA stamping with ' +
        'cawg.consent, and public verification. Devnet and test PKI only; all people are fictional.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: config.publicBaseUrl }],
    components: {
      securitySchemes: {
        basicAuth: { type: 'http', scheme: 'basic', description: 'OLP client_id and client_secret (RSL 1.0 §5.3)' },
        licenseToken: { type: 'http', scheme: 'License', description: 'A License token from /olp/token (RSL 1.0 §6.2)' },
        adminBearer: { type: 'http', scheme: 'bearer' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: text, error_description: text, reason_code: text },
          required: ['error', 'error_description'],
        },
        Token: {
          type: 'object',
          properties: {
            access_token: text,
            token_type: { const: 'License' },
            expires_in: { type: 'integer' },
            license_id: text,
            subject_scope: text,
            excluded_scope: { type: 'object', additionalProperties: text },
          },
          required: ['access_token', 'token_type', 'expires_in'],
        },
      },
    },
    paths,
  };
}
