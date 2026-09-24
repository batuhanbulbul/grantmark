import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { useEffect, useMemo, useState } from 'react';
import { api, type LicenseOutcome, type Payment, type Persona } from '../api';
import { Alert, Card, Chip, ExternalLink, Field, Mono } from '../components';
import { formatAmount, shortHash, usageLabel } from '../format';
import { placeholderImage } from '../placeholder';
import { href } from '../router';
import { connectWallet, installedWallets, signAndSendTransaction } from '../wallet';

type Token = Extract<LicenseOutcome, { kind: 'token' }>;
const explorer = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function WalletPicker({ account, onConnect }: { account: WalletAccount | undefined; onConnect: (wallet: Wallet, account: WalletAccount) => void }) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => setWallets(installedWallets()), []);

  if (account !== undefined) return <p>Connected: <Mono>{account.address}</Mono></p>;
  if (wallets.length === 0) {
    return (
      <Alert tone="neutral" title="No Solana wallet found in this browser">
        Install Phantom or Solflare, switch it to <strong>devnet</strong> (testnet mode), and get devnet SOL and devnet USDC from{' '}
        <ExternalLink href="https://faucet.solana.com">faucet.solana.com</ExternalLink> and{' '}
        <ExternalLink href="https://faucet.circle.com">faucet.circle.com</ExternalLink>. Then reload this page.
      </Alert>
    );
  }
  return (
    <div className="stack-small">
      <div className="row">
        {wallets.map((wallet) => (
          <button
            key={wallet.name}
            type="button"
            className="button"
            onClick={() => connectWallet(wallet).then((a) => onConnect(wallet, a), (e: Error) => setError(e.message))}
          >
            <img src={wallet.icon} alt="" width={20} height={20} /> Connect {wallet.name}
          </button>
        ))}
      </div>
      <p className="muted small">Use a devnet-only wallet. This demo never asks for mainnet funds.</p>
      {error !== undefined && <Alert tone="bad" title="Could not connect">{error}</Alert>}
    </div>
  );
}

function PaymentSummary({ payment }: { payment: Payment }) {
  const option = payment.accepts[0];
  return (
    <dl className="fields">
      <Field label="Amount">{formatAmount(payment.amount)} in devnet USDC</Field>
      {option !== undefined && (
        <Field label="Paid to">
          <ul className="plain">
            {option.pay_to.map((p) => (
              <li key={p.role}>
                {p.role === 'rights_holder' ? 'Rights holder' : 'Operator fee'}: {(Number(p.amount) / 1e6).toFixed(2)} USDC to <Mono>{shortHash(p.wallet)}</Mono>
              </li>
            ))}
          </ul>
        </Field>
      )}
      {option !== undefined && (
        <Field label="Memo (commitment)">
          <Mono>{option.memo}</Mono>
        </Field>
      )}
      {payment.expires_at !== undefined && <Field label="Expires">{new Date(payment.expires_at).toLocaleTimeString()}</Field>}
    </dl>
  );
}

