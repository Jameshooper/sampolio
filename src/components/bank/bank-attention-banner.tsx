'use client';

import { AlertBanner } from '@/components/ui/alert-banner';
import type { ConnectionAttention } from '@/lib/actions/bank';
import { MdAccountBalance } from 'react-icons/md';

export interface BankAttentionBannerProps {
  /** Connections needing attention (from `getBankConnectionsNeedingAttention`). */
  attention: ConnectionAttention[];
  /** Called when the user taps the action button (e.g. navigate to /bank or /settings?tab=banking). */
  onAction: () => void;
}

/**
 * Shared "your bank connection needs attention" banner — consent expired,
 * expiring soon, or a connection that keeps failing to sync for a non-expiry
 * reason. Used by both Overview's `BannerStack` and Home so the two surfaces
 * stay in sync. Renders nothing when there's nothing to flag.
 */
export function BankAttentionBanner({ attention, onAction }: BankAttentionBannerProps) {
  if (attention.length === 0) return null;

  const expired = attention.filter((c) => c.expired);
  const expiringSoon = attention.filter((c) => !c.expired && c.expiringSoon);
  const failing = attention.filter((c) => !c.expired && !c.expiringSoon && c.syncFailing);

  return (
    <AlertBanner severity="warn" icon={<MdAccountBalance size={20} />} action={{ label: 'Reconnect', onClick: onAction }}>
      {expired.length > 0
        ? <>Your bank connection to <b>{expired.map((c) => c.aspspName).join(', ')}</b> has expired. Reconnect to keep your balances syncing.</>
        : expiringSoon.length > 0
          ? <>Your bank consent for <b>{expiringSoon.map((c) => c.aspspName).join(', ')}</b> expires soon{expiringSoon[0].daysUntilExpiry != null ? ` (in ${expiringSoon[0].daysUntilExpiry} days)` : ''}. Reconnect now to avoid a gap.</>
          : <>Your bank connection to <b>{failing.map((c) => c.aspspName).join(', ')}</b> keeps failing to sync{failing[0]?.lastError ? ` (${failing[0].lastError})` : ''}. Try reconnecting to restore it.</>}
    </AlertBanner>
  );
}
