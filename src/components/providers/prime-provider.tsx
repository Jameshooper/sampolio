'use client';

import { PrimeReactProvider } from 'primereact/api';

interface PrimeProviderProps {
    children: React.ReactNode;
}

export function PrimeProvider({ children }: PrimeProviderProps) {
    return (
        <PrimeReactProvider>
            {children}
        </PrimeReactProvider>
    );
}