function StampPanel({ token }: { token: Token }) {
  const [source, setSource] = useState<{ blob: Blob; name: string; url: string }>();
  const [mode, setMode] = useState<'embedded' | 'sidecar'>('embedded');
  const [result, setResult] = useState<{ url: string; name: string; sha256: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const generate = async () => {
    const blob = await placeholderImage(Math.floor(Math.random() * 1000));
    setSource({ blob, name: 'grantmark-placeholder.png', url: URL.createObjectURL(blob) });
    setResult(undefined);
  };

  const stamp = async () => {
    if (source === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const { blob, sha256 } = await api.stamp(token.licenseId, token.token, source.blob, source.name, mode);
      const name = mode === 'sidecar' ? source.name.replace(/\.\w+$/, '.c2pa') : source.name.replace(/(\.\w+)$/, '-stamped$1');
      setResult({ url: URL.createObjectURL(blob), name, sha256 });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="4. Stamp an image">
      <p>
        Grantmark signs a C2PA manifest with a <Mono>cawg.consent</Mono> assertion that points to the public record of license{' '}
        <Mono>{token.licenseId}</Mono>. Signed with test certificates, so outside Grantmark it shows as an unknown signer.
      </p>
      <div className="row">
        <button type="button" className="button" onClick={() => void generate()}>
          Generate a placeholder image
        </button>
        <label className="button secondary">
          Upload PNG, JPEG or WebP
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="visually-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) {
                setSource({ blob: file, name: file.name, url: URL.createObjectURL(file) });
                setResult(undefined);
              }
            }}
          />
        </label>
      </div>
      {source !== undefined && (
        <>
          <img className="preview" src={source.url} alt="The image to stamp" />
          <fieldset className="row">
            <legend>Manifest</legend>
            <label>
              <input type="radio" name="mode" checked={mode === 'embedded'} onChange={() => setMode('embedded')} /> Embedded in the image
            </label>
            <label>
              <input type="radio" name="mode" checked={mode === 'sidecar'} onChange={() => setMode('sidecar')} /> Separate .c2pa file
            </label>
          </fieldset>
          <button type="button" className="button primary" disabled={busy} onClick={() => void stamp()}>
            {busy ? 'Stamping…' : 'Stamp with Content Credentials'}
          </button>
        </>
      )}
      {error !== undefined && <Alert tone="bad" title="Stamping refused">{error}</Alert>}
      {result !== undefined && (
        <Alert tone="good" title="Stamped">
          <p>
            <a className="button small" href={result.url} download={result.name}>
              Download {result.name}
            </a>{' '}
            <a href={href('verify', { license: token.licenseId })}>Verify it</a>
          </p>
          <p className="small">
            Asset SHA-256: <Mono>{result.sha256}</Mono>
          </p>
        </Alert>
      )}
    </Card>
  );
}

