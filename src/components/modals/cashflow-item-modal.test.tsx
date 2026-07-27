// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { createMockAccount } from '@/test/mocks';
import { CashflowItemModal } from './cashflow-item-modal';

const ok = <T,>(data: T) => Promise.resolve({ success: true, data });

vi.mock('@/lib/actions/recurring', () => ({
  getRecurringItems: vi.fn(() => ok([])),
  createRecurringItem: vi.fn(() => ok({})),
  updateRecurringItem: vi.fn(() => ok({})),
  deleteRecurringItem: vi.fn(() => ok(undefined)),
}));
vi.mock('@/lib/actions/planned', () => ({
  getPlannedItems: vi.fn(() => ok([])),
  createPlannedItem: vi.fn(() => ok({})),
  updatePlannedItem: vi.fn(() => ok({})),
  deletePlannedItem: vi.fn(() => ok(undefined)),
}));
vi.mock('@/lib/actions/salary', () => ({
  getSalaryConfigs: vi.fn(() => ok([])),
  createSalaryConfig: vi.fn(() => ok({})),
  updateSalaryConfig: vi.fn(() => ok({})),
  deleteSalaryConfig: vi.fn(() => ok(undefined)),
}));
vi.mock('@/lib/actions/taxed-income', () => ({
  getTaxedIncomes: vi.fn(() => ok([])),
  createTaxedIncome: vi.fn(() => ok({})),
  updateTaxedIncome: vi.fn(() => ok({})),
  deleteTaxedIncome: vi.fn(() => ok(undefined)),
}));
vi.mock('@/lib/actions/user-preferences', () => ({
  getUserPreferences: vi.fn(() => ok({})),
}));
vi.mock('@/lib/actions/bank', () => ({
  getCreditCardOptions: vi.fn(() => ok([])),
}));
vi.mock('@/components/providers/toast-provider', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn() }),
}));

function renderModal(initialType: 'income' | 'expense' = 'expense') {
  const account = createMockAccount({ id: 'acc-1', name: 'Main Account' });
  return renderWithProviders(
    <CashflowItemModal
      visible
      onHide={vi.fn()}
      selectedAccountId="acc-1"
      accounts={[account]}
      onAccountChange={vi.fn()}
      initialType={initialType}
      initialRecurrence="recurring"
      autoOpenForm
    />
  );
}

describe('CashflowItemModal (quick-add create form)', () => {
  it('opens the create form with the essential fields and hides secondary ones', async () => {
    renderModal();
    // Form dialog header
    expect(await screen.findByText('Add Item')).toBeInTheDocument();

    // Essential fields
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('Recurrence')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Amount (EUR)')).toBeInTheDocument();
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByText('Frequency')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /More options/i })).toBeInTheDocument();

    // Secondary fields hidden behind "More options"
    expect(screen.queryByText('Start Month')).not.toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('reveals Start Month and Active after clicking More options', async () => {
    renderModal();
    const moreBtn = await screen.findByRole('button', { name: /More options/i });
    fireEvent.click(moreBtn);

    expect(await screen.findByText('Start Month')).toBeInTheDocument();
    expect(screen.getByText('End Month (opt)')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    // The button collapses once opened
    expect(screen.queryByRole('button', { name: /More options/i })).not.toBeInTheDocument();
  });

  it('auto-suggests the Entertainment category when the name is Netflix', async () => {
    renderModal();
    const nameInput = await screen.findByPlaceholderText(/Rent, Groceries, Netflix/);
    fireEvent.change(nameInput, { target: { value: 'Netflix' } });

    expect(await screen.findByText('(suggested)')).toBeInTheDocument();
    // The Category dropdown's selected label shows the auto-picked category
    // ('Entertainment' also exists in the option list, so scope to the label)
    const hits = screen.getAllByText('Entertainment');
    expect(hits.some((el) => el.className.includes('p-dropdown-label'))).toBe(true);
  });

  it('shows the Scheduled Month field when switching Recurrence to One-Off', async () => {
    renderModal();
    await screen.findByText('Add Item');
    expect(screen.queryByText('Scheduled Month')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('One-Off'));

    expect(await screen.findByText('Scheduled Month')).toBeInTheDocument();
    // Recurring-only field disappears
    expect(screen.queryByText('Frequency')).not.toBeInTheDocument();
  });

  it('offers the Gross income recurrence for income but not for expense', async () => {
    const { unmount } = renderModal('income');
    await screen.findByText('Add Item');
    expect(screen.getByText('Gross income')).toBeInTheDocument();
    unmount();

    renderModal('expense');
    await screen.findByText('Add Item');
    expect(screen.queryByText('Gross income')).not.toBeInTheDocument();
  });

  it('shows gross-amount, salary-settings toggle and a net preview for Gross income', async () => {
    renderModal('income');
    await screen.findByText('Add Item');

    fireEvent.click(screen.getByText('Gross income'));

    expect(await screen.findByText('Gross Amount (EUR)')).toBeInTheDocument();
    expect(screen.getByText(/Use my salary.s tax settings/)).toBeInTheDocument();
    expect(screen.getByText('Calculated Net')).toBeInTheDocument();
    // The recurring/one-off amount field is hidden for gross income
    expect(screen.queryByText('Amount (EUR)')).not.toBeInTheDocument();
  });
});
