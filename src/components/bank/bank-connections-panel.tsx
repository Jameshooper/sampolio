'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Dropdown } from 'primereact/dropdown';
import { InputNumber } from 'primereact/inputnumber';
import { InputText } from 'primereact/inputtext';
import { Tag } from 'primereact/tag';
import { Message } from 'primereact/message';
import { Dialog } from 'primereact/dialog';
import { confirmDialog } from 'primereact/confirmdialog';
import { ProgressSpinner } from 'primereact/progressspinner';
import { InputSwitch } from 'primereact/inputswitch';
import { MdAccountBalance, MdAdd, MdSync, MdLinkOff, MdHelpOutline, MdCheck, MdCreditCard, MdSavings, MdAutorenew } from 'react-icons/md';
import { useTheme } from '@/components/providers/theme-provider';
import { useToast } from '@/components/providers/toast-provider';
import { HelpHint } from '@/components/ui/help-hint';
import {
  getBankFeatureStatus,
  getBankConnections,
  listBankAspsps,
  startBankConnection,
  refreshBankConnection,
  reconnectBankConnection,
  disconnectBankConnection,
  updateBankAccountLink,
} from '@/lib/actions/bank';
import { getAccounts } from '@/lib/actions/accounts';
import { maskIban, getConsentExpiryInfo, effectiveCardNumbers } from '@/lib/bank-utils';
import { suggestStatementDay } from '@/lib/bank/card-billing';
import { STATEMENT_GRACE_DAYS } from '@/lib/bank/constants';
import { formatCurrency } from '@/lib/constants';
import type {
  BankConnection,
  BankAccountLink,
  BankAccountRole,
  BankConnectionStatus,
  FinancialAccount,
} from '@/types';

const ROLE_OPTIONS: { label: string; value: BankAccountRole }[] = [
  { label: 'Cash account', value: 'cash' },
  { label: 'Savings', value: 'savings' },
  { label: 'Credit card', value: 'credit-card' },
  { label: 'Other', value: 'other' },
];

function statusSeverity(status: BankConnectionStatus): 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'active':
      return 'success';
    case 'pending':
      return 'info';
    case 'expired':
    case 'revoked':
      return 'warning';
    case 'error':
      return 'danger';
  }
}