export function Studio({ initialHcrn, initialLicense }: { initialHcrn: string | null; initialLicense: number | null }) {
  const [personas, setPersonas] = useState<Persona[]>();
  const [hcrn, setHcrn] = useState(initialHcrn ?? 'HCRN-0000-0068-F');
  const [license, setLicense] = useState(initialLicense ?? 1);
  const [scopes, setScopes] = useState<string[]>([]);
  const [wallet, setWallet] = useState<{ wallet: Wallet; account: WalletAccount }>();
  const [outcome, setOutcome] = useState<LicenseOutcome>();
  const [signature, setSignature] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.personas().then(setPersonas, () => setPersonas([]));
  }, []);

  const choice = useMemo(() => {
    for (const persona of personas ?? []) {
      const declaration = persona.declarations.find((d) => d.hcrn === hcrn);
      if (declaration !== undefined) return { persona, declaration, offer: declaration.offers.find((o) => o.license === license) };
    }
    return undefined;
  }, [personas, hcrn, license]);
  const available = choice?.declaration.subject_scope ?? ['image', 'likeness'];

  // A new offer starts a new request; image generation needs the image scope when there is one.
  useEffect(() => {
    setScopes(available.includes('image') ? ['image'] : available.slice(0, 1));
    setOutcome(undefined);
    setSignature(undefined);
    setStatus(undefined);
  }, [hcrn, license, available.join(' ')]);

  const request = async (extra: { payer?: string; payment_id?: string; payment_evidence?: string } = {}) =>
    api.requestLicense({ hcrn, license, ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}), ...extra });

  const requestLicense = async () => {
    setBusy(true);
    setSignature(undefined);
    setStatus(undefined);
    setOutcome(await request(wallet === undefined ? {} : { payer: wallet.account.address }));
    setBusy(false);
  };

  const pay = async (payment: Payment) => {
    const option = payment.accepts[0];
    if (wallet === undefined || option === undefined || payment.id === undefined) return;
    setBusy(true);
    try {
      setStatus('Waiting for your wallet…');
      const sent = await signAndSendTransaction(wallet.wallet, wallet.account, option.transaction);
      setSignature(sent);
      for (let attempt = 0; attempt < 40; attempt++) {
        setStatus(attempt === 0 ? 'Payment sent. Waiting for finalization on devnet (about 15 seconds)…' : `Waiting for finalization… (${attempt})`);
        const next = await request({ payment_id: payment.id, payment_evidence: sent });
        if (next.kind !== 'payment_required' || next.payment.status === 'failed' || next.payment.status === 'expired') {
          setOutcome(next);
          break;
        }
        await sleep(3000);
      }
    } catch (e) {
      setStatus(`The wallet did not send the payment: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <header className="page-header">
        <h1>Studio</h1>
        <p className="lead">
          License a person&apos;s likeness through the OLP-HCS prototype, pay the rights holder in devnet USDC, and stamp the output. The demo studio is a
          fictional OLP client; its requests run on the server so no client secret reaches your browser.
        </p>
      </header>

      <Card title="1. Choose an offer">
        <div className="row">
          <label>
            Declaration{' '}
            <select value={hcrn} onChange={(e) => { setHcrn(e.target.value); setLicense(1); }}>
              {(personas ?? []).flatMap((p) =>
                p.declarations.map((d) => (
                  <option key={d.hcrn} value={d.hcrn}>
                    {p.name} · {d.hcrn}
                  </option>
                )),
              )}
            </select>
          </label>
          <label>
            Offer{' '}
            <select value={license} onChange={(e) => setLicense(Number(e.target.value))}>
              {(choice?.declaration.offers ?? []).map((o) => (
                <option key={o.license} value={o.license}>
                  #{o.license} · {o.usage.map(usageLabel).join(', ') || 'no usage'} · {o.user?.join(', ') ?? 'anyone'} · {formatAmount(o.amount)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="row">
          <legend>Rights scopes this use needs</legend>
          {available.map((scope) => (
            <label key={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={(e) => setScopes(e.target.checked ? [...scopes, scope] : scopes.filter((s) => s !== scope))}
              />{' '}
              {scope}
            </label>
          ))}
        </fieldset>
        {choice !== undefined && (
          <p className="small muted">
            Rights holder: {choice.persona.name} (fictional). License server: {choice.declaration.server ?? 'none named'}.{' '}
            <a href={href('people', { hcsi: choice.persona.hcsi })}>See the declaration</a>
          </p>
        )}
      </Card>

      <Card title="2. Connect a devnet wallet">
        <WalletPicker account={wallet?.account} onConnect={(w, account) => setWallet({ wallet: w, account })} />
      </Card>

      <Card title="3. Request the license">
        <button type="button" className="button primary" disabled={busy || scopes.length === 0} onClick={() => void requestLicense()}>
          Request license
        </button>
        {outcome?.kind === 'error' && (
          <Alert tone="bad" title={outcome.reasonCode === 'minor_protection' ? 'Refused: minor protection' : 'Refused'}>
            {outcome.description}
          </Alert>
        )}
        {outcome?.kind === 'payment_required' && (
          <div className="stack-small">
            <Alert tone="warn" title={outcome.payment.status === 'failed' ? 'Payment failed' : outcome.payment.status === 'expired' ? 'Payment expired' : 'Payment required'}>
              {outcome.payment.reason ?? outcome.description}
            </Alert>
            <PaymentSummary payment={outcome.payment} />
            {outcome.payment.accepts.length > 0 && outcome.payment.status === 'requires_payment' && (
              <button type="button" className="button primary" disabled={busy || wallet === undefined} onClick={() => void pay(outcome.payment)}>
                Pay {formatAmount(outcome.payment.amount)} with {wallet?.wallet.name ?? 'your wallet'}
              </button>
            )}
          </div>
        )}
        {status !== undefined && <p className="muted" role="status">{status}</p>}
        {signature !== undefined && (
          <p className="small">
            Transaction: <ExternalLink href={explorer(signature)}>{shortHash(signature)}</ExternalLink>
          </p>
        )}
        {outcome?.kind === 'token' && (
          <Alert tone="good" title="Licensed">
            <p>
              License <a href={href('verify', { license: outcome.licenseId })}><Mono>{outcome.licenseId}</Mono></a> for{' '}
              {outcome.subjectScope.split(' ').map((s) => <Chip key={s}>{s}</Chip>)}, valid for {Math.round(outcome.expiresIn / 86400)} days.
            </p>
            {Object.entries(outcome.excludedScope).map(([scope, reason]) => (
              <p key={scope} className="small">
                Not licensed: <strong>{scope}</strong>. {reason}
              </p>
            ))}
          </Alert>
        )}
      </Card>

      {outcome?.kind === 'token' && <StampPanel token={outcome} />}
    </div>
  );
}
