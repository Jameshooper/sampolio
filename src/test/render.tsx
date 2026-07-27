import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { ThemeProvider } from '@/components/providers/theme-provider';

/** Render a component inside the providers app components assume (ThemeProvider). */
export function renderWithProviders(ui: React.ReactElement, options?: RenderOptions) {
  return render(<ThemeProvider>{ui}</ThemeProvider>, options);
}
