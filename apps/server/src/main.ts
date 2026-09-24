import { serve } from '@hono/node-server';
import { createApp, createServices } from './app';
import { loadConfig } from './config';
import { openDatabase } from './db';
import { loadEnvFile } from './env';

const POLL_INTERVAL_MS = 15_000;

loadEnvFile();
const config = loadConfig(process.env);
const services = createServices(openDatabase(config.databasePath), config);
const app = createApp(services, config);

// Settles payments whose transaction the client never reported, and expires stale requests.
setInterval(() => {
  services.paymentService.poll().catch((error: unknown) => console.error('payment poll failed', error));
}, POLL_INTERVAL_MS).unref();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Grantmark server on port ${info.port}, public URL ${config.publicBaseUrl}`);
});
