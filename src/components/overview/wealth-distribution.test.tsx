// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { formatCurrency } from '@/lib/constants';

// The component pulls the shared WEALTH_COLORS map from wealth-chart.tsx, which
// transitively imports AppLayout (and therefore next-auth) — stub it out, the
// same way the other component suites do.
vi.mock('@/components/layout/app-layout', () => ({
  useAppContext: () => null,
}));

import { WealthDistribution } from './wealth-distribution';

// testing-library's default normalizer collapses NBSP/narrow-NBSP (fi-FI
// number formatting) to plain spaces — normalize expectations the same way.
const eur = (n: number) => formatCurrency(n, 'EUR').replace(/\s+/g, ' ');

const ZERO = {
  cashTotal: 0,
  investmentsTotal: 0,
  receivablesTotal: 0,
  mortgageEquity: 0,
  splitNetTotal: 0,
  debtsTotal: 0,
  cardLiabilitiesTotal: 0,
  netWorth: 0,
};

function renderBar(overrides: Partial<typeof ZERO> = {}, isSimple = false) {
  const values = { ...ZERO, ...overrides };
  return renderWithProviders(
    <WealthDistribution values={values} currency="EUR" isMixedCurrency={false} isSimple={isSimple} />
  );
}

/** The bar's own aria-label, which enumerates every rendered segment. */
const barLabel = () => screen.getByRole('img').getAttribute('aria-label') ?? '';

describe('WealthDistribution', () => {
  it('renders a segment per positive category and skips zero ones', () => {
    renderBar({ cashTotal: 6000, investmentsTotal: 4000, netWorth: 10000 });

    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('Investments')).toBeInTheDocument();
    // Receivables / home equity / split are all zero here.
    expect(screen.queryByText('Receivables')).not.toBeInTheDocument();
    expect(screen.queryByText('Home equity')).not.toBeInTheDocument();
    expect(screen.getByText(eur(6000))).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('omits a zero-investments legend row', () => {
    renderBar({ cashTotal: 1000, investmentsTotal: 0, netWorth: 1000 });
    expect(screen.queryByText('Investments')).not.toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('shares add up to ~100% across every segment', () => {
    renderBar({
      cashTotal: 1234.56,
      investmentsTotal: 7777.77,
      receivablesTotal: 333.33,
      mortgageEquity: 45678.9,
      splitNetTotal: 12.34,
      netWorth: 55036.9,
    });

    const percents = [...barLabel().matchAll(/(\d+)%/g)].map(m => Number(m[1]));
    expect(percents).toHaveLength(5);
    const sum = percents.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThanOrEqual(99);
    expect(sum).toBeLessThanOrEqual(101);
  });

  it('exposes the distribution as an accessible image label naming the categories', () => {
    renderBar({ cashTotal: 5000, mortgageEquity: 5000, netWorth: 10000 });
    const label = barLabel();
    expect(label).toContain('Wealth distribution:');
    expect(label).toContain('Cash 50%');
    expect(label).toContain('Home equity 50%');
  });

  it('uses plain-language labels in simple mode', () => {
    renderBar({ cashTotal: 5000, receivablesTotal: 5000, netWorth: 10000 }, true);
    expect(barLabel()).toContain('Where your wealth sits:');
    expect(screen.getByText('Money owed to you')).toBeInTheDocument();
  });

  it('renders nothing when there are no assets at all', () => {
    const { container } = renderBar({ debtsTotal: 500, netWorth: -500 });
    expect(container).toBeEmptyDOMElement();
  });

  it('adds the net-worth footer when there are debts or cards, and not otherwise', () => {
    const { unmount } = renderBar({
      cashTotal: 10000,
      debtsTotal: 2000,
      cardLiabilitiesTotal: 500,
      netWorth: 7500,
    });
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          (el.textContent ?? '').replace(/\s+/g, ' ').includes(`After ${eur(2500)} of debts and credit cards`)
      )
    ).toBeInTheDocument();
    unmount();

    renderBar({ cashTotal: 10000, netWorth: 10000 });
    expect(screen.queryByText(/After/)).not.toBeInTheDocument();
  });

  it('counts an owed split balance as a liability, never as a segment', () => {
    renderBar({ cashTotal: 1000, splitNetTotal: -250, netWorth: 750 });
    expect(barLabel()).not.toContain('Split balance');
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          (el.textContent ?? '').replace(/\s+/g, ' ').includes(`After ${eur(250)} of shared expenses`)
      )
    ).toBeInTheDocument();
  });

  it('shows the split segment only when the balance is owed to the user', () => {
    renderBar({ cashTotal: 1000, splitNetTotal: 1000, netWorth: 2000 });
    expect(barLabel()).toContain('Split balance 50%');
    expect(screen.getByText('Split balance')).toBeInTheDocument();
  });
});
