import type { ReactNode } from 'react';
import { decisionLabel, decisionTone, verdictLabel, verdictTone, type Decision, type Tone, type VerdictStatus } from './format';

const TONE_ICON: Record<Tone, string> = { good: '✓', warn: '!', bad: '✕', neutral: '–' };

/** A status label that carries meaning in text and icon, not only colour. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`badge tone-${tone}`}>
      <span aria-hidden="true" className="badge-icon">
        {TONE_ICON[tone]}
      </span>
      {children}
    </span>
  );
}

export function DecisionBadge({ decision }: { decision: Decision }) {
  return <Badge tone={decisionTone(decision)}>{decisionLabel(decision)}</Badge>;
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title !== undefined || actions !== undefined) && (
        <header className="card-header">
          {title !== undefined && <h3>{title}</h3>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Alert({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) {
  return (
    <div className={`alert tone-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <strong>
        <span aria-hidden="true">{TONE_ICON[tone]} </span>
        {title}
      </strong>
      {children !== undefined && <div className="alert-body">{children}</div>}
    </div>
  );
}

export function VerdictCard({ verdict }: { verdict: { status: VerdictStatus; summary: string; warnings: string[] } }) {
  const tone = verdictTone(verdict.status);
  return (
    <section className={`verdict tone-${tone}`} aria-live="polite">
      <div className="verdict-icon" aria-hidden="true">
        {TONE_ICON[tone]}
      </div>
      <div>
        <h2>{verdictLabel(verdict.status)}</h2>
        <p>{verdict.summary}</p>
        {verdict.warnings.length > 0 && (
          <ul className="warnings">
            {verdict.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="mono">{children}</code>;
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}
