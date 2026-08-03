'use client';

import React from 'react';
import { Card } from 'primereact/card';
import { Tag } from 'primereact/tag';
import type { Currency } from '@/types';
import { formatCurrency } from '@/lib/constants';
import { useTheme } from '@/components/providers/theme-provider';
import { HelpHint } from '@/components/ui/help-hint';

interface KpiTileProps {
    title: string;
    /** Plain-language explanation of the metric, rendered as a tap-friendly
     *  "?" hint next to the title (see src/lib/plain-language.ts). */
    help?: string;
    value: number;
    currency?: Currency;
    /** Month-over-month delta. Badge renders only when |change| >= 1; a true
     *  zero delta shows muted "unchanged" instead of a broken-looking "+€0,00". */
    change?: number;
    changeLabel?: string;
    /** Optional secondary line under the value (e.g. "€3 500 available of €5 000 limit"). */
    subline?: React.ReactNode;
    /** Optional 0–1 ratio rendered as a thin progress bar (e.g. credit utilization). */
    progress?: number;
    icon: React.ReactNode;
    onClick?: () => void;
    severity?: 'info' | 'success' | 'warning' | 'danger';
    /** Overrides the progress bar's color independently of `severity` (e.g. a
     *  liability tile whose bar should read green→red by utilization). */
    progressSeverity?: 'info' | 'success' | 'warning' | 'danger';
}

export function KpiTile({ title, help, value, currency = 'EUR', change, changeLabel, subline, progress, icon, onClick, severity = 'info', progressSeverity }: KpiTileProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';

    const severityColors = {
        info: isDark ? 'text-blue-400' : 'text-blue-600',
        success: isDark ? 'text-green-400' : 'text-green-600',
        warning: isDark ? 'text-yellow-400' : 'text-yellow-600',
        danger: isDark ? 'text-red-400' : 'text-red-600',
    };
    const barColors = {
        info: 'bg-blue-500',
        success: 'bg-green-500',
        warning: 'bg-yellow-500',
        danger: 'bg-red-500',
    };

    const showChange = change !== undefined && Math.abs(change) >= 1;
    const showUnchanged = change !== undefined && !showChange;

    return (
        <Card
            className={onClick ? 'pressable cursor-pointer hover:scale-[1.01] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500' : ''}
            onClick={onClick}
            // Clickable Cards are divs — give them button semantics for keyboard users.
            role={onClick ? 'button' : undefined}
            tabIndex={onClick ? 0 : undefined}
            aria-label={onClick ? `${title}: view details` : undefined}
            onKeyDown={onClick ? (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick();
                }
            } : undefined}
        >
            {/* Title + icon share the header row; the value gets the FULL card
                width below. Money strings use non-breaking spaces (one
                unbreakable token), so a value beside the icon overflows under
                it on narrow cards — never place them in the same row. */}
            <div className="flex items-start justify-between gap-2">
                <p className={`text-sm font-medium min-w-0 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {title}
                    {help && <HelpHint text={help} />}
                </p>
                <div className={`p-2.5 rounded-full shrink-0 ${isDark ? 'bg-gray-800' : 'bg-gray-100'} text-lg ${severityColors[severity]}`}>
                    {icon}
                </div>
            </div>
            <div className="-mt-1">
                    <p className={`text-2xl font-bold tabular-nums ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                        {formatCurrency(value, currency)}
                    </p>
                    {subline && (
                        <p className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            {subline}
                        </p>
                    )}
                    {typeof progress === 'number' && (
                        <div className={`mt-2 h-1.5 w-full max-w-40 overflow-hidden rounded-full ${isDark ? 'bg-gray-700' : 'bg-gray-200'}`}>
                            <div
                                className={`h-full rounded-full ${barColors[progressSeverity ?? severity]}`}
                                style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
                            />
                        </div>
                    )}
                    {showChange && (
                        <div className="flex items-center gap-2 mt-2">
                            <Tag
                                value={`${change >= 0 ? '+' : ''}${formatCurrency(change, currency)}`}
                                severity={change >= 0 ? 'success' : 'danger'}
                            />
                            {changeLabel && (
                                <span className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                                    {changeLabel}
                                </span>
                            )}
                        </div>
                    )}
                    {showUnchanged && changeLabel && (
                        <p className={`text-xs mt-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            unchanged {changeLabel}
                        </p>
                    )}
            </div>
        </Card>
    );
}
