'use client';

import { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import { Toast, type ToastMessage } from 'primereact/toast';

/**
 * App-wide toast surface. One <Toast> is mounted here (instead of a local ref in
 * every dialog), and any client component gets it via useToast(). This gives a
 * single, consistent confirmation surface so every mutation can cheaply say
 * "done" / "failed" — the feedback users were missing after an edit.
 */
interface ToastContextValue {
  show: (message: ToastMessage | ToastMessage[]) => void;
  success: (summary: string, detail?: string) => void;
  error: (summary: string, detail?: string) => void;
  info: (summary: string, detail?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const ref = useRef<Toast>(null);

  const show = useCallback((message: ToastMessage | ToastMessage[]) => {
    ref.current?.show(message);
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      success: (summary, detail) =>
        show({ severity: 'success', summary, detail, life: 2000 }),
      error: (summary, detail) =>
        show({ severity: 'error', summary, detail, life: 5000 }),
      info: (summary, detail) => show({ severity: 'info', summary, detail, life: 3000 }),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={value}>
      <Toast ref={ref} position="bottom-center" />
      {children}
    </ToastContext.Provider>
  );
}

/**
 * Access the app-wide toast. Safe to call outside the provider (returns no-ops)
 * so components remain usable in isolation / tests without a provider wrapper.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  return (
    ctx ?? {
      show: () => {},
      success: () => {},
      error: () => {},
      info: () => {},
    }
  );
}
