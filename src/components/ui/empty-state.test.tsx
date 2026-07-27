// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('renders title and body', () => {
    renderWithProviders(<EmptyState title="No expenses yet" body="Add one above." />);
    expect(screen.getByText('No expenses yet')).toBeInTheDocument();
    expect(screen.getByText('Add one above.')).toBeInTheDocument();
  });

  it('fires the action', () => {
    const onClick = vi.fn();
    renderWithProviders(
      <EmptyState title="Nothing this month" action={{ label: 'Load older months', onClick }} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load older months' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders without body or action', () => {
    renderWithProviders(<EmptyState title="Empty" />);
    expect(screen.getByText('Empty')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
