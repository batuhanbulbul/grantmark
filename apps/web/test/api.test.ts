import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('api.requestLicense', () => {
  it('returns a token outcome', async () => {
    const fetchMock = mockFetch(200, { access_token: 't', token_type: 'License', expires_in: 60, license_id: 'lic_1', subject_scope: 'image' });
    const outcome = await api.requestLicense({ hcrn: 'HCRN-0000-0068-F', license: 1, scope: 'image' });
    expect(outcome).toEqual({ kind: 'token', token: 't', licenseId: 'lic_1', subjectScope: 'image', expiresIn: 60, excludedScope: {} });
    expect(fetchMock).toHaveBeenCalledWith('/v1/demo/licenses', expect.objectContaining({ method: 'POST' }));
  });

  it('returns a payment outcome for 402', async () => {
    mockFetch(402, { error: 'payment_required', error_description: 'pay', payment: { id: 'pay_1', status: 'requires_payment', accepts: [] } });
    const outcome = await api.requestLicense({ hcrn: 'HCRN-0000-0068-F', license: 1 });
    expect(outcome).toMatchObject({ kind: 'payment_required', description: 'pay', payment: { id: 'pay_1' } });
  });

  it('returns a refusal with its reason code', async () => {
    mockFetch(403, { error: 'invalid_license', error_description: 'minor', reason_code: 'minor_protection' });
    expect(await api.requestLicense({ hcrn: 'HCRN-0000-006A-H', license: 1 })).toEqual({
      kind: 'error',
      status: 403,
      error: 'invalid_license',
      description: 'minor',
      reasonCode: 'minor_protection',
    });
  });
});

describe('api JSON helpers', () => {
  it('throws the server description on errors', async () => {
    mockFetch(404, { error: 'not_found', error_description: 'no such license' });
    await expect(api.license('lic_x')).rejects.toThrow('no such license');
  });

  it('sends evaluation requests as JSON', async () => {
    const fetchMock = mockFetch(200, { decision: 'prohibited' });
    await api.evaluate({ subject: 'HCSI-0000-0035-V', usage: 'hcs:ai-train' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ subject: 'HCSI-0000-0035-V', usage: 'hcs:ai-train' });
  });
});
