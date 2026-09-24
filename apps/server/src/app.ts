import { Hono } from 'hono';
import type { Config } from './config';
import { apiError, registryRoutes } from './registry/routes';
import type { RegistryStore } from './registry/store';

export interface AppDependencies {
  readonly store: RegistryStore;
  readonly config: Config;
}

export function createApp({ store, config }: AppDependencies): Hono {
  const app = new Hono();
  app.route('/', registryRoutes(store, config));
  app.notFound((c) => apiError(c, 404, 'not_found', `no route for ${c.req.method} ${c.req.path}`));
  app.onError((error, c) => {
    console.error(error);
    return apiError(c, 500, 'server_error', 'the server could not handle the request');
  });
  return app;
}
