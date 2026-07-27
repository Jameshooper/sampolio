'use client';

import React from 'react';
import { useTheme } from '@/components/providers/theme-provider';

/** A titled group of KPI tiles (Assets / Debts & liabilities / Net). 2-col on
 * mobile so nine tiles don't become a ~2 800px scroll of look-alike cards. */
export function KpiGroup({ title, children }: { title: string; children: React.ReactNode }) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    return (
        <section>
            <h3 className={`text-xs font-semibold uppercase tracking-wider mb-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {title}
            </h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                {children}
            </div>
        </section>
    );
}
