import { useEffect, useState } from 'react';
import { api, type Evaluation, type Persona, type PersonaDeclaration } from '../api';
import { Alert, Badge, Card, Chip, DecisionBadge, ExternalLink, Field, Mono } from '../components';
import { formatAmount, usageLabel } from '../format';
import { href } from '../router';

const USAGES = ['hcs:ai-generate', 'hcs:ai-train'] as const;

function DeclarationXml({ url }: { url: string }) {
  const [xml, setXml] = useState<string>();
  return (
    <details
      className="xml"
      onToggle={(event) => {
        if ((event.target as HTMLDetailsElement).open && xml === undefined) {
          fetch(url).then((r) => r.text()).then(setXml, () => setXml('Could not load the declaration.'));
        }
      }}
    >
      <summary>Show the HCS declaration (XML)</summary>
      <pre>{xml ?? 'Loading…'}</pre>
    </details>
  );
}

function DeclarationCard({ declaration }: { declaration: PersonaDeclaration }) {
  const withdrawn = declaration.status !== undefined && declaration.status !== 'active';
  return (
    <Card
      title={<Mono>{declaration.hcrn}</Mono>}
      actions={<Badge tone={withdrawn ? 'bad' : 'good'}>{declaration.status ?? 'unknown'}</Badge>}
    >
      <dl className="fields">
        <Field label="Registry">{declaration.registry}</Field>
        <Field label="Rights scope">
          {declaration.subject_scope === null ? 'Every scope' : declaration.subject_scope.map((s) => <Chip key={s}>{s}</Chip>)}
        </Field>
        <Field label="Territory">{declaration.territory === null ? 'Worldwide' : declaration.territory.join(', ')}</Field>
        <Field label="License server">{declaration.server ?? 'None named'}</Field>
      </dl>
      <table className="offers">
        <caption>License offers in this declaration</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Permits</th>
            <th scope="col">Prohibits</th>
            <th scope="col">Licensee</th>
            <th scope="col">Price</th>
            <th scope="col">
              <span className="visually-hidden">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {declaration.offers.map((offer) => (
            <tr key={offer.license}>
              <td>{offer.license}</td>
              <td>{offer.usage.map(usageLabel).join(', ') || '—'}</td>
              <td>{offer.prohibits.map(usageLabel).join(', ') || '—'}</td>
              <td>{offer.user?.join(', ') ?? 'Anyone'}</td>
              <td>{offer.usage.length === 0 ? '—' : formatAmount(offer.amount)}</td>
              <td>
                {offer.usage.length > 0 && !withdrawn && (
                  <a className="button small" href={href('studio', { hcrn: declaration.hcrn, license: offer.license })}>
                    License this
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <DeclarationXml url={declaration.url} />
    </Card>
  );
}

function EvaluationPanel({ persona }: { persona: Persona }) {
  const [usage, setUsage] = useState<(typeof USAGES)[number]>('hcs:ai-generate');
  const [evaluation, setEvaluation] = useState<Evaluation>();
  const [error, setError] = useState<string>();
  const scopes = [...new Set(persona.declarations.flatMap((d) => d.subject_scope ?? ['image', 'likeness']))];

  useEffect(() => {
    setEvaluation(undefined);
    setError(undefined);
    api.evaluate({ subject: persona.hcsi, usage, scopes }).then(setEvaluation, (e: Error) => setError(e.message));
  }, [persona.hcsi, usage]);

  return (
    <Card
      title="What an AI system may do"
      actions={
        <div className="segmented" role="group" aria-label="Usage">
          {USAGES.map((u) => (
            <button key={u} type="button" aria-pressed={usage === u} onClick={() => setUsage(u)}>
              {usageLabel(u)}
            </button>
          ))}
        </div>
      }
    >
      {error !== undefined && <Alert tone="bad" title="Evaluation failed">{error}</Alert>}
      {evaluation === undefined && error === undefined && <p className="muted">Evaluating…</p>}
      {evaluation !== undefined && (
        <>
          <p className="decision-line">
            <DecisionBadge decision={evaluation.decision} /> for {usageLabel(usage).toLowerCase()} of {scopes.join(' and ')}
          </p>
          {evaluation.minorProtectionApplied && (
            <Alert tone="bad" title="Minor protection (HCS §1.1)">
              No permission, payment or license server path is operative for this person. Grantmark refuses every license request, payment and stamp.
            </Alert>
          )}
          <ul className="scope-list">
            {evaluation.scopes.map((scope) => (
              <li key={scope.scope}>
                <span className="scope-name">{scope.scope}</span>
                <DecisionBadge decision={scope.decision} />
                {scope.conflict && <Chip>conflict</Chip>}
                <p>{scope.explanation}</p>
              </li>
            ))}
          </ul>
          {evaluation.declarations
            .filter((d) => !d.operative)
            .map((d) => (
              <Alert key={d.hcrn ?? 'unknown'} tone="warn" title={`${d.hcrn ?? 'A declaration'} is not operative`}>
                <ul>
                  {d.reasons.map((r) => (
                    <li key={r.code + r.at}>
                      {r.message} <span className="muted">({r.rule})</span>
                    </li>
                  ))}
                </ul>
              </Alert>
            ))}
        </>
      )}
    </Card>
  );
}

export function People({ selected }: { selected: string | null }) {
  const [personas, setPersonas] = useState<Persona[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.personas().then(setPersonas, (e: Error) => setError(e.message));
  }, []);

  if (error !== undefined) return <Alert tone="bad" title="Could not load the personas">{error}</Alert>;
  if (personas === undefined) return <p className="muted">Loading…</p>;
  const persona = personas.find((p) => p.hcsi === selected) ?? personas[0];

  return (
    <div className="split">
      <nav className="persona-list" aria-label="Fictional people">
        <h2>Fictional people</h2>
        <p className="muted small">Each person published a declaration in a mock HCS registry. None of them is real.</p>
        <ul>
          {personas.map((p) => (
            <li key={p.hcsi}>
              <a href={href('people', { hcsi: p.hcsi })} aria-current={p.hcsi === persona?.hcsi ? 'page' : undefined}>
                <strong>{p.name}</strong>
                <span className="muted small">
                  {p.declarations.length} declaration{p.declarations.length === 1 ? '' : 's'}
                  {p.age_status === 'minor' ? ' · minor' : ''}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {persona !== undefined && (
        <div className="stack">
          <header className="page-header">
            <h1>{persona.name}</h1>
            <p>
              {persona.fictional && <Chip>Fictional</Chip>}{' '}
              <Chip>{persona.age_status === 'adult' ? 'Adult' : persona.age_status === 'minor' ? 'Minor' : 'Age unknown'}</Chip>{' '}
              <Mono>{persona.hcsi}</Mono> · <ExternalLink href={persona.record_url}>Rights Subject Record</ExternalLink>
            </p>
          </header>
          <EvaluationPanel persona={persona} />
          {persona.declarations.map((d) => (
            <DeclarationCard key={d.hcrn} declaration={d} />
          ))}
        </div>
      )}
    </div>
  );
}
