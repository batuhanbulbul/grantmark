import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { Config } from './config';
import { apiError } from './http';
import { ClientStore } from './olp/clients';
import { KeyStore } from './olp/keys';
import { LicenseStore } from './olp/licenses';
import { olpRoutes } from './olp/routes';
import { LicenseService } from './olp/service';
import { registryRoutes } from './registry/routes';
import { RegistryStore } from './registry/store';

export interface Services {
  readonly registry: RegistryStore;
  readonly clients: ClientStore;
  readonly keys: KeyStore;
  readonly licenses: LicenseStore;
  readonly licensing: LicenseService;
}

export function createServices(db: DatabaseSync, config: Config, now: () => Date = () => new Date()): Services {
  const registry = new RegistryStore(db, now);
  const licenses = new LicenseStore(db, now);
  const keys = new KeyStore(db, config.licenseServerUrl, now);
  return {
    registry,
    clients: new ClientStore(db, now),
    keys,
    licenses,
    licensing: new LicenseService({ registry, licenses, keys, config, now }),
  };
}

export function createApp(services: Services, config: Config): Hono {
  const app = new Hono();
  app.route('/', registryRoutes(services.registry, config));
  app.route('/', olpRoutes(services));
  app.notFound((c) => apiError(c, 404, 'not_found', `no route for ${c.req.method} ${c.req.path}`));
  app.onError((error, c) => {
    console.error(error);
    return apiError(c, 500, 'server_error', 'the server could not handle the request');
  });
  return app;
}
