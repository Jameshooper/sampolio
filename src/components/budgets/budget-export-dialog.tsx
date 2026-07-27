'use client';

import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { MdReceiptLong, MdSummarize } from 'react-icons/md';
import { buildExpenseLogCsv, buildBudgetSummaryCsv } from '@/lib/budget-csv';
import { downloadCsv, slugifyFilename } from '@/lib/csv-utils';
import type { Budget } from '@/types';

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function BudgetExportDialog({
  visible,
  budget,
  onHide,
}: {
  visible: boolean;
  budget: Budget;
  onHide: () => void;
}) {
  const slug = slugifyFilename(budget.name);

  return (
    <Dialog header="Download your report" visible={visible} onHide={onHide} style={{ width: '26rem' }}>
      <p className="text-sm opacity-70 mb-4">Two simple files that open straight in Excel.</p>
      <div className="space-y-3">
        <div className="p-3 rounded-lg surface-ground">
          <div className="flex items-center gap-2 mb-1">
            <MdReceiptLong className="opacity-60" />
            <span className="font-medium text-sm">Spending log</span>
          </div>
          <p className="text-xs opacity-60 mb-2">
            Every expense you logged: date, description, category, amount, who paid. This is what grant reports
            usually want.
          </p>
          <Button
            label="Download CSV"
            size="small"
            outlined
            disabled={budget.expenseEntries.length === 0}
            onClick={() => downloadCsv(`${slug}-spending-log-${today()}.csv`, buildExpenseLogCsv(budget))}
          />
          {budget.expenseEntries.length === 0 && (
            <p className="text-xs opacity-50 mt-1">Nothing logged yet.</p>
          )}
        </div>
        <div className="p-3 rounded-lg surface-ground">
          <div className="flex items-center gap-2 mb-1">
            <MdSummarize className="opacity-60" />
            <span className="font-medium text-sm">Budget summary</span>
          </div>
          <p className="text-xs opacity-60 mb-2">
            Planned costs, actual spending and funding coverage, per category — plus each grant&apos;s totals.
          </p>
          <Button
            label="Download CSV"
            size="small"
            outlined
            onClick={() => downloadCsv(`${slug}-summary-${today()}.csv`, buildBudgetSummaryCsv(budget))}
          />
        </div>
      </div>
    </Dialog>
  );
}
