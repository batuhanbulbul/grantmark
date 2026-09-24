import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db';
import { ClientStore, parseBasicAuth } from '../src/olp/clients';

let clients: ClientStore;
beforeEach(() => {
  clients = new ClientStore(openDatabase(':memory:'), () => new Date('2026-09-20T10:00:00Z'));
});

describe('ClientStore', () => {
  it('creates a client with a random secret and verifies it', () => {
    const { clientId, clientSecret } = clients.create('Demo Studio');
    expect(clientId).toMatch(/^cli_/);
    expect(clientSecret.length).toBeGreaterThanOrEqual(40);
    expect(clients.verify(clientId, clientSecret)).toEqual({ clientId, name: 'Demo Studio' });
  });

  it('accepts a chosen id and secret', () => {
    clients.create('Demo Studio', { clientId: 'demo-studio', secret: 'a-chosen-secret-value' });
    expect(clients.verify('demo-studio', 'a-chosen-secret-value')?.clientId).toBe('demo-studio');
  });

  it('rejects a wrong secret or an unknown client', () => {
    const { clientId } = clients.create('Demo Studio');
    expect(clients.verify(clientId, 'wrong')).toBeUndefined();
    expect(clients.verify('cli_unknown', 'anything')).toBeUndefined();
  });

  it('never stores the secret itself', () => {
    const db = openDatabase(':memory:');
    const store = new ClientStore(db);
    const { clientSecret } = store.create('Demo Studio');
    const row = db.prepare('SELECT secret_hash FROM clients').get() as { secret_hash: string };
    expect(row.secret_hash).not.toContain(clientSecret);
    expect(row.secret_hash).toMatch(/^scrypt\$/);
  });

  it('refuses duplicate client ids', () => {
    clients.create('A', { clientId: 'demo-studio', secret: 'a-chosen-secret-value' });
    expect(() => clients.create('B', { clientId: 'demo-studio', secret: 'another-secret-value' })).toThrow();
  });
});

describe('parseBasicAuth (RFC 7617, RSL §5.3.1)', () => {
  const header = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;

  it('decodes the form-encoded id and secret', () => {
    expect(parseBasicAuth(header('demo-studio:s3cret'))).toEqual({ clientId: 'demo-studio', secret: 's3cret' });
    expect(parseBasicAuth(header('my%20client:a%3Ab+c'))).toEqual({ clientId: 'my client', secret: 'a:b c' });
  });

  it('keeps colons in the secret', () => {
    expect(parseBasicAuth(header('id:a:b'))).toEqual({ clientId: 'id', secret: 'a:b' });
  });

  it.each([
    ['no header', undefined],
    ['another scheme', 'Bearer abc'],
    ['no colon', header('idonly')],
    ['an empty id', header(':secret')],
    ['bad percent-encoding', header('%E0%A4%A:secret')],
  ])('rejects %s', (_label, value) => {
    expect(parseBasicAuth(value)).toBeUndefined();
  });
});
