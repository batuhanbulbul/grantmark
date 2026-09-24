import { useEffect, useState } from 'react';
import { api, type Verification } from '../api';
import { Alert, Badge, Card, Chip, ExternalLink, Field, Mono, VerdictCard } from '../components';
import { formatAmount, shortHash, usageLabel } from '../format';

function Details({ result }: { result: Verification }) {
  const { manifest, license, receipt, payment, asset } = result;
  return (
    <div className="grid">
      {manifest !== undefined && (
        <Card title="Content Credentials (C2PA)">
          <dl className="fields">
            <Field label="Manifest">
              {manifest.found ? (manifest.embedded ? 'Embedded in the image' : 'Separate .c2pa file') : 'None found'}
            </Field>
            {manifest.found && (
              <Field label="Signature">
                <Badge tone={manifest.trusted ? 'good' : manifest.validation_state === 'Valid' ? 'warn' : 'bad'}>{manifest.trust ?? '—'}</Badge>
              </Field>
            )}
            {manifest.signer !== null && <Field label="Signer">{manifest.signer.commonName ?? manifest.signer.issuer ?? '—'}</Field>}
            {manifest.digital_source_type !== null && (
              <Field label="Source type">{manifest.digital_source_type.endsWith('trainedAlgorithmicMedia') ? 'AI generated (trainedAlgorithmicMedia)' : manifest.digital_source_type}</Field>
            )}
            {manifest.failures.length > 0 && <Field label="Validation codes">{manifest.failures.map((f) => <Chip key={f}>{f}</Chip>)}</Field>}
          </dl>
          {(result.consent_references ?? []).length > 0 && (
            <>
              <h4>cawg.consent references</h4>
              <ul className="plain">
                {result.consent_references!.map((r) => (
                  <li key={r.uri}>
                    <ExternalLink href={r.uri}>{r.uri}</ExternalLink> <span className="muted small">({r.reference_type}, {r.consent_domain})</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}
      {license !== null && (
        <Card title="License record">
          <dl className="fields">
            <Field label="License">
              <Mono>{license.license_id}</Mono> <Badge tone={license.status === 'active' ? 'good' : 'warn'}>{license.status}</Badge>
            </Field>
            <Field label="New uses now">
              {license.current_permission.permitted ? <Badge tone="good">Permitted</Badge> : <Badge tone="bad">Not permitted</Badge>}
              {license.current_permission.reason !== undefined && <p className="small">{license.current_permission.reason}</p>}
            </Field>
            <Field label="Rights subject">
              {license.declaring_party.rights_subject.name ?? '—'} <Mono>{license.declaring_party.rights_subject.hcsi}</Mono>
            </Field>
            <Field label="Declaration">
              <ExternalLink href={license.declaring_party.declaration_url}>{license.declaring_party.hcrn}</ExternalLink>
            </Field>
            <Field label="Grant">
              {license.grant.usage.map(usageLabel).join(', ')} · {license.grant.subject_scope.map((s) => <Chip key={s}>{s}</Chip>)}
            </Field>
            <Field label="Term">
              {new Date(license.term.valid_from).toLocaleDateString()} – {new Date(license.term.valid_until).toLocaleDateString()}
            </Field>
            <Field label="Compensation">{formatAmount(license.compensation.amount)}</Field>
          </dl>
          <p className="small muted">{license.revocability}</p>
        </Card>
      )}
      <Card title="Receipt and payment">
        <dl className="fields">
          <Field label="Receipt">
            {!receipt.present ? 'None' : receipt.valid ? <Badge tone="good">Signature valid</Badge> : <Badge tone="bad">Does not verify</Badge>}
          </Field>
          <Field label="On-chain payment">
            {payment.on_chain === 'verified' && <Badge tone="good">Verified on devnet</Badge>}
            {payment.on_chain === 'none' && 'No payment (free license)'}
            {payment.on_chain !== 'verified' && payment.on_chain !== 'none' && <Badge tone="warn">{payment.on_chain.replace('_', ' ')}</Badge>}
            {payment.explorer_url !== undefined && payment.transaction_signature !== undefined && (
              <p className="small">
                <ExternalLink href={payment.explorer_url}>{shortHash(payment.transaction_signature)} on Solana Explorer</ExternalLink>
              </p>
            )}
          </Field>
          {asset !== undefined && (
            <Field label="Image hash">
              <Mono>{shortHash(asset.sha256)}</Mono> {asset.registered ? <Badge tone="good">Registered when stamped</Badge> : <Badge tone="neutral">Not registered</Badge>}
            </Field>
          )}
        </dl>
      </Card>
    </div>
  );
}

export function Verify({ initialLicense }: { initialLicense: string | null }) {
  const [image, setImage] = useState<File>();
  const [manifest, setManifest] = useState<File>();
  const [licenseId, setLicenseId] = useState(initialLicense ?? '');
  const [result, setResult] = useState<Verification>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (check: () => Promise<Verification>) => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await check());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialLicense !== null) void run(() => api.verifyLicense(initialLicense));
  }, [initialLicense]);

  return (
    <div className="stack">
      <header className="page-header">
        <h1>Verify</h1>
        <p className="lead">
          Check an image&apos;s Content Credentials, the license they point to, and the payment behind it, re-read live from Solana devnet. Anyone can use this
          page; it grants nothing.
        </p>
      </header>
      <div className="grid">
        <Card title="Check an image">
          <form
            className="stack-small"
            onSubmit={(e) => {
              e.preventDefault();
              if (image !== undefined) void run(() => api.verifyImage(image, manifest));
            }}
          >
            <label>
              Image (PNG, JPEG or WebP)
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setImage(e.target.files?.[0])} />
            </label>
            <label>
              Separate .c2pa manifest (optional)
              <input type="file" accept=".c2pa,application/c2pa" onChange={(e) => setManifest(e.target.files?.[0])} />
            </label>
            <button type="submit" className="button primary" disabled={busy || image === undefined}>
              Verify image
            </button>
          </form>
        </Card>
        <Card title="Look up a license">
          <form
            className="stack-small"
            onSubmit={(e) => {
              e.preventDefault();
              if (licenseId.trim() !== '') void run(() => api.verifyLicense(licenseId.trim()));
            }}
          >
            <label>
              License ID
              <input type="text" value={licenseId} placeholder="lic_…" onChange={(e) => setLicenseId(e.target.value)} />
            </label>
            <button type="submit" className="button" disabled={busy || licenseId.trim() === ''}>
              Look up
            </button>
          </form>
        </Card>
      </div>
      {busy && <p className="muted" role="status">Checking…</p>}
      {error !== undefined && <Alert tone="bad" title="Could not verify">{error}</Alert>}
      {result !== undefined && (
        <>
          <VerdictCard verdict={result.verdict} />
          <Details result={result} />
        </>
      )}
    </div>
  );
}
