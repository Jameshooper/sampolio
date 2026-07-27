'use client';

import React from 'react';
import { Button } from 'primereact/button';
import { useTheme } from '@/components/providers/theme-provider';

export type AlertBannerSeverity = 'info' | 'warn' | 'error' | 'success';

interface AlertBannerAction {
    label: string;
    onClick: () => void;
    /** PrimeReact button severity; defaults to match the banner severity. */
    severity?: 'success' | 'info' | 'warning' | 'danger' | 'secondary';
}

interface AlertBannerProps {
    severity?: AlertBannerSeverity;
    icon?: React.ReactNode;
    /** Main message. Inline markup (e.g. <b>) is fine. */
    children: React.ReactNode;
    action?: AlertBannerAction;
    onDismiss?: () => void;
    className?: string;
}

const LIGHT_CLASSES: Record<AlertBannerSeverity, string> = {
    info: 'bg-blue-50 border-blue-200 text-blue-700',
    warn: 'bg-yellow-50 border-yellow-200 text-yellow-700',
    error: 'bg-red-50 border-red-200 text-red-700',
    success: 'bg-green-50 border-green-200 text-green-700',
};

const DARK_CLASSES: Record<AlertBannerSeverity, string> = {
    info: 'bg-blue-900/20 border-blue-800 text-blue-400',
    warn: 'bg-yellow-900/20 border-yellow-800 text-yellow-400',
    error: 'bg-red-900/20 border-red-800 text-red-400',
    success: 'bg-green-900/20 border-green-800 text-green-400',
};

const ACTION_SEVERITY: Record<AlertBannerSeverity, AlertBannerAction['severity']> = {
    info: undefined, // PrimeReact default (primary)
    warn: 'warning',
    error: 'danger',
    success: 'success',
};

/**
 * Shared alert/reminder banner (check-in due, Euribor due, bank consent, budget
 * warnings…). Text and action wrap gracefully on narrow screens instead of
 * squeezing the button off-canvas.
 */
export function AlertBanner({ severity = 'warn', icon, children, action, onDismiss, className = '' }: AlertBannerProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const palette = isDark ? DARK_CLASSES[severity] : LIGHT_CLASSES[severity];

    return (
        <div role="status" className={`flex flex-wrap items-center gap-3 p-3 sm:p-4 rounded-lg border ${palette} ${className}`}>
            {icon && <span className="shrink-0 text-xl leading-none" aria-hidden>{icon}</span>}
            <span className="flex-1 min-w-48 text-sm sm:text-base">{children}</span>
            <span className="flex items-center gap-1 ml-auto shrink-0">
                {action && (
                    <Button
                        label={action.label}
                        size="small"
                        severity={action.severity ?? ACTION_SEVERITY[severity]}
                        onClick={action.onClick}
                    />
                )}
                {onDismiss && (
                    <Button
                        icon="pi pi-times"
                        rounded
                        text
                        size="small"
                        severity="secondary"
                        aria-label="Dismiss"
                        onClick={onDismiss}
                        className="!w-10 !h-10"
                    />
                )}
            </span>
        </div>
    );
}
