'use server';

import { z } from 'zod';
import { auth } from '@/lib/auth';
import { calculateProjection } from '@/lib/projection';
import { gatherProjectionInputs, computeCardBillTransfersForAccount } from '@/lib/projection-inputs';
import { applyScenarioModifications, type ScenarioModification } from '@/lib/scenario-utils';
import type { ApiResponse, MonthlyProjection } from '@/types';

const scenarioModSchema = z.object({
  type: z.enum(['add-income', 'add-expense', 'remove-item', 'modify-amount']),
  name: z.string().optional(),
  amount: z.number().optional(),
  frequency: z.enum(['monthly', 'quarterly', 'yearly']).optional(),
  itemId: z.string().optional(), // for remove/modify
  newAmount: z.number().optional(), // for modify
  isOneOff: z.boolean().optional(), // one-off add-* event
  scheduledDate: z.string().regex(/^\d{4}-\d{2}$/).optional(), // YYYY-MM for one-off
});

const runScenarioSchema = z.object({
  accountId: z.string().min(1),
  modifications: z.array(scenarioModSchema).min(1),
});

interface ScenarioResult {
  current: MonthlyProjection[];
  modified: MonthlyProjection[];
  summary: {
    currentEndBalance: number;
    modifiedEndBalance: number;
    difference: number;
    monthsProjected: number;
  };
}

export async function runScenarioProjection(
  accountId: string,
  modifications: ScenarioModification[]
): Promise<ApiResponse<ScenarioResult>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const parsed = runScenarioSchema.safeParse({ accountId, modifications });
    if (!parsed.success) {
      return { success: false, error: 'Invalid scenario input' };
    }

    // Same inputs as the real cashflow projection (anchor snapshot + injected
    // mortgage/budget transfer lines), so Playground absolute balances match
    // the cashflow page.
    const inputs = await gatherProjectionInputs(session.user.id, accountId);
    if (!inputs) {
      return { success: false, error: 'Account not found' };
    }
    const {
      account,
      recurringItems,
      plannedItems,
      taxedIncomes,
      latestSnapshot,
      mortgageTransfers,
      budgetTransfers,
      goalTransfers,
      tripTransfers,
      currentMonthActuals,
      directRecurring,
      directPlanned,
    } = inputs;

    // Baseline: card bills from the FULL item lists (tagged card spend feeds
    // the forecast cycles), projection from the card-filtered direct lists —
    // exactly like getProjection.
    const baselineCardBills = await computeCardBillTransfersForAccount(
      session.user.id, accountId, account, recurringItems, plannedItems
    );
    const current = calculateProjection(
      account, directRecurring, directPlanned, taxedIncomes,
      undefined, latestSnapshot, mortgageTransfers, budgetTransfers, baselineCardBills, currentMonthActuals,
      goalTransfers, tripTransfers
    );

    // Apply the modifications to the UNFILTERED lists (a modified card-tagged
    // expense must flow into the recomputed card bills), then recompute card
    // bills from the modified lists, then filter "paid by card" items out of
    // the direct lists for the projection run.
    const { recurring: modifiedRecurring, planned: modifiedPlanned } = applyScenarioModifications(
      recurringItems, plannedItems, modifications, accountId, new Date().toISOString()
    );
    const modifiedCardBills = await computeCardBillTransfersForAccount(
      session.user.id, accountId, account, modifiedRecurring, modifiedPlanned
    );
    const modifiedDirectRecurring = modifiedRecurring.filter((i) => !i.paidByCardLinkId);
    const modifiedDirectPlanned = modifiedPlanned.filter((i) => !i.paidByCardLinkId);

    // Same anchor and same injected transfers, so the delta is meaningful.
    // currentMonthActuals is also shared with the baseline run — the engine
    // re-matches it against each run's own (possibly modified) item lines.
    const modified = calculateProjection(
      account, modifiedDirectRecurring, modifiedDirectPlanned, taxedIncomes,
      undefined, latestSnapshot, mortgageTransfers, budgetTransfers, modifiedCardBills, currentMonthActuals,
      goalTransfers, tripTransfers
    );

    const currentEnd = current[current.length - 1];
    const modifiedEnd = modified[modified.length - 1];

    return {
      success: true,
      data: {
        current,
        modified,
        summary: {
          currentEndBalance: currentEnd?.endingBalance ?? account.startingBalance,
          modifiedEndBalance: modifiedEnd?.endingBalance ?? account.startingBalance,
          difference: (modifiedEnd?.endingBalance ?? 0) - (currentEnd?.endingBalance ?? 0),
          monthsProjected: current.length,
        },
      },
    };
  } catch (error) {
    console.error('Scenario projection error:', error);
    return { success: false, error: 'Failed to run scenario' };
  }
}
