import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { openDatabase } from './db';
import { loadEnvFile } from './env';
import { RegistryStore } from './registry/store';

loadEnvFile();
const config = loadConfig(process.env);
const store = new RegistryStore(openDatabase(config.databasePath));
const app = createApp({ store, config });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Grantmark server on port ${info.port}, public URL ${config.publicBaseUrl}`);
});
