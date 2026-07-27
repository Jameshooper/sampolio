// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { formatCents } from '@/lib/constants';
import { SplitEditor, emptyDraft, type SplitDraft } from './split-editor';
import type { SplitGroupMember } from '@/types';

// Build expectations from the app's own formatter, collapsed the same way
// testing-library's default normalizer collapses NBSP/whitespace.
const cents = (n: number) => formatCents(n, 'EUR').replace(/\s+/g, ' ');


const members: SplitGroupMember[] = [
  { userId: 'u1', email: 'alex@example.com', name: 'Alex', role: 'owner' },
  { userId: 'u2', email: 'sam@example.com', name: 'Sam', role: 'member' },
];

/** Stateful harness so the editor behaves like it does inside the dialogs. */
function Harness({ amountCents = 10000 }: { amountCents?: number }) {
  const [draft, setDraft] = useState<SplitDraft>(() => emptyDraft('u1'));
  return (
    <SplitEditor
      members={members}
      myId="u1"
      currency="EUR"
      amountCents={amountCents}
      value={draft}
      onChange={setDraft}
    />
  );
}

describe('SplitEditor', () => {
  it('renders the split-mode preset options with a live preview', () => {
    renderWithProviders(<Harness />);

    expect(screen.getByRole('button', { name: 'You paid, split equally' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "You paid, you're owed in full" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sam paid, split equally' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sam is owed in full' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom split…' })).toBeInTheDocument();

    // Default preset (me-equal) previews an even split of the 100 € total
    expect(screen.getByText(`Sam owes you ${cents(5000)}`)).toBeInTheDocument();
  });

  it('auto-fills the other member when one custom amount is entered', async () => {
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom split…' }));
    fireEvent.click(screen.getByText('Amounts'));

    // Both fields blank → each placeholder shows the even auto-split
    const inputs = await screen.findAllByPlaceholderText(cents(5000));
    expect(inputs).toHaveLength(2);

    // Type 40 for "You" and commit (PrimeReact InputNumber commits on blur)
    fireEvent.change(inputs[0], { target: { value: '40' } });
    fireEvent.blur(inputs[0]);

    // The untouched member absorbs the remainder: 100 − 40 = 60
    expect(await screen.findByPlaceholderText(cents(6000))).toBeInTheDocument();
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    // You paid 100 and owe 40 → Sam owes you 60
    expect(screen.getByText(`Sam owes you ${cents(6000)}`)).toBeInTheDocument();
  });

  it('shows an even split in custom equal mode', async () => {
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom split…' }));

    // Custom defaults to "Equally"
    expect(
      await screen.findByText('Split equally between all 2 members.')
    ).toBeInTheDocument();
    expect(screen.getByText(`Sam owes you ${cents(5000)}`)).toBeInTheDocument();
  });
});
