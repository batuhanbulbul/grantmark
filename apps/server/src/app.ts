import type { DatabaseSync } from 'node:sqlite';
import { SolanaUsdcDevnet, createDevnetRpc, type SolanaRpc } from '@grantmark/payments';
import { Stamper, loadTestPki, type SigningMaterial } from '@grantmark/stamp';
import { Hono } from 'hono';
import type { Config } from './config';
import { demoRoutes } from './demo/routes';
import { apiError } from './http';
import { licenseRoutes } from './licenses/routes';
import { verifyRoutes } from './licenses/verify';
import { ClientStore } from './olp/clients';
import { KeyStore } from './olp/keys';
import { LicenseStore } from './olp/licenses';
import { olpRoutes } from './olp/routes';
import { LicenseService } from './olp/service';
import { paymentRoutes } from './payments/routes';
import { PaymentService } from './payments/service';
import { PayeeStore, PaymentStore } from './payments/store';
import { registryRoutes } from './registry/routes';
import { RegistryStore } from './registry/store';

export interface Services {
  readonly registry: RegistryStore;
  readonly clients: ClientStore;
  readonly keys: KeyStore;
  readonly licenses: LicenseStore;
  readonly licensing: LicenseService;
  readonly payees: PayeeStore;
  readonly payments: PaymentStore;
  readonly paymentService: PaymentService;
  readonly stamper: Stamper;
  readonly provider: SolanaUsdcDevnet;
  /** Certificates and trust anchors for C2PA signing and verification (test PKI). */
  readonly signing: SigningMaterial;
  readonly now: () => Date;
}

export interface ServiceOptions {
  /** Replaces the devnet JSON-RPC client, e.g. with recorded data in tests. */
  readonly solanaRpc?: SolanaRpc | undefined;
  /** C2PA signing material; the c2pa-rs test PKI by default. */
  readonly signing?: SigningMaterial | undefined;
}

export function createServices(
  db: DatabaseSync,
  config: Config,
  now: () => Date = () => new Date(),
  options: ServiceOptions = {},
): Services {
  const registry = new RegistryStore(db, now);
  const licenses = new LicenseStore(db, now);
  const keys = new KeyStore(db, config.licenseServerUrl, now);
  const licensing = new LicenseService({ registry, licenses, keys, config, now });
  const payees = new PayeeStore(db);
  const payments = new PaymentStore(db, now);
  const provider = new SolanaUsdcDevnet(options.solanaRpc ?? createDevnetRpc(config.solanaRpcUrl));
  const signing = options.signing ?? loadTestPki();
  return {
    registry,
    clients: new ClientStore(db, now),
    keys,
    licenses,
    licensing,
    payees,
    payments,
    paymentService: new PaymentService({ payments, payees, licenses, licensing, provider, config, now }),
    stamper: new Stamper(signing),
    provider,
    signing,
    now,
  };
}

export function createApp(services: Services, config: Config): Hono {
  const app = new Hono();
  app.route('/', registryRoutes(services.registry, config));
  app.route('/', olpRoutes(services));
  app.route('/', paymentRoutes(services));
  app.route('/', licenseRoutes(services, config, services.now));
  app.route('/', verifyRoutes(services, config, services.now));
  app.route('/', demoRoutes(services, config, services.now, config.demoClientId));
  app.notFound((c) => apiError(c, 404, 'not_found', `no route for ${c.req.method} ${c.req.path}`));
  app.onError((error, c) => {
    console.error(error);
    return apiError(c, 500, 'server_error', 'the server could not handle the request');
  });
  return app;
}
