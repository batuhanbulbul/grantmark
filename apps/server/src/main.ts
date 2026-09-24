import { serve } from '@hono/node-server';
import { createApp, createServices } from './app';
import { loadConfig } from './config';
import { openDatabase } from './db';
import { loadEnvFile } from './env';

loadEnvFile();
const config = loadConfig(process.env);
const app = createApp(createServices(openDatabase(config.databasePath), config), config);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Grantmark server on port ${info.port}, public URL ${config.publicBaseUrl}`);
});
