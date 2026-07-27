'use client';

import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { formatCurrency } from '@/lib/constants';
import type { SplitExpenseBankLink } from '@/types';

/** 'YYYY-MM-DD' → a readable date (never UTC parsing — the day must not shift). */
function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

interface BankLinkDetailsDialogProps {
  visible: boolean;
  onHide: () => void;
  bankLink: SplitExpenseBankLink;
  memberName: string;
}

/**
 * Display-only "where did this come from" popup for a split expense created
 * via another member's "Split this" (bank/page.tsx). The viewer has no access
 * to that member's bank data, so this shows the denormalized `bankLink`
 * fields instead of deep-linking into /bank.
 */
export function BankLinkDetailsDialog({ visible, onHide, bankLink, memberName }: BankLinkDetailsDialogProps) {
  const row = (label: string, value: string) => (
    <div className="flex gap-3 py-1.5">
      <span className="w-24 shrink-0 text-sm opacity-60">{label}</span>
      <span className="text-sm break-words">{value}</span>
    </div>
  );

  return (
    <Dialog
      header="Linked bank transaction"
      visible={visible}
      onHide={onHide}
      modal
      dismissableMask
      style={{ width: '28rem' }}
    >
      <div className="flex flex-col divide-y divide-gray-100 dark:divide-gray-800">
        {row('From', `${memberName}'s bank${bankLink.bankName ? ` · ${bankLink.bankName}` : ''}`)}
        {row('Date', formatIsoDate(bankLink.bookingDate))}
        {row('Amount', formatCurrency(bankLink.amount, bankLink.currency))}
        {row('Counterparty', bankLink.counterpartyName ?? '—')}
      </div>
      <div className="flex justify-end pt-3">
        <Button label="Close" outlined size="small" onClick={onHide} />
      </div>
    </Dialog>
  );
}
