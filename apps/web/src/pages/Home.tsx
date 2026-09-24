import { Card, Chip, ExternalLink } from '../components';
import { href } from '../router';

export function Home() {
  return (
    <div className="stack">
      <header className="hero">
        <h1>The open clearance layer for AI likeness rights</h1>
        <p className="lead">
          People declare how AI may use their likeness with the Human Consent Standard. Studios license it through an open license server, pay the rights holder
          in USDC, and stamp every generated image with consent anyone can verify.
        </p>
        <div className="row">
          <a className="button primary" href={href('people')}>
            Meet the fictional people
          </a>
          <a className="button" href={href('studio')}>
            License and stamp
          </a>
          <a className="button" href={href('verify')}>
            Verify an image
          </a>
        </div>
      </header>

      <div className="grid three">
        <Card title="1. Declare">
          <p>
            A rights holder publishes an HCS declaration in a registry: which uses are permitted or prohibited, for which scopes (image, likeness, voice…), and
            at what price. Grantmark evaluates it by the draft&apos;s rules, including conflicts between registries.
          </p>
        </Card>
        <Card title="2. License and pay">
          <p>
            A studio asks the license server named in the declaration for a license (OLP from RSL 1.0). Paid offers settle in devnet USDC straight to the rights
            holder&apos;s wallet, bound on-chain to the exact terms. Minors never get a permission path.
          </p>
        </Card>
        <Card title="3. Stamp and verify">
          <p>
            The output is signed with a C2PA manifest whose <code>cawg.consent</code> assertion points to the license. Anyone can check the image, the license
            status and the payment.
          </p>
        </Card>
      </div>

      <Card title="Standards">
        <p>
          <Chip>Human Consent Standard 1.0 Draft</Chip> <Chip>RSL 1.0 · Open License Protocol</Chip> <Chip>C2PA 2.4 + CAWG consent (draft)</Chip>{' '}
          <Chip>Solana devnet · USDC</Chip>
        </p>
        <p className="small muted">
          Machine-readable entry points: <ExternalLink href="/.well-known/hcs.xml">/.well-known/hcs.xml</ExternalLink>,{' '}
          <ExternalLink href="/registry/sitemap.xml">registry sitemap</ExternalLink>, <ExternalLink href="/.well-known/jwks.json">JWKS</ExternalLink>, OLP at{' '}
          <code>/olp/token</code> and <code>/olp/introspect</code>.
        </p>
      </Card>
    </div>
  );
}
