// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DecisionBadge, VerdictCard } from '../src/components';

afterEach(cleanup);

describe('DecisionBadge', () => {
  it('shows the decision with a tone for colour-blind-safe styling', () => {
    render(<DecisionBadge decision="prohibited" />);
    const badge = screen.getByText('Prohibited');
    expect(badge.className).toContain('tone-bad');
  });
});

describe('VerdictCard', () => {
  it('shows the verdict, summary and warnings', () => {
    render(
      <VerdictCard
        verdict={{ status: 'licensed', summary: 'Licensed under lic_1 for hcs:ai-generate (image).', warnings: ['The payment transaction could not be found on devnet.'] }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Licensed' })).toBeTruthy();
    expect(screen.getByText(/Licensed under lic_1/)).toBeTruthy();
    expect(screen.getByText(/could not be found on devnet/)).toBeTruthy();
  });
});
