# Settings Page (`/settings`)

User preferences, banking, and administration panel.

## Key File

`page.tsx` — A PrimeReact **TabView**. Tabs (`tabKeys`): `general`, `finance`, `banking`, `data` (hidden in Simple display mode), `admin` (admin users only, also hidden in Simple mode), `account` (visible in BOTH modes — account safety is never gated behind Advanced), `about`. The active tab is **deep-linkable** via `?tab=<key>` (e.g. `/settings?tab=banking`) — a controlled `activeIndex` reads the query param on load and updates the URL on tab change. Other pages link straight to a tab (e.g. the Overview reconnect banner → `/settings?tab=banking`).

## Tabs

### General
- Appearance: dark/light mode toggle (persisted via ThemeProvider)
- **Reminders**: "Monthly check-in reminders" InputSwitch → `updateCheckInReminders` (`UserPreferences.checkInRemindersEnabled`, default on). Off hides the Overview check-in banner; the Overview header button, ⌘M, and the palette command remain. A sub-toggle "Also notify on this device" → `updateCheckInNotifications` (`checkInNotificationsEnabled`, default off, disabled while reminders are off) requests browser Notification permission on enable (denied ⇒ toast + revert) and drives the local check-in notification (`CheckinNotifier`, one per month via the service worker).
- **Push notifications**: five InputSwitch rows (New/Edited/Deleted expenses, Settle-ups, Recurring expenses) → `updateSplitNotificationPrefs` (`UserPreferences.splitNotificationPrefs`, **opt-out** — absent key ⇒ on; the UI always sends the full five-key record). Optimistic toggle + toast, rollback on failure. `getSplitNotifyStatus()` gates an info `AlertBanner` when the server lacks `HA_WEBHOOK_URL` (toggles still save). Delivery itself is the split → Home Assistant webhook — see root AGENTS.md §Split and `docs/features.md` §1.
- Keyboard shortcuts display: `Cmd+K` palette, `Cmd+I` add income, `Cmd+E` add expense, `Cmd+M` monthly check-in
- Accounts management: open the accounts drawer to view/create/edit/archive cash accounts

### Finance
- **Categories management**: view active categories (built-in defaults + custom), remove defaults (moved to a "removed" list), add custom, restore removed. Saved via `updatePreferences()`. Defaults in `src/lib/constants.ts` (`ITEM_CATEGORIES`).
- **Tax & contribution defaults**: tax rate (%), contributions rate (%), other deductions (fixed). Saved in `UserPreferences.taxDefaults`; used as defaults for new salary configs.

### Accounts & Banking
- Renders `BankConnectionsPanel` (`src/components/bank/bank-connections-panel.tsx`) — connect/reconnect/disconnect banks via Enable Banking (**read-only** PSD2 AIS sync) and configure each linked account (role, anchor cash account, exclude, card statement/due day, expected monthly spend, custom name) with autosave + field tooltips.
- When the feature is **unconfigured** (no `ENABLE_BANKING_*` env), the panel shows a "not configured" notice and makes no network calls. See the root "Bank Sync" convention.

### Data & Storage
- **Export Data**: `exportUserData()` (`src/lib/actions/data-transfer.ts`) assembles every user-scoped entity into one versioned JSON envelope, downloaded client-side as `sampolio-export-<date>.json`. Excludes shared mortgages/split groups and all bank data (listed in the payload's `notIncluded`).
- **Import Data**: hidden file input → client-side JSON parse → a dialog showing the file's account count with a "replace all" checkbox (default **merge** = upsert by id; replace requires an extra destructive confirm). Runs `importUserData(payload, { mode })`; orphaned `paidByCardLinkId` refs are stripped with a warning toast. Bank data is never touched.
- Preview then run history compaction via `previewHistoryCompaction` / `compactHistory` (`src/lib/actions/maintenance.ts`)
- Prunes accumulated reconciliation snapshots/sessions/adjustments; keeps the latest snapshot per entity, is anchor-gated and idempotent (projections stay byte-identical), and never touches mortgage data

### Admin (visible only to admin users)
- **Allow self-signup**: toggle public registration
- **Manage Users**: opens `UsersModal` for user CRUD (create, edit roles, deactivate)
- **Force Revalidate Caches**: calls `revalidateAllCaches()` to clear all Next.js caches

### Account (both display modes)
Renders `AccountPanel` (`src/components/settings/account-panel.tsx`, dynamic-imported like `BankConnectionsPanel`); actions in `src/lib/actions/account.ts` (all session-scoped).
- **Change password**: RHF + `changePasswordSchema` (same strength rules as sign-up); `changeMyPassword` re-verifies the current password (`verifyPassword`) before `changePassword`.
- **Danger zone — Start fresh** (`resetMyData`): dialog lists exactly what is wiped (all owned financial data incl. bank connections, which are disconnected with best-effort EB consent revoke) vs. kept (login, preferences, shared split groups/mortgages untouched); a confirmation checkbox gates the button, then a second `confirmDialog` (danger) fires the action. Afterwards `refreshData()` + `router.refresh()`.
- **Danger zone — Delete account** (`deleteMyAccount`): opening the dialog calls `getAccountDeletionPreflight`; blockers (nonzero split balance, sole owner of a shared group/mortgage with other members, only active admin with other active users) render as an actionable checklist that disables deletion. With no blockers the dialog shows the deletion summary and requires **typing the account email** to enable the danger button, then a final `confirmDialog`. On success: toast + `signOut({ callbackUrl: '/auth/signin' })`. The action re-runs the preflight server-side — never trusts the client.

### About
- App name and version (from `package.json`)
- Link to GitHub repository

## Server Actions Used

- `src/lib/actions/user-preferences.ts` — Read/update preferences
- `src/lib/actions/bank.ts` — Bank connections (Enable Banking) — connect/reconnect/refresh, link config
- `src/lib/actions/data-transfer.ts` — JSON backup export/import
- `src/lib/actions/maintenance.ts` — History compaction preview/run
- `src/lib/actions/admin.ts` — User management, app settings (admin only)
- `src/lib/actions/app-info.ts` — App version

## Feedback

Transient save results (admin settings, categories, tax defaults, export/import)
use the global `useToast()`. Persistent inline `Message`s remain only for the
compaction preview/result, which the user reads while deciding.
