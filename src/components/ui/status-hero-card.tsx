'use client';

import { useMemo } from 'react';
import { Card } from 'primereact/card';
import { useTheme } from '@/components/providers/theme-provider';
import { formatCurrency, MONTHS } from '@/lib/constants';
import type { Currency, MonthlyProjection } from '@/types';

interface StatusHeroCardProps {
    userName: string;
    currentMonthProjection?: MonthlyProjection;
    previousMonthProjection?: MonthlyProjection;
    currency: Currency;
}

type Sentiment = 'positive' | 'caution' | 'negative';

function getSentiment(
    netChange: number,
    totalIncome: number
): Sentiment {
    if (netChange < 0) return 'negative';
    if (totalIncome > 0 && netChange < totalIncome * 0.1) return 'caution';
    return 'positive';
}

const SENTIMENT_COLORS: Record<Sentiment, { bg: string; text: string; border: string }> = {
    positive: {
        bg: 'bg-green-50 dark:bg-green-900/20',
        text: 'text-green-700 dark:text-green-400',
        border: 'border-green-200 dark:border-green-800',
    },
    caution: {
        bg: 'bg-yellow-50 dark:bg-yellow-900/20',
        text: 'text-yellow-700 dark:text-yellow-400',
        border: 'border-yellow-200 dark:border-yellow-800',
    },
    negative: {
        bg: 'bg-red-50 dark:bg-red-900/20',
        text: 'text-red-700 dark:text-red-400',
        border: 'border-red-200 dark:border-red-800',
    },
};

export function StatusHeroCard({
    userName,
    currentMonthProjection,
    previousMonthProjection,
    currency,
}: StatusHeroCardProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';

    const monthName = useMemo(() => {
        const now = new Date();
        return MONTHS[now.getMonth()];
    }, []);

    const firstName = userName.split(' ')[0] || userName;

    const netChange = currentMonthProjection?.netChange ?? 0;
    const totalIncome = currentMonthProjection?.totalIncome ?? 0;
    const endBalance = currentMonthProjection?.endingBalance ?? 0;
    const prevEndBalance = previousMonthProjection?.endingBalance ?? endBalance;
    const balanceTrend = endBalance - prevEndBalance;

    const sentiment = getSentiment(netChange, totalIncome);
    const colors = SENTIMENT_COLORS[sentiment];

    const summaryText = useMemo(() => {
        if (netChange > 0) {
            return `You're projected to save ${formatCurrency(netChange, currency)} this month`;
        } else if (netChange < 0) {
            return `Expenses exceed income by ${formatCurrency(Math.abs(netChange), currency)}`;
        }
        return 'Income and expenses are balanced this month';
    }, [netChange, currency]);

    return (
        <Card className={`border ${colors.border} ${colors.bg}`}>
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                    <h2 className={`text-xl font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                        Hi {firstName}, here&apos;s your {monthName} overview
                    </h2>
                    <p className={`text-lg mt-1 ${colors.text} font-medium`}>
                        {summaryText}
                    </p>
                </div>

                <div className="flex items-center gap-6">
                    <div className="text-right">
                        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            Projected end balance
                        </p>
                        <p className={`text-2xl font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                            {formatCurrency(endBalance, currency)}
                        </p>
                        <div className="flex items-center gap-1 justify-end">
                            <span className={balanceTrend >= 0 ? 'text-green-500' : 'text-red-500'}>
                                {balanceTrend >= 0 ? '\u25B2' : '\u25BC'}
                            </span>
                            <span className={`text-sm ${balanceTrend >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                {formatCurrency(Math.abs(balanceTrend), currency)} vs last month
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </Card>
    );
}
