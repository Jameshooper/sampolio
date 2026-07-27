'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from 'primereact/button';
import { MdAdd, MdLuggage } from 'react-icons/md';
import { BudgetCard } from '@/components/budgets/budget-card';
import { BudgetSetupWizard } from '@/components/budgets/budget-setup-wizard';
import type { Budget } from '@/types';

interface BudgetsSectionProps {
  budgets: Budget[];
  /** Re-fetch the parent page's data after a create. */
  onChanged: () => void;
}

/**
 * The Budgets half of the merged "Trips & Budgets" page: bounded project/trip
 * budget cards, the archived toggle, and the setup wizard. Budgets are fetched
 * by the parent; creating one navigates straight to its detail route.
 */
export function BudgetsSection({ budgets, onChanged }: BudgetsSectionProps) {
  const router = useRouter();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const active = budgets.filter((b) => !b.isArchived);
  const archived = budgets.filter((b) => b.isArchived);

  return (
    <section id="budgets" className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Budgets</h2>
          <p className="text-sm opacity-60">
            Plan a bounded project or trip budget — costs, funding (including restricted grants), and an expense log.
          </p>
        </div>
        <Button label="Plan a new budget" icon={<MdAdd />} className="shrink-0 self-start sm:self-auto" onClick={() => setWizardOpen(true)} />
      </div>

      {active.length === 0 && archived.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <MdLuggage size={48} className="opacity-30 mb-4" />
          <p className="text-lg font-medium mb-1">Plan a trip or a project</p>
          <p className="text-sm opacity-60 max-w-md mb-4">
            Add what it&apos;ll cost and who&apos;s paying — grants, daily allowances, your own money — and Sampolio
            tells you if it adds up. When it&apos;s a go, one click puts it in your cashflow.
          </p>
          <Button label="Plan a new budget" icon={<MdAdd />} onClick={() => setWizardOpen(true)} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {active.map((b) => (
              <BudgetCard key={b.id} budget={b} onClick={() => router.push(`/budgets/${b.id}`)} />
            ))}
          </div>
          {archived.length > 0 && (
            <div className="pt-2">
              <Button
                label={showArchived ? 'Hide archived' : `Show archived (${archived.length})`}
                text
                size="small"
                severity="secondary"
                onClick={() => setShowArchived((s) => !s)}
              />
              {showArchived && (
                <div className="animate-fade-in grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
                  {archived.map((b) => (
                    <BudgetCard key={b.id} budget={b} onClick={() => router.push(`/budgets/${b.id}`)} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <BudgetSetupWizard
        visible={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={(b) => {
          setWizardOpen(false);
          onChanged();
          router.push(`/budgets/${b.id}`);
        }}
      />
    </section>
  );
}
