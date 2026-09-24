import { Home } from './pages/Home';
import { People } from './pages/People';
import { Studio } from './pages/Studio';
import { Verify } from './pages/Verify';
import { href, useRoute } from './router';

const NAV = [
  ['home', 'Overview'],
  ['people', 'People'],
  ['studio', 'Studio'],
  ['verify', 'Verify'],
] as const;

export function App() {
  const route = useRoute();
  const license = route.params.get('license');

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="banner" role="note">
        Prototype on the Human Consent Standard 1.0 <strong>Draft</strong> · Solana <strong>devnet</strong> only · every person here is{' '}
        <strong>fictional</strong> · not affiliated with or certified by the Human Consent Foundation, RSL or C2PA.
      </div>
      <header className="site-header">
        <a className="brand" href={href('home')}>
          <span className="brand-mark" aria-hidden="true">
            G
          </span>
          Grantmark
        </a>
        <nav aria-label="Main">
          <ul>
            {NAV.map(([page, label]) => (
              <li key={page}>
                <a href={href(page)} aria-current={route.page === page ? 'page' : undefined}>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {route.page === 'people' && <People selected={route.params.get('hcsi')} />}
        {route.page === 'studio' && (
          <Studio initialHcrn={route.params.get('hcrn')} initialLicense={license === null ? null : Number(route.params.get('license'))} />
        )}
        {route.page === 'verify' && <Verify initialLicense={license} />}
        {!['people', 'studio', 'verify'].includes(route.page) && <Home />}
      </main>
      <footer className="site-footer">
        <p>
          Grantmark · Apache-2.0 · Test PKI and devnet only. Content Credentials signed here show as an unknown signer in other verifiers, by design.
        </p>
      </footer>
    </>
  );
}