export function BankConnectionsPanel() {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const appToast = useToast();
  const hasLoadedOnce = useRef(false);

  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [connections, setConnections] = useState<BankConnection[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Connect dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [aspsps, setAspsps] = useState<{ label: string; value: string; country: string }[]>([]);
  const [selectedBank, setSelectedBank] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const toast = useCallback(
    (msg: string, severity: 'success' | 'error' | 'info' = 'success') =>
      severity === 'error'
        ? appToast.error('Error', msg)
        : severity === 'info'
          ? appToast.info('Info', msg)
          : appToast.success('Done', msg),
    [appToast]
  );

  const load = useCallback(async () => {
    if (!hasLoadedOnce.current) setLoading(true);
    try {
      const status = await getBankFeatureStatus();
      const isConfigured = status.success && !!status.data?.configured;
      setConfigured(isConfigured);
      if (isConfigured) {
        const [connRes, acctRes] = await Promise.all([getBankConnections(), getAccounts()]);
        if (connRes.success && connRes.data) setConnections(connRes.data);
        if (acctRes.success && acctRes.data) setAccounts(acctRes.data.filter((a) => !a.isArchived));
      }
    } finally {
      hasLoadedOnce.current = true;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Surface the result of a returning consent (?bankConnected / ?bankError).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('bankConnected');
    const error = params.get('bankError');
    if (connected) toast(`Connected ${decodeURIComponent(connected)} — syncing your accounts`);
    else if (error) toast(`Bank connection failed (${error})`, 'error');
    if (connected || error) {
      window.history.replaceState({}, '', '/settings');
    }
  }, [toast]);

  const openConnectDialog = async () => {
    setDialogOpen(true);
    setSelectedBank(null);
    const res = await listBankAspsps('FI');
    if (res.success && res.data) {
      setAspsps(res.data.map((a) => ({ label: a.name, value: a.name, country: a.country })));
    } else {
      toast(res.error ?? 'Could not load banks', 'error');
    }
  };

  const handleConnect = async () => {
    if (!selectedBank) return;
    setConnecting(true);
    const country = aspsps.find((a) => a.value === selectedBank)?.country ?? 'FI';
    const res = await startBankConnection({ aspspName: selectedBank, aspspCountry: country });
    setConnecting(false);
    if (res.success && res.data?.authUrl) {
      window.location.href = res.data.authUrl; // off to the bank for SCA
    } else {
      toast(res.error ?? 'Could not start the connection', 'error');
    }
  };

  const handleRefresh = async (connectionId: string) => {
    setBusyId(connectionId);
    const res = await refreshBankConnection(connectionId);
    setBusyId(null);
    if (res.success) {
      toast('Refreshed');
      load();
    } else {
      toast(res.error ?? 'Refresh failed', 'error');
    }
  };

  const handleReconnect = async (connectionId: string) => {
    setBusyId(connectionId);
    const res = await reconnectBankConnection(connectionId);
    setBusyId(null);
    if (res.success && res.data?.authUrl) {
      window.location.href = res.data.authUrl; // re-run SCA; mappings are preserved
    } else {
      toast(res.error ?? 'Could not start reconnection', 'error');
    }
  };

  const handleDisconnect = (conn: BankConnection) =>
    confirmDialog({
      message: `Disconnect ${conn.aspspName}? This removes the cached balances and transactions and revokes the bank consent. Your manually-entered data is untouched.`,
      header: 'Disconnect bank',
      icon: 'pi pi-exclamation-triangle',
      acceptClassName: 'p-button-danger',
      accept: async () => {
        setBusyId(conn.id);
        const res = await disconnectBankConnection(conn.id);
        setBusyId(null);
        if (res.success) {
          toast('Disconnected');
          load();
        } else {
          toast(res.error ?? 'Disconnect failed', 'error');
        }
      },
    });

  const patchLink = async (
    connectionId: string,
    linkId: string,
    data: Parameters<typeof updateBankAccountLink>[2]
  ): Promise<boolean> => {
    const res = await updateBankAccountLink(connectionId, linkId, data);
    if (res.success && res.data) {
      setConnections((prev) => prev.map((c) => (c.id === connectionId ? res.data! : c)));
      return true;
    }
    toast(res.error ?? 'Update failed', 'error');
    return false;
  };

  const heading = `text-lg font-semibold mb-1 ${isDark ? 'text-gray-100' : 'text-gray-900'}`;
  const subtle = `text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`;

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <ProgressSpinner style={{ width: 24, height: 24 }} strokeWidth="6" />
          <span className={subtle}>Loading bank connections…</span>
        </div>
      </Card>
    );
  }

  return (
    <Card>

      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className={heading}>Bank connections</h2>
          <p className={subtle}>
            Read-only PSD2 (AIS) sync via Enable Banking. Balances auto-anchor your forecasts; the
            app only ever reads the local encrypted cache. IBANs are masked and never logged.
            Hover (or tap) the <MdHelpOutline className="inline align-text-bottom" /> icons for help —
            every change here <b>saves automatically</b>.
          </p>
        </div>
        {configured && (
          <Button
            label="Connect a bank"
            icon={<MdAdd />}
            size="small"
            className="shrink-0 whitespace-nowrap"
            onClick={openConnectDialog}
          />
        )}
      </div>

      {!configured && (
        <Message
          severity="info"
          className="w-full"
          text="Bank sync is not configured on this server. Add the Enable Banking secrets (app id, redirect URL, private key) to enable it."
        />
      )}

      {configured && connections.length === 0 && (
        <div className={`flex flex-col items-center text-center gap-2 py-6 ${subtle}`}>
          <MdAccountBalance size={32} className="opacity-50" />
          <p>No banks connected yet. Connect one to pull balances and transactions automatically.</p>
        </div>
      )}

      <div className="space-y-4">
        {connections.map((conn) => {
          const expiry = getConsentExpiryInfo(conn);
          return (
            <div
              key={conn.id}
              className={`rounded-lg border p-4 ${isDark ? 'border-gray-700' : 'border-gray-200'}`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <MdAccountBalance className="opacity-70" />
                  <span className="font-semibold">{conn.aspspName}</span>
                  <Tag value={conn.status} severity={statusSeverity(conn.status)} />
                  {(expiry.expired || expiry.expiringSoon) && (
                    <Tag
                      value={expiry.expired ? 'consent expired' : `expires in ${expiry.daysUntilExpiry}d`}
                      severity="warning"
                    />
                  )}
                  {conn.lastSyncStatus && conn.lastSyncStatus !== 'ok' && (
                    <Tag
                      value={`sync ${conn.lastSyncStatus}${conn.lastError ? `: ${conn.lastError}` : ''}`}
                      severity={conn.lastSyncStatus === 'error' ? 'danger' : 'warning'}
                    />
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    label={expiry.expired ? 'Reconnect' : 'Renew consent'}
                    icon={<MdAutorenew />}
                    size="small"
                    outlined={!(expiry.expired || expiry.expiringSoon)}
                    severity={expiry.expired || expiry.expiringSoon ? 'warning' : 'secondary'}
                    loading={busyId === conn.id}
                    tooltip="Re-run the bank's secure authentication to renew consent (every ~180 days). Your account mappings and settings are kept, and full transaction history (~24 months) is re-fetched — deepening the cashflow retrospective."
                    tooltipOptions={{ position: 'top' }}
                    onClick={() => handleReconnect(conn.id)}
                  />
                  <Button
                    label="Refresh now"
                    icon={<MdSync />}
                    size="small"
                    outlined
                    loading={busyId === conn.id}
                    onClick={() => handleRefresh(conn.id)}
                  />
                  <Button
                    icon={<MdLinkOff />}
                    size="small"
                    severity="danger"
                    text
                    tooltip="Disconnect"
                    onClick={() => handleDisconnect(conn)}
                  />
                </div>
              </div>

              <p className={`${subtle} mb-3`}>
                {conn.lastSyncAt
                  ? `Last synced ${new Date(conn.lastSyncAt).toLocaleString('en-GB')} · ${conn.lastSyncStatus ?? ''}`
                  : 'Not synced yet'}
                {expiry.expiresAt && ` · consent valid until ${expiry.expiresAt.toLocaleDateString('en-GB')}`}
              </p>

              {conn.linkedAccounts.length === 0 && (
                <p className={subtle}>No accounts returned yet — try Refresh now.</p>
              )}

              <div className="space-y-3">
                {conn.linkedAccounts.map((link) => (
                  <AccountLinkRow
                    key={link.id}
                    link={link}
                    accounts={accounts}
                    isDark={isDark}
                    onPatch={(data) => patchLink(conn.id, link.id, data)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <Dialog
        header="Connect a bank"
        visible={dialogOpen}
        onHide={() => setDialogOpen(false)}
        style={{ width: '28rem' }}
      >
        <div className="space-y-4">
          <p className={subtle}>
            Pick your bank. You&apos;ll be sent to the bank to approve read-only access (strong
            authentication is required by law). Only whitelisted IBANs return data.
          </p>
          <Dropdown
            value={selectedBank}
            options={aspsps}
            onChange={(e) => setSelectedBank(e.value)}
            placeholder={aspsps.length ? 'Select your bank' : 'Loading banks…'}
            filter
            className="w-full"
          />
          <div className="flex justify-end gap-2">
            <Button label="Cancel" text onClick={() => setDialogOpen(false)} />
            <Button
              label="Continue to bank"
              disabled={!selectedBank}
              loading={connecting}
              onClick={handleConnect}
            />
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

// Field-level help, shown via the self-contained <HelpHint> (tap-friendly on
// mobile, works regardless of when this row mounts — unlike a delegated
// data-pr-tooltip selector bound once by a Tooltip elsewhere in the tree).
const TIPS = {
  customName: 'A friendly name for this account, shown everywhere in Sampolio (cashflow lines, overview, the ledger). Cards often arrive unnamed from the bank — e.g. name it “Nordea Platinum”. Leave blank to use the bank’s name.',
  type: 'How Sampolio uses this account. Cash / Savings: its balance auto-anchors the linked account’s forecast on every sync. Credit card: its statement is billed into the paying account and the outstanding counts as a liability. Other: synced for reference only — no forecast impact.',
  anchors:
    'The Sampolio cash account this bank account keeps truthful. After each sync, that account’s forecast re-anchors to this real balance (a “bank-sync” snapshot for the current month). Leave unlinked to store transactions only, without touching any forecast.',
  paidFrom:
    'The Sampolio cash account that pays this card. The latest statement balance is injected as a future expense on the payment-due day, and the current outstanding is subtracted from your net worth as a liability.',
  statementDay:
    'Day of the month your statement closes (1–31). Sampolio groups transactions into billing cycles around this day to work out each statement’s total. It’s printed on your card statement.',
  dueDay:
    'Day of the month the card bill must be paid (1–31). The statement total appears as an expense in the paying account’s cashflow on this day.',
  creditLimit:
    'Optional. Your card’s total credit limit. Only needed when your bank doesn’t report one (OP, for example, sends only the balance) — Sampolio then uses it to show your available credit (limit minus what you owe). Leave blank if your bank already reports a limit.',
  expectedSpend:
    'Forecast buffer for untracked card spend. Future card bills = your expenses tagged “paid by this card” that month + this amount. For the current, still-open cycle only the share of the days still ahead is added on top of the real synced transactions — so as the cycle progresses, actuals take over from the estimate. Set it to roughly your typical untracked monthly card spend; it replaces a manual lump “credit card” expense.',
  exclude:
    'Ignore this account completely — no balance, no transactions, no forecast or net-worth impact. Use it for accounts you don’t want Sampolio to track.',
};

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function FieldLabel({ label, tip, isDark }: { label: string; tip: string; isDark: boolean }) {
  return (
    <label className={`flex items-center gap-1 text-xs mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
      {label} <HelpHint text={tip} />
    </label>
  );
}

function ToggleField({
  label,
  tip,
  checked,
  onChange,
  isDark,
}: {
  label: string;
  tip: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  isDark: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-md px-3 py-2 border ${isDark ? 'border-gray-700' : 'border-gray-200'}`}
    >
      <span className={`flex items-center gap-1 text-xs ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
        {label} <HelpHint text={tip} />
      </span>
      <InputSwitch checked={checked} onChange={(e) => onChange(!!e.value)} />
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'saving')
    return (
      <span className="text-xs opacity-70 flex items-center gap-1">
        <i className="pi pi-spin pi-spinner" style={{ fontSize: '0.7rem' }} /> Saving…
      </span>
    );
  if (state === 'saved')
    return (
      <span className="text-xs text-green-600 flex items-center gap-1">
        <MdCheck /> Saved
      </span>
    );
  if (state === 'error') return <span className="text-xs text-red-500">Save failed — retry</span>;
  return null;
}

function AccountLinkRow({
  link,
  accounts,
  isDark,
  onPatch,
}: {
  link: BankAccountLink;
  accounts: FinancialAccount[];
  isDark: boolean;
  onPatch: (data: Parameters<typeof updateBankAccountLink>[2]) => Promise<boolean>;
}) {
  const subtle = `text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`;
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [nameDraft, setNameDraft] = useState(link.customName ?? '');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the "Saved" auto-hide timer if the row unmounts mid-flight.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const patch = async (data: Parameters<typeof updateBankAccountLink>[2]) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSaveState('saving');
    const ok = await onPatch(data);
    setSaveState(ok ? 'saved' : 'error');
    if (ok) timerRef.current = setTimeout(() => setSaveState('idle'), 1800);
  };

  const accountOptions = [
    { label: '— not linked —', value: null as string | null },
    ...accounts.map((a) => ({ label: a.name, value: a.id })),
  ];
  const isCard = link.accountRole === 'credit-card';
  const roleIcon = isCard ? <MdCreditCard /> : link.accountRole === 'savings' ? <MdSavings /> : <MdAccountBalance />;
  const displayName = link.customName?.trim() || link.name?.trim() || (isCard ? 'Credit card' : 'Account');
  const fmt = (n: number) => formatCurrency(n, link.currency);
  const idParts: string[] = [maskIban(link.iban), link.currency].filter(Boolean) as string[];
  if (isCard) {
    // Card figures with the bank's gaps filled (owed from balance, limit from the
    // manual fallback, available derived) — see effectiveCardNumbers.
    const eff = effectiveCardNumbers(link);
    const before = idParts.length;
    if (typeof eff.outstanding === 'number') idParts.push(`owed ${fmt(eff.outstanding)}`);
    if (typeof eff.availableCredit === 'number') idParts.push(`${fmt(eff.availableCredit)} available`);
    if (typeof eff.creditLimit === 'number') idParts.push(`limit ${fmt(eff.creditLimit)}`);
    // Nothing derivable → show the raw last balance, like a deposit account.
    if (idParts.length === before && typeof link.lastBalance === 'number') idParts.push(fmt(link.lastBalance));
  } else if (typeof link.lastBalance === 'number') {
    idParts.push(fmt(link.lastBalance));
  }

  return (
    <div className={`rounded-md p-3 ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="opacity-70 shrink-0">{roleIcon}</span>
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{displayName}</div>
            <div className={`${subtle} truncate`}>{idParts.join(' · ')}</div>
          </div>
        </div>
        <div className="shrink-0 min-h-[1rem]">
          <SaveIndicator state={saveState} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
        <div className="sm:col-span-2">
          <FieldLabel label="Display name" tip={TIPS.customName} isDark={isDark} />
          <InputText
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => {
              const next = nameDraft.trim();
              if (next !== (link.customName ?? '')) patch({ customName: next || null });
            }}
            placeholder={link.name?.trim() || (isCard ? 'e.g. Nordea Platinum' : 'Account name')}
            className="w-full"
            maxLength={60}
          />
        </div>

        <div>
          <FieldLabel label="Type" tip={TIPS.type} isDark={isDark} />
          <Dropdown
            value={link.accountRole}
            options={ROLE_OPTIONS}
            onChange={(e) => patch({ accountRole: e.value })}
            className="w-full"
          />
        </div>

        <div>
          <FieldLabel
            label={isCard ? 'Paid from account' : 'Anchors account'}
            tip={isCard ? TIPS.paidFrom : TIPS.anchors}
            isDark={isDark}
          />
          <Dropdown
            value={link.linkedFinancialAccountId ?? null}
            options={accountOptions}
            // PrimeReact returns the whole option OBJECT (not its value) when the
            // selected option's value is null/'' — normalize before saving.
            onChange={(e) => patch({ linkedFinancialAccountId: typeof e.value === 'string' ? e.value : null })}
            className="w-full"
            placeholder="Choose account"
          />
        </div>

        {isCard && (
          <>
            <div>
              <FieldLabel label="Statement closes (day)" tip={TIPS.statementDay} isDark={isDark} />
              <InputNumber
                value={link.statementDay ?? null}
                onValueChange={(e) => patch({ statementDay: e.value ?? null })}
                min={1}
                max={31}
                useGrouping={false}
                placeholder="e.g. 20"
                className="w-full"
                inputClassName="w-full"
              />
            </div>
            <div>
              <FieldLabel label="Payment due (day)" tip={TIPS.dueDay} isDark={isDark} />
              <InputNumber
                value={link.paymentDueDay ?? null}
                onValueChange={(e) => {
                  const due = e.value ?? null;
                  // Convenience: when the close day isn't set yet, infer it from
                  // the due day (typical grace period). The user can adjust it.
                  if (due != null && link.statementDay == null) {
                    patch({ paymentDueDay: due, statementDay: suggestStatementDay(due, STATEMENT_GRACE_DAYS) });
                  } else {
                    patch({ paymentDueDay: due });
                  }
                }}
                min={1}
                max={31}
                useGrouping={false}
                placeholder="e.g. 10"
                className="w-full"
                inputClassName="w-full"
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel label="Credit limit" tip={TIPS.creditLimit} isDark={isDark} />
              <InputNumber
                value={link.manualCreditLimit ?? null}
                onValueChange={(e) => patch({ manualCreditLimit: e.value ?? null })}
                mode="currency"
                currency={link.currency}
                locale="fi-FI"
                min={0}
                placeholder="e.g. 5000"
                className="w-full"
                inputClassName="w-full"
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel label="Expected monthly spend (forecast buffer)" tip={TIPS.expectedSpend} isDark={isDark} />
              <InputNumber
                value={link.expectedMonthlySpend ?? null}
                onValueChange={(e) => patch({ expectedMonthlySpend: e.value ?? null })}
                mode="currency"
                currency={link.currency}
                locale="fi-FI"
                min={0}
                placeholder="e.g. 200"
                className="w-full"
                inputClassName="w-full"
              />
            </div>
            <p className={`sm:col-span-2 text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              Tip: enter the payment-due day and Sampolio fills in a likely statement-closing
              day for you (≈{STATEMENT_GRACE_DAYS} days earlier) — adjust it to match your statement.
              The card&apos;s amount owed and available credit are read live from the bank; if your
              bank doesn&apos;t report a credit limit, set one above so Sampolio can show available credit.
            </p>
          </>
        )}

        <ToggleField
          label="Exclude from sync"
          tip={TIPS.exclude}
          checked={!!link.isExcluded}
          onChange={(v) => patch({ isExcluded: v })}
          isDark={isDark}
        />
      </div>

      {isCard && link.linkedFinancialAccountId && (
        <Message
          severity="warn"
          className="w-full mt-3"
          text="This card now bills automatically into the paying account. Archive any manual card-expense items you used to enter by hand, to avoid counting them twice (nothing is deleted automatically)."
        />
      )}
    </div>
  );
}
