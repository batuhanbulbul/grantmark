export type Decision = 'permitted' | 'permitted_with_terms' | 'prohibited' | 'not_determinable';

export type VerdictStatus =
  | 'licensed'
  | 'licensed_before_change'
  | 'expired'
  | 'revoked'
  | 'tampered'
  | 'no_credentials'
  | 'unknown_authority'
  | 'unknown_license';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/** The Human Consent Registry's three signals, plus "no permission" for silence (HCS §1.2). */
export function decisionLabel(decision: Decision): string {
  return {
    permitted: 'Permitted',
    permitted_with_terms: 'Permitted with terms',
    prohibited: 'Prohibited',
    not_determinable: 'No permission',
  }[decision];
}

export function decisionTone(decision: Decision): Tone {
  return { permitted: 'good', permitted_with_terms: 'warn', prohibited: 'bad', not_determinable: 'neutral' }[decision] as Tone;
}

export function verdictLabel(status: VerdictStatus): string {
  return {
    licensed: 'Licensed',
    licensed_before_change: 'Licensed before a change',
    expired: 'License expired',
    revoked: 'License revoked',
    tampered: 'Changed after stamping',
    no_credentials: 'No Content Credentials',
    unknown_authority: 'Unknown consent authority',
    unknown_license: 'Unknown license',
  }[status];
}

export function verdictTone(status: VerdictStatus): Tone {
  if (status === 'licensed') return 'good';
  if (status === 'licensed_before_change' || status === 'expired') return 'warn';
  if (status === 'tampered' || status === 'revoked') return 'bad';
  return 'neutral';
}

export function usageLabel(token: string): string {
  return token === 'hcs:ai-generate' ? 'AI generation' : token === 'hcs:ai-train' ? 'AI training' : token;
}

export function formatAmount(amount: { value: string; currency: string } | null | undefined): string {
  if (amount === null || amount === undefined) return 'Free';
  const value = Number(amount.value).toFixed(2);
  return amount.currency === 'USD' ? `$${value}` : `${value} ${amount.currency}`;
}

export function shortHash(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}
