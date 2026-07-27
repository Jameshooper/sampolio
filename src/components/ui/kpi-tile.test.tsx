// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { formatCurrency } from '@/lib/constants';
import { KpiTile } from './kpi-tile';

// testing-library's default normalizer collapses NBSP/narrow-NBSP (fi-FI
// number formatting) to plain spaces — normalize expectations the same way.
const eur = (n: number) => formatCurrency(n, 'EUR').replace(/\s+/g, ' ');

describe('KpiTile', () => {
  it('renders title and formatted value', () => {
    renderWithProviders(<KpiTile title="Net Worth" value={12345} icon={<span>€</span>} />);
    expect(screen.getByText('Net Worth')).toBeInTheDocument();
    expect(screen.getByText(eur(12345))).toBeInTheDocument();
  });

  it('shows a change badge for a non-zero delta', () => {
    renderWithProviders(
      <KpiTile title="Cash" value={100} change={250} changeLabel="vs last month" icon={<span />} />
    );
    expect(screen.getByText(`+${eur(250)}`)).toBeInTheDocument();
    expect(screen.getByText('vs last month')).toBeInTheDocument();
  });

  it('suppresses the badge for a zero delta and shows "unchanged"', () => {
    renderWithProviders(
      <KpiTile title="Cash" value={100} change={0} changeLabel="vs last month" icon={<span />} />
    );
    expect(screen.queryByText(`+${eur(0)}`)).not.toBeInTheDocument();
    expect(screen.getByText('unchanged vs last month')).toBeInTheDocument();
  });

  it('suppresses sub-1€ deltas too', () => {
    renderWithProviders(
      <KpiTile title="Cash" value={100} change={0.4} changeLabel="vs last month" icon={<span />} />
    );
    expect(screen.getByText('unchanged vs last month')).toBeInTheDocument();
  });

  it('renders subline and clamps the progress bar', () => {
    renderWithProviders(
      <KpiTile title="Credit cards" value={1000} subline="€3 500 available" progress={1.4} icon={<span />} />
    );
    expect(screen.getByText('€3 500 available')).toBeInTheDocument();
  });

  it('is keyboard-activatable when clickable', () => {
    const onClick = vi.fn();
    renderWithProviders(<KpiTile title="Cash" value={1} icon={<span />} onClick={onClick} />);
    const tile = screen.getByRole('button', { name: 'Cash: view details' });
    fireEvent.keyDown(tile, { key: 'Enter' });
    fireEvent.click(tile);
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});
