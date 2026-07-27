'use client';

import React from 'react';
import { Button } from 'primereact/button';
import { useTheme } from '@/components/providers/theme-provider';

interface EmptyStateProps {
    icon?: React.ReactNode;
    title: string;
    body?: React.ReactNode;
    action?: { label: string; onClick: () => void; icon?: React.ReactNode };
    className?: string;
}

/** Shared empty-state block: icon, one-line title, optional body + action. */
export function EmptyState({ icon, title, body, action, className = '' }: EmptyStateProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';

    return (
        <div className={`flex flex-col items-center justify-center gap-2 py-10 px-4 text-center ${className}`}>
            {icon && (
                <div className={`text-4xl mb-1 ${isDark ? 'text-gray-600' : 'text-gray-300'}`} aria-hidden>
                    {icon}
                </div>
            )}
            <p className={`font-medium ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>{title}</p>
            {body && (
                <p className={`text-sm max-w-md ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{body}</p>
            )}
            {action && (
                <Button
                    label={action.label}
                    icon={action.icon}
                    size="small"
                    outlined
                    className="mt-2"
                    onClick={action.onClick}
                />
            )}
        </div>
    );
}
