'use client';

import type { Debt } from '@/types';
import type { DebtPayoffInfo } from '@/lib/debt-utils';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import { useTheme } from '@/components/providers/theme-provider';

interface DebtProgressCardProps {
  debt: Debt;
  payoffInfo: DebtPayoffInfo;
  isSimpleMode?: boolean;
}

function getProgressColor(percentPaid: number, isDark: boolean): string {
  if (percentPaid > 50) {
    return isDark ? 'bg-green-500' : 'bg-green-500';
  }
  if (percentPaid >= 25) {
    return isDark ? 'bg-yellow-500' : 'bg-yellow-500';
  }
  return isDark ? 'bg-blue-400' : 'bg-blue-500';
}

function getProgressTrackColor(isDark: boolean): string {
  return isDark ? 'bg-neutral-700' : 'bg-neutral-200';
}

export function DebtProgressCard({ debt, payoffInfo, isSimpleMode }: DebtProgressCardProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const progressColor = getProgressColor(payoffInfo.percentPaid, isDark);
  const trackColor = getProgressTrackColor(isDark);

  const displayPercent = Math.round(payoffInfo.percentPaid * 10) / 10;

  return (
    <div
      className={`rounded-xl border p-4 ${
        isDark
          ? 'border-neutral-700 bg-neutral-800/50'
          : 'border-neutral-200 bg-white'
      }`}
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <h3
          className={`text-base font-semibold ${
            isDark ? 'text-neutral-100' : 'text-neutral-900'
          }`}
        >
          {debt.name}
        </h3>
        {!isSimpleMode && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              isDark
                ? 'bg-neutral-700 text-neutral-300'
                : 'bg-neutral-100 text-neutral-600'
            }`}
          >
            {debt.debtType === 'amortized' ? 'Amortized' : 'Fixed installment'}
            {debt.interestModelType === 'variable' && ' · Variable rate'}
            {debt.interestModelType === 'fixed' && ' · Fixed rate'}
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className={`h-3 w-full overflow-hidden rounded-full ${trackColor}`}>
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${progressColor}`}
          style={{ width: `${Math.min(100, Math.max(0, payoffInfo.percentPaid))}%` }}
        />
      </div>

      {/* Progress text */}
      <p
        className={`mt-2 text-sm ${
          isDark ? 'text-neutral-300' : 'text-neutral-600'
        }`}
      >
        <span className="font-medium">{displayPercent}% paid off</span>
        {' · '}
        {formatCurrency(payoffInfo.remaining, debt.currency)} remaining of{' '}
        {formatCurrency(debt.initialPrincipal, debt.currency)}
      </p>

      {/* Details row */}
      <div
        className={`mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm ${
          isDark ? 'text-neutral-400' : 'text-neutral-500'
        }`}
      >
        {payoffInfo.monthlyPayment > 0 && (
          <span>
            Monthly payment: {formatCurrency(payoffInfo.monthlyPayment, debt.currency)}
          </span>
        )}
        {payoffInfo.estimatedPayoffDate && (
          <span>
            Payoff: {formatYearMonth(payoffInfo.estimatedPayoffDate)}
          </span>
        )}
      </div>
    </div>
  );
}
