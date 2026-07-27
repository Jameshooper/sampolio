'use server';

import { updateTag } from 'next/cache';
import packageJson from '../../../package.json';
import { auth } from '@/lib/auth';
import {
  cachedGetAccounts,
  cachedGetAccountProjectionData,
  cachedGetWealthData,
  cachedGetGoals,
  cachedGetBudgets,
  cachedGetBalanceSnapshots,
  cachedGetReconciliationSessions,
  cachedGetUserPreferences,
  cachedGetBankConnections,
} from '@/lib/db/cached';
import { getAllAdjustments } from '@/lib/db/reconciliation';
import { writeUserDataFromExport, type ImportCounts } from '@/lib/db/data-transfer';
import { stripOrphanCardLinks } from '@/lib/data-transfer-utils';
import {
  dataExportSchema,
  importOptionsSchema,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  type DataExport,
  type ImportOptions,
} from '@/lib/schemas/data-transfer.schema';
import type { ApiResponse } from '@/types';

// What the backup deliberately leaves out (also embedded in the payload so a
// reader of the JSON knows). Shared entities live outside the user dir and
// have their own members; bank data is consent-bound to this instance.
const NOT_INCLUDED = [
  'shared mortgages (shared entity — not part of a personal backup)',
  'split groups (shared entity — not part of a personal backup)',
  'bank connections, bank transactions and sync history (instance-bound consents; reconnect to restore)',
];

export interface ImportSummary {
  counts: ImportCounts;
  warnings: string[];
}

/** Assemble every user-scoped entity into one versioned JSON document. */
export async function exportUserData(): Promise<ApiResponse<DataExport>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const userId = session.user.id;

    const [accounts, wealth, goals, budgets, snapshots, adjustments, sessions, preferences] =
      await Promise.all([
        cachedGetAccounts(userId),
        cachedGetWealthData(userId),
        cachedGetGoals(userId),
        cachedGetBudgets(userId),
        cachedGetBalanceSnapshots(userId),
        getAllAdjustments(userId),
        cachedGetReconciliationSessions(userId),
        cachedGetUserPreferences(userId),
      ]);

    const accountsWithItems = await Promise.all(
      accounts.map(async (account) => {
        const { recurringItems, plannedItems, salaryConfigs, taxedIncomes } =
          await cachedGetAccountProjectionData(userId, account.id);
        return { ...account, recurringItems, plannedItems, salaryConfigs, taxedIncomes };
      })
    );

    const payload: DataExport = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: packageJson.version,
      userId,
      entities: {
        accounts: accountsWithItems,
        investments: wealth.investments,
        debts: wealth.debts,
        receivables: wealth.receivables,
        goals,
        budgets,
        reconciliation: { snapshots, adjustments, sessions },
        preferences,
      },
      notIncluded: NOT_INCLUDED,
    };

    return { success: true, data: payload };
  } catch (error) {
    console.error('Export data error:', error);
    return { success: false, error: 'Failed to export data' };
  }
}

/**
 * Restore a backup produced by `exportUserData`. `merge` upserts by id;
 * `replace` wipes the exported entity types first (never bank data). The
 * payload's entities are re-stamped with the importing user's id.
 */
export async function importUserData(
  payload: unknown,
  options: ImportOptions
): Promise<ApiResponse<ImportSummary>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }
    const userId = session.user.id;

    const parsedOptions = importOptionsSchema.safeParse(options);
    if (!parsedOptions.success) {
      return { success: false, error: 'Invalid import options' };
    }
    const parsed = dataExportSchema.safeParse(payload);
    if (!parsed.success) {
      return { success: false, error: `Not a valid Sampolio export file (${parsed.error.issues[0]?.message ?? 'invalid structure'})` };
    }
    // Structurally validated by the schema; DataExport is the concrete app-typed view.
    const data = parsed.data as unknown as DataExport;
    if (data.version > EXPORT_VERSION) {
      return { success: false, error: `This backup was made by a newer app version (export v${data.version}) — update Sampolio first` };
    }

    const warnings: string[] = [];

    // Card-tagged expenses reference this instance's bank links; strip refs
    // that don't exist here so the items keep hitting cash instead of vanishing.
    const connections = await cachedGetBankConnections(userId);
    const validLinkIds = new Set(connections.flatMap((c) => c.linkedAccounts.map((l) => l.id)));
    let strippedTotal = 0;
    for (const account of data.entities.accounts) {
      const recurring = stripOrphanCardLinks(account.recurringItems, validLinkIds);
      const planned = stripOrphanCardLinks(account.plannedItems, validLinkIds);
      account.recurringItems = recurring.items;
      account.plannedItems = planned.items;
      strippedTotal += recurring.strippedCount + planned.strippedCount;
    }
    if (strippedTotal > 0) {
      warnings.push(`${strippedTotal} item(s) referenced credit-card links that don't exist here — they were switched to direct cash expenses.`);
    }

    const counts = await writeUserDataFromExport(userId, data, parsedOptions.data.mode);

    // Every user-scoped cached query carries this tag.
    updateTag(`user:${userId}`);

    return { success: true, data: { counts, warnings } };
  } catch (error) {
    console.error('Import data error:', error);
    return { success: false, error: 'Failed to import data' };
  }
}
