// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { AlertBanner } from './alert-banner';

describe('AlertBanner', () => {
  it('renders the message and icon', () => {
    renderWithProviders(
      <AlertBanner severity="warn" icon={<span data-testid="icon">!</span>}>
        Time to check in for July.
      </AlertBanner>
    );
    expect(screen.getByRole('status')).toHaveTextContent('Time to check in for July.');
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('fires the action and dismiss callbacks', () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    renderWithProviders(
      <AlertBanner action={{ label: 'Check in now', onClick: onAction }} onDismiss={onDismiss}>
        msg
      </AlertBanner>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check in now' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('applies the severity palette', () => {
    renderWithProviders(<AlertBanner severity="info">info msg</AlertBanner>);
    expect(screen.getByRole('status').className).toContain('border-blue-200');
  });

  it('renders no buttons when action and onDismiss are omitted', () => {
    renderWithProviders(<AlertBanner>plain</AlertBanner>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
