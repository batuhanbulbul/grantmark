import { loadConfig } from './config';
import { openDatabase } from './db';
import { loadEnvFile } from './env';
import { RegistryStore } from './registry/store';
import { seedPersonas } from './seed';

loadEnvFile();
const config = loadConfig(process.env);
const store = new RegistryStore(openDatabase(config.databasePath));
const result = seedPersonas(store, config);

console.log(`Seeded ${result.subjects.length} fictional Rights Subjects into ${config.databasePath}`);
for (const { hcrn, version, changed } of result.declarations) {
  console.log(`  ${hcrn} v${version} ${changed ? 'published' : 'unchanged'}`);
}
