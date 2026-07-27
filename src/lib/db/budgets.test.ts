import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  createBudget,
  getBudgetById,
  setBudgetStatus,
  addBudgetLine,
  addBudgetFundingSource,
  deleteBudgetFundingSource,
  addBudgetExpenseEntry,
} from './budgets';

/** Real disk round-trips (encrypted write → decrypt read) of the single-doc budget. */
describe('budgets db layer', () => {
  let dataDir: string;
  const userId = 'test-user';

  beforeAll(async () => {
    dataDir = path.join(os.tmpdir(), `sampolio-budgets-test-${process.pid}`);
    process.env.DATA_DIR = dataDir;
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('round-trips a budget with embedded collections', async () => {
    const created = await createBudget(userId, {
      name: 'Research trip abroad',
      destination: 'Stockholm',
      currency: 'SEK',
      startMonth: '2026-03',
      endMonth: '2026-04',
    });
    expect(created.status).toBe('draft');
    expect(created.includeRegularIncome).toBe(true);

    await addBudgetLine(userId, created.id, {
      name: 'Rent',
      category: 'Accommodation',
      amount: 800,
      kind: 'monthly',
    });
    const withFunding = await addBudgetFundingSource(userId, created.id, {
      name: 'Foundation grant',
      type: 'grant',
      amount: 2000,
      restrictedToCategories: ['Accommodation', 'Travel'],
      timing: 'upfront',
    });
    const sourceId = withFunding!.fundingSources[0].id;
    await addBudgetExpenseEntry(userId, created.id, {
      date: '2026-03-14',
      description: 'Groceries at the market',
      amount: 240,
      category: 'Food',
      fundingSourceId: sourceId,
    });

    const readBack = await getBudgetById(userId, created.id);
    expect(readBack).not.toBeNull();
    expect(readBack!.lines).toHaveLength(1);
    expect(readBack!.lines[0].kind).toBe('monthly');
    expect(readBack!.fundingSources[0].restrictedToCategories).toEqual(['Accommodation', 'Travel']);
    expect(readBack!.expenseEntries[0].date).toBe('2026-03-14');
    expect(readBack!.expenseEntries[0].fundingSourceId).toBe(sourceId);
  });

  it('persists confirm fields via setBudgetStatus and keeps them on unconfirm', async () => {
    const created = await createBudget(userId, {
      name: 'Conference trip',
      currency: 'EUR',
      startMonth: '2026-06',
      endMonth: '2026-06',
    });

    await setBudgetStatus(userId, created.id, 'confirmed', {
      linkedAccountId: 'acc-1',
      exchangeRate: 0.088,
    });
    let readBack = await getBudgetById(userId, created.id);
    expect(readBack!.status).toBe('confirmed');
    expect(readBack!.linkedAccountId).toBe('acc-1');
    expect(readBack!.exchangeRate).toBe(0.088);

    await setBudgetStatus(userId, created.id, 'draft');
    readBack = await getBudgetById(userId, created.id);
    expect(readBack!.status).toBe('draft');
    // Kept so re-confirming is one click.
    expect(readBack!.linkedAccountId).toBe('acc-1');
    expect(readBack!.exchangeRate).toBe(0.088);
  });

  it('unclaims expense entries when their funding source is deleted', async () => {
    const created = await createBudget(userId, {
      name: 'Cleanup case',
      currency: 'EUR',
      startMonth: '2026-05',
      endMonth: '2026-05',
    });
    const withFunding = await addBudgetFundingSource(userId, created.id, {
      name: 'Stipend',
      type: 'other',
      amount: 500,
      timing: 'upfront',
    });
    const sourceId = withFunding!.fundingSources[0].id;
    await addBudgetExpenseEntry(userId, created.id, {
      date: '2026-05-02',
      description: 'Taxi',
      amount: 40,
      category: 'Local transport',
      fundingSourceId: sourceId,
    });

    await deleteBudgetFundingSource(userId, created.id, sourceId);
    const readBack = await getBudgetById(userId, created.id);
    expect(readBack!.fundingSources).toHaveLength(0);
    expect(readBack!.expenseEntries[0].fundingSourceId).toBeUndefined();
  });
});
