import { createServices } from './app';
import { loadConfig } from './config';
import { openDatabase } from './db';
import { loadEnvFile } from './env';
import { seedPersonas } from './seed';

loadEnvFile();
const config = loadConfig(process.env);
const services = createServices(openDatabase(config.databasePath), config);
const result = seedPersonas(services.registry, config);

console.log(`Seeded ${result.subjects.length} fictional Rights Subjects into ${config.databasePath}`);
for (const { hcrn, version, changed } of result.declarations) {
  console.log(`  ${hcrn} v${version} ${changed ? 'published' : 'unchanged'}`);
}

// A demo OLP client. Its secret is printed once, when it is created.
const clientId = process.env.DEMO_CLIENT_ID || 'demo-studio';
if (services.clients.get(clientId) === undefined) {
  const secret = process.env.DEMO_CLIENT_SECRET || undefined;
  const { clientSecret } = services.clients.create('Demo Studio (fictional)', { clientId, ...(secret ? { secret } : {}) });
  console.log(`Created OLP client ${clientId}${secret ? '' : ` with secret ${clientSecret}`}`);
}
