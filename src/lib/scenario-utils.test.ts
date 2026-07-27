import { describe, it, expect } from 'vitest';
import { applyScenarioModifications } from './scenario-utils';
import { createMockRecurringItem, createMockPlannedItem } from '@/test/mocks';

const NOW_ISO = '2026-07-03T12:00:00.000Z';
const ACCOUNT_ID = 'test-account';

describe('applyScenarioModifications', () => {
  describe('add-income / add-expense', () => {
    it('appends a synthetic recurring income with a scenario- prefixed id', () => {
      const { recurring, planned } = applyScenarioModifications(
        [],
        [],
        [{ type: 'add-income', name: 'Side gig', amount: 800, frequency: 'monthly' }],
        ACCOUNT_ID,
        NOW_ISO
      );

      expect(planned).toHaveLength(0);
      expect(recurring).toHaveLength(1);
      const item = recurring[0];
      expect(item.id).toMatch(/^scenario-/);
      expect(item.accountId).toBe(ACCOUNT_ID);
      expect(item.type).toBe('income');
      expect(item.name).toBe('Side gig');
      expect(item.amount).toBe(800);
      expect(item.frequency).toBe('monthly');
      expect(item.startDate).toBe('2026-07');
      expect(item.isActive).toBe(true);
      expect(item.createdAt).toBe(NOW_ISO);
      expect(item.updatedAt).toBe(NOW_ISO);
    });

    it('appends a synthetic expense with default name, amount, and frequency', () => {
      const { recurring } = applyScenarioModifications(
        [],
        [],
        [{ type: 'add-expense' }],
        ACCOUNT_ID,
        NOW_ISO
      );

      expect(recurring).toHaveLength(1);
      const item = recurring[0];
      expect(item.type).toBe('expense');
      expect(item.name).toBe('New Expense');
      expect(item.amount).toBe(0);
      expect(item.frequency).toBe('monthly');
    });

    it('does not mutate the input lists', () => {
      const baseRecurring = [createMockRecurringItem()];
      const basePlanned = [createMockPlannedItem()];
      applyScenarioModifications(
        baseRecurring,
        basePlanned,
        [{ type: 'add-income', amount: 100 }, { type: 'remove-item', itemId: baseRecurring[0].id }],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(baseRecurring).toHaveLength(1);
      expect(basePlanned).toHaveLength(1);
    });
  });

  describe('one-off add-income / add-expense', () => {
    it('creates a synthetic one-off planned item with a scenario- id and scheduledDate; recurring untouched', () => {
      const { recurring, planned } = applyScenarioModifications(
        [],
        [],
        [{ type: 'add-expense', name: 'New sofa', amount: 1200, isOneOff: true, scheduledDate: '2026-09' }],
        ACCOUNT_ID,
        NOW_ISO
      );

      expect(recurring).toHaveLength(0);
      expect(planned).toHaveLength(1);
      const item = planned[0];
      expect(item.id).toMatch(/^scenario-/);
      expect(item.accountId).toBe(ACCOUNT_ID);
      expect(item.kind).toBe('one-off');
      expect(item.type).toBe('expense');
      expect(item.name).toBe('New sofa');
      expect(item.amount).toBe(1200);
      expect(item.scheduledDate).toBe('2026-09');
      expect(item.createdAt).toBe(NOW_ISO);
      expect(item.updatedAt).toBe(NOW_ISO);
    });

    it('defaults the one-off month to nowIso when scheduledDate is omitted', () => {
      const { planned } = applyScenarioModifications(
        [],
        [],
        [{ type: 'add-income', amount: 500, isOneOff: true }],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(planned).toHaveLength(1);
      expect(planned[0].scheduledDate).toBe('2026-07');
      expect(planned[0].type).toBe('income');
    });

    it('maps a one-off income to a planned income item', () => {
      const { planned } = applyScenarioModifications(
        [],
        [],
        [{ type: 'add-income', name: 'Tax refund', amount: 900, isOneOff: true, scheduledDate: '2026-08' }],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(planned[0].type).toBe('income');
      expect(planned[0].name).toBe('Tax refund');
    });

    it('without isOneOff still appends a recurring item (unchanged behavior)', () => {
      const { recurring, planned } = applyScenarioModifications(
        [],
        [],
        [{ type: 'add-expense', name: 'Gym', amount: 40, frequency: 'monthly' }],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(recurring).toHaveLength(1);
      expect(planned).toHaveLength(0);
      expect(recurring[0].frequency).toBe('monthly');
    });
  });

  describe('remove-item', () => {
    it('removes a recurring item by id', () => {
      const target = createMockRecurringItem({ id: 'rec-1' });
      const keep = createMockRecurringItem({ id: 'rec-2' });
      const { recurring } = applyScenarioModifications(
        [target, keep],
        [],
        [{ type: 'remove-item', itemId: 'rec-1' }],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(recurring.map(r => r.id)).toEqual(['rec-2']);
    });

    it('removes a planned item by id', () => {
      const target = createMockPlannedItem({ id: 'plan-1' });
      const keep = createMockPlannedItem({ id: 'plan-2' });
      const { planned } = applyScenarioModifications(
        [],
        [target, keep],
        [{ type: 'remove-item', itemId: 'plan-1' }],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(planned.map(p => p.id)).toEqual(['plan-2']);
    });
  });

  describe('modify-amount', () => {
    it('updates a recurring item amount', () => {
      const item = createMockRecurringItem({ id: 'rec-1', amount: 3000 });
      const { recurring } = applyScenarioModifications(
        [item],
        [],
        [{ type: 'modify-amount', itemId: 'rec-1', newAmount: 3500 }],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(recurring[0].amount).toBe(3500);
      // Original item is untouched (map produces a copy).
      expect(item.amount).toBe(3000);
    });

    it('updates a planned item amount (regression: planned ids were silently ignored)', () => {
      const item = createMockPlannedItem({ id: 'plan-1', amount: 500 });
      const { planned } = applyScenarioModifications(
        [],
        [item],
        [{ type: 'modify-amount', itemId: 'plan-1', newAmount: 750 }],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(planned[0].amount).toBe(750);
      expect(item.amount).toBe(500);
    });

    it('leaves other items alone when modifying one', () => {
      const rec = createMockRecurringItem({ id: 'rec-1', amount: 3000 });
      const plan = createMockPlannedItem({ id: 'plan-1', amount: 500 });
      const { recurring, planned } = applyScenarioModifications(
        [rec],
        [plan],
        [{ type: 'modify-amount', itemId: 'plan-1', newAmount: 999 }],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(recurring[0].amount).toBe(3000);
      expect(planned[0].amount).toBe(999);
    });

    it('is a no-op when newAmount is missing', () => {
      const rec = createMockRecurringItem({ id: 'rec-1', amount: 3000 });
      const { recurring } = applyScenarioModifications(
        [rec],
        [],
        [{ type: 'modify-amount', itemId: 'rec-1' }],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(recurring[0].amount).toBe(3000);
    });
  });

  describe('unknown ids', () => {
    it('remove-item with an unknown id is a no-op', () => {
      const rec = createMockRecurringItem({ id: 'rec-1' });
      const plan = createMockPlannedItem({ id: 'plan-1' });
      const { recurring, planned } = applyScenarioModifications(
        [rec],
        [plan],
        [{ type: 'remove-item', itemId: 'nope' }],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(recurring).toHaveLength(1);
      expect(planned).toHaveLength(1);
    });

    it('modify-amount with an unknown id is a no-op', () => {
      const rec = createMockRecurringItem({ id: 'rec-1', amount: 3000 });
      const plan = createMockPlannedItem({ id: 'plan-1', amount: 500 });
      const { recurring, planned } = applyScenarioModifications(
        [rec],
        [plan],
        [{ type: 'modify-amount', itemId: 'nope', newAmount: 1 }],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(recurring[0].amount).toBe(3000);
      expect(planned[0].amount).toBe(500);
    });
  });

  describe('combined modifications', () => {
    it('applies multiple modifications in order', () => {
      const rec = createMockRecurringItem({ id: 'rec-1', amount: 3000 });
      const plan = createMockPlannedItem({ id: 'plan-1', amount: 500 });
      const { recurring, planned } = applyScenarioModifications(
        [rec],
        [plan],
        [
          { type: 'add-expense', name: 'Car lease', amount: 400, frequency: 'monthly' },
          { type: 'modify-amount', itemId: 'plan-1', newAmount: 800 },
          { type: 'remove-item', itemId: 'rec-1' },
        ],
        ACCOUNT_ID,
        NOW_ISO
      );
      expect(recurring).toHaveLength(1);
      expect(recurring[0].name).toBe('Car lease');
      expect(planned[0].amount).toBe(800);
    });
  });
});
