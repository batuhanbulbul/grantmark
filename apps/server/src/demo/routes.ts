/**
 * Endpoints for the demo web app.
 *
 * - GET /v1/demo/personas: the fictional personas and their declarations.
 * - POST /v1/evaluate: evaluate a subject or declaration for a use, or check pasted XML.
 * - POST /v1/demo/licenses: the demo studio's license requests, run server side so no client
 *   secret reaches the browser. It goes through exactly the same code as /olp/token.
 */

import {
  CANONICAL_ID_BASE,
  SUBJECT_SCOPES,
  USAGE_TOKENS,
  ageStatus,
  checkDocument,
  evaluate,
  isCountryCode,
  isValidHcsId,
  parseHcsDocument,
  type UsageToken,
} from '@grantmark/hcs';
import { Hono } from 'hono';
import type { Config } from '../config';
import { apiError } from '../http';
import { respondToTokenRequest, type OlpServices } from '../olp/routes';
import type { RegistryStore } from '../registry/store';
import { declarationUrl, registryView, subjectDocuments } from '../registry/view';

interface DemoServices extends OlpServices {
  readonly registry: RegistryStore;
}

function parsedDeclaration(registry: RegistryStore, hcrn: string) {
  const stored = registry.declaration(hcrn);
  if (stored === undefined) return undefined;
  const parsed = parseHcsDocument(stored.content);
  return parsed.ok ? { stored, right: parsed.document.rights[0]!, check: checkDocument(parsed.document)[0]! } : undefined;
}

const CLAIM = /^[A-Za-z0-9_-]{16,128}$/;

export function demoRoutes(services: DemoServices, config: Config, now: () => Date, demoClientId: string): Hono {
  const { registry, clients } = services;
  const base = config.publicBaseUrl;
  const app = new Hono();

  app.get('/v1/demo/personas', (c) => {
    const personas = registry
      .subjects()
      .map((subject) => {
        const record = subject.record as { name?: string; description?: string };
        const declarations = registry.declarationsFor(subject.hcsi).filter((d) => d.subjectHcsi === subject.hcsi);
        return {
          hcsi: subject.hcsi,
          name: record.name ?? subject.hcsi,
          description: record.description,
          fictional: typeof record.description === 'string' && record.description.startsWith('Fictional'),
          age_status: ageStatus(subject.record, now()),
          record_url: `${base}/registry/subjects/${subject.hcsi}`,
          declarations: declarations.map((stored) => {
            const declaration = parsedDeclaration(registry, stored.hcrn)?.check.declaration;
            return {
              hcrn: stored.hcrn,
              version: stored.version,
              registry: stored.registry,
              url: declarationUrl(base, stored.hcrn),
              status: declaration?.status,
              subject_scope: declaration?.subjectScope ?? null,
              territory: declaration?.territory ?? null,
              server: declaration?.server ?? null,
              offers: (declaration?.licenses ?? []).map((terms, i) => ({
                license: i + 1,
                usage: terms.permits.usage ?? [],
                prohibits: terms.prohibits.usage ?? [],
                user: terms.permits.user ?? null,
                amount: terms.payment?.amount ?? null,
                xml: terms.source,
              })),
            };
          }),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ personas });
  });

  app.post('/v1/evaluate', async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as
      | { subject?: unknown; hcrn?: unknown; xml?: unknown; usage?: unknown; scopes?: unknown; place?: unknown }
      | undefined;
    if (body === undefined) return apiError(c, 400, 'invalid_request', 'send a JSON body');

    if (typeof body.xml === 'string') {
      const parsed = parseHcsDocument(body.xml);
      if (!parsed.ok) return apiError(c, 400, 'invalid_request', `not a readable HCS document: ${parsed.error.message}`, { parse_error: parsed.error });
      return c.json({ declarations: checkDocument(parsed.document) });
    }

    const usage = body.usage ?? 'hcs:ai-generate';
    if (typeof usage !== 'string' || !(USAGE_TOKENS as readonly string[]).includes(usage)) {
      return apiError(c, 400, 'invalid_request', `usage must be one of ${USAGE_TOKENS.join(', ')}`);
    }
    if (body.place !== undefined && (typeof body.place !== 'string' || !isCountryCode(body.place))) {
      return apiError(c, 400, 'invalid_request', 'place must be an ISO 3166-1 alpha-2 code');
    }
    if (body.scopes !== undefined && !(Array.isArray(body.scopes) && body.scopes.every((s) => typeof s === 'string'))) {
      return apiError(c, 400, 'invalid_request', 'scopes must be an array of strings');
    }

    let subject: string;
    let scopes = body.scopes as string[] | undefined;
    if (typeof body.hcrn === 'string') {
      const found = parsedDeclaration(registry, body.hcrn);
      const declaration = found?.check.declaration;
      if (declaration?.subjectId === undefined) return apiError(c, 404, 'not_found', 'no declaration for a specific subject with this HCRN');
      subject = declaration.subjectId;
      scopes ??= declaration.subject === 'mark' ? undefined : [...(declaration.subjectScope ?? SUBJECT_SCOPES[declaration.subject])];
    } else if (typeof body.subject === 'string' && isValidHcsId(body.subject, 'HCSI')) {
      subject = body.subject;
    } else {
      return apiError(c, 400, 'invalid_request', 'send subject (an HCSI), hcrn, or xml');
    }

    const evaluation = evaluate({
      subject,
      documents: subjectDocuments(registry, base, subject),
      registry: registryView(registry, base),
      use: { usage: usage as UsageToken, at: now(), scopes, place: body.place as string | undefined },
    });
    return c.json({ ...evaluation, subject_uri: CANONICAL_ID_BASE + subject });
  });

  app.post('/v1/demo/licenses', async (c) => {
    const client = clients.get(demoClientId);
    if (client === undefined) return apiError(c, 503, 'temporarily_unavailable', 'the demo studio client is not set up on this server');
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (body === undefined || typeof body.hcrn !== 'string') return apiError(c, 400, 'invalid_request', 'send hcrn and license');
    const offer = parsedDeclaration(registry, body.hcrn)?.right.licenses[Number(body.license) - 1];
    if (offer === undefined) return apiError(c, 400, 'invalid_request', 'license must be the number of an offer in the declaration');

    const text = (name: string) => (typeof body[name] === 'string' ? (body[name] as string) : undefined);
    // Every browser shares the demo client, so a payment is tied to a secret its browser keeps.
    const claim = text('claim');
    const paying = text('payer') !== undefined || text('payment_id') !== undefined;
    if (paying && (claim === undefined || !CLAIM.test(claim))) {
      return apiError(c, 400, 'invalid_request', 'claim is required for payments: a random value (16-128 letters, digits, - or _) this browser keeps');
    }
    const stored = registry.declaration(body.hcrn)!;
    const license = new TextDecoder().decode(stored.content).slice(offer.element.start, offer.element.end);
    const form = {
      grant_type: 'client_credentials',
      license,
      resource: body.hcrn,
      scope: text('scope'),
      place: text('place'),
      payer: text('payer'),
      payment_id: text('payment_id'),
      payment_evidence: text('payment_evidence'),
    };
    return respondToTokenRequest(c, services, client, form, { claim });
  });

  return app;
}
