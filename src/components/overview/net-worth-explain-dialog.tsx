'use client';

import { Dialog } from 'primereact/dialog';
import { useTheme } from '@/components/providers/theme-provider';
import { formatCurrency } from '@/lib/constants';
import type { Currency } from '@/types';

export interface NetWorthExplainValues {
    cashTotal: number;
    investmentsTotal: number;
    receivablesTotal: number;
    mortgageEquity: number;
    splitNetTotal: number;
    debtsTotal: number;
    cardLiabilitiesTotal: number;
    netWorth: number;
}

interface NetWorthExplainDialogProps {
    visible: boolean;
    onHide: () => void;
    values: NetWorthExplainValues;
    currency: Currency;
}

/**
 * Plain-words breakdown of the net-worth number, opened by tapping the
 * Net Worth KPI on Overview. Display-only: rows mirror exactly the terms of
 * the net-worth sum computed on the page (cash + investments + receivables
 * + home equity ± split − debts − cards), so the rows always add up to the
 * headline number.
 */
export function NetWorthExplainDialog({ visible, onHide, values, currency }: NetWorthExplainDialogProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';

    const rows: { label: string; amount: number; show: boolean }[] = [
        { label: 'Money in your accounts', amount: values.cashTotal, show: true },
        { label: 'Your investments', amount: values.investmentsTotal, show: values.investmentsTotal !== 0 },
        { label: 'Money others owe you', amount: values.receivablesTotal, show: values.receivablesTotal !== 0 },
        { label: 'Your share of the home (after the mortgage)', amount: values.mortgageEquity, show: values.mortgageEquity !== 0 },
        { label: values.splitNetTotal >= 0 ? 'Shared expenses others still owe you' : 'Shared expenses you still owe', amount: values.splitNetTotal, show: values.splitNetTotal !== 0 },
        { label: 'Debts you are paying off', amount: -values.debtsTotal, show: values.debtsTotal !== 0 },
        { label: 'What you owe on credit cards', amount: -values.cardLiabilitiesTotal, show: values.cardLiabilitiesTotal !== 0 },
    ];

    const mutedText = isDark ? 'text-gray-400' : 'text-gray-500';
    const strongText = isDark ? 'text-gray-100' : 'text-gray-900';

    return (
        <Dialog
            header="What does this number mean?"
            visible={visible}
            onHide={onHide}
            dismissableMask
            className="w-full max-w-lg"
        >
            <p className={`mb-4 ${mutedText}`}>
                Your net worth is everything you own minus everything you owe. Right now that adds up like this:
            </p>
            <ul className="space-y-2">
                {rows.filter((r) => r.show).map((r) => (
                    <li key={r.label} className="flex items-center justify-between gap-4">
                        <span className={mutedText}>{r.label}</span>
                        <span className={`font-medium whitespace-nowrap ${r.amount >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                            {r.amount >= 0 ? '+' : '−'}{formatCurrency(Math.abs(r.amount), currency)}
                        </span>
                    </li>
                ))}
            </ul>
            <div className={`flex items-center justify-between gap-4 mt-4 pt-3 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
                <span className={`font-semibold ${strongText}`}>What you own overall</span>
                <span className={`font-bold text-lg whitespace-nowrap ${strongText}`}>
                    {formatCurrency(values.netWorth, currency)}
                </span>
            </div>
            <p className={`mt-4 text-sm ${mutedText}`}>
                This number goes up when you save, invest, or pay off debt — and down when you spend more than you earn.
            </p>
        </Dialog>
    );
}
