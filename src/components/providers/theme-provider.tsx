'use client';

import { createContext, useContext, useEffect, useState, useCallback, useSyncExternalStore } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextType {
    theme: Theme;
    toggleTheme: () => void;
    setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

interface ThemeProviderProps {
    children: React.ReactNode;
}

// SSR-safe check for client-side mounting
const emptySubscribe = () => () => { };
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function ThemeProvider({ children }: ThemeProviderProps) {
    const [theme, setThemeState] = useState<Theme>('light');
    const isClient = useSyncExternalStore(emptySubscribe, getClientSnapshot, getServerSnapshot);

    const applyTheme = useCallback((newTheme: Theme) => {
        const root = document.documentElement;

        // Remove existing theme link if any
        const existingLink = document.getElementById('primereact-theme');
        if (existingLink) {
            existingLink.remove();
        }

        // Create new theme link
        const link = document.createElement('link');
        link.id = 'primereact-theme';
        link.rel = 'stylesheet';
        link.href = newTheme === 'dark'
            ? '/themes/sampolio-dark.css'
            : '/themes/sampolio-light.css';
        document.head.appendChild(link);

        // Re-append the glass-overrides stylesheet *after* the theme link so its
        // (un-layered, no-!important) rules win purely on source order. Remove
        // any existing copy first so re-theming never accumulates duplicates.
        const existingOverrides = document.getElementById('glass-overrides');
        if (existingOverrides) {
            existingOverrides.remove();
        }
        const overridesLink = document.createElement('link');
        overridesLink.id = 'glass-overrides';
        overridesLink.rel = 'stylesheet';
        overridesLink.href = '/themes/glass-overrides.css';
        document.head.appendChild(overridesLink);

        // Update HTML class for Tailwind dark mode
        if (newTheme === 'dark') {
            root.classList.add('dark');
        } else {
            root.classList.remove('dark');
        }

        // Update CSS variables for backgrounds — mirrored in globals.css
        // :root/.dark for the SSR-rendered first paint (before this runs).
        if (newTheme === 'dark') {
            root.style.setProperty('--background', '#0F1412');
            root.style.setProperty('--foreground', '#E7ECE9');
        } else {
            root.style.setProperty('--background', '#F3F6F4');
            root.style.setProperty('--foreground', '#1A211D');
        }
    }, []);

    useEffect(() => {
        if (!isClient) return;

        // Check localStorage first
        // Hydrate theme from the external store (localStorage / system pref) on
        // mount — a legitimate effect→state sync, not derivable during render.
        const savedTheme = localStorage.getItem('sampolio-theme') as Theme | null;
        if (savedTheme) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setThemeState(savedTheme);
            applyTheme(savedTheme);
        } else {
            // Check system preference
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            const initialTheme = prefersDark ? 'dark' : 'light';
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setThemeState(initialTheme);
            applyTheme(initialTheme);
        }
    }, [applyTheme, isClient]);

    const setTheme = useCallback((newTheme: Theme) => {
        setThemeState(newTheme);
        localStorage.setItem('sampolio-theme', newTheme);
        applyTheme(newTheme);
    }, [applyTheme]);

    const toggleTheme = useCallback(() => {
        const newTheme = theme === 'light' ? 'dark' : 'light';
        setTheme(newTheme);
    }, [theme, setTheme]);

    if (!isClient) {
        return null;
    }

    return (
        <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
}
